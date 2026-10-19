-- Test for 0009 (quyền theo vai trò): the seeded defaults, the owner editing a role's permissions, and every kind
-- of check following the table (functions, approvals, kitchen sign-in, read policies), on plain Postgres 16 after
-- all migrations with the Supabase stand-ins. Run: supabase/tests/run.sh 0009_role_permissions_test.sql
\set ON_ERROR_STOP 1
\pset footer off

create function t_ok(p_cond boolean, p_msg text) returns text language plpgsql as $$
begin
  if p_cond is not true then raise exception 'FAIL: %', p_msg; end if;
  return 'ok - ' || p_msg;
end $$;
create function t_err(p_sql text, p_like text, p_msg text) returns text language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when others then
    if sqlerrm not ilike p_like then raise exception 'FAIL: % -> wrong error: % (wanted %)', p_msg, sqlerrm, p_like; end if;
    return 'ok - ' || p_msg || '  [' || sqlerrm || ']';
  end;
  raise exception 'FAIL: % -> no error raised', p_msg;
end $$;
create function t_as(p_token text) returns text language sql as $$
  select set_config('request.headers', case when p_token is null then '' else json_build_object('x-staff-session', p_token)::text end, false)
$$;
-- sign in on the current device (ends whoever was signed in there) and send that session's header
create function t_login(p_staff uuid, p_pin text) returns text language sql as $$
  select t_as(staff_sign_in(p_staff, p_pin) ->> 'token')
$$;
grant execute on function t_ok(boolean, text), t_err(text, text, text), t_as(text), t_login(uuid, text) to authenticated, anon;

-- ---------------------------------------------------------------- bootstrap
\set D1 '00000000-0000-0000-0000-0000000000d1'
\set DK '00000000-0000-0000-0000-0000000000dc'
insert into auth.users values (:'D1'), (:'DK');
select admin_add_staff('Chủ quán', 'owner', '2468') as s_owner \gset
select admin_add_staff('Quản lý Hà', 'manager', '1397') as s_mgr \gset
select admin_add_staff('Hùng', 'waiter', '2580') as s_hung \gset
select admin_add_staff('Lan', 'cashier', '3690') as s_lan \gset
select admin_add_staff('Bếp nướng', 'kitchen', '4826') as s_bep \gset
select admin_create_device_code('Máy quầy', 'pos') as code1 \gset
select admin_create_device_code('Màn bếp', 'kitchen') as code_k \gset
insert into areas (name, sort) values ('Tầng 1', 1);
insert into tables (area_id, name, sort) select a.id, n::text, n from areas a, generate_series(1, 4) n;
select id as t1 from tables where name = '1' \gset
select id as t2 from tables where name = '2' \gset
insert into menu_categories (name, default_station_id) select 'Bò', id from stations where code = 'grill' returning id as c_bo \gset
insert into menu_items (category_id, name, short_name, price) values (:'c_bo', 'Bò lúc lắc', 'LÚC LẮC', 150000) returning id as luc_lac \gset
select format('{"menu_item_id":"%s","qty":2}', :'luc_lac') as two \gset

-- ---------------------------------------------------------------- defaults reproduce 0001–0008
select t_ok((select array_agg(perm order by perm) from role_permissions where role = 'waiter') = '{order.take}', 'waiter: order.take only') as check;
select t_ok((select count(*) from role_permissions where role = 'manager') = (select count(*) from permissions where id <> 'admin.delete'), 'manager: everything but Xoá vĩnh viễn (0010)') as check;
select t_ok(role_can('owner', 'menu.edit') and role_can('owner', 'no.such') and not role_can('waiter', 'pay.collect') and not role_can(null, 'order.take'),
            'owner has everything, nobody else what is not in the table') as check;
select t_ok(not exists (select 1 from role_permissions where role = 'owner'), 'owner rows are never stored') as check;

set role authenticated;
set test.uid = :'D1';
select name from register_device(:'code1');
set test.uid = :'DK';
select name from register_device(:'code_k');
set test.uid = :'D1';

-- the API cannot write the table directly, anon cannot reach it at all
select t_err('insert into role_permissions values (''waiter'', ''pay.collect'')', 'permission denied%', 'no direct insert') as check;
select t_err('delete from role_permissions', 'permission denied%', 'no direct delete') as check;
select t_ok(not has_function_privilege('anon', 'set_role_permissions(text, text[])', 'execute'), 'anon cannot call set_role_permissions') as check;
select t_ok(not has_function_privilege('authenticated', '_need(text)', 'execute'), '_need is internal') as check;


-- ---------------------------------------------------------------- everyone reads the table, only the owner writes it
select t_login(:'s_hung', '2580') \g /dev/null
select t_ok((select count(*) from role_permissions) > 0 and (select count(*) from permissions) = 19, 'signed-in staff read the table') as check;
select t_err('select set_role_permissions(''waiter'', ''{pay.collect}'')', 'Chỉ chủ quán được phân quyền', 'a waiter cannot change permissions') as check;
select t_login(:'s_mgr', '1397') \g /dev/null
select t_err('select set_role_permissions(''waiter'', ''{pay.collect}'')', 'Chỉ chủ quán được phân quyền', 'a manager cannot change permissions') as check;
select t_login(:'s_owner', '2468') \g /dev/null
select t_err('select set_role_permissions(''owner'', ''{}'')', 'Vai trò không hợp lệ', 'the owner role is not editable') as check;
select t_err('select set_role_permissions(''waiter'', ''{order.take,steal.money}'')', 'Quyền không hợp lệ: steal.money', 'unknown permissions refused') as check;

-- waiter: may take payment and give discounts, may no longer void after the pre-bill (never could); keeps order.take
select t_ok(set_role_permissions('waiter', '{order.take,pay.collect,pay.discount,order.take}') = '{order.take,pay.collect,pay.discount}', 'waiter gets pay.collect and pay.discount (repeats ignored)') as check;
-- cashier: loses payments, gets the kitchen screen and staff management
select t_ok(set_role_permissions('cashier', '{order.take,kitchen.work,staff.manage}') = '{kitchen.work,order.take,staff.manage}', 'cashier: kitchen and staff, no money') as check;
-- manager: no discounts any more
select t_ok(cardinality(set_role_permissions('manager', (select array_agg(id) from permissions where id not in ('pay.discount', 'admin.delete')))) = 17, 'manager loses pay.discount') as check;
reset role;
select t_ok((select detail -> 'added' = '["pay.collect", "pay.discount"]'::jsonb and detail -> 'removed' = '[]'::jsonb and staff_id = :'s_owner'
               from audit_log where action = 'permissions' and detail ->> 'role' = 'waiter'), 'the change is in the audit log: who, role, added, removed') as check;
select t_ok((select count(*) from audit_log where action = 'permissions') = 3, 'one audit row per changed role') as check;
set role authenticated;
select t_login(:'s_owner', '2468') \g /dev/null
select set_role_permissions('waiter', '{order.take,pay.collect,pay.discount}') \g /dev/null
reset role;
select t_ok((select count(*) from audit_log where action = 'permissions') = 3, 'saving the same permissions logs nothing') as check;
set role authenticated;

-- ---------------------------------------------------------------- the checks follow the table
select t_login(:'s_hung', '2580') \g /dev/null
select id as o1 from open_table(:'t1', 2) \gset
select count(*) as sent from send_order_lines(:'o1', jsonb_build_array(:'two'::jsonb));
select t_ok((select paying_by = :'s_hung' from begin_payment(:'o1')), 'waiter with pay.collect opens the payment') as check;
select cancel_payment(:'o1') \g /dev/null
select t_ok((select count(*) from bills) = 0 and has_perm('pay.collect'), 'waiter with pay.collect may read money (no bills yet)') as check;

select t_login(:'s_lan', '3690') \g /dev/null
select t_err(format('select begin_payment(%L)', :'o1'), 'Chưa có quyền: Thu tiền, in hoá đơn', 'cashier without pay.collect cannot take payment') as check;
select t_err('select open_shift(0)', 'Chưa có quyền: Mở ca, chốt ca', 'cashier without shift.manage cannot open a shift') as check;
select t_ok((select count(*) from shifts) = 0, 'cashier without money permissions reads no shifts') as check;
select t_ok((select count(*) from staff_admin_list()) = 5, 'cashier with staff.manage opens the staff list') as check;
select t_ok((select role::text from staff_save(null, 'Tý', 'waiter', '7531')) = 'waiter', 'cashier with staff.manage adds a waiter') as check;
select t_err('select staff_save(null, ''Sếp'', ''manager'', ''7531'')', 'Chỉ chủ quán%', 'but never a manager') as check;
select t_err(format('select staff_reset_pin(%L, ''7531'')', :'s_mgr'), 'Chỉ chủ quán%', 'nor a manager''s PIN') as check;
select t_err('select create_device_code(''x'')', 'Chưa có quyền: Thêm và khoá máy', 'staff.manage is not devices.manage') as check;

-- approvals: a manager without pay.discount needs one and cannot give one; the waiter with pay.discount can
select t_login(:'s_mgr', '1397') \g /dev/null
select t_ok((verify_manager_pin(:'s_mgr', '1397', 'discount', :'o1', '{"amount": 10000}') ->> 'error') = 'Người này chưa có quyền duyệt việc này', 'manager without pay.discount cannot approve a discount') as check;
select t_ok((verify_manager_pin(:'s_hung', '2580', 'discount', :'o1', '{"amount": 10000}') ->> 'ok')::boolean, 'waiter with pay.discount approves it') as check;
select t_ok((verify_manager_pin(:'s_mgr', '1397', 'void_item', :'o1', jsonb_build_object('line', (select id from order_items where order_id = :'o1' limit 1))) ->> 'ok')::boolean,
            'manager still approves voids') as check;
select t_ok((verify_manager_pin(:'s_owner', '2468', 'discount', :'o1', '{"amount": 10000}') ->> 'ok')::boolean, 'the owner approves anything') as check;

-- kitchen display: whoever has kitchen.work signs in there
set test.uid = :'DK';
select t_as(null) \g /dev/null
select t_ok((select array_agg(name order by name) from signin_roster()) = '{Bếp nướng,Chủ quán,Lan,"Quản lý Hà"}', 'kitchen roster follows kitchen.work (Lan in)') as check;
select t_ok((staff_sign_in(:'s_lan', '3690') ->> 'ok')::boolean, 'cashier with kitchen.work signs in on the kitchen screen') as check;
select t_ok((staff_sign_in(:'s_hung', '2580') ->> 'error') = 'Máy bếp chỉ đăng nhập người có quyền Màn hình bếp', 'waiter does not') as check;

-- take a permission away: the next call is refused
set test.uid = :'D1';
select t_login(:'s_owner', '2468') \g /dev/null
select set_role_permissions('waiter', '{}') \g /dev/null
select t_login(:'s_hung', '2580') \g /dev/null
select t_err(format('select open_table(%L, 2)', :'t2'), 'Chưa có quyền: Mở bàn, gọi món, gửi bếp', 'waiter without order.take cannot open a table') as check;
select t_ok((select count(*) from orders) = 1, 'but still reads the floor') as check;
