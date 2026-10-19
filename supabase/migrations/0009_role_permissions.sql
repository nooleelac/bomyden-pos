-- Bò Mỹ Đen POS 0009: quyền theo vai trò, do chủ quán đặt (Nhân viên → Phân quyền), on top of 0001–0008.
-- Same catalog and defaults as src/auth/permissions.ts, and the same checks as src/floor/engine.ts and
-- src/auth/memoryRepo.ts (the sample engines); keep them in step.
--
-- Before: what each role could do was fixed in code (my_role() in ('cashier', 'manager') …).
-- After:
--   * `permissions` lists what can be allowed (id + Vietnamese label); `role_permissions` says which roles have it.
--   * The owner always has every permission and is the only one who changes role_permissions
--     (set_role_permissions) or manages managers and owners. Everyone else gets exactly what their role has.
--   * has_perm(p) checks the caller (session token / personal login), reader_can(p) the device's current session
--     too (read policies and Realtime), role_can(role, p) anyone (sign-in roster, approvers).
--   * Approvals: whoever may do a thing themselves also approves it for others with their PIN
--     (discount -> pay.discount, void_item / void_order -> order.void_sent).
--   * Every function and policy that compared roles now checks a permission; the seeded defaults reproduce the
--     0001–0008 rules exactly, so nothing changes for a shop until the owner edits the table.
--   * Refusals read "Chưa có quyền: <label>" so staff know what to ask the owner for.

-- ---------------------------------------------------------------- catalog and table

create table permissions (
  id text primary key,
  label text not null,
  sort int not null
);
insert into permissions (id, label, sort) values
  ('order.take', 'Mở bàn, gọi món, gửi bếp', 1),
  ('order.move_done', 'Chuyển món đã xong hoặc đã ra', 2),
  ('order.split', 'Tách đơn, tách bàn khỏi nhóm', 3),
  ('order.void_after_bill', 'Huỷ món sau khi in tạm tính', 4),
  ('order.void_sent', 'Huỷ món đã gửi bếp không cần duyệt', 5),
  ('pay.collect', 'Thu tiền, in hoá đơn', 6),
  ('pay.discount', 'Giảm giá không cần duyệt', 7),
  ('shift.manage', 'Mở ca, chốt ca', 8),
  ('kitchen.work', 'Màn hình bếp', 9),
  ('kitchen.override', 'Lùi trạng thái quá 2 phút, gọi lại phiếu quá 30 phút', 10),
  ('menu.soldout', 'Báo hết món / có lại', 11),
  ('menu.edit', 'Sửa thực đơn', 12),
  ('tables.temp', 'Thêm bàn tạm', 13),
  ('tables.edit', 'Sửa khu vực và bàn', 14),
  ('staff.manage', 'Quản lý nhân viên', 15),
  ('devices.manage', 'Thêm và khoá máy', 16),
  ('audit.view', 'Xem nhật ký', 17),
  ('settings.edit', 'Cài đặt đăng nhập và quán', 18);

-- Owner rows are never stored: the owner has everything.
create table role_permissions (
  role text not null check (role in ('waiter', 'cashier', 'kitchen', 'manager')),
  perm text not null references permissions on delete cascade,
  primary key (role, perm)
);
insert into role_permissions (role, perm) values
  ('waiter', 'order.take'),
  ('cashier', 'order.take'), ('cashier', 'order.move_done'), ('cashier', 'order.split'), ('cashier', 'order.void_after_bill'),
  ('cashier', 'pay.collect'), ('cashier', 'shift.manage'), ('cashier', 'menu.soldout'), ('cashier', 'tables.temp'),
  ('kitchen', 'kitchen.work'), ('kitchen', 'menu.soldout');
insert into role_permissions (role, perm) select 'manager', id from permissions;

-- ---------------------------------------------------------------- checks

create function role_can(p_role text, p_perm text) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(p_role = 'owner' or exists (select 1 from role_permissions where role = p_role and perm = p_perm), false)
$$;

-- The caller (session token or personal login).
create function has_perm(p_perm text) returns boolean
language sql stable security definer set search_path = public as $$
  select role_can(my_real_role(), p_perm)
$$;

-- For read policies and Realtime (no headers): the caller, else the device's current session.
create function reader_real_role() returns text
language sql stable security definer set search_path = public as $$
  select coalesce(my_real_role(), (
    select st.role::text
      from devices d
      join staff_sessions s on s.device_id = d.id and s.ended_at is null and (s.expires_at is null or s.expires_at > now())
      join staff st on st.id = s.staff_id and st.active
     where d.user_id = auth.uid() and d.active
     order by s.started_at desc limit 1))
$$;

create function reader_can(p_perm text) returns boolean
language sql stable security definer set search_path = public as $$
  select role_can(reader_real_role(), p_perm)
$$;

-- Raise "Chưa có quyền: …" unless the caller has the permission.
create function _need(p_perm text) returns void
language plpgsql stable security definer set search_path = public as $$
begin
  if my_staff_id() is null then raise exception 'Đăng nhập trước khi làm việc này'; end if;
  if not has_perm(p_perm) then
    raise exception 'Chưa có quyền: %', coalesce((select label from permissions where id = p_perm), p_perm);
  end if;
end $$;

-- Which permission approves an approval action (and lets its holder skip the approval).
create function _approval_perm(p_action text) returns text
language sql immutable set search_path = public as $$
  select case p_action when 'discount' then 'pay.discount' when 'void_item' then 'order.void_sent' when 'void_order' then 'order.void_sent' end
$$;

-- ---------------------------------------------------------------- the owner edits the table

-- Replace one role's permissions. Owner only; the owner role itself is not editable.
create function set_role_permissions(p_role text, p_perms text[]) returns text[]
language plpgsql security definer set search_path = public as $$
declare
  v_old text[];
  v_new text[];
  v_bad text;
begin
  if my_real_role() is distinct from 'owner' then raise exception 'Chỉ chủ quán được phân quyền'; end if;
  if p_role is null or p_role not in ('waiter', 'cashier', 'kitchen', 'manager') then raise exception 'Vai trò không hợp lệ'; end if;
  select x into v_bad from unnest(coalesce(p_perms, '{}')) x where not exists (select 1 from permissions where id = x) limit 1;
  if v_bad is not null then raise exception 'Quyền không hợp lệ: %', v_bad; end if;
  select coalesce(array_agg(perm order by perm), '{}') into v_old from role_permissions where role = p_role;
  delete from role_permissions where role = p_role;
  insert into role_permissions (role, perm) select distinct p_role, x from unnest(coalesce(p_perms, '{}')) x;
  select coalesce(array_agg(perm order by perm), '{}') into v_new from role_permissions where role = p_role;
  if v_new is distinct from v_old then
    perform _audit('permissions', jsonb_build_object('role', p_role,
      'added', (select coalesce(jsonb_agg(x), '[]') from unnest(v_new) x where x <> all (v_old)),
      'removed', (select coalesce(jsonb_agg(x), '[]') from unnest(v_old) x where x <> all (v_new))));
  end if;
  return v_new;
end $$;

-- ---------------------------------------------------------------- functions: roles -> permissions

create or replace function require_floor_staff() returns uuid
language plpgsql stable security definer set search_path = public as $$
begin
  perform _need('order.take');
  return my_staff_id();
end $$;

create or replace function require_kitchen_or_manager() returns uuid
language plpgsql stable security definer set search_path = public as $$
begin
  perform _need('kitchen.work');
  return my_staff_id();
end $$;

create or replace function send_order_lines(p_order uuid, p_lines jsonb, p_batch uuid default null, p_rush_reason text default null)
returns setof order_items language plpgsql security definer set search_path = public as $$
begin
  perform _need('order.take');
  return query select * from _send_lines(p_order, p_lines, p_batch, my_staff_id(), p_rush_reason, true);
end $$;

-- Managers-or-owner rules for staff become: the owner manages everyone; anyone with staff.manage manages waiters,
-- kitchen and cashiers (and their own PIN).
create or replace function _may_manage(p_target_role text, p_target uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(my_real_role() = 'owner'
    or has_perm('staff.manage') and (p_target_role in ('waiter', 'kitchen', 'cashier') or p_target is not distinct from my_staff_id() and p_target is not null), false)
$$;

-- Exact-text edits of the latest bodies (the same way 0006 moved callers to my_staff_id()). Each edit must match.
-- Bodies pasted from Windows files carry CRLF line ends: compare (and rewrite) them with plain LF.
create function pg_temp.patch(p_fn text, p_old text, p_new text) returns void
language plpgsql as $$
declare
  r record;
  v_def text;
  v_n int := 0;
begin
  for r in select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = p_fn loop
    v_def := replace(pg_get_functiondef(r.oid), E'\r\n', E'\n');
    if position(p_old in v_def) > 0 then
      execute replace(v_def, p_old, p_new);
      v_n := v_n + 1;
    end if;
  end loop;
  if v_n = 0 then raise exception '0009: % does not contain: %', p_fn, p_old; end if;
end $$;

select pg_temp.patch('merge_orders',
  $x$(select id from staff where id = my_staff_id() and active and role::text in ('waiter', 'cashier', 'manager', 'owner'))$x$,
  $x$(case when has_perm('order.take') then my_staff_id() end)$x$);
select pg_temp.patch('merge_orders', $x$raise exception 'Không có quyền gộp bàn'$x$, $x$perform _need('order.take')$x$);

select pg_temp.patch('move_items', $x$if v_role is null or v_role = 'kitchen' then raise exception 'Không có quyền chuyển món'; end if;$x$, $x$perform _need('order.take');$x$);
select pg_temp.patch('move_items',
  $x$if v_line.status in ('ready', 'served') and v_role = 'waiter' then
      raise exception 'Chuyển món đã xong hoặc đã ra cần thu ngân hoặc quản lý';$x$,
  $x$if v_line.status in ('ready', 'served') and not has_perm('order.move_done') then
      raise exception 'Chưa có quyền: Chuyển món đã xong hoặc đã ra';$x$);

select pg_temp.patch('split_order',
  $x$if not coalesce(my_role() in ('cashier', 'manager'), false) then raise exception 'Chỉ thu ngân hoặc quản lý được tách đơn'; end if;$x$,
  $x$perform _need('order.split');$x$);
select pg_temp.patch('split_table_from_group',
  $x$if my_role() not in ('cashier', 'manager') then raise exception 'Chỉ thu ngân hoặc quản lý được tách bàn khỏi nhóm'; end if;$x$,
  $x$perform _need('order.split');$x$);

select pg_temp.patch('set_sold_out',
  $x$if not coalesce(my_role() in ('kitchen', 'cashier', 'manager'), false) then
    raise exception 'Chỉ bếp, thu ngân hoặc quản lý được báo hết món';
  end if;$x$,
  $x$perform _need('menu.soldout');$x$);

select pg_temp.patch('set_item_status', $x$if v_role = 'kitchen' then raise exception 'Tài khoản bếp không bấm Đã bưng'; end if;$x$,
  $x$perform _need('order.take');$x$);
select pg_temp.patch('set_item_status',
  $x$if v_role not in ('kitchen', 'manager') then raise exception 'Chỉ máy bếp, bar hoặc quản lý được đổi trạng thái này'; end if;$x$,
  $x$perform _need('kitchen.work');$x$);
select pg_temp.patch('set_item_status', $x$if v_back and v_role <> 'manager'$x$, $x$if v_back and not has_perm('kitchen.override')$x$);
select pg_temp.patch('set_item_status', $x$'Quá 2 phút: chỉ quản lý lùi được trạng thái'$x$, $x$'Quá 2 phút: cần quyền lùi trạng thái'$x$);

select pg_temp.patch('recall_ticket',
  $x$and my_role() <> 'manager' then raise exception 'Phiếu xong quá 30 phút: cần quản lý gọi lại'$x$,
  $x$and not has_perm('kitchen.override') then raise exception 'Phiếu xong quá 30 phút: cần quyền gọi lại phiếu cũ'$x$);

select pg_temp.patch('begin_payment',
  $x$if my_role() not in ('cashier', 'manager') then raise exception 'Chỉ thu ngân hoặc quản lý được thanh toán'; end if;$x$,
  $x$perform _need('pay.collect');$x$);
select pg_temp.patch('cancel_payment',
  $x$if my_role() not in ('cashier', 'manager') then raise exception 'Chỉ thu ngân hoặc quản lý được thanh toán'; end if;$x$,
  $x$perform _need('pay.collect');$x$);
select pg_temp.patch('pay_order',
  $x$if v_staff is null or my_role() not in ('cashier', 'manager') then raise exception 'Chỉ thu ngân hoặc quản lý được thanh toán'; end if;$x$,
  $x$perform _need('pay.collect');$x$);
select pg_temp.patch('print_bill',
  $x$if my_role() is null or my_role() not in ('cashier', 'manager') then raise exception 'Chỉ thu ngân hoặc quản lý được in hoá đơn'; end if;$x$,
  $x$perform _need('pay.collect');$x$);
select pg_temp.patch('open_shift',
  $x$if my_role() is null or my_role() not in ('cashier', 'manager') then raise exception 'Chỉ thu ngân hoặc quản lý được mở ca'; end if;$x$,
  $x$perform _need('shift.manage');$x$);
select pg_temp.patch('close_shift',
  $x$if my_role() is null or my_role() not in ('cashier', 'manager') then raise exception 'Chỉ thu ngân hoặc quản lý được chốt ca'; end if;$x$,
  $x$perform _need('shift.manage');$x$);
select pg_temp.patch('shift_summary', $x$reader_role() in ('cashier', 'manager')$x$, $x$(reader_can('pay.collect') or reader_can('shift.manage'))$x$);

select pg_temp.patch('void_item',
  $x$if v_order.bill_requested_at is not null and my_role() = 'waiter' then raise exception 'Đơn đã in tạm tính: huỷ món cần thu ngân hoặc quản lý'; end if;$x$,
  $x$if v_order.bill_requested_at is not null and not has_perm('order.void_after_bill') then raise exception 'Đơn đã in tạm tính: chưa có quyền huỷ món sau tạm tính'; end if;$x$);
select pg_temp.patch('void_order',
  $x$if v_order.bill_requested_at is not null and my_role() = 'waiter' then raise exception 'Đơn đã in tạm tính: huỷ đơn cần thu ngân hoặc quản lý'; end if;$x$,
  $x$if v_order.bill_requested_at is not null and not has_perm('order.void_after_bill') then raise exception 'Đơn đã in tạm tính: chưa có quyền huỷ món sau tạm tính'; end if;$x$);

select pg_temp.patch('verify_manager_pin',
  $x$select * into v_m from staff where id = p_manager and active and role::text in ('manager', 'owner');
  if not found then return jsonb_build_object('ok', false, 'error', 'Chỉ quản lý hoặc chủ quán duyệt được'); end if;$x$,
  $x$select * into v_m from staff where id = p_manager and active and role_can(role::text, _approval_perm(p_action));
  if not found then return jsonb_build_object('ok', false, 'error', 'Người này chưa có quyền duyệt việc này'); end if;$x$);
select pg_temp.patch('_approver', $x$if my_role() = 'manager' then return v_me; end if;$x$, $x$if has_perm(_approval_perm(p_action)) then return v_me; end if;$x$);
select pg_temp.patch('_approver',
  $x$if not exists (select 1 from staff where id = v_a.manager_id and active and role::text in ('manager', 'owner')) then
    raise exception 'Người duyệt không còn là quản lý';$x$,
  $x$if not exists (select 1 from staff where id = v_a.manager_id and active and role_can(role::text, _approval_perm(p_action))) then
    raise exception 'Người duyệt không còn quyền duyệt việc này';$x$);

select pg_temp.patch('signin_roster', $x$(v_d.kind = 'pos' or s.role::text in ('kitchen', 'manager', 'owner'))$x$, $x$(v_d.kind = 'pos' or role_can(s.role::text, 'kitchen.work'))$x$);
select pg_temp.patch('staff_sign_in',
  $x$if v_d.kind = 'kitchen' and v_s.role::text not in ('kitchen', 'manager', 'owner') then
    return jsonb_build_object('ok', false, 'error', 'Máy bếp chỉ đăng nhập tài khoản bếp hoặc quản lý');$x$,
  $x$if v_d.kind = 'kitchen' and not role_can(v_s.role::text, 'kitchen.work') then
    return jsonb_build_object('ok', false, 'error', 'Máy bếp chỉ đăng nhập người có quyền Màn hình bếp');$x$);

select pg_temp.patch('create_device_code', $x$if my_role() is distinct from 'manager' then raise exception 'Chỉ quản lý hoặc chủ quán được thêm máy'; end if;$x$, $x$perform _need('devices.manage');$x$);
select pg_temp.patch('device_set_active', $x$if my_role() is distinct from 'manager' then raise exception 'Chỉ quản lý hoặc chủ quán được khoá máy'; end if;$x$, $x$perform _need('devices.manage');$x$);
select pg_temp.patch('staff_admin_list', $x$if my_role() is distinct from 'manager' then raise exception 'Chỉ quản lý hoặc chủ quán xem được danh sách này'; end if;$x$, $x$perform _need('staff.manage');$x$);
select pg_temp.patch('staff_save', $x$if my_role() is distinct from 'manager' then raise exception 'Chỉ quản lý hoặc chủ quán được sửa nhân viên'; end if;$x$, $x$perform _need('staff.manage');$x$);
select pg_temp.patch('staff_reset_pin', $x$if my_role() is distinct from 'manager' then raise exception 'Chỉ quản lý hoặc chủ quán được đặt lại PIN'; end if;$x$, $x$perform _need('staff.manage');$x$);
select pg_temp.patch('staff_set_active', $x$if my_role() is distinct from 'manager' then raise exception 'Chỉ quản lý hoặc chủ quán được khoá nhân viên'; end if;$x$, $x$perform _need('staff.manage');$x$);

-- nothing may compare roles for a permission any more (my_role() is not null, i.e. "signed in", stays)
do $$
declare
  v text;
begin
  select string_agg(p.proname, ', ') into v from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname not in ('my_role', 'reader_role', 'reader_real_role', 'staff_set_active', 'staff_save', 'staff_admin_list', 'signin_roster', 'staff_sign_in', 'admin_add_staff')
     and (p.prosrc ~ 'my_role\(\)\s*(=|<>|not in|in|is distinct)' or p.prosrc ~ 'reader_role\(\)\s*(=|<>|not in|in)' or p.prosrc ~ 'v_role\s*(=|<>|not in|in) ''');
  if v is not null then raise exception '0009: still comparing roles in %', v; end if;
end $$;

-- ---------------------------------------------------------------- row level security: roles -> permissions

do $$
declare
  r record;
  v_perm text;
begin
  for r in select tablename, policyname from pg_policies where schemaname = 'public' and policyname = 'manage' loop
    v_perm := case
      when r.tablename in ('areas', 'tables') then 'tables.edit'
      when r.tablename = 'shop_settings' then 'settings.edit'
      when r.tablename in ('menu_categories', 'menu_items', 'menu_item_variants', 'modifier_groups', 'modifier_options', 'item_modifier_groups',
                           'item_option_overrides', 'item_components', 'item_component_variant_qty', 'stations', 'vat_groups', 'vat_rates') then 'menu.edit'
    end;
    if v_perm is null then raise exception '0009: no permission for policy manage on %', r.tablename; end if;
    execute format('alter policy manage on %I using ((select has_perm(%L))) with check ((select has_perm(%L)))', r.tablename, v_perm, v_perm);
  end loop;
end $$;

alter policy temp_table on tables with check ((select has_perm('tables.temp')) and is_temporary);
alter policy open_order on orders with check ((select has_perm('order.take')));
alter policy move_order on orders using ((select has_perm('order.take')));
alter policy join_table on order_tables with check ((select has_perm('order.take')));

alter policy read_money on bills using ((select reader_can('pay.collect')) or (select reader_can('shift.manage')));
alter policy read_money on payments using ((select reader_can('pay.collect')) or (select reader_can('shift.manage')));
alter policy read_money on shifts using ((select reader_can('pay.collect')) or (select reader_can('shift.manage')));

alter policy read_mgr on audit_log using ((select has_perm('audit.view')));
alter policy read_mgr on approvals using ((select has_perm('audit.view')));
alter policy read_mgr on price_history using ((select has_perm('menu.edit')));
alter policy read_mgr on devices using ((select has_perm('devices.manage')));
alter policy read_mgr on staff_sessions using ((select has_perm('staff.manage')));

do $$
declare
  v text;
begin
  select string_agg(tablename || '.' || policyname, ', ') into v from pg_policies
   where schemaname = 'public' and (coalesce(qual, '') || coalesce(with_check, '')) ~ '(my_role|reader_role)\(\) AS (my_role|reader_role)\) (=|<>)';
  if v is not null then raise exception '0009: policies still compare roles: %', v; end if;
end $$;

-- the table itself: everyone signed in reads it (screens hide what a person cannot use); only set_role_permissions writes
alter table permissions enable row level security;
alter table role_permissions enable row level security;
revoke insert, update, delete, truncate on permissions, role_permissions from anon, authenticated;
create policy read_all on permissions for select using ((select reader_role()) is not null);
create policy read_all on role_permissions for select using ((select reader_role()) is not null);

-- internal ones closed; the checks (used inside policies) and the owner's editor for signed-in devices only
revoke execute on function _need(text), _approval_perm(text), reader_real_role() from public, anon, authenticated;
revoke execute on function role_can(text, text), has_perm(text), reader_can(text), set_role_permissions(text, text[]) from public, anon;
grant execute on function role_can(text, text), has_perm(text), reader_can(text), set_role_permissions(text, text[]) to authenticated;

alter publication supabase_realtime add table role_permissions;
