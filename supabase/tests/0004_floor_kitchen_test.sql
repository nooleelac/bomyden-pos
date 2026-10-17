-- Test for 0004 (floor and kitchen) on plain Postgres 16 after all migrations (0001–0006), as the API role `authenticated` (RLS on).
-- pay_order needs an open shift since 0005. Run: supabase/tests/run.sh
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
grant execute on function t_ok(boolean, text), t_err(text, text, text) to authenticated;

-- ---------------------------------------------------------------- seed (superuser)
insert into auth.users values ('00000000-0000-0000-0000-000000000001'), ('00000000-0000-0000-0000-000000000002'),
                              ('00000000-0000-0000-0000-000000000003'), ('00000000-0000-0000-0000-000000000004');
insert into staff (user_id, name, role) values
  ('00000000-0000-0000-0000-000000000001', 'Hùng', 'waiter'),
  ('00000000-0000-0000-0000-000000000002', 'Lan', 'cashier'),
  ('00000000-0000-0000-0000-000000000003', 'Chủ quán', 'manager'),
  ('00000000-0000-0000-0000-000000000004', 'Bếp', 'kitchen');
-- 0004 rules: a line the kitchen has not started is voided by any floor staff. 0006 asks a manager for every
-- sent line by default (void_approval = 'sent', tested in 0006_staff_auth_test.sql); this file keeps 'started'.
update shop_settings set void_approval = 'started';
insert into areas (name, sort) values ('Tầng 1', 1), ('Tầng 2', 2);
insert into tables (area_id, name, sort, seats) select a.id, n::text, n, 4 from areas a, generate_series(1, 12) n where a.name = 'Tầng 1';
insert into tables (area_id, name, sort, seats) select a.id, n::text, n, 6 from areas a, generate_series(13, 16) n where a.name = 'Tầng 2';
select id as t2 from tables where name = '2' \gset
select id as t3 from tables where name = '3' \gset
select id as t4 from tables where name = '4' \gset
select id as t5 from tables where name = '5' \gset
select id as t7 from tables where name = '7' \gset
select id as t8 from tables where name = '8' \gset
select id as t12 from tables where name = '12' \gset
select id as t15 from tables where name = '15' \gset
select id as a2 from areas where name = 'Tầng 2' \gset

insert into menu_categories (name, default_station_id) select 'Bò', id from stations where code = 'grill' returning id as c_bo \gset
insert into menu_categories (name, default_station_id) select 'Lẩu', id from stations where code = 'hotpot' returning id as c_lau \gset
insert into menu_categories (name, default_station_id, vat_group) select 'Bia', id, 'alcohol' from stations where code = 'bar' returning id as c_bia \gset
insert into menu_items (category_id, name, short_name, price, has_sizes) values (:'c_bo', 'Steak bò nướng', 'STEAK BÒ', 0, true) returning id as steak \gset
insert into menu_items (category_id, name, short_name, price) values (:'c_lau', 'Lẩu bò', 'LẨU BÒ', 399000) returning id as lau \gset
insert into menu_items (category_id, name, short_name, price) values (:'c_bia', 'Bia Tiger lon', 'TIGER', 25000) returning id as bia \gset
insert into menu_item_variants (item_id, name, price, sort) values (:'steak', '300g', 279000, 1), (:'steak', '400g', 359000, 2);
select id as v300 from menu_item_variants where name = '300g' \gset
select id as v400 from menu_item_variants where name = '400g' \gset
insert into modifier_groups (name, kind, min_select, max_select) values ('Độ chín', 'choice', 1, 1) returning id as g_dc \gset
insert into modifier_options (group_id, name, kitchen_name, sort) values (:'g_dc', 'Medium', 'MEDIUM', 1), (:'g_dc', 'Well done', 'WELL', 2);
select id as o_m from modifier_options where name = 'Medium' \gset
select id as o_wd from modifier_options where name = 'Well done' \gset
insert into item_modifier_groups (item_id, group_id) values (:'steak', :'g_dc');
insert into item_components (item_id, name, kitchen_name, removable, removal_discount) values (:'steak', 'Trứng ốp la', 'TRỨNG', true, 3000) returning id as c_egg \gset

\set W '00000000-0000-0000-0000-000000000001'
\set C '00000000-0000-0000-0000-000000000002'
\set M '00000000-0000-0000-0000-000000000003'
\set K '00000000-0000-0000-0000-000000000004'
\set steak300 '{"menu_item_id":":steak","variant_id":":v300","qty":2,"options":[{"option_id":":o_m"}]}'
select replace(replace(replace(:'steak300', ':steak', :'steak'), ':v300', :'v300'), ':o_m', :'o_m') as steak300 \gset
select format('{"menu_item_id":"%s","qty":%s}', :'bia', 6) as beer6 \gset
select format('{"menu_item_id":"%s","qty":1}', :'lau') as lau1 \gset

set role authenticated;

-- ---------------------------------------------------------------- open, ghép, mang về
set test.uid = :'W';
select id as o3 from open_table(:'t3', 6) \gset
select t_ok((select id from open_table(:'t3', 2)) = :'o3', 'a second open of the same table returns the same order') as check;
select t_err(format('select open_table(%L, 0)', :'t4'), 'Số khách%', 'guests 1–99') as check;
set test.uid = :'K';
select t_err(format('select open_table(%L, 2)', :'t4'), 'Chỉ phục vụ%', 'kitchen account cannot open a table') as check;
set test.uid = :'M';
update areas set active = false where id = :'a2';
set test.uid = :'W';
select t_err(format('select open_table(%L, 2)', :'t15'), 'Khu này đang tạm đóng', 'closed area refuses new orders') as check;

select id as o5a from open_table(:'t5', 2) \gset
select t_err(format('select add_shared_order(%L, 2, %L)', :'t5', '2 khách áo xanh'), '%mỗi đơn phải ghi vị trí ngồi', 'ghép needs a label on the existing order') as check;
select id as o5b from add_shared_order(:'t5', 2, '2 khách áo xanh', jsonb_build_object(:'o5a', 'đầu bàn')) \gset
select t_ok(order_label(:'o5a') = '5-A' and order_label(:'o5b') = '5-B', '5 becomes 5-A and 5-B') as check;

select id as mv1 from open_takeaway('anh Tuấn') \gset
select id as mv2 from open_takeaway() \gset
select t_ok(order_label(:'mv1') = 'MV-01' and order_label(:'mv2') = 'MV-02', 'takeaway MV-01, MV-02 without a table') as check;

-- ---------------------------------------------------------------- Gửi bếp: rounds, rush, notes, takeaway
select gen_random_uuid() as b1 \gset
select count(*) as sent from send_order_lines(:'o3', jsonb_build_array(:'steak300'::jsonb, :'lau1'::jsonb, :'beer6'::jsonb), :'b1');
select t_ok((select count(*) from send_order_lines(:'o3', jsonb_build_array(:'beer6'::jsonb), :'b1')) = 3
            and (select count(*) from order_items where order_id = :'o3') = 3, 'resending a batch is a no-op') as check;
select s.code, i.price, i.round, i.status from order_items i join stations s on s.id = i.station_id where order_id = :'o3' order by s.sort;
select t_ok((select array_agg(s.code order by s.sort) from order_items i join stations s on s.id = i.station_id where order_id = :'o3') = '{grill,hotpot,bar}',
            'lines split by station; beer goes to the bar') as check;
select count(*) from send_order_lines(:'o3', jsonb_build_array(:'beer6'::jsonb), null, 'Trẻ em');
select t_ok((select round || rush::text || rush_reason from order_items where order_id = :'o3' order by sent_at desc, round desc limit 1) = '2trueTrẻ em'
            and (select rounds from orders where id = :'o3') = 2, 'second send = Lượt 2, GẤP with reason') as check;
select t_err(format('select send_order_lines(%L, %L::jsonb, null, %L)', :'o3', jsonb_build_array(:'beer6'::jsonb), 'vui'), 'Chọn lý do GẤP', 'rush needs a listed reason') as check;
select t_err(format('select send_order_lines(%L, %L::jsonb)', :'o3', jsonb_build_array(:'beer6'::jsonb || jsonb_build_object('note', repeat('x', 61)))),
             'Ghi chú tối đa 60%', 'item note ≤ 60') as check;
select t_err(format('update orders set note = %L where id = %L', repeat('x', 61), :'o3'), '%orders_note_check%', 'order note ≤ 60') as check;
update orders set note = 'Khách dị ứng đậu phộng', allergy = true where id = :'o3';
select count(*) from send_order_lines(:'mv1', jsonb_build_array(:'lau1'::jsonb));
select t_ok((select delivery_table_id is null from order_items where order_id = :'mv1'), 'takeaway lines have no delivery table') as check;

-- ---------------------------------------------------------------- item states, bump, recall
select id as l_steak from order_items i where order_id = :'o3' and menu_item_id = :'steak' \gset
select t_err(format('update order_items set status = %L where id = %L', 'cooking', :'l_steak'), '%permission denied%', 'status changes only through the RPCs') as check;
select t_err(format('select set_item_status(array[%L]::uuid[], %L)', :'l_steak', 'cooking'), 'Chỉ máy bếp%', 'waiter cannot start cooking') as check;
set test.uid = :'K';
select count(*) from set_item_status(array[:'l_steak']::uuid[], 'cooking');
select count(*) from set_item_status(array[:'l_steak']::uuid[], 'ready');
select t_ok((select status = 'ready' and started_at is not null and ready_at is not null from order_items where id = :'l_steak'), 'Chờ làm → Đang làm → Xong with times') as check;
select count(*) from set_item_status(array[:'l_steak']::uuid[], 'cooking');
select t_ok((select status from order_items where id = :'l_steak') = 'cooking', 'one step back within 2 minutes') as check;
reset role;
update order_items set started_at = now() - interval '5 minutes' where id = :'l_steak';
set role authenticated;
select t_err(format('select set_item_status(array[%L]::uuid[], %L)', :'l_steak', 'new'), 'Quá 2 phút%', 'after 2 minutes only a manager steps back') as check;
select t_err(format('select set_item_status(array[%L]::uuid[], %L)', :'l_steak', 'served'), '%không bấm Đã bưng', 'kitchen does not mark served') as check;

select ticket_key(i) as k_grill from order_items i where id = :'l_steak' \gset
select bumped_at is not null as bumped from bump_ticket(:'k_grill');
select t_ok((select status from order_items where id = :'l_steak') = 'ready', 'bump sets the rest to Xong') as check;
set test.uid = :'W';
select count(*) from set_item_status(array[:'l_steak']::uuid[], 'served');
set test.uid = :'K';
select t_err(format('select recall_ticket(%L)', :'k_grill'), 'Món của phiếu đã bưng hết', 'recall needs an unserved dish') as check;
select id as l_lau from order_items where order_id = :'o3' and menu_item_id = :'lau' \gset
select ticket_key(i) as k_lau from order_items i where id = :'l_lau' \gset
select bumped_at is not null from bump_ticket(:'k_lau');
select recall_count from recall_ticket(:'k_lau');
select t_ok((select status from order_items where id = :'l_lau') = 'cooking'
            and (select recalled_at is not null and bumped_at is null from ticket_states where key = :'k_lau'), 'recall: back to Đang làm, GỌI LẠI') as check;

-- ---------------------------------------------------------------- huỷ, sửa
set test.uid = :'W';
select id as l_beer from order_items where order_id = :'o3' and menu_item_id = :'bia' and round = 1 \gset
select t_err(format('select void_item(%L, 1, %L)', :'l_beer', ''), 'Chọn lý do huỷ', 'void needs a reason') as check;
select t_err(format('select void_item(%L, 1, %L)', :'l_beer', 'Khác'), '%ghi rõ lý do', '"Khác" needs a note') as check;
select qty, status, void_stage from void_item(:'l_beer', 2, 'Khách đổi ý');
select t_ok((select qty from order_items where id = :'l_beer') = 4
            and (select text from kitchen_notices where kind = 'void') = 'HUỶ 2 BIA TIGER LON (bớt 2, còn 4) – Khách đổi ý', 'partial void: 4 left, kitchen notice HUỶ') as check;
select t_err(format('select void_item(%L, 1, %L)', :'l_lau', 'Món lỗi'), 'Món bếp đã làm: cần quản lý%', 'started dish: manager only (PIN later)') as check;
set test.uid = :'K';
select t_err(format('select bump_ticket(%L)', (select ticket_key(i) from order_items i where id = :'l_beer')), '%Đã biết%', 'bump waits for Đã biết on HUỶ') as check;
select ack_at is not null from ack_notice((select id from kitchen_notices where kind = 'void'));

set test.uid = :'W';
select count(*) from send_order_lines(:'o5b', jsonb_build_array(jsonb_build_object('menu_item_id', :'steak', 'variant_id', :'v300', 'qty', 1, 'options', jsonb_build_array(jsonb_build_object('option_id', :'o_m')))));
select id as l_5b from order_items where order_id = :'o5b' \gset
select status, text, before from modify_item(:'l_5b', jsonb_build_object('menu_item_id', :'steak', 'variant_id', :'v300', 'qty', 1,
  'options', jsonb_build_array(jsonb_build_object('option_id', :'o_m')), 'removals', jsonb_build_array(:'c_egg')));
select id as l_5b2 from order_items where order_id = :'o5b' and status <> 'void' \gset
select t_ok((select price from order_items where id = :'l_5b2') = 276000 and (select replaced_by from order_items where id = :'l_5b') = :'l_5b2',
            'SỬA on Chờ làm: applied, −3.000đ, old line replaced') as check;
select t_err(format('select modify_item(%L, %L::jsonb)', :'l_5b2', jsonb_build_object('menu_item_id', :'steak', 'variant_id', :'v300', 'qty', 2, 'options', '[]'::jsonb)),
             'Đổi số lượng%', 'qty change is not a modify') as check;
set test.uid = :'K';
select ack_at is not null from ack_notice((select id from kitchen_notices where kind = 'modify'));
select count(*) from set_item_status(array[:'l_5b2']::uuid[], 'cooking');
set test.uid = :'W';
select status, text from modify_item(:'l_5b2', jsonb_build_object('menu_item_id', :'steak', 'variant_id', :'v400', 'qty', 1,
  'options', jsonb_build_array(jsonb_build_object('option_id', :'o_m')), 'removals', jsonb_build_array(:'c_egg')));
select t_ok((select price from order_items where id = :'l_5b2') = 276000 and (select status from order_items where id = :'l_5b2') = 'cooking',
            'SỬA on Đang làm waits for the kitchen; price unchanged') as check;
set test.uid = :'K';
select t_err(format('select ack_notice(%L)', (select id from kitchen_notices where status = 'pending')), 'Chọn Nhận sửa%', 'pending SỬA needs a decision') as check;
select status from decide_modify((select id from kitchen_notices where status = 'pending'), true);
select t_ok((select price || variant_name || status from order_items where order_id = :'o5b' and status <> 'void') = '356000400gcooking', 'Nhận sửa: 400g, 356.000, still cooking') as check;

-- ---------------------------------------------------------------- giục
set test.uid = :'W';
select chase_count from chase_order(:'o5b');
select t_err(format('select chase_order(%L)', :'o5b'), 'Vừa giục xong%', 'chase spacing 3 minutes') as check;

-- ---------------------------------------------------------------- gộp: lines keep delivery table and state, no notice
select id as o7 from open_table(:'t7', 4) \gset
select id as o8 from open_table(:'t8', 3) \gset
select count(*) from send_order_lines(:'o8', jsonb_build_array(:'lau1'::jsonb));
select count(*) as notices_before from kitchen_notices \gset
select status from merge_orders(:'o7', array[:'o8']::uuid[]);
select t_ok((select delivery_table_id from order_items where order_id = :'o7') = :'t8' and (select moved_from_label from order_items where order_id = :'o7') = ''
            and (select count(*) from kitchen_notices) = :notices_before and order_group_label(:'o7') = 'nhóm gộp 7+8'
            and (select guest_count from orders where id = :'o7') = 7, 'merge keeps delivery table, no CHUYỂN, no notice, guests summed') as check;
select t_err(format('select release_table(%L, %L)', :'o7', :'t8'), 'Còn 1 món sẽ ra bàn 8%', 'release blocked while a dish is headed there') as check;
set test.uid = :'C';
select order_label(id) from split_table_from_group(:'o7', :'t8', 3);
select t_ok((select order_label(order_id) from order_items where menu_item_id = :'lau' and order_id <> :'o3' and order_id <> :'mv1') = '8'
            and order_group_label(:'o7') is null, 'split table 8 back out of the group with its dish') as check;

-- ---------------------------------------------------------------- chuyển bàn, chuyển món, tách đơn
set test.uid = :'W';
select id as o2 from open_table(:'t2', 4) \gset
select count(*) from send_order_lines(:'o2', jsonb_build_array(:'steak300'::jsonb, :'beer6'::jsonb));
set test.uid = :'K';
select count(*) from set_item_status(array(select id from order_items where order_id = :'o2' and menu_item_id = :'bia'), 'ready');
set test.uid = :'W';
select count(*) from set_item_status(array(select id from order_items where order_id = :'o2' and menu_item_id = :'bia'), 'served');
select order_label(id) from move_order(:'o2', :'t12');
select t_ok((select delivery_table_id || '/' || moved_from_label from order_items where order_id = :'o2' and menu_item_id = :'steak') = :'t12' || '/2'
            and (select delivery_table_id from order_items where order_id = :'o2' and menu_item_id = :'bia') = :'t2'
            and not exists (select 1 from order_tables where table_id = :'t2' and left_at is null), 'move: unfinished dish follows (CHUYỂN TỪ 2), served stays, table 2 free') as check;
select t_err(format('select move_order(%L, %L)', :'o2', :'t3'), '%Gộp vào đơn hoặc Thành đơn ghép', 'occupied target needs merge or shared') as check;
select order_label(id) from move_order(:'o2', :'t3', null, 'shared', 'cuối bàn', jsonb_build_object(:'o3', 'đầu bàn'));
select t_ok(order_label(:'o2') = '3-B' and order_label(:'o3') = '3-A', 'move as shared order: 3-B') as check;

select id as l_b5 from send_order_lines(:'o5a', jsonb_build_array(:'beer6'::jsonb)) \gset
select count(*) from move_items(jsonb_build_array(jsonb_build_object('id', :'l_b5', 'qty', 2)), :'o5b');
select t_ok((select qty from order_items where id = :'l_b5') = 4
            and (select qty || moved_from_label from order_items where order_id = :'o5b' and menu_item_id = :'bia') = '25-A', 'move 2 of 6 beers to 5-B (CHUYỂN TỪ 5-A)') as check;

-- ---------------------------------------------------------------- tạm tính, thanh toán (lock), dọn bàn
select bill_print_count from request_bill(:'o5a');
select t_ok((select bill_requested_at is not null from orders where id = :'o5a'), 'Chờ thanh toán') as check;
select count(*) from send_order_lines(:'o5a', jsonb_build_array(:'beer6'::jsonb));
select t_ok((select bill_requested_at is null from orders where id = :'o5a'), 'ordering more makes the pre-bill stale') as check;
select t_err(format('select begin_payment(%L)', :'o5a'), 'Chỉ thu ngân%', 'waiter cannot open payment') as check;
set test.uid = :'C';
select paying_at is not null from begin_payment(:'o5a');
set test.uid = :'W';
select t_err(format('select send_order_lines(%L, %L::jsonb)', :'o5a', jsonb_build_array(:'beer6'::jsonb)), 'Đơn đang thanh toán%', 'payment lock blocks other devices') as check;
set test.uid = :'C';
select (calc_bill(:'o5a') ->> 'total')::int as total_5a \gset
select id is not null as shift_opened from open_shift(0);
select bill_no is not null from pay_order(:'o5a', 0, jsonb_build_array(jsonb_build_object('method', 'cash', 'amount', :total_5a)));
select t_ok((select needs_cleaning from tables where id = :'t5') = false, '5-B still seated: table 5 not Chờ dọn yet') as check;
select (calc_bill(:'o5b') ->> 'total')::int as total_5b \gset
select bill_no is not null from pay_order(:'o5b', 0, jsonb_build_array(jsonb_build_object('method', 'bank', 'amount', :total_5b)));
select t_ok((select needs_cleaning from tables where id = :'t5'), 'all orders paid: Chờ dọn') as check;
set test.uid = :'W';
select needs_cleaning from mark_table_clean(:'t5');
select t_ok((select id from open_table(:'t5', 2)) is not null, 'Dọn xong -> free and opens again') as check;

-- ---------------------------------------------------------------- tables: never out of use with an open order
set test.uid = :'M';
select t_err(format('update tables set active = false where id = %L', :'t3'), 'Bàn còn đơn%', 'table with an open order cannot be put out of use') as check;
set test.uid = :'C';
insert into tables (area_id, name, is_temporary) select area_id, 'Tạm 1', true from tables where id = :'t3';
select t_ok(exists (select 1 from tables where name = 'Tạm 1'), 'cashier adds a temporary table') as check;
select t_err('insert into tables (name) values (''99'')', '%row-level security%', 'cashier cannot add a normal table') as check;

reset role;
select 'ALL CHECKS PASSED' as result;
