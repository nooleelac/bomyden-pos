-- Bò Mỹ Đen POS 0030: tự xác nhận chuyển khoản (Pay2S), on top of 0001–0029.
--
--   * Pay2S posts every incoming transfer of the linked accounts to the edge function pay2s-hook (Bearer token from
--     bank_feed_config), which hands them to bank_txns_in: one row per transaction in bank_txns, with the order code
--     found in the memo ("BMD3F9A2C…" from payMemo in src/cashier/bill.ts).
--   * The cashier's VietQR sheet sees the money arrive (get_floor_state 'transfers' + Realtime) and confirms the row
--     itself; the payment carries ref 'p2s:<id>'. pay_order checks that transaction: not used before, enough money,
--     and ties it to the payment, so one transfer never pays two bills.
--   * When the feed is on (bank_feed_config.enabled, one Pay2S account for every branch), a transfer confirmed by hand is written to the audit log
--     (bank_manual) and the owner is told; a transfer whose memo names another order (bank_link) too.
--   * Cài đặt → Thanh toán → Tự xác nhận chuyển khoản (owner only): turn on / off, see and renew the webhook token.

create or replace function pg_temp.patch(p_fn text, p_old text, p_new text) returns void
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
  if v_n = 0 then raise exception '0030: % does not contain: %', p_fn, p_old; end if;
end $$;

-- ---------------------------------------------------------------- tables

create table if not exists bank_txns (
  id text primary key,                         -- 'p2s:' || Pay2S transaction id
  gateway text not null default '',            -- bank (VCB, MBB, ACB…)
  account text not null default '',            -- the shop account the money went to
  amount bigint not null,
  content text not null default '',            -- memo as the bank wrote it
  code text,                                   -- 'BMD' + 6 of the order id, when the memo has one
  remitter text not null default '',
  bank_at timestamptz,
  received_at timestamptz not null default now(),
  raw jsonb not null default '{}',
  payment_id uuid references payments(id) on delete set null,
  used_at timestamptz,
  used_by uuid references staff(id) on delete set null
);
create index if not exists bank_txns_open on bank_txns (received_at) where payment_id is null;
alter table bank_txns enable row level security;
drop policy if exists read_money on bank_txns;
create policy read_money on bank_txns for select
  using ((select reader_can('pay.collect')) or (select reader_can('shift.manage')));
revoke insert, update, delete on bank_txns from anon, authenticated;

create table if not exists bank_feed_config (
  id int primary key default 1 check (id = 1),
  enabled boolean not null default false,
  token text not null default '',
  last_at timestamptz
);
insert into bank_feed_config (id) values (1) on conflict do nothing;
alter table bank_feed_config enable row level security;   -- no policy: only definer functions and the edge function
revoke all on bank_feed_config from anon, authenticated;


do $$ begin
  alter publication supabase_realtime add table bank_txns;
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------- webhook → rows

-- Called by pay2s-hook (service role) with Pay2S's "transactions" array. Money out and repeats are skipped.
create or replace function bank_txns_in(p_txns jsonb) returns int
language plpgsql security definer set search_path = public as $$
declare
  t jsonb;
  v_at timestamptz;
  v_memo text;
  v_name text;
  v_n int := 0;
  v_rows int;
begin
  if jsonb_typeof(p_txns) <> 'array' then return 0; end if;
  for t in select value from jsonb_array_elements(p_txns) loop
    continue when upper(coalesce(t ->> 'transferType', '')) <> 'IN' or coalesce(t ->> 'id', '') = '';
    begin
      v_at := (t ->> 'transactionDate')::timestamp at time zone 'Asia/Ho_Chi_Minh';
    exception when others then
      v_at := null;
    end;
    v_memo := coalesce(t ->> 'content', '');
    v_name := nullif(nullif(btrim(coalesce(t -> 'extraData' ->> 'remitterName', '')), 'N/A'), '');
    insert into bank_txns (id, gateway, account, amount, content, code, remitter, bank_at, raw)
    values ('p2s:' || left(t ->> 'id', 36), left(coalesce(t ->> 'gateway', ''), 20), left(coalesce(t ->> 'accountNumber', ''), 30),
            round(coalesce((t ->> 'transferAmount')::numeric, 0))::bigint, left(v_memo, 300),
            (regexp_match(upper(v_memo), 'BMD\s*([0-9A-Z]{6})'))[1], left(coalesce(v_name, ''), 80), v_at, t)
    on conflict (id) do nothing;
    get diagnostics v_rows = row_count;
    v_n := v_n + v_rows;
  end loop;
  update bank_feed_config set last_at = now() where id = 1;
  return v_n;
end $$;
revoke execute on function bank_txns_in(jsonb) from public, anon, authenticated;
grant execute on function bank_txns_in(jsonb) to service_role;

-- ---------------------------------------------------------------- settings (owner)

create or replace function _need_owner() returns void
language plpgsql stable security definer set search_path = public as $$
begin
  if (select role::text from staff where id = my_staff_id()) is distinct from 'owner' then
    raise exception 'Chỉ chủ quán làm được việc này';
  end if;
end $$;

-- What the owner sees in Cài đặt: on / off, the token to paste in Pay2S, the last time Pay2S called.
create or replace function bank_feed_status() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform _need_owner();
  return (select jsonb_build_object('on', c.enabled, 'token', c.token, 'last_at', c.last_at,
                                    'count_today', (select count(*) from bank_txns where received_at > now() - interval '24 hours'))
            from bank_feed_config c where c.id = 1);
end $$;

create or replace function bank_feed_setup(p_on boolean, p_new_token boolean default false) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  perform _need_owner();
  if p_new_token or (select token from bank_feed_config where id = 1) = '' then
    update bank_feed_config set token = replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '') where id = 1;
  end if;
  update bank_feed_config set enabled = coalesce(p_on, false) where id = 1;
  perform _audit('bank_feed', jsonb_build_object('on', coalesce(p_on, false), 'new_token', p_new_token));
  return bank_feed_status();
end $$;

revoke execute on function _need_owner(), bank_feed_status(), bank_feed_setup(boolean, boolean) from public, anon;
grant execute on function bank_feed_status(), bank_feed_setup(boolean, boolean) to authenticated;

-- ---------------------------------------------------------------- floor state: transfers not used yet

-- get_floor_state runs as the caller, who cannot read bank_feed_config.
create or replace function bank_feed_on() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select enabled from bank_feed_config where id = 1), false)
$$;
revoke execute on function bank_feed_on() from public, anon;
grant execute on function bank_feed_on() to authenticated;

select pg_temp.patch('get_floor_state',
  $x$    'now', (select t_now from p),$x$,
  $x$    'now', (select t_now from p),
    'bank_feed', bank_feed_on(),
    'transfers', (select coalesce(jsonb_agg(to_jsonb(x) - 'raw' order by x.received_at), '[]') from bank_txns x, p
                    where x.payment_id is null and x.received_at > p.t_now - interval '24 hours'),$x$);

-- ---------------------------------------------------------------- pay_order: tie the transfer to the payment

select pg_temp.patch('pay_order',
  $x$  p jsonb;
begin$x$,
  $x$  p jsonb;
  v_pm payments;
  v_tx bank_txns;
  v_feed boolean := coalesce((select enabled from bank_feed_config where id = 1), false);
  v_code text := 'BMD' || upper(left(replace(p_order::text, '-', ''), 6));
begin$x$);
select pg_temp.patch('pay_order',
  $x$  update orders set status = 'paid', closed_at = now(), paying_at = null, paying_by = null where id = p_order;$x$,
  $x$  for v_pm in select * from payments where bill_id = v_bill.id and method = 'bank' loop
    if v_pm.ref like 'p2s:%' then
      select * into v_tx from bank_txns where id = v_pm.ref for update;
      if not found then raise exception 'Không thấy giao dịch ngân hàng này: tải lại trang rồi thử lại'; end if;
      if v_tx.payment_id is not null then raise exception 'Khoản tiền về này đã được dùng cho hoá đơn khác'; end if;
      if v_tx.amount < v_pm.amount then raise exception 'Tiền về % ít hơn số thu %', v_tx.amount, v_pm.amount; end if;
      update bank_txns set payment_id = v_pm.id, used_at = now(), used_by = v_staff where id = v_tx.id;
      if v_tx.code is null or 'BMD' || v_tx.code <> v_code then
        perform _audit('bank_link', jsonb_build_object('bill', v_bill.bill_no, 'amount', v_pm.amount, 'name', v_bill.table_label,
                                                       'content', v_tx.content, 'remitter', v_tx.remitter, 'received', v_tx.amount));
      end if;
    elsif v_feed then
      perform _audit('bank_manual', jsonb_build_object('bill', v_bill.bill_no, 'amount', v_pm.amount, 'name', v_bill.table_label));
    end if;
  end loop;

  update orders set status = 'paid', closed_at = now(), paying_at = null, paying_by = null where id = p_order;$x$);

-- ---------------------------------------------------------------- cảnh báo cho chủ

select pg_temp.patch('audit_alert',
  $x$    else
      return null;
  end case;$x$,
  $x$    when 'bank_manual' then
      v_title := '🏦 Chuyển khoản xác nhận tay · ' || _push_vnd(v_amount::int);
      v_body := format('%s · HĐ %s · %s · ngân hàng chưa báo tiền về', v_who, d ->> 'bill', coalesce(nullif(d ->> 'name', ''), 'mang về'));
    when 'bank_link' then
      v_title := '🏦 Gắn tiền về khác nội dung · ' || _push_vnd(v_amount::int);
      v_body := format('%s · HĐ %s · nội dung “%s”%s', v_who, d ->> 'bill', d ->> 'content', coalesce(' · ' || nullif(d ->> 'remitter', ''), ''));
    else
      return null;
  end case;$x$);
