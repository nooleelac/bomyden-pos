-- Test for 0010 (Xoá vĩnh viễn): who may delete, and that each kind goes with what depends on it while old bills
-- keep their dishes, on plain Postgres 16 after all migrations with the Supabase stand-ins.
-- Run: supabase/tests/run.sh 0010_admin_delete_test.sql
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
create function t_login(p_staff uuid, p_pin text) returns text language sql as $$
  select t_as(staff_sign_in(p_staff, p_pin) ->> 'token')
$$;
grant execute on function t_ok(boolean, text), t_err(text, text, text), t_as(text), t_login(uuid, text) to authenticated, anon;

-- ---------------------------------------------------------------- bootstrap
\set D1 '00000000-0000-0000-0000-0000000000d1'
\set D2 '00000000-0000-0000-0000-0000000000d2'
insert into auth.users values (:'D1'), (:'D2');
select admin_add_staff('Chủ quán', 'owner', '2468') as s_owner \gset
select admin_add_staff('Quản lý Hà', 'manager', '1397') as s_mgr \gset
select admin_add_staff('Hùng', 'waiter', '2580') as s_hung \gset
select admin_add_staff('Lan', 'cashier', '3690') as s_lan \gset
select admin_create_device_code('Máy quầy', 'pos') as code1 \gset
select admin_create_device_code('Máy tầng 2', 'pos') as code2 \gset
insert into areas (name, sort) values ('Tầng 1', 1), ('Sân', 2);
select id as a1 from areas where name = 'Tầng 1' \gset
select id as a2 from areas where name = 'Sân' \gset
insert into tables (area_id, name, sort) select :'a1', n::text, n from generate_series(1, 4) n;
insert into tables (area_id, name, sort) values (:'a2', 'S1', 10), (:'a2', 'S2', 11);
select id as t1 from tables where name = '1' \gset
select id as t2 from tables where name = '2' \gset
select id as t3 from tables where name = '3' \gset
select id as s1 from tables where name = 'S1' \gset
insert into menu_categories (name, default_station_id) select 'Bò', id from stations where code = 'grill' returning id as c_bo \gset
insert into menu_categories (name, parent_id, default_station_id) select 'Bò Mỹ', :'c_bo', id from stations where code = 'grill' returning id as c_bomy \gset
insert into menu_items (category_id, name, short_name, price) values (:'c_bo', 'Bò lúc lắc', 'LÚC LẮC', 150000) returning id as luc_lac \gset
insert into menu_items (category_id, name, short_name, price) values (:'c_bomy', 'Bò Mỹ nướng', 'BÒ MỸ', 200000) returning id as bo_my \gset
insert into modifier_groups (name, kind) values ('Món thêm', 'addon') returning id as g_add \gset
insert into modifier_options (group_id, name, price_delta, max_qty) values (:'g_add', 'Trứng ốp la', 10000, 3) returning id as egg \gset
insert into item_modifier_groups (item_id, group_id) values (:'luc_lac', :'g_add');

set role authenticated;
set test.uid = :'D2';
select name from register_device(:'code2');
set test.uid = :'D1';
select name from register_device(:'code1');
reset role;
select id as dev1 from devices where name = 'Máy quầy' \gset
select id as dev2 from devices where name = 'Máy tầng 2' \gset
set role authenticated;

-- ---------------------------------------------------------------- who may delete
select t_ok(not has_function_privilege('anon', 'admin_delete(text, uuid)', 'execute'), 'anon cannot call admin_delete') as check;
select t_ok(not has_function_privilege('authenticated', '_purge(regclass, text, int)', 'execute'), '_purge is internal') as check;
select t_as(null) \g /dev/null
select t_err(format('select admin_delete(''table'', %L)', :'t3'), 'Đăng nhập trước%', 'nobody signed in: refused') as check;
select t_login(:'s_mgr', '1397') \g /dev/null
select t_err(format('select admin_delete(''table'', %L)', :'t3'), 'Chưa có quyền: Xoá vĩnh viễn', 'a manager has no Xoá vĩnh viễn by default') as check;
select t_login(:'s_owner', '2468') \g /dev/null
select t_err('select admin_delete(''nuclear'', gen_random_uuid())', 'Loại cần xoá không hợp lệ%', 'unknown kind refused') as check;
select t_err('select admin_delete(''table'', gen_random_uuid())', 'Không tìm thấy bàn', 'missing row refused') as check;

-- ---------------------------------------------------------------- a paid order, an open order, a merged order
select t_login(:'s_lan', '3690') \g /dev/null
select id as sh1 from open_shift(500000) \gset
select t_login(:'s_hung', '2580') \g /dev/null
select id as o_paid from open_table(:'t1', 2) \gset
select count(*) from send_order_lines(:'o_paid', jsonb_build_array(jsonb_build_object('menu_item_id', :'luc_lac', 'qty', 2, 'options', jsonb_build_array(jsonb_build_object('option_id', :'egg', 'qty', 1)))));
select id as o_open from open_table(:'t2', 2) \gset
select count(*) from send_order_lines(:'o_open', jsonb_build_array(jsonb_build_object('menu_item_id', :'bo_my', 'qty', 1)));
select id as o_src from open_table(:'t3', 2) \gset
select count(*) from send_order_lines(:'o_src', jsonb_build_array(jsonb_build_object('menu_item_id', :'bo_my', 'qty', 1)));
select id as o_sun from open_table(:'s1', 4) \gset
select t_login(:'s_lan', '3690') \g /dev/null
select merge_orders(:'o_open', array[:'o_src']::uuid[]) \g /dev/null
select bill_no as bill1, total as total1 from pay_order(:'o_paid', 0, jsonb_build_array(jsonb_build_object('method', 'cash', 'amount', 320000))) \gset
select t_ok(:'total1'::int = 320000, 'the paid order: 2 × (150000 + 10000)') as check;

-- ---------------------------------------------------------------- menu: old bills keep their dishes
select t_login(:'s_owner', '2468') \g /dev/null
select admin_delete('group', :'g_add') \g /dev/null
select t_ok(not exists (select 1 from modifier_options where id = :'egg') and not exists (select 1 from item_modifier_groups where group_id = :'g_add'),
            'group: options and dish links gone') as check;
select t_ok((select m.option_id is null and m.name = 'Trứng ốp la' and m.unit_delta = 10000 from order_item_modifiers m join order_items i on i.id = m.order_item_id where i.order_id = :'o_paid'),
            'the sold add-on keeps its name and price, without the option') as check;
select admin_delete('item', :'luc_lac') \g /dev/null
select t_ok(not exists (select 1 from menu_items where id = :'luc_lac'), 'item gone') as check;
select t_ok((select menu_item_id is null and name = 'Bò lúc lắc' and price = 160000 and qty = 2 from order_items where order_id = :'o_paid'), 'its sold line stays on the bill') as check;
select admin_delete('category', :'c_bo') \g /dev/null
select t_ok(not exists (select 1 from menu_categories where id in (:'c_bo', :'c_bomy')) and not exists (select 1 from menu_items where id = :'bo_my'),
            'category: its sub-group and their dishes gone too') as check;
select t_ok((select count(*) from order_items where order_id = :'o_open' and name = 'Bò Mỹ nướng') = 2, 'lines of an open order keep their names') as check;

-- ---------------------------------------------------------------- tables and areas
select admin_delete('table', :'t1') \g /dev/null
select t_ok(not exists (select 1 from tables where id = :'t1'), 'table gone') as check;
select t_ok((select table_id is null and status = 'paid' from orders where id = :'o_paid') and exists (select 1 from bills where bill_no = :'bill1'),
            'the paid order on it keeps its bill, without the table') as check;
select admin_delete('table', :'t2') \g /dev/null
select t_ok(not exists (select 1 from orders where id in (:'o_open', :'o_src')) and not exists (select 1 from order_items where order_id in (:'o_open', :'o_src'))
            and not exists (select 1 from order_tables where order_id in (:'o_open', :'o_src')),
            'the open order on it goes, with the order merged into it') as check;
select t_ok(exists (select 1 from tables where id = :'t3'), 'the merged order''s old table stays') as check;
select admin_delete('area', :'a2') \g /dev/null
select t_ok(not exists (select 1 from areas where id = :'a2') and not exists (select 1 from tables where area_id = :'a2' or id = :'s1')
            and not exists (select 1 from orders where id = :'o_sun'), 'area: its tables and their open orders gone') as check;
select t_ok(exists (select 1 from areas where id = :'a1'), 'other areas untouched') as check;

-- ---------------------------------------------------------------- orders, bills, shifts
select admin_delete('shift', :'sh1') \g /dev/null
select t_ok(not exists (select 1 from shifts where id = :'sh1') and (select shift_id is null from bills where bill_no = :'bill1'), 'shift gone; its bills stay without it') as check;
select admin_delete('order', :'o_paid') \g /dev/null
select t_ok(not exists (select 1 from orders where id = :'o_paid') and not exists (select 1 from bills where bill_no = :'bill1')
            and not exists (select 1 from order_items where order_id = :'o_paid'), 'order: bill, payments and lines gone') as check;

-- ---------------------------------------------------------------- staff and devices
select t_err(format('select admin_delete(''staff'', %L)', :'s_owner'), 'Không tự xoá%', 'not oneself') as check;
select t_err(format('select admin_delete(''device'', %L)', :'dev1'), 'Đang dùng máy này%', 'not the device in use') as check;
select admin_delete('staff', :'s_hung') \g /dev/null
select admin_delete('device', :'dev2') \g /dev/null
reset role;
select t_ok(not exists (select 1 from staff where id = :'s_hung') and not exists (select 1 from staff_secrets where staff_id = :'s_hung')
            and not exists (select 1 from staff_sessions where staff_id = :'s_hung'), 'staff: PIN and sessions gone') as check;
select t_ok(not exists (select 1 from devices where id = :'dev2') and not exists (select 1 from staff_sessions where device_id = :'dev2'), 'device and its sessions gone') as check;
set role authenticated;

-- the owner gives Xoá vĩnh viễn to managers: still never an owner
select set_role_permissions('manager', (select array_agg(id) from permissions)) \g /dev/null
select t_login(:'s_mgr', '1397') \g /dev/null
select t_err(format('select admin_delete(''staff'', %L)', :'s_owner'), 'Chỉ chủ quán được xoá%', 'a manager with the permission cannot delete the owner') as check;
select admin_delete('staff', :'s_lan') \g /dev/null
select t_ok(not exists (select 1 from staff where id = :'s_lan'), 'but deletes a cashier') as check;

reset role;
select t_ok((select count(*) from audit_log where action = 'delete') = 11, 'every delete is in the audit log') as check;
select t_ok((select detail ->> 'name' from audit_log where action = 'delete' and detail ->> 'kind' = 'area') = 'Sân', 'with what was deleted') as check;
