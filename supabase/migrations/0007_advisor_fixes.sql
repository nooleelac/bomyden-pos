-- Bò Mỹ Đen POS 0007: fixes from the Supabase security advisor on the first real project (test project, 17/10/2026).
--
-- 1. shift_summary(shift) was security definer with no role check, so any API caller holding a shift id
--    (even the anon key with no sign-in) could read that shift's money totals. Now cashier/manager only,
--    the same rule as the read_money policies on bills, payments and shifts.
-- 2. Fixed search_path on the six helper functions that had none (advisor 0011 function_search_path_mutable).
-- 3. No API call is made before the device signs in (anonymously or not), so the anon role needs no function at all:
--    execute is taken from anon on every function in public, now and for functions created later
--    (advisor 0028 anon_security_definer_function_executable). Signed-in devices use the authenticated role.
--
-- Part 3 is REVOKE only. On a Supabase project where the MCP tool holds REVOKE for confirmation, it can be pasted
-- in the SQL Editor on its own (see the "part 2" marker below).

-- ---------------------------------------------------------------- part 1

create or replace function shift_summary(p_shift uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v jsonb;
begin
  if not coalesce(reader_role() in ('cashier', 'manager'), false) then
    raise exception 'Chỉ thu ngân hoặc quản lý được xem tổng ca';
  end if;
  with b as (select * from bills where shift_id = p_shift),
       p as (select pm.* from payments pm join b on b.id = pm.bill_id)
  select jsonb_build_object(
    'bills', (select count(*) from b),
    'subtotal', (select coalesce(sum(subtotal), 0) from b),
    'discount', (select coalesce(sum(discount), 0) from b),
    'service_charge', (select coalesce(sum(service_charge), 0) from b),
    'rounding', (select coalesce(sum(rounding), 0) from b),
    'sales', (select coalesce(sum(total), 0) from b),
    'vat_total', (select coalesce(sum(vat_total), 0) from b),
    'by_method', jsonb_build_object(
      'cash', (select coalesce(sum(amount), 0) from p where method = 'cash'),
      'bank', (select coalesce(sum(amount), 0) from p where method = 'bank'),
      'card', (select coalesce(sum(amount), 0) from p where method = 'card')),
    'cash_tendered', (select coalesce(sum(coalesce(tendered, amount)), 0) from p where method = 'cash'),
    'change_given', (select coalesce(sum(coalesce(tendered, amount) - amount), 0) from p where method = 'cash'),
    'opening_float', s.opening_float,
    'expected_cash', s.opening_float + (select coalesce(sum(amount), 0) from p where method = 'cash'))
  into v
  from shifts s where s.id = p_shift;
  return v;
end $$;

alter function _token() set search_path = public, extensions;
alter function _hash(text) set search_path = public, extensions;
alter function _void_reason(text, text) set search_path = public;
alter function pin_problem(text) set search_path = public;
alter function server_now() set search_path = public;
alter function ticket_key(order_items) set search_path = public;

-- ---------------------------------------------------------------- part 2 (REVOKE only)

-- Functions run through PUBLIC's default execute right, which anon inherits. Each function that authenticated may run
-- today gets an explicit grant to authenticated, then PUBLIC and anon lose it. Functions already closed to authenticated
-- (the _internal ones, admin_*) stay closed. service_role and the owner keep theirs.
do $$
declare
  f regprocedure;
begin
  for f in select p.oid::regprocedure from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prokind = 'f' loop
    if has_function_privilege('authenticated', f, 'execute') then
      execute format('grant execute on function %s to authenticated', f);
    end if;
    execute format('revoke execute on function %s from public, anon', f);
  end loop;
end $$;
-- Functions added later by Supabase's default grants: not to anon. (New migrations still revoke PUBLIC themselves,
-- as 0006 does.)
alter default privileges in schema public revoke execute on functions from anon;
