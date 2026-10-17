-- Bò Mỹ Đen POS 0006: staff sign-in on shared devices, PINs, manager approval and audit on top of 0001–0005.
-- Same rules as src/auth/memoryRepo.ts and src/floor/engine.ts (the sample engines); keep them in step.
--
-- Who is calling (after this migration):
--   * A registered device (tablet, POS, kitchen screen) is one Supabase auth user (anonymous sign-in is enough)
--     with a row in `devices`. It is registered once with a one-time code from a manager (create_device_code),
--     or for the very first device with admin_create_device_code() run in the SQL editor.
--   * On that device staff pick their name and enter a 4–6 digit PIN (staff_sign_in). The PIN is stored only as a
--     bcrypt hash (pgcrypto crypt/gen_salt('bf')) in staff_secrets, which no API role can read.
--     staff_sign_in returns a session token; the client sends it on every request as the `x-staff-session` header.
--     my_staff_id() / my_role() resolve that token (hash lookup, same device, not ended, not idle-expired).
--   * Idle sign-out: a session expires `idle_signout_min` after its last touch_session(); kitchen accounts
--     never expire (the kitchen display stays signed in until someone taps Đổi người).
--   * A staff row with its own user_id (owner's phone with an email login) still works as before.
--   * Realtime cannot send headers, so read policies also accept the device's current session (reader_role()).
--     Every write still needs the session token.
--
-- Roles: waiter, kitchen, cashier, manager, owner. Owner can do everything a manager can (my_role() maps
-- owner -> manager so the 0001–0005 policies keep working); only an owner manages managers and owners.
--
-- Manager approval (verified here, not on the device):
--   verify_manager_pin(manager, pin, action, order, detail) -> short-lived single-use token, bound to the action,
--   the order, the person who asked and (discount) the maximum amount / (void_item) the line. Passed as p_approval to
--     pay_order   a bill discount by anyone but a manager/owner
--     void_item   huỷ / bớt a sent line (shop_settings.void_approval: 'sent' = every sent line, 'started' = only
--                 lines the kitchen started, done or served)
--     void_order  huỷ cả đơn: every live line of an order with one reason and one approval
--   Wrong PINs count per person (sign-in and approvals together): `pin_max_attempts` misses lock the PIN for
--   `pin_lock_min` minutes. Sign-in, failures, lockouts, approvals and staff changes go to audit_log
--   (staff_id = who, approved_by = which manager, device_id = where, at = when).
--
-- Left for later: rate limit on device codes per IP, PIN change by the staff member themselves, sessions list UI.

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

-- New enum value: usable only after this transaction commits, so everything below compares role::text.
alter type staff_role add value if not exists 'owner';

-- ---------------------------------------------------------------- settings

alter table shop_settings
  add column idle_signout_min int not null default 5 check (idle_signout_min between 1 and 240),
  add column pin_max_attempts int not null default 5 check (pin_max_attempts between 3 and 10),
  add column pin_lock_min int not null default 5 check (pin_lock_min between 1 and 120),
  add column approval_ttl_sec int not null default 120 check (approval_ttl_sec between 30 and 600),
  add column void_approval text not null default 'sent' check (void_approval in ('sent', 'started'));

-- ---------------------------------------------------------------- tables

alter table staff
  add column updated_at timestamptz not null default now(),
  add constraint staff_name_len check (char_length(btrim(name)) between 1 and 40);

-- PIN hashes and the failed-PIN counter. No API role can read or write this table.
create table staff_secrets (
  staff_id uuid primary key references staff on delete cascade,
  pin_hash text not null,                        -- bcrypt, from extensions.crypt(pin, extensions.gen_salt('bf', 8))
  pin_set_at timestamptz not null default now(),
  failed_count int not null default 0 check (failed_count >= 0),
  locked_until timestamptz
);

create table devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 40),
  kind text not null default 'pos' check (kind in ('pos', 'kitchen')),
  active boolean not null default true,
  registered_by uuid references staff,
  registered_at timestamptz not null default now(),
  last_seen_at timestamptz
);

create table device_codes (
  code_hash text primary key,                    -- sha256 of the code; the code itself is shown once
  name text not null,
  kind text not null check (kind in ('pos', 'kitchen')),
  created_by uuid references staff,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz,
  device_id uuid references devices on delete set null
);

create table staff_sessions (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique,               -- sha256 of the token the device holds
  device_id uuid not null references devices on delete cascade,
  staff_id uuid not null references staff on delete cascade,
  started_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at timestamptz,                        -- null = no idle sign-out (kitchen accounts)
  ended_at timestamptz,
  end_reason text check (end_reason in ('sign_out', 'switched', 'disabled', 'device_off', 'pin_reset'))
);
create index staff_sessions_device on staff_sessions (device_id) where ended_at is null;
create index staff_sessions_staff on staff_sessions (staff_id) where ended_at is null;

create table approvals (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique,
  action text not null check (action in ('discount', 'void_item', 'void_order')),
  order_id uuid not null references orders on delete cascade,
  detail jsonb not null default '{}',            -- discount: {"amount": max đồng}; void_item: {"line": id}
  manager_id uuid not null references staff,
  requested_by uuid not null references staff,
  device_id uuid references devices on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz
);

alter table audit_log
  add column approved_by uuid references staff,
  add column device_id uuid references devices on delete set null;
create index audit_log_at on audit_log (at desc);

-- ---------------------------------------------------------------- identity

create function session_token_hash() returns text
language plpgsql stable set search_path = public as $$
declare
  v_h text := current_setting('request.headers', true);
  v_t text;
begin
  if v_h is null or v_h = '' then return null; end if;
  v_t := nullif(btrim(v_h::json ->> 'x-staff-session'), '');
  if v_t is null then return null; end if;
  return encode(extensions.digest(v_t, 'sha256'), 'hex');
exception when others then
  return null;   -- malformed header: not signed in
end $$;

-- The calling device (null when this auth user is not an active device).
create function my_device_id() returns uuid
language sql stable security definer set search_path = public as $$
  select id from devices where user_id = auth.uid() and active
$$;

-- staff.id of the caller: the device session named by the x-staff-session header, else a personal login.
create or replace function my_staff_id() returns uuid
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select s.staff_id
       from staff_sessions s
       join devices d on d.id = s.device_id and d.active and d.user_id = auth.uid()
       join staff st on st.id = s.staff_id and st.active
      where s.token_hash = session_token_hash() and s.ended_at is null and (s.expires_at is null or s.expires_at > now())),
    (select id from staff where user_id = auth.uid() and active))
$$;

-- The caller's real role, as text ('owner' included).
create function my_real_role() returns text
language sql stable security definer set search_path = public as $$
  select role::text from staff where id = my_staff_id()
$$;

-- Role for permission checks: an owner counts as a manager everywhere 0001–0005 check 'manager'.
create or replace function my_role() returns staff_role
language sql stable security definer set search_path = public as $$
  select case when role::text = 'owner' then 'manager'::staff_role else role end from staff where id = my_staff_id()
$$;

-- For read policies (and Realtime, which sends no headers): the caller's role, else the role of the device's
-- current session.
create function reader_role() returns staff_role
language sql stable security definer set search_path = public as $$
  select coalesce(my_role(), (
    select case when st.role::text = 'owner' then 'manager'::staff_role else st.role end
      from devices d
      join staff_sessions s on s.device_id = d.id and s.ended_at is null and (s.expires_at is null or s.expires_at > now())
      join staff st on st.id = s.staff_id and st.active
     where d.user_id = auth.uid() and d.active
     order by s.started_at desc limit 1))
$$;

create or replace function require_floor_staff() returns uuid
language plpgsql stable security definer set search_path = public as $$
declare
  v uuid := my_staff_id();
begin
  if v is null or my_role() not in ('waiter', 'cashier', 'manager') then raise exception 'Chỉ phục vụ, thu ngân hoặc quản lý được thao tác đơn'; end if;
  return v;
end $$;

create or replace function require_kitchen_or_manager() returns uuid
language plpgsql stable security definer set search_path = public as $$
declare
  v uuid := my_staff_id();
begin
  if v is null or my_role() not in ('kitchen', 'manager') then raise exception 'Chỉ máy bếp, bar hoặc quản lý được đổi trạng thái này'; end if;
  return v;
end $$;

create or replace function send_order_lines(p_order uuid, p_lines jsonb, p_batch uuid default null, p_rush_reason text default null)
returns setof order_items language plpgsql security definer set search_path = public as $$
declare
  v_staff uuid := my_staff_id();
begin
  if v_staff is null or my_role() not in ('waiter', 'cashier', 'manager') then raise exception 'Chỉ phục vụ, thu ngân hoặc quản lý được gửi bếp'; end if;
  return query select * from _send_lines(p_order, p_lines, p_batch, v_staff, p_rush_reason, true);
end $$;

-- 0002 functions that looked the caller up by staff.user_id: same bodies, caller from my_staff_id(), owner allowed.
do $$
declare
  f text;
  v_def text;
  v_new text;
begin
  foreach f in array array['log_price_change', 'merge_orders', 'move_items', 'split_order', 'set_sold_out'] loop
    select pg_get_functiondef(p.oid) into v_def from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = f;
    if v_def is null then raise exception '0006: function % not found', f; end if;
    v_new := replace(v_def, 'user_id = auth.uid()', 'id = my_staff_id()');
    v_new := replace(v_new, 'role in (''waiter'', ''cashier'', ''manager'')', 'role::text in (''waiter'', ''cashier'', ''manager'', ''owner'')');
    if v_new = v_def then raise exception '0006: nothing to change in %', f; end if;
    execute v_new;
  end loop;
  -- nothing else may identify the caller by staff.user_id
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and p.prosrc like '%auth.uid()%'
                and p.proname not in ('my_staff_id', 'my_device_id', 'reader_role')) then
    raise exception '0006: a function still reads auth.uid(): %', (
      select string_agg(p.proname, ', ') from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.prosrc like '%auth.uid()%' and p.proname not in ('my_staff_id', 'my_device_id', 'reader_role'));
  end if;
end $$;

-- ---------------------------------------------------------------- helpers

create function _token() returns text language sql volatile as $$ select encode(extensions.gen_random_bytes(24), 'hex') $$;
create function _hash(p text) returns text language sql immutable as $$ select encode(extensions.digest(p, 'sha256'), 'hex') $$;

create function _audit(p_action text, p_detail jsonb, p_staff uuid default null, p_approved_by uuid default null)
returns void language sql security definer set search_path = public as $$
  insert into audit_log (staff_id, action, detail, approved_by, device_id)
  values (coalesce(p_staff, my_staff_id()), p_action, coalesce(p_detail, '{}'), p_approved_by, my_device_id())
$$;

-- 4–6 digits; not all the same digit; not a straight run (1234, 98765).
create function pin_problem(p_pin text) returns text
language plpgsql immutable as $$
declare
  i int;
  up boolean := true;
  down boolean := true;
begin
  if p_pin is null or p_pin !~ '^[0-9]{4,6}$' then return 'Mã PIN gồm 4 đến 6 chữ số'; end if;
  if p_pin ~ '^(.)\1*$' then return 'Mã PIN không được toàn một chữ số'; end if;
  for i in 2 .. length(p_pin) loop
    if substr(p_pin, i, 1)::int <> (substr(p_pin, i - 1, 1)::int + 1) % 10 then up := false; end if;
    if substr(p_pin, i, 1)::int <> (substr(p_pin, i - 1, 1)::int + 9) % 10 then down := false; end if;
  end loop;
  if up or down then return 'Mã PIN không được là dãy liên tiếp (1234, 4321…)'; end if;
  return null;
end $$;

create function _set_pin(p_staff uuid, p_pin text) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_bad text := pin_problem(p_pin);
begin
  if v_bad is not null then raise exception '%', v_bad; end if;
  insert into staff_secrets (staff_id, pin_hash) values (p_staff, extensions.crypt(p_pin, extensions.gen_salt('bf', 8)))
  on conflict (staff_id) do update set pin_hash = excluded.pin_hash, pin_set_at = now(), failed_count = 0, locked_until = null;
end $$;

-- Check a PIN with the lockout. Never raises for a wrong PIN (the failed count must commit): returns
-- {"ok":true} or {"ok":false,"error":...,"attempts_left":n | "locked_until":ts}.
create function _check_pin(p_staff uuid, p_pin text, p_purpose text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_sec staff_secrets;
  v_max int;
  v_lock int;
  v_left int;
  v_until timestamptz;
begin
  select pin_max_attempts, pin_lock_min into v_max, v_lock from shop_settings;
  select * into v_sec from staff_secrets where staff_id = p_staff for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'Chưa có mã PIN: nhờ quản lý đặt PIN'); end if;
  if v_sec.locked_until > now() then
    return jsonb_build_object('ok', false, 'locked_until', v_sec.locked_until,
      'error', format('Nhập sai quá nhiều lần: khoá đến %s', to_char(v_sec.locked_until at time zone 'Asia/Ho_Chi_Minh', 'HH24:MI')));
  end if;
  if p_pin ~ '^[0-9]{4,6}$' and v_sec.pin_hash = extensions.crypt(p_pin, v_sec.pin_hash) then
    update staff_secrets set failed_count = 0, locked_until = null where staff_id = p_staff;
    return jsonb_build_object('ok', true);
  end if;
  v_left := v_max - v_sec.failed_count - 1;
  if v_left <= 0 then
    v_until := now() + make_interval(mins => v_lock);
    update staff_secrets set failed_count = 0, locked_until = v_until where staff_id = p_staff;
    perform _audit('pin_locked', jsonb_build_object('purpose', p_purpose, 'by', my_staff_id(), 'until', v_until), p_staff);
    return jsonb_build_object('ok', false, 'locked_until', v_until,
      'error', format('Sai mã PIN %s lần: khoá %s phút', v_max, v_lock));
  end if;
  update staff_secrets set failed_count = failed_count + 1 where staff_id = p_staff;
  perform _audit('pin_failed', jsonb_build_object('purpose', p_purpose, 'by', my_staff_id(), 'left', v_left), p_staff);
  return jsonb_build_object('ok', false, 'attempts_left', v_left, 'error', format('Mã PIN không đúng (còn %s lần thử)', v_left));
end $$;

-- ---------------------------------------------------------------- devices

create function _new_device_code(p_name text, p_kind text, p_by uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_alphabet text := '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';   -- no 0/O, 1/I
  v_code text := '';
  v_b bytea := extensions.gen_random_bytes(8);
  v_exp timestamptz := now() + interval '30 minutes';
  i int;
begin
  if char_length(btrim(coalesce(p_name, ''))) not between 1 and 40 then raise exception 'Đặt tên máy (1–40 ký tự)'; end if;
  if p_kind is null or p_kind not in ('pos', 'kitchen') then raise exception 'Loại máy không hợp lệ'; end if;
  for i in 0 .. 7 loop
    v_code := v_code || substr(v_alphabet, get_byte(v_b, i) % 32 + 1, 1);
  end loop;
  v_code := substr(v_code, 1, 4) || '-' || substr(v_code, 5, 4);
  insert into device_codes (code_hash, name, kind, created_by, expires_at) values (_hash(v_code), btrim(p_name), p_kind, p_by, v_exp);
  return jsonb_build_object('code', v_code, 'name', btrim(p_name), 'kind', p_kind, 'expires_at', v_exp);
end $$;

-- Manager / owner: a one-time code (30 minutes) to register a new device.
create function create_device_code(p_name text, p_kind text default 'pos') returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v jsonb;
begin
  if my_role() is distinct from 'manager' then raise exception 'Chỉ quản lý hoặc chủ quán được thêm máy'; end if;
  v := _new_device_code(p_name, p_kind, my_staff_id());
  perform _audit('device_code', jsonb_build_object('name', v ->> 'name', 'kind', p_kind));
  return v;
end $$;

-- First device of a new shop: run in the SQL editor (not callable through the API).
create function admin_create_device_code(p_name text, p_kind text default 'pos') returns text
language sql security definer set search_path = public as $$
  select _new_device_code(p_name, p_kind, null) ->> 'code'
$$;

-- Bootstrap staff (SQL editor only): select admin_add_staff('Chủ quán', 'owner', '2468');
create function admin_add_staff(p_name text, p_role text, p_pin text) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v uuid;
begin
  insert into staff (name, role) values (btrim(p_name), p_role::staff_role) returning id into v;
  perform _set_pin(v, p_pin);
  return v;
end $$;

-- This auth user becomes a device, with a code from create_device_code.
create function register_device(p_code text) returns devices
language plpgsql security definer set search_path = public as $$
declare
  v_c device_codes;
  v_d devices;
begin
  if auth.uid() is null then raise exception 'Máy chưa kết nối'; end if;
  if exists (select 1 from devices where user_id = auth.uid()) then raise exception 'Máy này đã được đăng ký'; end if;
  select * into v_c from device_codes where code_hash = _hash(upper(btrim(coalesce(p_code, '')))) for update;
  if not found or v_c.used_at is not null or v_c.expires_at < now() then raise exception 'Mã đăng ký máy không đúng hoặc đã hết hạn'; end if;
  insert into devices (user_id, name, kind, registered_by) values (auth.uid(), v_c.name, v_c.kind, v_c.created_by) returning * into v_d;
  update device_codes set used_at = now(), device_id = v_d.id where code_hash = v_c.code_hash;
  insert into audit_log (staff_id, action, detail, device_id) values (v_c.created_by, 'device_registered', jsonb_build_object('name', v_d.name, 'kind', v_d.kind), v_d.id);
  return v_d;
end $$;

-- The calling device, or null (also for a disabled one: the screen then says so).
create function my_device() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('id', id, 'name', name, 'kind', kind, 'active', active,
                            'idle_min', (select idle_signout_min from shop_settings))
  from devices where user_id = auth.uid()
$$;

create function device_set_active(p_device uuid, p_active boolean) returns devices
language plpgsql security definer set search_path = public as $$
declare
  v devices;
begin
  if my_role() is distinct from 'manager' then raise exception 'Chỉ quản lý hoặc chủ quán được khoá máy'; end if;
  update devices set active = p_active where id = p_device returning * into v;
  if not found then raise exception 'Không tìm thấy máy'; end if;
  if not p_active then
    update staff_sessions set ended_at = now(), end_reason = 'device_off' where device_id = p_device and ended_at is null;
  end if;
  perform _audit(case when p_active then 'device_on' else 'device_off' end, jsonb_build_object('device', v.name));
  return v;
end $$;

-- ---------------------------------------------------------------- sign-in

-- Names on the sign-in screen of this device. Kitchen devices list kitchen accounts and managers only.
create function signin_roster()
returns table (id uuid, name text, role text, has_pin boolean, locked_until timestamptz)
language plpgsql stable security definer set search_path = public as $$
declare
  v_d devices;
begin
  select * into v_d from devices where user_id = auth.uid() and active;
  if not found then raise exception 'Máy này chưa được đăng ký hoặc đã bị khoá'; end if;
  return query
    select s.id, s.name, s.role::text, sec.staff_id is not null, case when sec.locked_until > now() then sec.locked_until end
      from staff s left join staff_secrets sec on sec.staff_id = s.id
     where s.active and (v_d.kind = 'pos' or s.role::text in ('kitchen', 'manager', 'owner'))
     order by array_position(array['waiter', 'cashier', 'kitchen', 'manager', 'owner'], s.role::text), s.name;
end $$;

-- Pick a name, enter the PIN. Ends whoever was signed in on this device. Returns
-- {"ok":true,"token":...,"staff":{id,name,role},"expires_at":ts|null,"idle_min":n} or {"ok":false,"error":...}.
create function staff_sign_in(p_staff uuid, p_pin text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_d devices;
  v_s staff;
  v_chk jsonb;
  v_tok text := _token();
  v_idle int := (select idle_signout_min from shop_settings);
  v_exp timestamptz;
begin
  select * into v_d from devices where user_id = auth.uid() and active;
  if not found then raise exception 'Máy này chưa được đăng ký hoặc đã bị khoá'; end if;
  select * into v_s from staff where id = p_staff and active;
  if not found then return jsonb_build_object('ok', false, 'error', 'Không tìm thấy nhân viên hoặc đã ngừng làm'); end if;
  if v_d.kind = 'kitchen' and v_s.role::text not in ('kitchen', 'manager', 'owner') then
    return jsonb_build_object('ok', false, 'error', 'Máy bếp chỉ đăng nhập tài khoản bếp hoặc quản lý');
  end if;
  v_chk := _check_pin(v_s.id, p_pin, 'sign_in');
  if not (v_chk ->> 'ok')::boolean then return v_chk; end if;
  update staff_sessions set ended_at = now(), end_reason = 'switched' where device_id = v_d.id and ended_at is null;
  v_exp := case when v_s.role::text = 'kitchen' then null else now() + make_interval(mins => v_idle) end;
  insert into staff_sessions (token_hash, device_id, staff_id, expires_at) values (_hash(v_tok), v_d.id, v_s.id, v_exp);
  update devices set last_seen_at = now() where id = v_d.id;
  insert into audit_log (staff_id, action, detail, device_id) values (v_s.id, 'sign_in', jsonb_build_object('device', v_d.name), v_d.id);
  return jsonb_build_object('ok', true, 'token', v_tok, 'expires_at', v_exp, 'idle_min', v_idle,
                            'staff', jsonb_build_object('id', v_s.id, 'name', v_s.name, 'role', v_s.role::text));
end $$;

-- Activity on the device: push the idle sign-out back. Returns the new expiry (null = none) or raises when
-- the session is already over (the screen goes back to the names).
create function touch_session() returns timestamptz
language plpgsql security definer set search_path = public as $$
declare
  v staff_sessions;
begin
  update staff_sessions s set last_seen_at = now(),
         expires_at = case when s.expires_at is null then null else now() + make_interval(mins => (select idle_signout_min from shop_settings)) end
   where s.token_hash = session_token_hash() and s.ended_at is null and (s.expires_at is null or s.expires_at > now())
     and s.device_id = my_device_id()
  returning * into v;
  if not found then raise exception 'Phiên đăng nhập đã hết: đăng nhập lại'; end if;
  return v.expires_at;
end $$;

create function staff_sign_out() returns void
language plpgsql security definer set search_path = public as $$
declare
  v staff_sessions;
begin
  update staff_sessions set ended_at = now(), end_reason = 'sign_out'
   where token_hash = session_token_hash() and ended_at is null and device_id = my_device_id()
  returning * into v;
  if found then
    insert into audit_log (staff_id, action, detail, device_id) values (v.staff_id, 'sign_out', '{}', v.device_id);
  end if;
end $$;

-- ---------------------------------------------------------------- manager approval

-- A manager or owner enters their PIN on the asking device. Returns {"ok":true,"token":...,"manager":{id,name},
-- "expires_at":ts} or {"ok":false,"error":...}. The token is single-use, for this action, order and asker only.
create function verify_manager_pin(p_manager uuid, p_pin text, p_action text, p_order uuid, p_detail jsonb default '{}')
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_me uuid := my_staff_id();
  v_m staff;
  v_chk jsonb;
  v_tok text := _token();
  v_exp timestamptz := now() + make_interval(secs => (select approval_ttl_sec from shop_settings));
  v_detail jsonb := coalesce(p_detail, '{}');
begin
  if v_me is null then raise exception 'Đăng nhập trước khi xin quản lý duyệt'; end if;
  if p_action is null or p_action not in ('discount', 'void_item', 'void_order') then raise exception 'Việc cần duyệt không hợp lệ'; end if;
  if not exists (select 1 from orders where id = p_order) then raise exception 'Không tìm thấy đơn'; end if;
  if p_action = 'discount' and jsonb_typeof(v_detail -> 'amount') is distinct from 'number' then raise exception 'Ghi số tiền giảm cần duyệt'; end if;
  if p_action = 'void_item' and not exists (select 1 from order_items where id = (v_detail ->> 'line')::uuid and order_id = p_order) then
    raise exception 'Món cần duyệt không thuộc đơn';
  end if;
  select * into v_m from staff where id = p_manager and active and role::text in ('manager', 'owner');
  if not found then return jsonb_build_object('ok', false, 'error', 'Chỉ quản lý hoặc chủ quán duyệt được'); end if;
  v_chk := _check_pin(v_m.id, p_pin, 'approve_' || p_action);
  if not (v_chk ->> 'ok')::boolean then return v_chk; end if;
  insert into approvals (token_hash, action, order_id, detail, manager_id, requested_by, device_id, expires_at)
  values (_hash(v_tok), p_action, p_order, v_detail, v_m.id, v_me, my_device_id(), v_exp);
  perform _audit('approval', jsonb_build_object('for', p_action, 'order', p_order) || v_detail, v_me, v_m.id);
  return jsonb_build_object('ok', true, 'token', v_tok, 'expires_at', v_exp, 'manager', jsonb_build_object('id', v_m.id, 'name', v_m.name));
end $$;

-- Who approves this action: the caller when a manager/owner, else the manager behind a valid token (used up here).
create function _approver(p_token text, p_action text, p_order uuid, p_missing text, p_amount int default null, p_line uuid default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_me uuid := my_staff_id();
  v_a approvals;
begin
  if my_role() = 'manager' then return v_me; end if;
  if p_token is null or btrim(p_token) = '' then raise exception '%', p_missing; end if;
  update approvals set used_at = now()
   where token_hash = _hash(p_token) and action = p_action and order_id = p_order and requested_by = v_me
     and used_at is null and expires_at > now()
     and (p_amount is null or (detail ->> 'amount')::numeric >= p_amount)
     and (p_line is null or (detail ->> 'line')::uuid = p_line)
  returning * into v_a;
  if not found then raise exception 'Mã duyệt của quản lý không hợp lệ, đã dùng hoặc đã hết hạn: nhập PIN lại'; end if;
  if not exists (select 1 from staff where id = v_a.manager_id and active and role::text in ('manager', 'owner')) then
    raise exception 'Người duyệt không còn là quản lý';
  end if;
  return v_a.manager_id;
end $$;

-- ---------------------------------------------------------------- pay_order with approval

drop function pay_order(uuid, int, jsonb, text, text);

create function pay_order(p_order uuid, p_discount int, p_payments jsonb, p_discount_reason text default null,
                          p_register text default 'Quầy 1', p_approval text default null)
returns bills language plpgsql security definer set search_path = public as $$
declare
  v_staff uuid := my_staff_id();
  v_order orders;
  v_shift shifts;
  v_calc jsonb;
  v_total int;
  v_paid numeric;
  v_noncash numeric;
  v_bill bills;
  v_reason text := btrim(coalesce(p_discount_reason, ''));
  v_by uuid;
  p jsonb;
begin
  if v_staff is null or my_role() not in ('cashier', 'manager') then raise exception 'Chỉ thu ngân hoặc quản lý được thanh toán'; end if;
  select * into v_order from orders where id = p_order for update;
  if not found or v_order.status <> 'open' then raise exception 'Đơn không còn mở'; end if;
  if v_order.paying_at is not null and v_order.paying_by is distinct from v_staff then raise exception 'Đơn đang thanh toán ở máy khác'; end if;
  -- share lock: payments run side by side, close_shift waits for them
  select * into v_shift from shifts where register = p_register and closed_at is null for share;
  if not found then raise exception 'Chưa mở ca thu ngân: mở ca trước khi thu tiền'; end if;
  if not exists (select 1 from order_items where order_id = p_order and status <> 'void') then raise exception 'Đơn chưa có món'; end if;
  if coalesce(p_discount, 0) > 0 then
    if v_reason = '' then raise exception 'Chọn lý do giảm giá'; end if;
    v_by := _approver(p_approval, 'discount', p_order, 'Giảm giá hoá đơn cần quản lý nhập mã PIN', p_discount);
  end if;

  if p_payments is null or jsonb_typeof(p_payments) <> 'array' then raise exception 'Danh sách thanh toán không hợp lệ'; end if;
  for p in select value from jsonb_array_elements(p_payments) loop
    if coalesce(p ->> 'method', '') not in ('cash', 'bank', 'card') then raise exception 'Cách trả không hợp lệ'; end if;
    if jsonb_typeof(p -> 'amount') is distinct from 'number' or (p ->> 'amount')::numeric <= 0
       or (p ->> 'amount')::numeric <> trunc((p ->> 'amount')::numeric) then
      raise exception 'Số tiền mỗi khoản phải là số đồng dương';
    end if;
    if jsonb_typeof(p -> 'tendered') = 'number'
       and (p ->> 'method' <> 'cash' or (p ->> 'tendered')::numeric < (p ->> 'amount')::numeric
            or (p ->> 'tendered')::numeric <> trunc((p ->> 'tendered')::numeric)) then
      raise exception 'Tiền khách đưa chỉ ghi cho tiền mặt và không nhỏ hơn số thu';
    end if;
  end loop;

  v_calc := calc_bill(p_order, coalesce(p_discount, 0));
  v_total := (v_calc ->> 'total')::int;
  select coalesce(sum((value ->> 'amount')::numeric), 0), coalesce(sum((value ->> 'amount')::numeric) filter (where value ->> 'method' <> 'cash'), 0)
  into v_paid, v_noncash from jsonb_array_elements(p_payments);
  if v_noncash > v_total then raise exception 'Chuyển khoản và thẻ không được vượt số phải thu'; end if;
  if v_paid <> v_total then raise exception 'Tổng thanh toán % khác số phải trả %', v_paid, v_total; end if;

  insert into bills (order_id, subtotal, discount, service_charge, vat_added, vat_total, rounding, total, vat_lines,
                     table_label, cashier_id, shift_id, discount_reason)
  values (p_order, (v_calc ->> 'subtotal')::int, coalesce(p_discount, 0), (v_calc ->> 'service_charge')::int,
          (v_calc ->> 'vat_added')::int, (v_calc ->> 'vat_total')::int, (v_calc ->> 'rounding')::int, v_total,
          v_calc -> 'vat', coalesce(order_group_label(p_order), order_label(p_order), ''), v_staff, v_shift.id,
          case when coalesce(p_discount, 0) > 0 then left(v_reason, 60) else '' end)
  returning * into v_bill;
  insert into payments (bill_id, method, amount, tendered, ref, shift_id, received_by)
  select v_bill.id, (value ->> 'method')::pay_method, (value ->> 'amount')::int,
         case when value ->> 'method' = 'cash' and jsonb_typeof(value -> 'tendered') = 'number'
                   and (value ->> 'tendered')::int > (value ->> 'amount')::int then (value ->> 'tendered')::int end,
         left(coalesce(value ->> 'ref', ''), 40), v_shift.id, v_staff
  from jsonb_array_elements(p_payments) with ordinality;

  update orders set status = 'paid', closed_at = now(), paying_at = null, paying_by = null where id = p_order;
  if coalesce(p_discount, 0) > 0 then
    perform _audit('discount', jsonb_build_object('bill', v_bill.bill_no, 'amount', p_discount, 'reason', v_bill.discount_reason), v_staff, v_by);
  end if;
  return v_bill;
end $$;

-- ---------------------------------------------------------------- huỷ món / huỷ đơn with approval

-- Internal: void p_qty of a line (split off when partial), tell the kitchen while it still has the dish to make.
create function _void_line(p_line order_items, p_qty int, p_reason text, p_staff uuid, p_approved_by uuid)
returns order_items language plpgsql security definer set search_path = public as $$
declare
  v_id uuid;
  v_out order_items;
begin
  if p_qty < p_line.qty then
    update order_items set qty = qty - p_qty where id = p_line.id;
    v_id := gen_random_uuid();
    insert into order_items
    select (jsonb_populate_record(null::order_items, to_jsonb(p_line) || jsonb_build_object('id', v_id, 'qty', p_qty))).*;
    insert into order_item_modifiers
    select (jsonb_populate_record(null::order_item_modifiers,
              to_jsonb(mo) || jsonb_build_object('id', gen_random_uuid(), 'order_item_id', v_id))).*
    from order_item_modifiers mo where mo.order_item_id = p_line.id;
  else
    v_id := p_line.id;
  end if;
  update order_items set status = 'void', void_reason = p_reason, voided_at = now(), voided_by = p_staff, void_stage = p_line.status
  where id = v_id returning * into v_out;

  if p_line.status in ('new', 'cooking') then
    insert into kitchen_notices (kind, order_id, order_item_id, station_id, send_batch, text, created_by)
    values ('void', p_line.order_id, v_id, p_line.station_id, p_line.send_batch,
            format('HUỶ %s %s%s – %s', p_qty, upper(p_line.name),
                   case when p_qty < p_line.qty then format(' (bớt %s, còn %s)', p_qty, p_line.qty - p_qty) else '' end, p_reason),
            p_staff);
  end if;
  perform _audit('void_item', jsonb_build_object('line', v_id, 'order', p_line.order_id, 'name', p_line.name, 'qty', p_qty,
                                                 'amount', p_line.price * p_qty, 'reason', p_reason, 'stage', p_line.status),
                 p_staff, p_approved_by);
  return v_out;
end $$;
revoke execute on function _void_line(order_items, int, text, uuid, uuid) from public, anon, authenticated;

create function _void_reason(p_reason text, p_note text) returns text
language plpgsql immutable as $$
declare
  v_note text := btrim(coalesce(p_note, ''));
begin
  if p_reason is null or p_reason not in ('Khách đổi ý', 'Gọi nhầm', 'Hết món', 'Ra quá lâu', 'Món lỗi', 'Khác') then raise exception 'Chọn lý do huỷ'; end if;
  if p_reason = 'Khác' and v_note = '' then raise exception 'Lý do "Khác": ghi rõ lý do'; end if;
  return case when p_reason = 'Khác' then left(v_note, 60) when v_note <> '' then p_reason || ': ' || left(v_note, 60) else p_reason end;
end $$;

-- Does voiding this line need a manager? (shop_settings.void_approval)
create function void_needs_approval(p_status item_status) returns boolean
language sql stable security definer set search_path = public as $$
  select p_status in ('cooking', 'ready', 'served') or (p_status = 'new' and (select void_approval from shop_settings) = 'sent')
$$;

drop function void_item(uuid, int, text, text);

-- Huỷ / bớt a sent line, with a reason; a manager approves (PIN token) unless the caller is one.
create function void_item(p_line uuid, p_qty int, p_reason text, p_note text default null, p_approval text default null)
returns order_items language plpgsql security definer set search_path = public as $$
declare
  v_staff uuid := require_floor_staff();
  v_line order_items;
  v_order orders;
  v_reason text;
  v_by uuid;
begin
  select * into v_line from order_items where id = p_line for update;
  if not found then raise exception 'Không tìm thấy món'; end if;
  select * into v_order from orders where id = v_line.order_id for update;
  if v_order.status <> 'open' then raise exception 'Đơn không còn mở'; end if;
  if v_line.status = 'void' then raise exception 'Món đã huỷ'; end if;
  v_reason := _void_reason(p_reason, p_note);
  if p_qty is null or p_qty < 1 or p_qty > v_line.qty then raise exception 'Số lượng huỷ không hợp lệ'; end if;
  if v_order.bill_requested_at is not null and my_role() = 'waiter' then raise exception 'Đơn đã in tạm tính: huỷ món cần thu ngân hoặc quản lý'; end if;
  if void_needs_approval(v_line.status) then
    v_by := _approver(p_approval, 'void_item', v_order.id,
                      case when v_line.status = 'new' then 'Huỷ món đã gửi bếp: cần quản lý nhập mã PIN' else 'Món bếp đã làm: cần quản lý nhập mã PIN' end,
                      null, v_line.id);
  end if;
  return _void_line(v_line, p_qty, v_reason, v_staff, v_by);
end $$;

-- Huỷ cả đơn after Gửi bếp: every live line with one reason (and one approval), then the order is closed as void.
create function void_order(p_order uuid, p_reason text, p_note text default null, p_approval text default null)
returns orders language plpgsql security definer set search_path = public as $$
declare
  v_staff uuid := require_floor_staff();
  v_order orders;
  v_reason text;
  v_by uuid;
  v_line order_items;
  v_n int := 0;
  v_amount bigint := 0;
begin
  select * into v_order from orders where id = p_order for update;
  if not found or v_order.status <> 'open' then raise exception 'Đơn không còn mở'; end if;
  if v_order.paying_at is not null and v_order.paying_by is distinct from v_staff then raise exception 'Đơn đang thanh toán: chưa sửa được'; end if;
  v_reason := _void_reason(p_reason, p_note);
  if v_order.bill_requested_at is not null and my_role() = 'waiter' then raise exception 'Đơn đã in tạm tính: huỷ đơn cần thu ngân hoặc quản lý'; end if;
  if exists (select 1 from order_items where order_id = p_order and status <> 'void' and void_needs_approval(status)) then
    v_by := _approver(p_approval, 'void_order', p_order, 'Huỷ đơn đã gửi bếp: cần quản lý nhập mã PIN');
  end if;
  for v_line in select * from order_items where order_id = p_order and status <> 'void' order by sent_at, id for update loop
    perform _void_line(v_line, v_line.qty, v_reason, v_staff, v_by);
    v_n := v_n + 1;
    v_amount := v_amount + v_line.price * v_line.qty;
  end loop;
  update orders set status = 'void', closed_at = now(), paying_at = null, paying_by = null where id = p_order returning * into v_order;
  perform _audit('void_order', jsonb_build_object('order', p_order, 'lines', v_n, 'amount', v_amount, 'reason', v_reason), v_staff, v_by);
  return v_order;
end $$;

-- ---------------------------------------------------------------- staff management

-- Managers manage waiters, kitchen and cashiers (and their own PIN); owners manage everyone.
create function _may_manage(p_target_role text, p_target uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(case my_real_role()
    when 'owner' then true
    when 'manager' then p_target_role in ('waiter', 'kitchen', 'cashier') or p_target is not distinct from my_staff_id() and p_target is not null
    else false end, false)
$$;

-- For the staff screen (managers): who has a PIN, who is locked out, who is signed in where.
create function staff_admin_list()
returns table (id uuid, name text, role text, active boolean, has_pin boolean, pin_set_at timestamptz, locked_until timestamptz,
               signed_in_on text, last_seen_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
begin
  if my_role() is distinct from 'manager' then raise exception 'Chỉ quản lý hoặc chủ quán xem được danh sách này'; end if;
  return query
    select s.id, s.name, s.role::text, s.active, sec.staff_id is not null, sec.pin_set_at,
           case when sec.locked_until > now() then sec.locked_until end,
           (select d.name from staff_sessions ss join devices d on d.id = ss.device_id
             where ss.staff_id = s.id and ss.ended_at is null and (ss.expires_at is null or ss.expires_at > now())
             order by ss.started_at desc limit 1),
           (select max(ss.last_seen_at) from staff_sessions ss where ss.staff_id = s.id)
      from staff s left join staff_secrets sec on sec.staff_id = s.id
     order by s.active desc, array_position(array['owner', 'manager', 'cashier', 'waiter', 'kitchen'], s.role::text), s.name;
end $$;

-- Add (p_id null, PIN required) or edit a staff member; a PIN given on edit replaces the old one.
create function staff_save(p_id uuid, p_name text, p_role text, p_pin text default null) returns staff
language plpgsql security definer set search_path = public as $$
declare
  v_old staff;
  v staff;
  v_name text := btrim(coalesce(p_name, ''));
begin
  if my_role() is distinct from 'manager' then raise exception 'Chỉ quản lý hoặc chủ quán được sửa nhân viên'; end if;
  if char_length(v_name) not between 1 and 40 then raise exception 'Nhập tên nhân viên (tối đa 40 ký tự)'; end if;
  if p_role is null or p_role not in ('waiter', 'kitchen', 'cashier', 'manager', 'owner') then raise exception 'Vai trò không hợp lệ'; end if;
  if exists (select 1 from staff where lower(name) = lower(v_name) and active and id is distinct from p_id) then
    raise exception 'Đã có nhân viên tên "%": thêm họ hoặc số để phân biệt', v_name;
  end if;
  if p_id is null then
    if not _may_manage(p_role, null) then raise exception 'Chỉ chủ quán được thêm quản lý hoặc chủ quán'; end if;
    if p_pin is null then raise exception 'Đặt mã PIN cho nhân viên mới'; end if;
    insert into staff (name, role) values (v_name, p_role::staff_role) returning * into v;
    perform _set_pin(v.id, p_pin);
    perform _audit('staff_add', jsonb_build_object('staff', v.id, 'name', v.name, 'role', p_role));
    return v;
  end if;
  select * into v_old from staff where id = p_id for update;
  if not found then raise exception 'Không tìm thấy nhân viên'; end if;
  if not _may_manage(v_old.role::text, v_old.id) or (p_role <> v_old.role::text and not _may_manage(p_role, null)) then
    raise exception 'Chỉ chủ quán được sửa quản lý hoặc chủ quán';
  end if;
  if v_old.id = my_staff_id() and p_role <> v_old.role::text then raise exception 'Không tự đổi vai trò của mình'; end if;
  update staff set name = v_name, role = p_role::staff_role, updated_at = now() where id = p_id returning * into v;
  if p_pin is not null then
    perform _set_pin(v.id, p_pin);
    update staff_sessions set ended_at = now(), end_reason = 'pin_reset' where staff_id = v.id and ended_at is null and token_hash is distinct from session_token_hash();
  end if;
  perform _audit('staff_edit', jsonb_build_object('staff', v.id, 'name', v.name, 'role', p_role,
                                                  'was', jsonb_build_object('name', v_old.name, 'role', v_old.role::text), 'pin_reset', p_pin is not null));
  return v;
end $$;

create function staff_reset_pin(p_staff uuid, p_pin text) returns void
language plpgsql security definer set search_path = public as $$
declare
  v staff;
begin
  if my_role() is distinct from 'manager' then raise exception 'Chỉ quản lý hoặc chủ quán được đặt lại PIN'; end if;
  select * into v from staff where id = p_staff;
  if not found then raise exception 'Không tìm thấy nhân viên'; end if;
  if not _may_manage(v.role::text, v.id) then raise exception 'Chỉ chủ quán được đặt lại PIN của quản lý hoặc chủ quán'; end if;
  perform _set_pin(v.id, p_pin);
  update staff_sessions set ended_at = now(), end_reason = 'pin_reset' where staff_id = v.id and ended_at is null and token_hash is distinct from session_token_hash();
  perform _audit('pin_reset', jsonb_build_object('staff', v.id, 'name', v.name));
end $$;

-- Ngừng làm / làm lại. Disabling signs the person out everywhere. Nobody disables themselves or the last owner.
create function staff_set_active(p_staff uuid, p_active boolean) returns staff
language plpgsql security definer set search_path = public as $$
declare
  v staff;
begin
  if my_role() is distinct from 'manager' then raise exception 'Chỉ quản lý hoặc chủ quán được khoá nhân viên'; end if;
  select * into v from staff where id = p_staff for update;
  if not found then raise exception 'Không tìm thấy nhân viên'; end if;
  if not _may_manage(v.role::text, v.id) then raise exception 'Chỉ chủ quán được khoá quản lý hoặc chủ quán'; end if;
  if v.id = my_staff_id() and not p_active then raise exception 'Không tự khoá tài khoản của mình'; end if;
  if not p_active and v.role::text = 'owner' and not exists (select 1 from staff where role::text = 'owner' and active and id <> v.id) then
    raise exception 'Phải còn ít nhất một chủ quán';
  end if;
  update staff set active = p_active, updated_at = now() where id = p_staff returning * into v;
  if not p_active then
    update staff_sessions set ended_at = now(), end_reason = 'disabled' where staff_id = p_staff and ended_at is null;
  end if;
  perform _audit(case when p_active then 'staff_on' else 'staff_off' end, jsonb_build_object('staff', v.id, 'name', v.name));
  return v;
end $$;

-- ---------------------------------------------------------------- row level security

-- Reads: every signed-in role, also through the device's current session (Realtime).
do $$
declare
  r record;
begin
  for r in select tablename from pg_policies where schemaname = 'public' and policyname = 'read_all' and qual = '(my_role() IS NOT NULL)' loop
    execute format('alter policy read_all on %I using (reader_role() is not null)', r.tablename);
  end loop;
end $$;

-- Money: bills, payments and shifts for cashiers and managers only (waiters and the kitchen see none).
drop policy read_all on bills;
drop policy read_all on payments;
drop policy read_all on shifts;
create policy read_money on bills for select using (reader_role() in ('cashier', 'manager'));
create policy read_money on payments for select using (reader_role() in ('cashier', 'manager'));
create policy read_money on shifts for select using (reader_role() in ('cashier', 'manager'));

-- Staff rows change only through staff_save / staff_set_active (owner rules); everyone signed in reads names.
drop policy manage on staff;
revoke insert, update, delete on staff from anon, authenticated;

-- Nothing deletes orders, lines, bills, payments or the audit trail through the API.
revoke delete on orders, order_items, bills, payments, audit_log, shifts from anon, authenticated;
revoke insert, update on audit_log, bills, payments from anon, authenticated;

alter table staff_secrets enable row level security;
alter table devices enable row level security;
alter table device_codes enable row level security;
alter table staff_sessions enable row level security;
alter table approvals enable row level security;
revoke all on staff_secrets, device_codes from anon, authenticated;
revoke all on devices, staff_sessions, approvals from anon, authenticated;
grant select on devices, staff_sessions, approvals to authenticated;
create policy read_mgr on devices for select using (my_role() = 'manager');
create policy read_mgr on staff_sessions for select using (my_role() = 'manager');
create policy read_mgr on approvals for select using (my_role() = 'manager');
-- staff_sessions.token_hash is a hash of a secret: managers see sessions, not hashes
revoke select on staff_sessions from authenticated;
grant select (id, device_id, staff_id, started_at, last_seen_at, expires_at, ended_at, end_reason) on staff_sessions to authenticated;
revoke select on approvals from authenticated;
grant select (id, action, order_id, detail, manager_id, requested_by, device_id, created_at, expires_at, used_at) on approvals to authenticated;

-- Functions: internal ones closed; SQL-editor-only ones closed to the API; the rest for signed-in users only.
revoke execute on function _token(), _hash(text), _audit(text, jsonb, uuid, uuid), _set_pin(uuid, text), _check_pin(uuid, text, text),
  _new_device_code(text, text, uuid), _approver(text, text, uuid, text, int, uuid), _may_manage(text, uuid),
  admin_create_device_code(text, text), admin_add_staff(text, text, text) from public, anon, authenticated;
revoke execute on function register_device(text), my_device(), signin_roster(), staff_sign_in(uuid, text), touch_session(), staff_sign_out(),
  verify_manager_pin(uuid, text, text, uuid, jsonb), create_device_code(text, text), device_set_active(uuid, boolean),
  staff_admin_list(), staff_save(uuid, text, text, text), staff_reset_pin(uuid, text), staff_set_active(uuid, boolean),
  pay_order(uuid, int, jsonb, text, text, text), void_item(uuid, int, text, text, text), void_order(uuid, text, text, text)
  from public, anon;
grant execute on function register_device(text), my_device(), signin_roster(), staff_sign_in(uuid, text), touch_session(), staff_sign_out(),
  verify_manager_pin(uuid, text, text, uuid, jsonb), create_device_code(text, text), device_set_active(uuid, boolean),
  staff_admin_list(), staff_save(uuid, text, text, text), staff_reset_pin(uuid, text), staff_set_active(uuid, boolean),
  pay_order(uuid, int, jsonb, text, text, text), void_item(uuid, int, text, text, text), void_order(uuid, text, text, text)
  to authenticated;

alter publication supabase_realtime add table staff, devices;
