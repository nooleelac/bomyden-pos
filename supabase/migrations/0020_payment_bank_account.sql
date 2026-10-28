-- Bò Mỹ Đen POS 0020: which shop account each transfer went to (the shop has several since 0019).
--
--   payments.bank_account   { id, bin, bank_name, account, holder } as it was at pay time; null for cash, card and
--                           transfers taken before this migration (Báo cáo shows them as "Chưa rõ tài khoản")
--
-- pay_order takes it from each bank payment (p_payments[].bank_account), keeping only those keys.
-- Same as payOrder in src/floor/engine.ts.

alter table payments
  add column bank_account jsonb
    check (bank_account is null or (method = 'bank' and jsonb_typeof(bank_account) = 'object'));

-- Exact-text edits of the latest pay_order (same helper as 0009). Each edit must match.
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
  if v_n = 0 then raise exception '0020: % does not contain: %', p_fn, p_old; end if;
end $$;

select pg_temp.patch('pay_order',
  $x$insert into payments (bill_id, method, amount, tendered, ref, shift_id, received_by)$x$,
  $x$insert into payments (bill_id, method, amount, tendered, ref, bank_account, shift_id, received_by)$x$);
select pg_temp.patch('pay_order',
  $x$left(coalesce(value ->> 'ref', ''), 40), v_shift.id, v_staff$x$,
  $x$left(coalesce(value ->> 'ref', ''), 40),
         case when value ->> 'method' = 'bank' and jsonb_typeof(value -> 'bank_account') = 'object' then jsonb_build_object(
           'id', left(coalesce(value -> 'bank_account' ->> 'id', ''), 40),
           'bin', left(coalesce(value -> 'bank_account' ->> 'bin', ''), 6),
           'bank_name', left(coalesce(value -> 'bank_account' ->> 'bank_name', ''), 60),
           'account', left(coalesce(value -> 'bank_account' ->> 'account', ''), 19),
           'holder', left(coalesce(value -> 'bank_account' ->> 'holder', ''), 60)) end,
         v_shift.id, v_staff$x$);
