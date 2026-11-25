-- 0033: staff sign in with their own account (tên đăng nhập) + PIN; the device no longer lists names.
--
--   * staff.username: unique in the whole shop (all branches), lowercase a–z 0–9 . _ (2–20). Existing staff get one
--     from their name without accents ("Quản lý Vân" → quanlyvan, a number added when taken); new staff too when the
--     manager leaves it empty (trigger).
--   * staff_sign_in_user(username, pin) and verify_manager_by_username(username, pin, …) look the person up and then
--     run the existing staff_sign_in / verify_manager_pin (device, branch, kitchen and lockout rules unchanged).
--     An unknown account answers like a wrong one: "Sai tài khoản hoặc mã PIN".
--   * signin_roster() stops being callable from the app in 0034 (after the new app is deployed): then a device that
--     nobody signed in on gets no staff list.
--   * staff_save gets p_username; staff_admin_list returns username.

alter table staff add column if not exists username text;

-- name or typed account → plain lowercase, no accents, no spaces
create or replace function _username_norm(p text) returns text
language sql immutable set search_path = public as $$
  select regexp_replace(lower(translate(btrim(coalesce(p, '')),
    'àáảãạăằắẳẵặâầấẩẫậèéẻẽẹêềếểễệìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵđÀÁẢÃẠĂẰẮẲẴẶÂẦẤẨẪẬÈÉẺẼẸÊỀẾỂỄỆÌÍỈĨỊÒÓỎÕỌÔỒỐỔỖỘƠỜỚỞỠỢÙÚỦŨỤƯỪỨỬỮỰỲÝỶỸỴĐ',
    'aaaaaaaaaaaaaaaaaeeeeeeeeeeeiiiiiooooooooooooooooouuuuuuuuuuuyyyyydaaaaaaaaaaaaaaaaaeeeeeeeeeeeiiiiiooooooooooooooooouuuuuuuuuuuyyyyyd')), '\s', '', 'g')
$$;

create or replace function username_problem(p text) returns text
language sql immutable set search_path = public as $$
  select case when p is null or p !~ '^[a-z0-9][a-z0-9._]{1,19}$'
    then 'Tên đăng nhập 2–20 ký tự: chữ không dấu, số, dấu chấm hoặc gạch dưới' end
$$;

-- a free account made from a name: base, base2, base3…
create or replace function _username_from(p_name text, p_except uuid default null) returns text
language plpgsql stable set search_path = public as $$
declare
  v_base text := left(regexp_replace(_username_norm(p_name), '[^a-z0-9]', '', 'g'), 17);
  v text;
  i int := 1;
begin
  if char_length(v_base) < 2 then v_base := 'nv' || v_base; end if;
  v := v_base;
  while exists (select 1 from staff where username = v and id is distinct from p_except) loop
    i := i + 1;
    v := v_base || i;
  end loop;
  return v;
end $$;

do $$
declare r record;
begin
  for r in select id, name from staff where username is null order by created_at, id loop
    update staff set username = _username_from(r.name, r.id) where id = r.id;
  end loop;
end $$;

alter table staff alter column username set not null;
alter table staff add constraint staff_username_ok check (username_problem(username) is null);
create unique index if not exists staff_username_key on staff (username);

create or replace function _staff_username_default() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.username is null or btrim(new.username) = '' then new.username := _username_from(new.name, new.id);
  else new.username := _username_norm(new.username);
  end if;
  return new;
end $$;
create trigger staff_username_default before insert on staff for each row execute function _staff_username_default();

-- sign in with an account ------------------------------------------------------------------------------------------

create function staff_sign_in_user(p_username text, p_pin text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_id uuid;
begin
  if not exists (select 1 from devices where user_id = auth.uid() and active) then
    raise exception 'Máy này chưa được đăng ký hoặc đã bị khoá';
  end if;
  select id into v_id from staff where username = _username_norm(p_username) and active;
  if not found then
    insert into audit_log (action, detail, device_id)
    select 'sign_in_unknown', jsonb_build_object('username', left(_username_norm(p_username), 20)), d.id from devices d where d.user_id = auth.uid();
    return jsonb_build_object('ok', false, 'error', 'Sai tài khoản hoặc mã PIN');
  end if;
  return staff_sign_in(v_id, p_pin);
end $$;

create function verify_manager_by_username(p_username text, p_pin text, p_action text, p_order uuid, p_detail jsonb default '{}')
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_id uuid;
begin
  if my_staff_id() is null then raise exception 'Đăng nhập trước khi xin quản lý duyệt'; end if;
  select id into v_id from staff where username = _username_norm(p_username) and active;
  if not found then return jsonb_build_object('ok', false, 'error', 'Sai tài khoản hoặc mã PIN'); end if;
  return verify_manager_pin(v_id, p_pin, p_action, p_order, p_detail);
end $$;

-- staff screen -----------------------------------------------------------------------------------------------------

drop function staff_admin_list();
create function staff_admin_list()
returns table (id uuid, name text, role text, active boolean, has_pin boolean, pin_set_at timestamptz, locked_until timestamptz,
               signed_in_on text, last_seen_at timestamptz, username text)
language plpgsql stable security definer set search_path = public as $$
begin
  perform _need('staff.manage');
  return query
    select s.id, s.name, s.role::text, s.active, sec.staff_id is not null, sec.pin_set_at,
           case when sec.locked_until > now() then sec.locked_until end,
           (select d.name from staff_sessions ss join devices d on d.id = ss.device_id
             where ss.staff_id = s.id and ss.ended_at is null and (ss.expires_at is null or ss.expires_at > now())
             order by ss.started_at desc limit 1),
           (select max(ss.last_seen_at) from staff_sessions ss where ss.staff_id = s.id),
           s.username
      from staff s left join staff_secrets sec on sec.staff_id = s.id
     where s.branch_id is null or s.branch_id = my_branch_id()
     order by s.active desc, array_position(array['owner', 'manager', 'cashier', 'waiter', 'kitchen'], s.role::text), s.name;
end $$;

drop function staff_save(uuid, text, text, text);
create function staff_save(p_id uuid, p_name text, p_role text, p_pin text default null, p_username text default null) returns staff
language plpgsql security definer set search_path = public as $$
declare
  v_old staff;
  v staff;
  v_name text := btrim(coalesce(p_name, ''));
  v_user text := nullif(_username_norm(p_username), '');
begin
  perform _need('staff.manage');
  if char_length(v_name) not between 1 and 40 then raise exception 'Nhập tên nhân viên (tối đa 40 ký tự)'; end if;
  if p_role is null or p_role not in ('waiter', 'kitchen', 'cashier', 'manager', 'owner') then raise exception 'Vai trò không hợp lệ'; end if;
  if exists (select 1 from staff where lower(name) = lower(v_name) and active and id is distinct from p_id and (branch_id is null or branch_id = my_branch_id())) then
    raise exception 'Đã có nhân viên tên "%": thêm họ hoặc số để phân biệt', v_name;
  end if;
  if v_user is not null then
    if username_problem(v_user) is not null then raise exception '%', username_problem(v_user); end if;
    if exists (select 1 from staff where username = v_user and id is distinct from p_id) then
      raise exception 'Tên đăng nhập "%" đã có người dùng: chọn tên khác', v_user;
    end if;
  end if;
  if p_id is null then
    if not _may_manage(p_role, null) then raise exception 'Chỉ chủ quán được thêm quản lý hoặc chủ quán'; end if;
    if p_pin is null then raise exception 'Đặt mã PIN cho nhân viên mới'; end if;
    insert into staff (name, role, username) values (v_name, p_role::staff_role, v_user) returning * into v;
    perform _set_pin(v.id, p_pin);
    perform _audit('staff_add', jsonb_build_object('staff', v.id, 'name', v.name, 'role', p_role, 'username', v.username));
    return v;
  end if;
  select * into v_old from staff where id = p_id for update;
  if not found then raise exception 'Không tìm thấy nhân viên'; end if;
  if not _may_manage(v_old.role::text, v_old.id) or (p_role <> v_old.role::text and not _may_manage(p_role, null)) then
    raise exception 'Chỉ chủ quán được sửa quản lý hoặc chủ quán';
  end if;
  if v_old.id = my_staff_id() and p_role <> v_old.role::text then raise exception 'Không tự đổi vai trò của mình'; end if;
  update staff set name = v_name, role = p_role::staff_role, username = coalesce(v_user, username), updated_at = now()
   where id = p_id returning * into v;
  if p_pin is not null then
    perform _set_pin(v.id, p_pin);
    update staff_sessions set ended_at = now(), end_reason = 'pin_reset' where staff_id = v.id and ended_at is null and token_hash is distinct from session_token_hash();
  end if;
  perform _audit('staff_edit', jsonb_build_object('staff', v.id, 'name', v.name, 'role', p_role, 'username', v.username,
                                                  'was', jsonb_build_object('name', v_old.name, 'role', v_old.role::text, 'username', v_old.username),
                                                  'pin_reset', p_pin is not null));
  return v;
end $$;

-- grants -----------------------------------------------------------------------------------------------------------

revoke execute on function _username_from(text, uuid), _staff_username_default(),
  staff_sign_in_user(text, text), verify_manager_by_username(text, text, text, uuid, jsonb), staff_admin_list(),
  staff_save(uuid, text, text, text, text) from public, anon, authenticated;
grant execute on function staff_sign_in_user(text, text), verify_manager_by_username(text, text, text, uuid, jsonb), staff_admin_list(),
  staff_save(uuid, text, text, text, text) to authenticated;
-- signin_roster / staff_sign_in / verify_manager_pin stay callable until the new app is deployed: 0034 closes them.
