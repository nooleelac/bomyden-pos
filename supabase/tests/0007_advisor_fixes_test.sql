-- Test for 0007 (advisor fixes) on plain Postgres 16 after all migrations, with the Supabase stand-ins.
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
grant execute on function t_ok(boolean, text), t_err(text, text, text) to anon, authenticated;

-- ---------------------------------------------------------------- grants (superuser)
select t_ok(not exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname not in ('t_ok', 't_err')
                        and has_function_privilege('anon', p.oid, 'execute')), 'anon runs no function in public') as check;
select t_ok(has_function_privilege('authenticated', 'send_order_lines(uuid, jsonb, uuid, text)', 'execute')
            and has_function_privilege('authenticated', 'my_role()', 'execute')
            and has_function_privilege('authenticated', 'pay_order(uuid, int, jsonb, text, text, text)', 'execute'),
            'signed-in devices keep the API functions') as check;
select t_ok(not has_function_privilege('authenticated', '_set_pin(uuid, text)', 'execute')
            and not has_function_privilege('authenticated', 'admin_create_device_code(text, text)', 'execute'),
            'internal and SQL-editor-only functions stay closed') as check;
select t_ok((select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace
             and p.proname in ('_token', '_hash', '_void_reason', 'pin_problem', 'server_now', 'ticket_key')
             and exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%')) = 6, 'helper functions have a fixed search_path') as check;

-- ---------------------------------------------------------------- shift_summary by role
insert into auth.users values ('00000000-0000-0000-0000-000000000001'), ('00000000-0000-0000-0000-000000000002');
insert into staff (user_id, name, role) values
  ('00000000-0000-0000-0000-000000000001', 'Hùng', 'waiter'),
  ('00000000-0000-0000-0000-000000000002', 'Lan', 'cashier');
set role authenticated;
set test.uid = '00000000-0000-0000-0000-000000000002';
select id as sh from open_shift(1000000) \gset
select t_ok((shift_summary(:'sh') ->> 'expected_cash')::int = 1000000, 'cashier reads the shift totals') as check;
set test.uid = '00000000-0000-0000-0000-000000000001';
select t_err(format('select shift_summary(%L)', :'sh'), 'Chỉ thu ngân hoặc quản lý%', 'waiter cannot read shift totals') as check;
set test.uid = '';
select t_err(format('select shift_summary(%L)', :'sh'), 'Chỉ thu ngân hoặc quản lý%', 'a device with no staff session cannot read them') as check;
reset role;
set role anon;
select t_err(format('select shift_summary(%L)', :'sh'), 'permission denied%', 'anon cannot call it at all') as check;
reset role;
