-- Test for 0006 (devices, PIN sign-in, idle sign-out, manager approval, lockout, audit, RLS by role) on plain
-- Postgres 16 after all migrations, with the Supabase stand-ins. Devices are auth users (test.uid); the staff
-- session token travels in the request.headers setting the way PostgREST passes the x-staff-session header.
-- Run: supabase/tests/run.sh 0006_staff_auth_test.sql
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
-- the device's staff session, as the x-staff-session request header
create function t_as(p_token text) returns text language sql as $$
  select set_config('request.headers', case when p_token is null then '' else json_build_object('x-staff-session', p_token)::text end, false)
$$;
grant execute on function t_ok(boolean, text), t_err(text, text, text), t_as(text) to authenticated, anon;

-- ---------------------------------------------------------------- bootstrap (SQL editor = superuser)
\set D1 '00000000-0000-0000-0000-0000000000d1'
\set D2 '00000000-0000-0000-0000-0000000000d2'
\set DK '00000000-0000-0000-0000-0000000000dc'
\set NEW '00000000-0000-0000-0000-0000000000ee'
insert into auth.users values (:'D1'), (:'D2'), (:'DK'), (:'NEW');
select admin_add_staff('Chủ quán', 'owner', '2468') as s_owner \gset
select admin_add_staff('Quản lý Hà', 'manager', '1397') as s_mgr \gset
select admin_add_staff('Hùng', 'waiter', '2580') as s_hung \gset
select admin_add_staff('Lan', 'cashier', '3690') as s_lan \gset
select admin_add_staff('Bếp nướng', 'kitchen', '4826') as s_bep \gset
select admin_create_device_code('Máy quầy', 'pos') as code1 \gset
select t_ok((select pin_hash like '$2a$08$%' and pin_hash not like '%2468%' from staff_secrets where staff_id = :'s_owner'), 'PIN stored as a bcrypt hash only') as check;
select t_ok(pin_problem('1111') is not null and pin_problem('1234') is not null and pin_problem('98765') is not null and pin_problem('890123') is not null
            and pin_problem('123') is not null and pin_problem('12a4') is not null and pin_problem('2580') is null, 'weak or malformed PINs refused') as check;

insert into areas (name, sort) values ('Tầng 1', 1);
insert into tables (area_id, name, sort) select a.id, n::text, n from areas a, generate_series(1, 6) n;
select id as t1 from tables where name = '1' \gset
select id as t2 from tables where name = '2' \gset
select id as t3 from tables where name = '3' \gset
select id as t4 from tables where name = '4' \gset
insert into menu_categories (name, default_station_id) select 'Bò', id from stations where code = 'grill' returning id as c_bo \gset
insert into menu_items (category_id, name, short_name, price) values (:'c_bo', 'Bò lúc lắc', 'LÚC LẮC', 150000) returning id as luc_lac \gset
select format('{"menu_item_id":"%s","qty":2}', :'luc_lac') as two \gset

set role authenticated;

-- ---------------------------------------------------------------- the API cannot reach the bootstrap or the hashes
set test.uid = :'D1';
select t_err('select admin_create_device_code(''x'')', 'permission denied%', 'admin_create_device_code is SQL-editor only') as check;
select t_err('select admin_add_staff(''x'', ''owner'', ''2468'')', 'permission denied%', 'admin_add_staff is SQL-editor only') as check;
select t_err('select * from staff_secrets', 'permission denied%', 'staff_secrets unreadable through the API') as check;
select t_err('select signin_roster()', 'Máy này chưa được đăng ký%', 'unregistered device sees no names') as check;

-- ---------------------------------------------------------------- register devices
select t_err('select register_device(''AAAA-BBBB'')', 'Mã đăng ký máy không đúng%', 'wrong device code') as check;
select name, kind from register_device(lower(:'code1'));
select t_err(format('select register_device(%L)', :'code1'), 'Máy này đã được đăng ký', 'a device registers once') as check;
set test.uid = :'D2';
select t_err(format('select register_device(%L)', :'code1'), 'Mã đăng ký máy không đúng%', 'a code is single-use') as check;
select t_err('select count(*) from signin_roster()', 'Máy này chưa được đăng ký%', 'D2 not registered yet') as check;
select t_ok(my_device() is null, 'my_device() is null for a plain user') as check;

set test.uid = :'D1';
select t_ok((select array_agg(name order by name) from signin_roster()) = '{Bếp nướng,Chủ quán,Hùng,Lan,"Quản lý Hà"}', 'POS roster lists everyone active') as check;
select t_ok(my_staff_id() is null and my_role() is null, 'a device without a signed-in person is nobody') as check;
select t_err(format('select open_table(%L, 2)', :'t1'), 'Đăng nhập trước%', 'no order without a sign-in') as check;
select t_ok((select count(*) from orders) = 0 and (select count(*) from staff) = 0, 'no reads without a sign-in') as check;

-- ---------------------------------------------------------------- PIN sign-in and lockout (5 misses -> 5 minutes)
select t_ok((staff_sign_in(:'s_hung', '0000') ->> 'attempts_left')::int = 4, 'wrong PIN: 4 tries left') as check;
select staff_sign_in(:'s_hung', '1111') ->> 'error' as e2 \gset
select staff_sign_in(:'s_hung', 'abcd') ->> 'error' as e3 \gset
select staff_sign_in(:'s_hung', '9999') ->> 'error' as e4 \gset
select t_ok(:'e4' = 'Mã PIN không đúng (còn 1 lần thử)', 'failed tries are counted (committed even though sign-in failed)') as check;
select t_ok((staff_sign_in(:'s_hung', '8888') ->> 'locked_until') is not null, '5th miss locks the PIN') as check;
select t_ok((staff_sign_in(:'s_hung', '2580') ->> 'error') like 'Nhập sai quá nhiều lần: khoá đến%', 'right PIN refused while locked') as check;
select t_ok((select locked_until is not null from signin_roster() where id = :'s_hung'), 'roster shows the lock') as check;
reset role;
select t_ok((select count(*) from audit_log where staff_id = :'s_hung' and action = 'pin_failed') = 4
            and (select count(*) from audit_log where staff_id = :'s_hung' and action = 'pin_locked') = 1, 'failures and the lock are in the audit log') as check;
update staff_secrets set locked_until = now() - interval '1 second' where staff_id = :'s_hung';   -- 5 minutes later
set role authenticated;
select staff_sign_in(:'s_hung', '2580') as w_in \gset
select t_ok((:'w_in'::jsonb ->> 'ok')::boolean and (:'w_in'::jsonb #>> '{staff,role}') = 'waiter'
            and (:'w_in'::jsonb ->> 'expires_at')::timestamptz between now() + interval '4 minutes' and now() + interval '6 minutes',
            'after the lock: signed in, idle sign-out in 5 minutes') as check;
select :'w_in'::jsonb ->> 'token' as tok_w \gset
reset role;
select t_ok((select failed_count = 0 and locked_until is null from staff_secrets where staff_id = :'s_hung'), 'success clears the counter') as check;
select t_ok((select token_hash <> :'tok_w' and length(token_hash) = 64 from staff_sessions where staff_id = :'s_hung'), 'only the token hash is stored') as check;
set role authenticated;

-- ---------------------------------------------------------------- the session token is the identity
select t_as(:'tok_w') \g /dev/null
select t_ok(my_staff_id() = :'s_hung' and my_role() = 'waiter', 'x-staff-session header -> Hùng, waiter') as check;
select id as o1 from open_table(:'t1', 2) \gset
select count(*) as sent from send_order_lines(:'o1', jsonb_build_array(:'two'::jsonb));
select t_ok((select opened_by = :'s_hung' from orders where id = :'o1'), 'order opened by Hùng') as check;
select t_as(null) \g /dev/null
select t_ok((select count(*) from orders) = 1, 'Realtime-style read without the header: device session still reads') as check;
select t_err(format('select open_table(%L, 2)', :'t2'), 'Đăng nhập trước%', 'writes need the header') as check;
select t_as('not-a-token') \g /dev/null
select t_ok(my_staff_id() is null, 'a wrong token is nobody') as check;
set test.uid = :'D2';
select t_as(:'tok_w') \g /dev/null
select t_ok(my_staff_id() is null, 'a token only works on the device it was issued to') as check;
set test.uid = :'D1';
select t_as(:'tok_w') \g /dev/null
select t_ok(touch_session() > now() + interval '4 minutes', 'touch_session pushes the idle sign-out back') as check;

-- money is for cashiers and managers
select t_ok((select count(*) from bills) = 0 and (select count(*) from shifts) = 0, 'waiter reads no bills or shifts (RLS)') as check;
select t_ok((select count(*) from audit_log) = 0, 'waiter reads no audit log') as check;
select t_err('select staff_admin_list()', 'Chưa có quyền%', 'waiter cannot open the staff list') as check;
select t_err(format('select staff_save(null, %L, %L, %L)', 'Tý', 'waiter', '7531'), 'Chưa có quyền%', 'waiter cannot add staff') as check;
select t_err(format('update staff set role = %L where id = %L', 'manager', :'s_hung'), 'permission denied%', 'nobody edits staff rows directly') as check;
select t_ok((verify_manager_pin(:'s_hung', '2580', 'void_order', :'o1') ->> 'error') = 'Người này chưa có quyền duyệt việc này', 'a waiter cannot approve') as check;

-- ---------------------------------------------------------------- void after Gửi bếp needs a manager (default void_approval = 'sent')
select id as l1 from order_items where order_id = :'o1' \gset
select t_err(format('select void_item(%L, 1, %L)', :'l1', 'Khách đổi ý'), 'Huỷ món đã gửi bếp: cần quản lý nhập mã PIN', 'waiter cannot void a sent line alone') as check;
select t_ok((verify_manager_pin(:'s_mgr', '0000', 'void_item', :'o1', jsonb_build_object('line', :'l1')) ->> 'attempts_left')::int = 4, 'wrong manager PIN counts') as check;
select verify_manager_pin(:'s_mgr', '1397', 'void_item', :'o1', jsonb_build_object('line', :'l1')) as appr \gset
select t_ok((:'appr'::jsonb ->> 'ok')::boolean and (:'appr'::jsonb #>> '{manager,name}') = 'Quản lý Hà'
            and (:'appr'::jsonb ->> 'expires_at')::timestamptz <= now() + interval '2 minutes', 'approval token for 2 minutes') as check;
select :'appr'::jsonb ->> 'token' as tok_appr \gset
select t_err(format('select void_item(%L, 1, %L, null, %L)', :'l1', 'Khách đổi ý', 'forged'), 'Mã duyệt của quản lý không hợp lệ%', 'a made-up token is refused') as check;
select qty, status, void_stage from void_item(:'l1', 1, 'Khách đổi ý', null, :'tok_appr');
select t_err(format('select void_item(%L, 1, %L, null, %L)', :'l1', 'Khách đổi ý', :'tok_appr'), 'Mã duyệt của quản lý không hợp lệ%', 'a token is single-use') as check;
select t_ok((select qty from order_items where id = :'l1') = 1 and (select count(*) from kitchen_notices where kind = 'void') = 1, 'bớt 1 of 2, kitchen told') as check;

-- the token is bound to the asker, the order and the line
select verify_manager_pin(:'s_mgr', '1397', 'void_item', :'o1', jsonb_build_object('line', :'l1')) ->> 'token' as tok_appr2 \gset
select t_err(format('select verify_manager_pin(%L, %L, %L, %L, %L)', :'s_mgr', '1397', 'void_item', :'o1', jsonb_build_object('line', gen_random_uuid())),
             'Món cần duyệt không thuộc đơn', 'approval names a line of the order') as check;

-- a second device: Lan signs in (cashier)
reset role;
select _new_device_code('Máy thu ngân', 'pos', :'s_owner') ->> 'code' as code2 \gset
set role authenticated;
set test.uid = :'D2';
select t_as(null) \g /dev/null
select name from register_device(:'code2');
select staff_sign_in(:'s_lan', '3690') ->> 'token' as tok_c \gset
select t_as(:'tok_c') \g /dev/null
select t_err(format('select void_item(%L, 1, %L, null, %L)', :'l1', 'Khách đổi ý', :'tok_appr2'), 'Mã duyệt của quản lý không hợp lệ%', 'another person cannot use Hùng''s token') as check;
select id as sh from open_shift(0) \gset
select t_ok((select count(*) from shifts) = 1, 'cashier reads shifts') as check;

-- expired approval
reset role;
update approvals set expires_at = now() - interval '1 second' where token_hash = _hash(:'tok_appr2');
set role authenticated;
set test.uid = :'D1';
select t_as(:'tok_w') \g /dev/null
select t_err(format('select void_item(%L, 1, %L, null, %L)', :'l1', 'Khách đổi ý', :'tok_appr2'), 'Mã duyệt của quản lý không hợp lệ%', 'an expired token is refused') as check;

-- ---------------------------------------------------------------- huỷ cả đơn (void_order)
select id as o2 from open_table(:'t2', 3) \gset
select count(*) as sent from send_order_lines(:'o2', jsonb_build_array(:'two'::jsonb, :'two'::jsonb));
select t_err(format('select void_order(%L, %L)', :'o2', 'Khách đổi ý'), 'Huỷ đơn đã gửi bếp: cần quản lý%', 'cancelling a sent order needs a manager') as check;
select verify_manager_pin(:'s_owner', '2468', 'void_order', :'o2') ->> 'token' as tok_o2 \gset
select t_err(format('select void_order(%L, %L, null, %L)', :'o1', 'Khách đổi ý', :'tok_o2'), 'Mã duyệt của quản lý không hợp lệ%', 'token for table 2 does not cancel table 1') as check;
select status from void_order(:'o2', 'Khách đổi ý', null, :'tok_o2');
select t_ok((select count(*) from order_items where order_id = :'o2' and status <> 'void') = 0
            and (select count(*) from kitchen_notices where order_id = :'o2' and kind = 'void') = 2
            and (select count(*) from order_tables where order_id = :'o2' and left_at is null) = 0, 'every line void, kitchen told, table free') as check;

-- shop setting 'started': a line the kitchen has not started is voided without a manager
reset role;
update shop_settings set void_approval = 'started';
set role authenticated;
select id as o3 from open_table(:'t3', 2) \gset
select id as l3 from send_order_lines(:'o3', jsonb_build_array(:'two'::jsonb)) \gset
select status from void_item(:'l3', 1, 'Gọi nhầm');
reset role;
update shop_settings set void_approval = 'sent';
set role authenticated;

-- ---------------------------------------------------------------- discount approval is bound to the amount
select id as o4 from open_table(:'t4', 2) \gset
select count(*) as sent from send_order_lines(:'o4', jsonb_build_array(:'two'::jsonb));
set test.uid = :'D2';
select t_as(:'tok_c') \g /dev/null
select t_err(format('select pay_order(%L, 30000, %L::jsonb, %L)', :'o4', '[{"method":"cash","amount":270000}]', 'Khách quen'),
             'Giảm giá hoá đơn cần quản lý nhập mã PIN', 'cashier discount needs a manager') as check;
select t_err(format('select verify_manager_pin(%L, %L, %L, %L)', :'s_mgr', '1397', 'discount', :'o4'), 'Ghi số tiền giảm%', 'discount approval names an amount') as check;
select verify_manager_pin(:'s_mgr', '1397', 'discount', :'o4', '{"amount":15000}') ->> 'token' as tok_d \gset
select t_err(format('select pay_order(%L, 30000, %L::jsonb, %L, %L, %L)', :'o4', '[{"method":"cash","amount":270000}]', 'Khách quen', 'Quầy 1', :'tok_d'),
             'Mã duyệt của quản lý không hợp lệ%', 'approved 15.000, asked 30.000: refused') as check;
select total, discount from pay_order(:'o4', 15000, '[{"method":"cash","amount":285000}]', 'Khách quen', 'Quầy 1', :'tok_d');
select t_ok((select count(*) from bills) = 1, 'cashier reads bills') as check;

-- ---------------------------------------------------------------- staff management (manager vs owner)
set test.uid = :'D1';
select staff_sign_in(:'s_mgr', '1397') ->> 'token' as tok_m \gset
select t_as(:'tok_w') \g /dev/null
select t_ok(my_staff_id() is null, 'signing in on the device ends the previous person''s session') as check;
select t_as(:'tok_m') \g /dev/null
select t_ok(my_role() = 'manager' and my_real_role() = 'manager', 'Hà is a manager') as check;
select t_ok((select count(*) from staff_admin_list()) = 5 and (select has_pin from staff_admin_list() where name = 'Hùng'), 'staff list with PIN status') as check;
select t_err(format('select staff_save(null, %L, %L, %L)', 'Tý', 'waiter', '1234'), 'Mã PIN không được là dãy%', 'weak PIN refused on add') as check;
select t_err(format('select staff_save(null, %L, %L)', 'Tý', 'waiter'), 'Đặt mã PIN%', 'new staff need a PIN') as check;
select id as s_ty from staff_save(null, 'Tý', 'waiter', '7531') \gset
select t_err(format('select staff_save(null, %L, %L, %L)', 'tý', 'cashier', '7532'), 'Đã có nhân viên tên%', 'names stay unique among active staff') as check;
select t_err(format('select staff_save(null, %L, %L, %L)', 'Minh', 'manager', '7531'), 'Chỉ chủ quán được thêm quản lý%', 'a manager cannot add a manager') as check;
select t_err(format('select staff_save(%L, %L, %L)', :'s_lan', 'Lan', 'manager'), 'Chỉ chủ quán%', 'a manager cannot promote to manager') as check;
select t_err(format('select staff_set_active(%L, false)', :'s_owner'), 'Chỉ chủ quán được khoá%', 'a manager cannot disable the owner') as check;
select t_err(format('select staff_reset_pin(%L, %L)', :'s_owner', '9753'), 'Chỉ chủ quán%', 'a manager cannot reset the owner''s PIN') as check;
select t_err(format('select staff_set_active(%L, false)', :'s_mgr'), 'Không tự khoá%', 'nobody disables themselves') as check;
select staff_reset_pin(:'s_mgr', '1398');
select t_ok(my_staff_id() = :'s_mgr', 'own PIN reset keeps this session') as check;
select staff_reset_pin(:'s_lan', '3691');
select role from staff_save(:'s_hung', 'Hùng', 'cashier');
select active from staff_set_active(:'s_ty', false);
select t_ok((select count(*) from signin_roster() where id = :'s_ty') = 0, 'disabled staff leave the roster') as check;
select t_ok((select count(*) from devices) = 2 and (select count(*) from audit_log where action in ('staff_add', 'staff_edit', 'staff_off', 'pin_reset')) = 5,
            'manager reads devices and the staff changes in the audit log') as check;
set test.uid = :'D2';
select t_as(:'tok_c') \g /dev/null
select t_ok(my_staff_id() is null, 'PIN reset by a manager signs Lan out') as check;

-- owner: everything a manager can, plus managers and owners
set test.uid = :'D1';
select staff_sign_in(:'s_owner', '2468') ->> 'token' as tok_o \gset
select t_as(:'tok_o') \g /dev/null
select t_ok(my_role() = 'manager' and my_real_role() = 'owner', 'owner counts as manager in older checks') as check;
select id as s_minh from staff_save(null, 'Minh', 'manager', '8642') \gset
update shop_settings set idle_signout_min = 10;
select t_ok((select idle_signout_min from shop_settings) = 10, 'owner changes shop settings (manager policy)') as check;
select t_err(format('select staff_set_active(%L, false)', :'s_owner'), 'Không tự khoá%', 'the owner cannot disable themselves') as check;
select (create_device_code('Màn bếp', 'kitchen')) ->> 'code' as code_k \gset
select t_ok(:'code_k' ~ '^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$', 'device code like K7Q2-M9XD') as check;

-- ---------------------------------------------------------------- kitchen display stays signed in
set test.uid = :'DK';
select t_as(null) \g /dev/null
select kind from register_device(:'code_k');
select t_ok((select array_agg(name order by name) from signin_roster()) = '{Bếp nướng,Chủ quán,Minh,"Quản lý Hà"}', 'kitchen roster: kitchen accounts and managers') as check;
select t_ok((staff_sign_in(:'s_lan', '3691') ->> 'error') = 'Máy bếp chỉ đăng nhập người có quyền Màn hình bếp', 'cashier cannot sign in on the kitchen screen') as check;
select staff_sign_in(:'s_bep', '4826') as k_in \gset
select t_ok((:'k_in'::jsonb ->> 'expires_at') is null, 'kitchen account: no idle sign-out') as check;
select t_as(:'k_in'::jsonb ->> 'token') \g /dev/null
select t_ok(touch_session() is null, 'touching a kitchen session keeps it open-ended') as check;
select t_err(format('select open_table(%L, 2)', :'t1'), 'Chưa có quyền%', 'kitchen cannot open tables') as check;
select t_ok((select count(*) from bills) = 0, 'kitchen reads no bills') as check;
select t_ok((select count(*) from order_items) > 0, 'kitchen reads the lines') as check;

-- idle sign-out on the POS
set test.uid = :'D1';
select t_as(:'tok_o') \g /dev/null
reset role;
update staff_sessions set expires_at = now() - interval '1 second' where token_hash = _hash(:'tok_o');
set role authenticated;
select t_ok(my_staff_id() is null, 'idle session is over') as check;
select t_err('select touch_session()', 'Phiên đăng nhập đã hết%', 'touch after idle sign-out fails') as check;
select t_ok((select count(*) from orders) = 0, 'and the device reads nothing') as check;

-- sign out; disable a device
select staff_sign_in(:'s_owner', '2468') ->> 'token' as tok_o2s \gset
select t_as(:'tok_o2s') \g /dev/null
select active from device_set_active((select id from devices where name = 'Màn bếp'), false);
select staff_sign_out();
select t_ok(my_staff_id() is null, 'signed out') as check;
set test.uid = :'DK';
select t_as(:'k_in'::jsonb ->> 'token') \g /dev/null
select t_ok(my_staff_id() is null, 'disabled device: kitchen session ended') as check;
select t_err('select count(*) from signin_roster()', 'Máy này chưa được đăng ký hoặc đã bị khoá', 'disabled device shows no names') as check;

-- anon (not even a device) cannot call the sign-in functions
set role anon;
select t_err(format('select staff_sign_in(%L, %L)', :'s_hung', '2580'), 'permission denied%', 'anon cannot sign in') as check;
set role authenticated;

-- ---------------------------------------------------------------- the audit trail: who, what, when, approved by
reset role;
select t_ok((select count(*) from audit_log a where a.action = 'void_item' and a.staff_id = :'s_hung' and a.approved_by = :'s_mgr' and a.device_id is not null) = 1,
            'void_item: Hùng, approved by Hà, on Máy quầy') as check;
select t_ok((select count(*) from audit_log where action = 'void_item' and approved_by is null) = 1, 'void of an unstarted line with void_approval=started: no approver') as check;
select t_ok((select approved_by = :'s_owner' and (detail ->> 'lines')::int = 2 from audit_log where action = 'void_order'), 'void_order approved by the owner') as check;
select t_ok((select staff_id = :'s_lan' and approved_by = :'s_mgr' and (detail ->> 'amount')::int = 15000 from audit_log where action = 'discount'), 'discount: Lan, approved by Hà') as check;
select t_ok((select count(*) from audit_log where action = 'approval') = 4, 'every approval logged') as check;
select t_ok((select count(*) from audit_log where action = 'sign_in') = 6 and (select count(*) from audit_log where action = 'sign_out') = 1, 'sign-ins and sign-outs logged') as check;
select action, count(*) from audit_log group by 1 order by 1;

select 'all 0006 checks passed' as result;
