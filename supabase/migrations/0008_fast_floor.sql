-- Bò Mỹ Đen POS 0008: faster floor loads and realtime.
--
-- 1. get_floor_state(): everything the floor, kitchen and cashier screens load, in one call. Until now the app made
--    about 6 round trips one after another (server_now, 9 tables, bills, payments, lines and tables, modifiers) on
--    every change. Same filters as before: open orders and those closed in the last 4 hours, notices and tickets of
--    the last 4 hours, shifts open or closed in the last 7 days, bills paid in the last 4 hours or in an open shift.
--    security invoker: the read policies still decide what each role sees (bills, payments, shifts stay hidden from
--    waiters and the kitchen).
-- 2. Read and write policies call reader_role() / my_role() through (select …), so Postgres works the caller out once
--    per query instead of once per row (Supabase advisor 0003 auth_rls_initplan). This also speeds up Realtime, which
--    checks the policies for every subscriber on every change.
-- 3. Indexes for the time filters above.

-- ---------------------------------------------------------------- 1. one call for the floor state

create or replace function get_floor_state() returns jsonb
language sql stable security invoker set search_path = public as $$
  with p as (select now() as t_now, now() - interval '4 hours' as since, now() - interval '7 days' as week),
  o as (select x.* from orders x, p where x.status = 'open' or x.closed_at > p.since),
  sh as (select x.* from shifts x, p where x.closed_at is null or x.closed_at > p.week),
  b as (select x.* from bills x, p
         where x.paid_at > p.since or x.shift_id in (select id from sh where closed_at is null)),
  i as (select x.* from order_items x where x.order_id in (select id from o))
  select jsonb_build_object(
    'now', (select t_now from p),
    'shop', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from (select * from shop_settings limit 1) x),
    'stations', (select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'sla_warn_min', x.sla_warn_min, 'sla_late_min', x.sla_late_min)), '[]')
                   from stations x),
    'areas', (select coalesce(jsonb_agg(to_jsonb(x) order by x.sort), '[]') from areas x),
    'tables', (select coalesce(jsonb_agg(to_jsonb(x) order by x.sort), '[]') from tables x),
    'staff', (select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'name', x.name)), '[]') from staff x),
    'orders', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from o x),
    'order_tables', (select coalesce(jsonb_agg(jsonb_build_object('order_id', x.order_id, 'table_id', x.table_id, 'suffix', x.suffix, 'joined_at', x.joined_at)), '[]')
                       from order_tables x where x.left_at is null and x.order_id in (select id from o)),
    'items', (select coalesce(jsonb_agg(to_jsonb(x) || jsonb_build_object('mods',
                (select coalesce(jsonb_agg(to_jsonb(m)), '[]') from order_item_modifiers m where m.order_item_id = x.id))), '[]')
                from i x),
    'notices', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from kitchen_notices x, p where x.created_at > p.since),
    'tickets', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from ticket_states x, p where x.bumped_at > p.since or x.recalled_at > p.since),
    'shifts', (select coalesce(jsonb_agg(to_jsonb(x) order by x.opened_at), '[]') from sh x),
    'bills', (select coalesce(jsonb_agg(to_jsonb(x) || jsonb_build_object('payments',
                (select coalesce(jsonb_agg(to_jsonb(y)), '[]') from payments y where y.bill_id = x.id)) order by x.paid_at), '[]')
                from b x))
$$;

revoke execute on function get_floor_state() from public, anon;
grant execute on function get_floor_state() to authenticated;

-- ---------------------------------------------------------------- 2. policies work the caller out once per query

do $$
declare
  r record;
  v_using text;
  v_check text;
  f text;
begin
  for r in select tablename, policyname, qual, with_check from pg_policies where schemaname = 'public' loop
    -- the deparsed text may name the schema ("public.reader_role()"); the functions live in public either way
    v_using := replace(r.qual, 'public.', '');
    v_check := replace(r.with_check, 'public.', '');
    foreach f in array array['reader_role', 'my_role', 'my_staff_id'] loop
      -- already wrapped ones read "( SELECT reader_role() AS reader_role)": leave those alone
      if v_using is not null and v_using not like '%SELECT ' || f || '()%' then
        v_using := replace(v_using, f || '()', '(select ' || f || '())');
      end if;
      if v_check is not null and v_check not like '%SELECT ' || f || '()%' then
        v_check := replace(v_check, f || '()', '(select ' || f || '())');
      end if;
    end loop;
    if v_using is distinct from replace(r.qual, 'public.', '') then
      execute format('alter policy %I on %I using (%s)', r.policyname, r.tablename, v_using);
    end if;
    if v_check is distinct from replace(r.with_check, 'public.', '') then
      execute format('alter policy %I on %I with check (%s)', r.policyname, r.tablename, v_check);
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------- 3. indexes for the time filters

create index if not exists orders_closed_at on orders (closed_at);
create index if not exists kitchen_notices_created_at on kitchen_notices (created_at);
create index if not exists ticket_states_bumped_at on ticket_states (bumped_at);
create index if not exists ticket_states_recalled_at on ticket_states (recalled_at);
