-- Test for 0005 (cashier, shifts) on plain Postgres 16 after all migrations (0001–0006), as the API role `authenticated` (RLS on).
-- Needs the Supabase stand-ins (auth.uid() from the test.uid setting, roles, supabase_realtime publication).
-- Expected numbers are the ones src/lib/pricing.ts and src/cashier/shift.ts give for the same bills
-- (see src/cashier/cashier.test.ts), so the screen and the server agree.
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
                              ('00000000-0000-0000-0000-000000000003'), ('00000000-0000-0000-0000-000000000005');
insert into staff (user_id, name, role) values
  ('00000000-0000-0000-0000-000000000001', 'Hùng', 'waiter'),
  ('00000000-0000-0000-0000-000000000002', 'Lan', 'cashier'),
  ('00000000-0000-0000-0000-000000000003', 'Chủ quán', 'manager'),
  ('00000000-0000-0000-0000-000000000005', 'Mai', 'cashier');
select _set_pin(id, '2468') from staff where name = 'Chủ quán';   -- 0006: manager PIN for approvals
insert into areas (name, sort) values ('Tầng 1', 1);
insert into tables (area_id, name, sort, seats) select a.id, n::text, n, 4 from areas a, generate_series(1, 12) n;
select id as t9 from tables where name = '9' \gset
select id as t10 from tables where name = '10' \gset
select id as t11 from tables where name = '11' \gset
insert into menu_categories (name, default_station_id) select 'Steak', id from stations where code = 'grill' returning id as c_steak \gset
insert into menu_categories (name, default_station_id, vat_group) select 'Bia', id, 'alcohol' from stations where code = 'bar' returning id as c_bia \gset
insert into menu_items (category_id, name, short_name, price, has_sizes) values (:'c_steak', 'Steak bò nướng', 'STEAK BÒ', 0, true) returning id as steak \gset
insert into menu_items (category_id, name, short_name, price, discountable) values (:'c_bia', 'Bia Tiger lon', 'TIGER', 25000, false) returning id as bia \gset
insert into menu_item_variants (item_id, name, price, sort) values (:'steak', '200g', 199000, 1), (:'steak', '400g', 359000, 2);
select id as v200 from menu_item_variants where name = '200g' \gset
select id as v400 from menu_item_variants where name = '400g' \gset
insert into item_components (item_id, name, kitchen_name, removable, removal_discount) values (:'steak', 'Trứng ốp la', 'TRỨNG', true, 3000) returning id as c_egg \gset

\set W '00000000-0000-0000-0000-000000000001'
\set C '00000000-0000-0000-0000-000000000002'
\set M '00000000-0000-0000-0000-000000000003'
\set C2 '00000000-0000-0000-0000-000000000005'
select format('{"menu_item_id":"%s","variant_id":"%s","qty":1,"removals":["%s"]}', :'steak', :'v200', :'c_egg') as steak200 \gset
select format('{"menu_item_id":"%s","variant_id":"%s","qty":1}', :'steak', :'v400') as steak400 \gset
select format('{"menu_item_id":"%s","qty":%s}', :'bia', 4) as beer4 \gset
select format('{"menu_item_id":"%s","qty":%s}', :'bia', 2) as beer2 \gset

set role authenticated;

-- ---------------------------------------------------------------- Bàn 9: steak 200g không trứng + 4 Tiger
set test.uid = :'W';
select id as o9 from open_table(:'t9', 4) \gset
select count(*) as sent from send_order_lines(:'o9', jsonb_build_array(:'steak200'::jsonb, :'beer4'::jsonb));
select t_ok((select array_agg(price::text || '/' || vat_rate || '/' || discountable order by vat_rate) from order_items where order_id = :'o9')
            = '{196000/8/true,25000/10/false}', 'VAT and discountable snapshotted at send: steak 8%, beer 10% not discountable') as check;
select t_err(format('select pay_order(%L, 0, %L::jsonb)', :'o9', '[{"method":"cash","amount":296000}]'), 'Chưa có quyền%', 'a waiter cannot take payment') as check;

set test.uid = :'C';
select t_err(format('select pay_order(%L, 0, %L::jsonb)', :'o9', '[{"method":"cash","amount":296000}]'), 'Chưa mở ca%', 'no payment before the shift is opened') as check;
select t_err('select open_shift(-1)', 'Tiền đầu ca%', 'opening float is not negative') as check;
select id as sh1 from open_shift(1500000) \gset
select t_err('select open_shift(0)', 'Quầy 1 đang có ca mở%', 'one open shift per register') as check;
select t_err(format('insert into shifts (opened_by, opening_float) values (%L, 0)', (select id from staff where name = 'Lan')), '%row-level security%', 'shifts are written only through the RPCs') as check;

-- 10% bill discount: only on the steak (beer not discountable) -> 19.600, total 296.000 - 19.600 = 276.400 -> 276.000
select calc_bill(:'o9', 19600) ->> 'total' as total_o9 \gset
select t_ok(:total_o9 = 276000 and (calc_bill(:'o9', 19600) -> 'vat') = '[{"vat_rate":8,"price_includes_vat":true,"base":163097,"vat":13048},{"vat_rate":10,"price_includes_vat":true,"base":90777,"vat":9078}]'::jsonb,
            'calc_bill = billTotals: 276.000đ, VAT 8% 13.048 on 163.097, 10% 9.078 on 90.777') as check;
select t_err(format('select pay_order(%L, 19600, %L::jsonb)', :'o9', '[{"method":"cash","amount":276000}]'), 'Chọn lý do giảm giá', 'a discount needs a reason') as check;
select t_err(format('select pay_order(%L, 0, %L::jsonb)', :'o9', '[{"method":"cash","amount":295000}]'), 'Tổng thanh toán 295000 khác số phải trả 296000', 'short by 1.000đ does not close') as check;
select t_err(format('select pay_order(%L, 0, %L::jsonb)', :'o9', '[{"method":"card","amount":300000}]'), 'Chuyển khoản và thẻ không được vượt%', 'card cannot exceed the total') as check;
select t_err(format('select pay_order(%L, 0, %L::jsonb)', :'o9', '[{"method":"bank","amount":296000,"tendered":300000}]'), 'Tiền khách đưa chỉ ghi cho tiền mặt%', 'tendered only on cash') as check;
select t_err(format('select pay_order(%L, 0, %L::jsonb)', :'o9', '[{"method":"cash","amount":296000,"tendered":200000}]'), 'Tiền khách đưa%không nhỏ hơn%', 'tendered not below the amount') as check;
select t_err(format('select pay_order(%L, 0, %L::jsonb)', :'o9', '[{"method":"cash","amount":296000.5}]'), 'Số tiền mỗi khoản%', 'whole đồng only') as check;
select t_err(format('select pay_order(%L, 0, %L::jsonb)', :'o9', '[{"method":"momo","amount":296000}]'), 'Cách trả không hợp lệ', 'cash, bank or card') as check;

-- another cashier has the payment screen open: Lan cannot pay it
set test.uid = :'C2';
select paying_at is not null as locked from begin_payment(:'o9');
set test.uid = :'C';
select t_err(format('select pay_order(%L, 0, %L::jsonb)', :'o9', '[{"method":"cash","amount":296000}]'), 'Đơn đang thanh toán ở máy khác', 'locked by another cashier') as check;
set test.uid = :'C2';
select paying_at is null as unlocked from cancel_payment(:'o9');
set test.uid = :'C';
select paying_at is not null as mine from begin_payment(:'o9');

-- split: 200.000 transfer + 76.000 cash (guest hands over 100.000, change 24.000)
-- 0006: Lan is a cashier, so the discount needs Chủ quán's PIN (single-use approval token)
select verify_manager_pin((select id from staff where name = 'Chủ quán'), '2468', 'discount', :'o9', '{"amount":19600}') ->> 'token' as appr9 \gset
select bill_no, total, shift_id = :'sh1' as in_shift, discount_reason from pay_order(:'o9', 19600,
  '[{"method":"bank","amount":200000,"ref":"FT123"},{"method":"cash","amount":76000,"tendered":100000}]'::jsonb, 'Khách quen', p_approval => :'appr9') \gset b9_
select id as b9 from bills where order_id = :'o9' \gset
select t_ok(:'b9_in_shift'::boolean and :'b9_discount_reason' = 'Khách quen' and :b9_total = 276000, 'bill in the open shift with its discount reason') as check;
select t_ok((select array_agg(method || ':' || amount || ':' || coalesce(tendered::text, '-') || ':' || ref order by method) from payments where bill_id = :'b9')
            = '{cash:76000:100000:,bank:200000:-:FT123}', 'payment rows: cash keeps what was handed over, bank its reference') as check;
select t_ok((select status = 'paid' and paying_at is null and paying_by is null from orders where id = :'o9'), 'order paid, payment lock released') as check;
select t_ok((select not needs_cleaning from tables where id = :'t9'), 'table free as soon as it is paid') as check;
set test.uid = :'M';   -- audit_log is readable by managers only
select t_ok((select detail ->> 'reason' from audit_log where action = 'discount' order by id desc limit 1) = 'Khách quen', 'discount logged with its reason') as check;
set test.uid = :'C';
select t_err(format('select pay_order(%L, 0, %L::jsonb)', :'o9', '[{"method":"cash","amount":276000}]'), 'Đơn không còn mở', 'cannot pay twice') as check;

-- prints: the 2nd is a reprint and is logged
select print_bill(:'b9') as p1 \gset
select print_bill(:'b9') as p2 \gset
set test.uid = :'M';
select t_ok(:p1 = 1 and :p2 = 2 and (select count(*) from audit_log where action = 'reprint') = 1, 'print_bill counts prints, logs the reprint') as check;
set test.uid = :'W';
select t_err(format('select print_bill(%L)', :'b9'), 'Chưa có quyền%', 'waiters do not print bills') as check;
select t_err(format('update bills set total = 1 where id = %L', :'b9'), 'permission denied%', 'bills cannot be edited directly (0006: no update grant)') as check;
set test.uid = :'C';
select t_ok((select total from bills where id = :'b9') = 276000, 'bill unchanged') as check;
set test.uid = :'W';

-- ---------------------------------------------------------------- Bàn 10: steak 400g + 2 Tiger, exact cash
select id as o10 from open_table(:'t10', 2) \gset
select count(*) from send_order_lines(:'o10', jsonb_build_array(:'steak400'::jsonb, :'beer2'::jsonb));
set test.uid = :'C';
select t_ok((calc_bill(:'o10', 0) ->> 'total')::int = 409000 and (calc_bill(:'o10', 0) ->> 'vat_total')::int = 31138, 'Bàn 10: 409.000đ, VAT 31.138 (as billTotals)') as check;
select bill_no from pay_order(:'o10', 0, '[{"method":"cash","amount":409000,"tendered":409000}]'::jsonb);
select t_ok((select tendered is null from payments p join bills b on b.id = p.bill_id where b.order_id = :'o10'), 'exact cash stores no tendered amount') as check;

-- ---------------------------------------------------------------- shift totals and close
select shift_summary(:'sh1') as sum1 \gset
select t_ok(:'sum1'::jsonb = '{"bills":2,"subtotal":705000,"discount":19600,"service_charge":0,"rounding":-400,"sales":685000,"vat_total":53264,
  "by_method":{"cash":485000,"bank":200000,"card":0},"cash_tendered":509000,"change_given":24000,"opening_float":1500000,"expected_cash":1985000}'::jsonb,
  'shift_summary = shiftSummary: 2 bills, 685.000đ, cash 485.000, bank 200.000, expected cash 1.985.000') as check;

-- an order on a payment screen blocks the close
set test.uid = :'W';
select id as o11 from open_table(:'t11', 2) \gset
select count(*) from send_order_lines(:'o11', jsonb_build_array(:'beer2'::jsonb));
set test.uid = :'C';
select paying_at is not null from begin_payment(:'o11');
select t_err(format('select close_shift(%L, %L::jsonb, %L)', :'sh1', '{"500000":3}', ''), 'Còn đơn đang thanh toán%', 'close waits for the payment screen') as check;
select paying_at is null from cancel_payment(:'o11');

select t_err(format('select close_shift(%L, %L::jsonb, %L)', :'sh1', '{"300000":1}', ''), 'Mệnh giá không hợp lệ%', 'only real notes') as check;
select t_err(format('select close_shift(%L, %L::jsonb, %L)', :'sh1', '{"500000":-1}', ''), 'Số tờ không hợp lệ%', 'counts are whole and not negative') as check;
-- counted 1.980.000 (5.000 short)
select t_err(format('select close_shift(%L, %L::jsonb, %L)', :'sh1', '{"500000":3,"200000":2,"50000":1,"20000":1,"10000":1,"1000":0}', ' '), 'Két lệch%ghi lý do', 'a difference needs a note') as check;
select counted_cash, expected_cash, counted_cash - expected_cash as diff, counted_detail
from close_shift(:'sh1', '{"500000":3,"200000":2,"50000":1,"20000":1,"10000":1,"1000":0}'::jsonb, 'Thối nhầm 5.000 bàn 10');
select t_ok((select counted_cash = 1980000 and expected_cash = 1985000 and closed_by is not null and counted_detail = '{"500000":3,"200000":2,"50000":1,"20000":1,"10000":1}'::jsonb
             from shifts where id = :'sh1'), 'closed: counted 1.980.000 vs expected 1.985.000, zero counts dropped') as check;
select t_err(format('select close_shift(%L, %L::jsonb, %L)', :'sh1', '{}', 'x'), 'Ca đã chốt', 'a closed shift stays closed') as check;
select t_err(format('select pay_order(%L, 0, %L::jsonb)', :'o11', '[{"method":"cash","amount":50000}]'), 'Chưa mở ca%', 'no payment after the shift closed') as check;

-- next shift: exact count closes without a note
select id as sh2 from open_shift(1980000) \gset
select bill_no from pay_order(:'o11', 0, '[{"method":"card","amount":50000,"ref":"4321"}]'::jsonb);
select t_ok((shift_summary(:'sh2') -> 'by_method' ->> 'card')::int = 50000 and (shift_summary(:'sh2') ->> 'expected_cash')::int = 1980000, 'card sale does not change the cash expected') as check;
select t_ok((select closed_at is not null from close_shift(:'sh2', '{"500000":3,"200000":2,"50000":1,"20000":1,"10000":1}'::jsonb)), 'exact count closes without a note') as check;

reset role;
select action, count(*) from audit_log where action in ('open_shift', 'close_shift', 'discount', 'reprint') group by 1 order by 1;
select 'all 0005 checks passed' as result;
