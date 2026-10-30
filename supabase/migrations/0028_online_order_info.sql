-- Bò Mỹ Đen POS 0028: a delivery's address stays on the order screen for as long as the order is open, not only for
-- the 4 hours after Nhận (0027). Paid bills read online_orders directly (billHistory).

create function pg_temp.patch(p_fn text, p_old text, p_new text) returns void
language plpgsql as $$
declare
  r record;
  v_def text;
  v_n int := 0;
begin
  for r in select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = p_fn loop
    v_def := replace(pg_get_functiondef(r.oid), E'\r\n', E'\n');
    if position(p_old in v_def) > 0 then
      execute replace(v_def, p_old, p_new);
      v_n := v_n + 1;
    end if;
  end loop;
  if v_n = 0 then raise exception '0028: % does not contain: %', p_fn, p_old; end if;
end $$;

select pg_temp.patch('get_floor_state',
  $x$where x.status in ('pending', 'quoted', 'agreed') or x.decided_at > p.since),$x$,
  $x$where x.status in ('pending', 'quoted', 'agreed') or x.decided_at > p.since or x.order_id in (select id from o)),$x$);
