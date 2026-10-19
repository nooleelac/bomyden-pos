-- Test for 0002 on plain Postgres 16 after all migrations (0001–0006), with the Supabase stand-ins (_supabase_stubs.sql).
-- Runs as the API role `authenticated` (RLS on) except where marked. Later migrations changed some calls:
-- kitchen status goes through set_item_status (0004), pay_order needs an open shift (0005) and a cashier's
-- discount needs a manager approval token from verify_manager_pin (0006). Run: supabase/tests/run.sh
\set ON_ERROR_STOP 1
\pset footer off

-- helpers (test only)
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

-- ---------------------------------------------------------------- seed (superuser): staff, tables
insert into auth.users values ('00000000-0000-0000-0000-000000000001'), ('00000000-0000-0000-0000-000000000002'),
                              ('00000000-0000-0000-0000-000000000003'), ('00000000-0000-0000-0000-000000000004');
insert into staff (user_id, name, role) values
  ('00000000-0000-0000-0000-000000000001', 'Hùng', 'waiter'),
  ('00000000-0000-0000-0000-000000000002', 'Lan', 'cashier'),
  ('00000000-0000-0000-0000-000000000003', 'Chủ quán', 'manager'),
  ('00000000-0000-0000-0000-000000000004', 'Bếp nướng', 'kitchen');
select _set_pin(id, '2468') from staff where name = 'Chủ quán';   -- 0006: manager PIN for approvals
insert into tables (name, sort) values ('3', 3), ('4', 4), ('5', 5), ('6', 6), ('7', 7);
select id as t3 from tables where name = '3' \gset
select id as t4 from tables where name = '4' \gset
select id as t5 from tables where name = '5' \gset
select id as t6 from tables where name = '6' \gset
select id as t7 from tables where name = '7' \gset

-- ---------------------------------------------------------------- menu, entered by the manager through RLS
set role authenticated;
set test.uid = '00000000-0000-0000-0000-000000000003';
insert into menu_categories (name, default_station_id, vat_group)
  select 'Bò nướng', id, 'food' from stations where code = 'grill';
insert into menu_categories (name, default_station_id, vat_group)
  select 'Lẩu', id, 'food' from stations where code = 'hotpot';
insert into menu_categories (name, default_station_id, vat_group)
  select 'Bia', id, 'alcohol' from stations where code = 'none';
insert into menu_items (category_id, name, price, has_sizes)
  select id, 'Steak bò nướng', 0, true from menu_categories where name = 'Bò nướng' returning id as steak \gset
insert into menu_items (category_id, name, price)
  select id, 'Lẩu bò', 399000 from menu_categories where name = 'Lẩu' returning id as lau \gset
insert into menu_items (category_id, name, price)
  select id, 'Bia Tiger lon', 25000 from menu_categories where name = 'Bia' returning id as bia \gset
insert into menu_item_variants (item_id, name, code, price, sort) values
  (:'steak', '200g', '101-200', 199000, 1), (:'steak', '300g', '101-300', 279000, 2), (:'steak', '400g', '101-400', 359000, 3);
select id as v200 from menu_item_variants where name = '200g' \gset
select id as v300 from menu_item_variants where name = '300g' \gset
select id as v400 from menu_item_variants where name = '400g' \gset

insert into modifier_groups (name, kind, min_select, max_select, sort) values
  ('Độ chín', 'choice', 1, 1, 1), ('Nước sốt', 'choice', 0, 2, 2), ('Món thêm', 'addon', 0, null, 3);
insert into modifier_options (group_id, name, kitchen_name, price_delta, max_qty, sort)
select g.id, o.name, o.kname, o.price, o.maxq, o.sort
from (values ('Độ chín', 'Rare', 'RARE', 0, 1, 1), ('Độ chín', 'Medium rare', 'MED RARE', 0, 1, 2),
             ('Độ chín', 'Medium', 'MEDIUM', 0, 1, 3), ('Độ chín', 'Well done', 'WELL', 0, 1, 4),
             ('Nước sốt', 'Tiêu đen', 'SỐT TIÊU', 0, 1, 1), ('Nước sốt', 'Nấm', 'SỐT NẤM', 0, 1, 2),
             ('Nước sốt', 'Vang đỏ', 'SỐT VANG', 15000, 1, 3),
             ('Món thêm', 'Thêm bánh mì', '+ BÁNH MÌ', 10000, 3, 1), ('Món thêm', 'Thêm trứng ốp la', '+ TRỨNG', 8000, 3, 2))
     as o(grp, name, kname, price, maxq, sort)
join modifier_groups g on g.name = o.grp;
select id as o_mr from modifier_options where name = 'Medium rare' \gset
select id as o_wd from modifier_options where name = 'Well done' \gset
select id as o_tieu from modifier_options where name = 'Tiêu đen' \gset
select id as o_nam from modifier_options where name = 'Nấm' \gset
select id as o_vang from modifier_options where name = 'Vang đỏ' \gset
select id as o_banhmi from modifier_options where name = 'Thêm bánh mì' \gset
select id as o_trung from modifier_options where name = 'Thêm trứng ốp la' \gset
insert into item_modifier_groups (item_id, group_id, sort) select :'steak', id, sort from modifier_groups;

insert into item_components (item_id, name, kitchen_name, qty, unit, removable, removal_discount, addon_option_id, sort) values
  (:'steak', 'Miếng steak bò', 'STEAK', 1, 'miếng', false, 0, null, 1),
  (:'steak', 'Trứng gà ốp la', 'TRỨNG', 1, 'quả', true, 3000, :'o_trung', 2),
  (:'steak', 'Salad trộn', 'SALAD', 1, 'đĩa', true, 0, null, 3);
select id as c_steak from item_components where name = 'Miếng steak bò' \gset
select id as c_egg from item_components where name = 'Trứng gà ốp la' \gset

select t_ok((select count(*) from price_history) = 18 and (select count(*) from price_history where changed_by is null) = 0,
  'price history logs initial prices with who set them (3 items, 3 sizes, 9 options, 3 components)') as check;

-- waiter cannot edit the menu
set test.uid = '00000000-0000-0000-0000-000000000001';
update menu_item_variants set price = 1 where id = :'v300';
select t_ok((select price from menu_item_variants where id = :'v300') = 279000, 'waiter cannot change a size price (RLS)') as check;

-- ---------------------------------------------------------------- 5-A: the spec example, 2 × Steak 300g
insert into orders (table_id, guest_count, position_label) values (:'t5', 2, 'đầu bàn') returning id as a_id \gset
select gen_random_uuid() as batch1 \gset
select count(*) as sent from send_order_lines(:'a_id', jsonb_build_array(
  jsonb_build_object('menu_item_id', :'steak', 'variant_id', :'v300', 'qty', 1,
    'options', jsonb_build_array(jsonb_build_object('option_id', :'o_mr'), jsonb_build_object('option_id', :'o_tieu'),
                                 jsonb_build_object('option_id', :'o_banhmi'))),
  jsonb_build_object('menu_item_id', :'steak', 'variant_id', :'v300', 'qty', 1,
    'options', jsonb_build_array(jsonb_build_object('option_id', :'o_mr'), jsonb_build_object('option_id', :'o_tieu')),
    'removals', jsonb_build_array(:'c_egg'))), :'batch1');
select i.name, variant_name, base_price, price, qty, vat_rate, price_includes_vat, s.code as station, status
from order_items i join stations s on s.id = i.station_id where order_id = :'a_id' order by price desc;
select t_ok(array(select price from order_items where order_id = :'a_id' order by price desc) = '{289000,276000}',
            'line 1 = 279.000 + bánh mì 10.000 = 289.000; line 2 = 279.000 − trứng 3.000 = 276.000') as check;
select t_ok((select sum(price * qty) from order_items where order_id = :'a_id') = 565000, 'two lines total 565.000') as check;
select t_ok((select count(*) from send_order_lines(:'a_id', '[{"menu_item_id":"00000000-0000-0000-0000-000000000000","qty":1}]', :'batch1')) = 2
            and (select count(*) from order_items where order_id = :'a_id') = 2, 'resending the same batch is a no-op') as check;
select m.kind, m.name, m.kitchen_name, m.qty, m.unit_delta from order_item_modifiers m join order_items i on i.id = m.order_item_id
where i.order_id = :'a_id' order by i.price desc, m.kind, m.name;

-- ---------------------------------------------------------------- send-time validation
\set q '''select send_order_lines(%L, %L::jsonb)'''
select t_err(format(:q, :'a_id', jsonb_build_array(jsonb_build_object('menu_item_id', :'steak', 'qty', 1,
  'options', jsonb_build_array(jsonb_build_object('option_id', :'o_mr'))))), 'Chọn size%', 'steak needs a size (no default size)') as check;
select t_err(format(:q, :'a_id', jsonb_build_array(jsonb_build_object('menu_item_id', :'steak', 'variant_id', :'v300', 'qty', 1))),
  'Nhóm "Độ chín"%', 'doneness is required before sending') as check;
select t_err(format(:q, :'a_id', jsonb_build_array(jsonb_build_object('menu_item_id', :'steak', 'variant_id', :'v300', 'qty', 1,
  'options', jsonb_build_array(jsonb_build_object('option_id', :'o_mr'), jsonb_build_object('option_id', :'o_tieu'),
                               jsonb_build_object('option_id', :'o_nam'), jsonb_build_object('option_id', :'o_vang'))))),
  'Nhóm "Nước sốt"%', 'at most 2 sauces') as check;
select t_err(format(:q, :'a_id', jsonb_build_array(jsonb_build_object('menu_item_id', :'steak', 'variant_id', :'v300', 'qty', 1,
  'options', jsonb_build_array(jsonb_build_object('option_id', :'o_mr')), 'removals', jsonb_build_array(:'c_steak')))),
  'Không bỏ được thành phần chính%', 'main component cannot be removed') as check;
select t_err(format(:q, :'a_id', jsonb_build_array(jsonb_build_object('menu_item_id', :'steak', 'variant_id', :'v300', 'qty', 1,
  'options', jsonb_build_array(jsonb_build_object('option_id', :'o_mr'), jsonb_build_object('option_id', :'o_trung')),
  'removals', jsonb_build_array(:'c_egg')))), 'Không thể vừa bỏ vừa thêm%', 'no egg + extra egg refused') as check;
select t_err(format(:q, :'a_id', jsonb_build_array(jsonb_build_object('menu_item_id', :'steak', 'variant_id', :'v300', 'qty', 1,
  'options', jsonb_build_array(jsonb_build_object('option_id', :'o_mr'), jsonb_build_object('option_id', :'o_trung', 'qty', 4))))),
  'Số lượng%', 'add-on max 3 per portion') as check;
select t_err(format(:q, :'a_id', jsonb_build_array(jsonb_build_object('menu_item_id', :'lau', 'variant_id', :'v300', 'qty', 1))),
  'Món % không có size', 'item without sizes refuses a size') as check;
select t_err(format('insert into order_items (order_id, menu_item_id, name, price, qty, station_id, base_price, delivery_table_id, vat_rate, price_includes_vat)
  select %L, %L, ''x'', 1, 1, id, 1, %L, 8, true from stations limit 1', :'a_id', :'lau', :'t5'),
  '%permission denied%', 'clients cannot insert lines directly') as check;
select t_err(format('update order_items set price = 1 where order_id = %L', :'a_id'), '%permission denied%',
  'locked price cannot be edited by clients') as check;
set test.uid = '00000000-0000-0000-0000-000000000004';
select t_err(format(:q, :'a_id', '[]'), 'Chưa có quyền%', 'kitchen account cannot send') as check;
select count(*) from set_item_status(array(select id from order_items where order_id = :'a_id'), 'cooking');
select t_ok((select bool_and(status = 'cooking') from order_items where order_id = :'a_id'), 'kitchen can still move status') as check;

-- sold out: 400g today, egg on hold
select set_sold_out('variant', :'v400', 'today') > now() as v400_sold_out_until_tomorrow_6am;
select set_sold_out('component', :'c_egg', 'hold') = 'infinity' as egg_on_hold;
set test.uid = '00000000-0000-0000-0000-000000000001';
select t_err(format('select set_sold_out(''item'', %L, ''hold'')', :'steak'), 'Chưa có quyền%', 'waiters only look at sold-out state') as check;
select t_err(format(:q, :'a_id', jsonb_build_array(jsonb_build_object('menu_item_id', :'steak', 'variant_id', :'v400', 'qty', 1,
  'options', jsonb_build_array(jsonb_build_object('option_id', :'o_mr')), 'removals', jsonb_build_array(:'c_egg')))),
  'Hết size 400g%', '400g sold out, refused at send') as check;
select t_err(format(:q, :'a_id', jsonb_build_array(jsonb_build_object('menu_item_id', :'steak', 'variant_id', :'v200', 'qty', 1,
  'options', jsonb_build_array(jsonb_build_object('option_id', :'o_mr'))))),
  'Hết Trứng gà ốp la%', 'egg sold out: steak must be sent without egg') as check;
set test.uid = '00000000-0000-0000-0000-000000000003';
select set_sold_out('variant', :'v400', 'reopen') is null as v400_reopened, set_sold_out('component', :'c_egg', 'reopen') is null as egg_reopened;
set test.uid = '00000000-0000-0000-0000-000000000001';

-- ---------------------------------------------------------------- shared table: 5-A and 5-B
select t_ok(order_table_label(:'a_id', :'t5') = '5', 'single order shows as "5"') as check;
select t_err(format('insert into orders (table_id, guest_count) values (%L, 2)', :'t5'),
  'Bàn 5 đang có nhiều đơn%', 'second order on a table needs a position label (also stops double-open)') as check;
insert into orders (table_id, guest_count, position_label) values (:'t5', 2, 'cuối bàn – áo xanh') returning id as b_id \gset
select label, position_label, guest_count from open_orders where table_id = :'t5' order by label;
select t_ok(order_table_label(:'a_id', :'t5') = '5-A' and order_table_label(:'b_id', :'t5') = '5-B', 'labels 5-A and 5-B') as check;
select t_err(format('update orders set position_label = '''' where id = %L', :'a_id'), 'Bàn 5 đang có nhiều đơn%',
  'cannot blank a label while the table is shared') as check;
reset role;
update shop_settings set max_orders_per_table = 2;
set role authenticated;
select t_err(format('insert into orders (table_id, position_label) values (%L, ''góc'')', :'t5'), 'Bàn 5 đã có đủ 2 đơn%',
  'max orders per table (setting)') as check;
reset role;
update shop_settings set max_orders_per_table = 4;
set role authenticated;
select count(*) as sent_b from send_order_lines(:'b_id', jsonb_build_array(jsonb_build_object('menu_item_id', :'steak',
  'variant_id', :'v200', 'qty', 1, 'note', 'ít muối', 'options', jsonb_build_array(jsonb_build_object('option_id', :'o_wd')))));
set test.uid = '00000000-0000-0000-0000-000000000004';
select count(*) from set_item_status(array(select id from order_items where order_id = :'b_id'), 'cooking');
set test.uid = '00000000-0000-0000-0000-000000000001';

-- ---------------------------------------------------------------- merge: group on 3+4 at opening, then 5-B merged in
insert into orders (table_id, guest_count, position_label) values (:'t3', 8, 'đoàn công ty') returning id as g_id \gset
insert into order_tables (order_id, table_id) values (:'g_id', :'t4');
select t_ok(order_group_label(:'g_id') = 'nhóm gộp 3+4', 'merge at opening: 3+4') as check;
select count(*) as sent_g from send_order_lines(:'g_id', jsonb_build_array(
  jsonb_build_object('menu_item_id', :'lau', 'qty', 1),
  jsonb_build_object('menu_item_id', :'bia', 'qty', 6, 'delivery_table_id', :'t4')));
select t_err(format(:q, :'g_id', jsonb_build_array(jsonb_build_object('menu_item_id', :'lau', 'qty', 1, 'delivery_table_id', :'t6'))),
  'Bàn ra món phải là một bàn của đơn%', 'delivery table must belong to the order') as check;
select t_ok((select status from order_items where order_id = :'g_id' and menu_item_id = :'bia') = 'ready',
  'no-prep station (bia lon) goes straight to ready') as check;

select id as b_line, status as b_status_before from order_items where order_id = :'b_id' \gset
select (merge_orders(:'g_id', array[:'b_id']::uuid[])).id = :'g_id' as merged;
select t_ok((select status::text = 'merged' and merged_into = :'g_id' from orders where id = :'b_id'), '5-B closed as merged into the group') as check;
select t_ok((select order_id = :'g_id' and delivery_table_id = :'t5' and status::text = :'b_status_before' and price = 199000
             from order_items where id = :'b_line'), 'merged line keeps delivery table 5, kitchen status and price') as check;
select t_ok(order_group_label(:'g_id') = 'nhóm gộp 3+4+5', 'group now spans 3+4+5') as check;
select t_ok((select guest_count from orders where id = :'g_id') = 10, 'guest counts added (8 + 2)') as check;
select delivery_label, group_label, name, variant_name, status, modifiers from kitchen_queue
where order_id = :'g_id' order by delivery_label, name;
select t_ok((select delivery_label = '5-B' and group_label = 'nhóm gộp 3+4+5' from kitchen_queue where id = :'b_line'),
  'kitchen: big "5-B", small "nhóm gộp 3+4+5"') as check;
reset role;
update shop_settings set max_merge_tables = 3;
set role authenticated;
select t_err(format('insert into order_tables (order_id, table_id) values (%L, %L)', :'g_id', :'t6'), 'Một nhóm gộp tối đa 3 bàn%',
  'merge limit (setting, default 30)') as check;
reset role;
update shop_settings set max_merge_tables = 30;
set role authenticated;

-- ---------------------------------------------------------------- move whole order 6 -> 7
insert into orders (table_id, guest_count) values (:'t6', 3) returning id as m_id \gset
select count(*) as sent_m from send_order_lines(:'m_id', jsonb_build_array(jsonb_build_object('menu_item_id', :'lau', 'qty', 1)));
update orders set table_id = :'t7' where id = :'m_id';
select t_ok((select array_agg(table_id) from order_tables where order_id = :'m_id' and left_at is null) = array[:'t7']::uuid[]
            and (select delivery_table_id from order_items where order_id = :'m_id') = :'t7', 'chuyển bàn 6 -> 7: table and pending dish follow') as check;

-- ---------------------------------------------------------------- move items: 2 of 6 beers from the group to 5-A
select id as beer_line from order_items where order_id = :'g_id' and menu_item_id = :'bia' \gset
select t_err(format('select move_items(''[{"id":"%s","qty":2}]'', %L)', :'beer_line', :'a_id'), 'Chưa có quyền: Chuyển món đã xong%',
  'waiter cannot move finished items (money between bills)') as check;
set test.uid = '00000000-0000-0000-0000-000000000002';
select id is not null as shift_opened from open_shift(0);
select name, qty, price, order_id = :'a_id' as now_on_5a from move_items(format('[{"id":"%s","qty":2}]', :'beer_line')::jsonb, :'a_id');
select t_ok((select qty from order_items where id = :'beer_line') = 4
            and (select sum(qty) from order_items where order_id = :'a_id' and menu_item_id = :'bia') = 2,
  'partial move splits the line 4 + 2') as check;

-- ---------------------------------------------------------------- split: the hotpot of the group becomes its own bill on table 3
select id as lau_line from order_items where order_id = :'g_id' and menu_item_id = :'lau' \gset
select (split_order(:'g_id', format('[{"id":"%s"}]', :'lau_line')::jsonb, 'bàn trong', 2)).id is not null as split;
select label, position_label, guest_count from open_orders where table_id = :'t3' order by label;

-- split one of 2 identical steaks (with options and 'no egg') off order 7: modifiers travel with the copy
select id as m_steak from send_order_lines(:'m_id', jsonb_build_array(jsonb_build_object('menu_item_id', :'steak', 'variant_id', :'v300',
  'qty', 2, 'options', jsonb_build_array(jsonb_build_object('option_id', :'o_mr')), 'removals', jsonb_build_array(:'c_egg')))) \gset
select (split_order(:'m_id', format('[{"id":"%s","qty":1}]', :'m_steak')::jsonb, 'cạnh cửa', 1, 'cửa sổ')).id as m2_id \gset
select o.label, i.qty, i.price, (select string_agg(mo.kind || ':' || mo.name || ':' || mo.unit_delta, ', ' order by mo.kind)
                                  from order_item_modifiers mo where mo.order_item_id = i.id) as modifiers
from order_items i join open_orders o on o.id = i.order_id where i.menu_item_id = :'steak' and o.table_id = :'t7' order by o.label;
select t_ok((select qty = 1 and price = 276000 from order_items where id = :'m_steak')
            and (select count(*) = 1 and sum(qty) = 1 and min(price) = 276000 from order_items where order_id = :'m2_id')
            and (select count(*) from order_item_modifiers mo join order_items i on i.id = mo.order_item_id where i.order_id = :'m2_id') = 2
            and order_table_label(:'m2_id', :'t7') = '7-B',
  'split 1 of 2 steaks to 7-B: price 276.000 and both modifiers copied') as check;

-- ---------------------------------------------------------------- pay 5-A (cashier): 289.000 + 276.000 + 2 × 25.000
select calc_bill(:'a_id', 0) as bill_5a;
set test.uid = '00000000-0000-0000-0000-000000000001';
select t_err(format('select pay_order(%L, 0, ''[{"method":"cash","amount":615000}]'')', :'a_id'), 'Chưa có quyền%', 'waiter cannot take payment') as check;
select t_err(format('update orders set status = ''paid'' where id = %L', :'a_id'), 'Chỉ thanh toán qua pay_order%',
  'status cannot be set to paid directly') as check;
set test.uid = '00000000-0000-0000-0000-000000000002';
select t_err(format('select pay_order(%L, 0, ''[{"method":"cash","amount":600000}]'')', :'a_id'), 'Tổng thanh toán 600000 khác số phải trả 615000%',
  'payments must equal the total') as check;
select bill_no, table_label, subtotal, discount, rounding, total, vat_total, vat_lines
from pay_order(:'a_id', 0, '[{"method":"cash","amount":500000,"tendered":1000000},{"method":"bank","amount":115000}]');
select t_ok((select total = 615000 and vat_total = 41852 + 4545 and table_label = '5-A' from bills where order_id = :'a_id'),
  'bill 5-A 615.000, VAT 8% 41.852 + 10% 4.545') as check;
select t_ok(order_table_label(:'g_id', :'t5') = '5-B', 'after 5-A leaves, the group still shows 5-B on table 5') as check;

-- ---------------------------------------------------------------- pay the group with a 10% discount: rounding and VAT split
select calc_bill(:'g_id', 29900) as bill_group;
select t_err(format('select pay_order(%L, 29900, ''[{"method":"bank","amount":269000}]'', ''Khách quen'')', :'g_id'), 'Giảm giá hoá đơn cần quản lý%',
  'a cashier discount needs a manager approval (0006)') as check;
select verify_manager_pin((select id from staff where name = 'Chủ quán'), '2468', 'discount', :'g_id', '{"amount":29900}') ->> 'token' as appr_g \gset
select bill_no, table_label, subtotal, discount, rounding, total, vat_total, vat_lines
from pay_order(:'g_id', 29900, '[{"method":"bank","amount":269000}]', 'Khách quen', p_approval => :'appr_g');
select t_ok((select subtotal = 299000 and total = 269000 and rounding = -100 and table_label = 'nhóm gộp 3+4+5' from bills where order_id = :'g_id'),
  'group bill 299.000 − 29.900 = 269.100 → 269.000 (round down)') as check;
select t_ok((select count(*) from order_tables where order_id = :'g_id' and left_at is null) = 0, 'paying frees tables 3, 4, 5') as check;
select t_ok((select status = 'cooking' from order_items where id = :'b_line'), 'unfinished dish stays on the kitchen screen after payment') as check;

-- ---------------------------------------------------------------- order guards
insert into orders (table_id, position_label) values (:'t4', null) returning id as e_id \gset
update orders set status = 'void' where id = :'e_id';
select t_ok((select status = 'void' and closed_at is not null from orders where id = :'e_id'), 'empty order can be closed without a bill') as check;
select t_err(format('update orders set status = ''void'' where id = %L', :'m_id'), 'Đơn còn món%', 'order with dishes cannot be voided directly') as check;
select t_err(format('update orders set table_id = %L where id = %L', :'t6', :'a_id'), 'Đơn đã đóng%', 'a paid order cannot change table') as check;
select t_err(format('insert into orders (table_id, status) values (%L, ''paid'')', :'t6'), 'Đơn mới phải ở trạng thái mở%', 'new orders start open') as check;

-- ---------------------------------------------------------------- calc_bill against the spec numbers (lines inserted as superuser)
reset role;
insert into orders (table_id) values (:'t6') returning id as x_id \gset
insert into order_items (order_id, menu_item_id, name, price, qty, station_id, base_price, delivery_table_id, vat_rate, price_includes_vat)
select :'x_id', :'steak', n, p, q, (select id from stations where code = 'grill'), p, :'t6', 8, true
from (values ('Steak 200g không trứng', 186000, 1), ('Steak 300g', 259000, 1), ('Coca', 20000, 2)) v(n, p, q);
select calc_bill(:'x_id', 48500) as spec_436k;
select t_ok(calc_bill(:'x_id', 48500) @> '{"subtotal":485000,"rounding":-500,"total":436000,"vat_total":32296}', 'spec: 485.000 −10% → 436.000, VAT 8% 32.296') as check;
update order_items set price_includes_vat = false, price = 500000, qty = 2, base_price = 500000 where order_id = :'x_id' and name = 'Steak 300g';
delete from order_items where order_id = :'x_id' and name <> 'Steak 300g';
update shop_settings set service_charge_pct = 5;
select t_ok(calc_bill(:'x_id', 50000) @> '{"subtotal":1000000,"service_charge":47500,"vat_added":79800,"rounding":-300,"total":1077000}',
  'spec: VAT excluded + 5% service: 1.077.300 → 1.077.000') as check;
update shop_settings set service_charge_pct = 0;
delete from order_items where order_id = :'x_id';
insert into order_items (order_id, menu_item_id, name, price, qty, station_id, base_price, delivery_table_id, vat_rate, price_includes_vat)
select :'x_id', :'steak', n, p, q, (select id from stations where code = 'grill'), p, :'t6', r, true
from (values ('Lẩu bò', 399000, 1, 8), ('Bò nướng tảng', 159000, 2, 8), ('Steak 200g', 189000, 1, 8),
             ('Steak 200g không trứng', 186000, 1, 8), ('Bia', 25000, 10, 10)) v(n, p, q, r);
select calc_bill(:'x_id', 67100) as spec_merged;
select t_ok(calc_bill(:'x_id', 67100) @> '{"subtotal":1342000,"rounding":-900,"total":1274000,"vat_total":98366,
  "vat":[{"vat_rate":8,"base":959878,"vat":76790},{"vat_rate":10,"base":215756,"vat":21576}]}', 'spec: merged bill 1.274.000, VAT split 8%/10% (same as pricing.test.ts)') as check;
select t_err(format('select calc_bill(%L, 2000000)', :'x_id'), 'Giảm giá 2000000 không hợp lệ%', 'discount capped at discountable subtotal') as check;

-- ---------------------------------------------------------------- price lock and history
set role authenticated;
set test.uid = '00000000-0000-0000-0000-000000000003';
update menu_item_variants set price = 289000 where id = :'v300';
select t_ok((select array_agg(base_price order by price) from bills b join order_items i on i.order_id = b.order_id
             where b.order_id = :'a_id' and i.menu_item_id = :'steak') = '{279000,279000}', 'old bill keeps 279.000') as check;
select entity_type, old_value, new_value, changed_by is not null as by_staff from price_history where entity_id = :'v300' order by id;
select t_ok(vat_rate_on('food', '2026-12-31') = 8 and vat_rate_on('food', '2027-01-01') = 10 and vat_rate_on('alcohol', '2026-10-29') = 10,
  'VAT: food 8% to 31/12/2026 then 10%, beer 10%') as check;
reset role;
select 'ALL CHECKS PASSED' as result;
