-- Test for 0022 (chi nhánh): a second branch with the first one's menu copied, devices fixed to a branch by their code,
-- staff per branch (owners everywhere), every read and write kept inside the caller's branch, settings and takeaway
-- numbers per branch, opening hours, and the owner switching branch. Plain Postgres 16 after all migrations with the
-- Supabase stand-ins. Run: supabase/tests/run.sh 0022_branches_test.sql
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

-- ---------------------------------------------------------------- bootstrap: branch A as before 0022
\set D1 '00000000-0000-0000-0000-0000000000d1'
\set D2 '00000000-0000-0000-0000-0000000000d2'
insert into auth.users values (:'D1'), (:'D2');
select id as br_a from branches \gset
select admin_add_staff('Chủ quán', 'owner', '2468') as s_owner \gset
select admin_add_staff('Quản lý Hà', 'manager', '1397') as s_mgr_a \gset
select admin_add_staff('Hùng', 'waiter', '2580') as s_hung \gset
select admin_create_device_code('Máy quầy A', 'pos') as code1 \gset
insert into areas (name, sort) values ('Tầng 1', 1);
insert into tables (area_id, name, sort) select a.id, n::text, n from areas a, generate_series(1, 3) n;
insert into menu_categories (name, default_station_id) select 'Bò', id from stations where code = 'grill' returning id as c_bo \gset
insert into menu_categories (name, parent_id) values ('Bò Mỹ', :'c_bo') returning id as c_bo_my \gset
insert into menu_items (category_id, name, short_name, price, code, has_sizes) values (:'c_bo_my', 'Steak', 'STEAK', 0, '101', true) returning id as steak \gset
insert into menu_item_variants (item_id, name, code, price, sort) values (:'steak', '200g', '101S', 200000, 1), (:'steak', '300g', '101L', 280000, 2);
insert into modifier_groups (name, min_select, max_select) values ('Độ chín', 1, 1) returning id as g_chin \gset
insert into modifier_options (group_id, name, sort) values (:'g_chin', 'Tái', 1), (:'g_chin', 'Chín', 2);
insert into item_modifier_groups (item_id, group_id) values (:'steak', :'g_chin');
update shop_settings set shop_name = 'BÒ MỸ ĐEN Q1';

select t_ok((select count(*) from branches) = 1 and (select count(*) from branch_settings) = 1, 'one branch holds the data so far') as check;
select t_ok(not exists (select 1 from orders where branch_id <> :'br_a') and (select branch_id from staff where id = :'s_hung') = :'br_a'
            and (select branch_id from staff where id = :'s_owner') is null, 'staff join the first branch, owners none') as check;

set role authenticated;
set test.uid = :'D1';
select name from register_device(:'code1');
select t_ok((my_device() ->> 'branch_id')::uuid = :'br_a' and my_device() ->> 'branch_name' = 'Chi nhánh chính', 'device A belongs to the first branch') as check;

-- ---------------------------------------------------------------- the owner adds branch B with A's menu
select t_login(:'s_mgr_a', '1397') \g /dev/null
select t_err('select branch_save(null, ''Q7'')', 'Chỉ chủ quán quản lý chi nhánh', 'a manager cannot add a branch') as check;
select t_err('select switch_branch(' || quote_literal(:'br_a') || ')', 'Chỉ chủ quán đổi chi nhánh', 'a manager cannot switch branch') as check;
select t_login(:'s_owner', '2468') \g /dev/null
select t_err('select branch_save(null, ''chi nhánh CHÍNH'')', 'Đã có chi nhánh tên%', 'branch names are unique') as check;
select (branch_save(null, 'Quận 7', true, :'br_a') ->> 'id') as br_b \gset
select t_ok((select count(*) from menu_items) = 1 and (select count(*) from menu_categories) = 2, 'branch A still sees only its own menu') as check;
reset role;
select t_ok((select count(*) from menu_items where branch_id = :'br_b') = 1
            and (select count(*) from menu_item_variants where branch_id = :'br_b') = 2
            and (select count(*) from modifier_options where branch_id = :'br_b') = 2
            and (select count(*) from item_modifier_groups where branch_id = :'br_b') = 1
            and (select count(*) from stations where branch_id = :'br_b') = (select count(*) from stations where branch_id = :'br_a'),
            'the menu was copied: dishes, sizes, options, links, stations') as check;
select t_ok(not exists (select 1 from menu_items i join menu_categories c on c.id = i.category_id where i.branch_id = :'br_b' and c.branch_id <> :'br_b')
            and not exists (select 1 from menu_categories c join menu_categories p on p.id = c.parent_id where c.branch_id = :'br_b' and p.branch_id <> :'br_b')
            and not exists (select 1 from item_modifier_groups l join modifier_groups g on g.id = l.group_id where l.branch_id = :'br_b' and g.branch_id <> :'br_b')
            and not exists (select 1 from menu_categories c join stations s on s.id = c.default_station_id where c.branch_id = :'br_b' and s.branch_id <> :'br_b'),
            'the copy points only at its own rows (groups, sub-groups, options, stations)') as check;
select t_ok((select shop_name from branch_settings where branch_id = :'br_b') = 'BÒ MỸ ĐEN Q1'
            and (select opening_hours from branch_settings where branch_id = :'br_b') = '{}', 'settings start as the source branch''s, hours empty') as check;
select t_ok(not exists (select 1 from tables where branch_id = :'br_b'), 'tables are not copied') as check;
set role authenticated;

-- a device for branch B
select (create_device_code('Máy quầy B', 'pos', :'br_b') ->> 'code') as code2 \gset
set test.uid = :'D2';
select name from register_device(:'code2');
select t_ok((my_device() ->> 'branch_id')::uuid = :'br_b', 'device B belongs to branch B') as check;

-- ---------------------------------------------------------------- staff per branch
select t_ok((select array_agg(name order by name) from signin_roster()) = '{Chủ quán}', 'branch B lists only the owner so far') as check;
select t_ok(staff_sign_in(:'s_hung', '2580') ->> 'error' = 'Nhân viên này làm ở chi nhánh khác', 'a waiter of A cannot sign in on B') as check;
select t_login(:'s_owner', '2468') \g /dev/null
select (staff_save(null, 'Quản lý Minh', 'manager', '1593')).id as s_mgr_b \gset
select (staff_save(null, 'Hùng', 'waiter', '7531')).id as s_hung_b \gset
reset role;
select t_ok((select branch_id from staff where id = :'s_mgr_b') = :'br_b' and (select branch_id from staff where id = :'s_hung_b') = :'br_b',
            'people added on B work at B (a second Hùng is fine there)') as check;
set role authenticated;
select t_ok((select array_agg(name order by name) from staff_admin_list()) = '{"Chủ quán",Hùng,"Quản lý Minh"}', 'Nhân viên on B: B''s people and the owner') as check;
select t_ok((select count(*) from staff) = 3, 'the staff table reads the same way') as check;

-- ---------------------------------------------------------------- data stays in its branch
select t_login(:'s_mgr_b', '1593') \g /dev/null
select t_ok((select count(*) from menu_items) = 1 and (select branch_id from menu_items) = :'br_b', 'B reads only its own dishes') as check;
insert into areas (name) values ('Sân') returning id as a_b \gset
insert into tables (area_id, name) values (:'a_b', '1') returning id as t_b1 \gset
select t_ok((select branch_id from tables where id = :'t_b1') = :'br_b', 'a table added on B is B''s, and may reuse A''s name "1"') as check;
select t_ok((select count(*) from tables) = 1 and (select count(*) from areas) = 1, 'B does not see A''s tables') as check;
select t_err('insert into areas (name, branch_id) values (''Lén'', ' || quote_literal(:'br_a') || ')', '%row-level security%', 'B cannot write into A') as check;
update menu_items set price = 1 where branch_id = :'br_a';
reset role;
select t_ok((select price from menu_items where id = :'steak') = 0, 'B cannot change A''s dishes') as check;
set role authenticated;
update shop_settings set shop_name = 'BÒ MỸ ĐEN Q7' where id = 1;
select t_ok((select shop_name from shop_settings) = 'BÒ MỸ ĐEN Q7', 'B edits its own settings through shop_settings') as check;
reset role;
select t_ok((select shop_name from branch_settings where branch_id = :'br_a') = 'BÒ MỸ ĐEN Q1', 'A''s settings are untouched') as check;
set role authenticated;

-- takeaway numbers and shifts per branch
select t_login(:'s_hung_b', '7531') \g /dev/null
select takeaway_no as tw_b1 from open_takeaway('Khách B') \gset
set test.uid = :'D1';
select t_login(:'s_hung', '2580') \g /dev/null
select takeaway_no as tw_a1 from open_takeaway('Khách A') \gset
select t_ok(:tw_b1 = 1 and :tw_a1 = 1, 'each branch numbers its takeaway orders from 1') as check;
select t_ok((select count(*) from orders) = 1, 'A sees only its own order') as check;
select t_login(:'s_mgr_a', '1397') \g /dev/null
select id as sh_a from open_shift(0) \gset
set test.uid = :'D2';
select t_login(:'s_mgr_b', '1593') \g /dev/null
select id as sh_b from open_shift(0) \gset
select t_ok(:'sh_a' <> :'sh_b', 'Quầy 1 has an open shift in each branch') as check;
select t_ok((select count(*) from shifts) = 1, 'B sees only its own shift') as check;

-- ---------------------------------------------------------------- opening hours
select t_err('select save_opening_hours(''{"1": {"open": "7h", "close": "22:00"}}'', true)', 'Giờ làm việc không hợp lệ%', 'hours are HH:MM') as check;
-- closed every day: an empty-length window on all seven days
select save_opening_hours(jsonb_build_object('1', '{"open":"00:00","close":"00:00"}'::jsonb), true, '05:00') \g /dev/null
select t_ok((select business_day_start from shop_settings) = '05:00' and (select enforce_hours from shop_settings), 'hours and day start saved for B') as check;
reset role;
update branch_settings set opening_hours = '{}' where branch_id = :'br_b';
select t_ok(set_config('app.branch_override', :'br_b', false) is not null and branch_is_open(), 'no hours = always open') as check;
update branch_settings set opening_hours = '{"1":{"open":"08:00","close":"22:00"},"5":{"open":"17:00","close":"02:00"}}' where branch_id = :'br_b';
select t_ok(branch_is_open('2026-10-26 09:00+07') and not branch_is_open('2026-10-26 23:00+07') and not branch_is_open('2026-10-27 09:00+07')
            and branch_is_open('2026-10-30 23:30+07') and branch_is_open('2026-10-31 01:30+07') and not branch_is_open('2026-10-31 02:30+07'),
            'Monday 8–22, Friday 17–02 past midnight, Tuesday closed') as check;
update branch_settings set opening_hours = '{"1":{"open":"03:00","close":"03:01"}}' where branch_id = :'br_b';   -- closed nearly always
select set_config('app.branch_override', '', false) \g /dev/null
set role authenticated;
select t_login(:'s_hung_b', '7531') \g /dev/null
select t_err('select open_table(' || quote_literal(:'t_b1') || ', 2)', 'Ngoài giờ làm việc%', 'outside the hours a waiter cannot open a table') as check;
select t_err('select open_takeaway()', 'Ngoài giờ làm việc%', 'nor a takeaway order') as check;
select t_login(:'s_mgr_b', '1593') \g /dev/null
select t_ok((open_table(:'t_b1', 2)).id is not null, 'a manager still can') as check;
select t_login(:'s_hung_b', '7531') \g /dev/null
select t_ok((open_table(:'t_b1', 2)).id is not null, 'the waiter reaches a table already open') as check;
set test.uid = :'D1';
select t_login(:'s_hung', '2580') \g /dev/null
select t_ok((select count(*) from open_takeaway('A vẫn mở')) = 1, 'branch A has no hours: open') as check;

-- ---------------------------------------------------------------- the owner switches branch on device A
select t_login(:'s_owner', '2468') \g /dev/null
select t_ok((my_branch() ->> 'id')::uuid = :'br_a' and (my_branch() ->> 'can_switch')::boolean, 'owner starts in the device''s branch') as check;
select t_ok(jsonb_array_length(branches_list()) = 2, 'owner lists both branches') as check;
select switch_branch(:'br_b') \g /dev/null
select t_ok((my_branch() ->> 'name') = 'Quận 7' and (select count(*) from tables) = 1 and (select shop_name from shop_settings) = 'BÒ MỸ ĐEN Q7',
            'after switching the owner works on B: its tables and settings') as check;
select switch_branch(:'br_a') \g /dev/null
select t_ok((my_branch() ->> 'id')::uuid = :'br_a' and (select count(*) from tables) = 3, 'and back on A') as check;
select switch_branch(:'br_b') \g /dev/null
select t_login(:'s_owner', '2468') \g /dev/null
select t_ok((my_branch() ->> 'id')::uuid = :'br_a', 'a new sign-in starts again in the device''s branch') as check;
select t_login(:'s_hung', '2580') \g /dev/null
select t_ok(jsonb_array_length(branches_list()) = 1, 'others list only their branch') as check;

-- ---------------------------------------------------------------- closing a branch
select t_login(:'s_owner', '2468') \g /dev/null
select branch_save(:'br_b', 'Quận 7', false) \g /dev/null
select t_err('select branch_save(' || quote_literal(:'br_a') || ', ''Chi nhánh chính'', false)', 'Phải còn ít nhất một chi nhánh mở', 'the last open branch stays open') as check;
select t_err('select switch_branch(' || quote_literal(:'br_b') || ')', 'Chi nhánh không tồn tại hoặc đã đóng', 'no switching into a closed branch') as check;
set test.uid = :'D2';
select t_ok(staff_sign_in(:'s_mgr_b', '1593') ->> 'error' = 'Chi nhánh này đã tạm đóng', 'a closed branch signs in nobody but the owner') as check;
select t_ok((select array_agg(name) from signin_roster()) = '{Chủ quán}', 'its roster shows the owner only') as check;
