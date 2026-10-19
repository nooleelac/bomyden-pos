-- Test for 0008 (one-call floor state, policies per query) on plain Postgres 16 after all migrations, with the Supabase stand-ins.
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

-- ---------------------------------------------------------------- policies (superuser)
select t_ok(not exists (select 1 from pg_policies where schemaname = 'public'
              and (coalesce(qual, '') ~ '(?<!SELECT )(reader_role|my_role|my_staff_id)\(\)'
                or coalesce(with_check, '') ~ '(?<!SELECT )(reader_role|my_role|my_staff_id)\(\)')),
            'every policy works the caller out once per query') as check;
select t_ok(exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'bills' and policyname = 'read_money'
              and qual like '%SELECT reader_can(%'), 'bills read by permission (0009), once per query') as check;
select t_ok(not has_function_privilege('anon', 'get_floor_state()', 'execute')
            and has_function_privilege('authenticated', 'get_floor_state()', 'execute'), 'get_floor_state for signed-in devices only') as check;

-- ---------------------------------------------------------------- what each role gets
insert into auth.users values ('00000000-0000-0000-0000-000000000001'), ('00000000-0000-0000-0000-000000000002');
insert into staff (user_id, name, role) values
  ('00000000-0000-0000-0000-000000000001', 'Hùng', 'waiter'),
  ('00000000-0000-0000-0000-000000000002', 'Lan', 'cashier');
set role authenticated;
set test.uid = '00000000-0000-0000-0000-000000000002';
select id as sh from open_shift(1000000) \gset
select t_ok(jsonb_typeof(get_floor_state() -> 'now') = 'string', 'the server clock comes with the state') as check;
select t_ok((select bool_and(jsonb_typeof(get_floor_state() -> k) = 'array')
               from unnest(array['shop', 'stations', 'areas', 'tables', 'staff', 'orders', 'order_tables', 'items', 'notices', 'tickets', 'shifts', 'bills']) k),
            'every list is an array, empty ones too') as check;
select t_ok(get_floor_state() -> 'shifts' @> jsonb_build_array(jsonb_build_object('id', :'sh')), 'cashier sees the open shift') as check;
select t_ok(jsonb_array_length(get_floor_state() -> 'staff') = 2 and not (get_floor_state() -> 'staff' -> 0 ? 'user_id'),
            'staff come as id and name only') as check;
set test.uid = '00000000-0000-0000-0000-000000000001';
select t_ok(get_floor_state() -> 'shifts' = '[]' and get_floor_state() -> 'bills' = '[]', 'waiter sees no shifts or bills') as check;
select t_ok(jsonb_array_length(get_floor_state() -> 'staff') = 2, 'waiter reads staff names') as check;
set test.uid = '';
select t_ok(get_floor_state() -> 'staff' = '[]', 'a device with no staff session reads nothing') as check;
reset role;
set role anon;
select t_err('select get_floor_state()', 'permission denied%', 'anon cannot call it') as check;
reset role;
