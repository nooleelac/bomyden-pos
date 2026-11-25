-- Bò Mỹ Đen POS 0032: báo tiền về lên điện thoại thu ngân.
--
-- Each transfer Pay2S reports (bank_txns_in, 0030) is pushed to every device with notifications on whose last
-- signed-in person can take payments (pay.collect: thu ngân, quản lý, chủ), even with the screen off or the app closed:
-- "🏦 Tiền về 250.000đ · Bàn 5" when the memo names an open order, else the remitter. Only while the feed is on.
-- A push problem never stops saving the transfer.

-- Devices with notifications on whose last signed-in person may take payments.
create or replace function _pay_devices() returns uuid[]
language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(d.device_id), '{}')
  from (select distinct on (ss.device_id) ss.device_id, ss.staff_id
          from staff_sessions ss
         where ss.device_id in (select device_id from push_subscriptions)
         order by ss.device_id, ss.started_at desc) d
  join staff st on st.id = d.staff_id
  where st.active and role_can(st.role::text, 'pay.collect')
$$;
revoke execute on function _pay_devices() from public, anon, authenticated;

create or replace function _push_bank_txn(p bank_txns) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_devs uuid[];
  v_order uuid;
  v_body text;
begin
  if not coalesce((select enabled from bank_feed_config where id = 1), false) then return; end if;
  v_devs := _pay_devices();
  if cardinality(v_devs) = 0 then return; end if;
  if p.code is not null then
    select o.id into v_order from orders o
     where o.status = 'open' and upper(left(replace(o.id::text, '-', ''), 6)) = p.code
     order by o.opened_at desc limit 1;
  end if;
  v_body := concat_ws(' · ',
    case when v_order is not null then _push_order_title(v_order) end,
    nullif(p.remitter, ''),
    case when v_order is null then nullif(left(p.content, 60), '') end);
  insert into push_outbox (kind, title, body, url, tag, actor, only_devices)
  values ('bank', '🏦 Tiền về ' || _push_vnd(least(p.amount, 2147483647)::int), coalesce(nullif(v_body, ''), 'Chuyển khoản vào tài khoản quán'),
          case when v_order is not null then '#/thu-ngan/' || v_order else '#/thu-ngan' end, 'bank-' || p.id, '', v_devs);
exception when others then
  raise warning 'bank push: %', sqlerrm;
end $$;
revoke execute on function _push_bank_txn(bank_txns) from public, anon, authenticated;

create or replace function bank_txns_in(p_txns jsonb) returns int
language plpgsql security definer set search_path = public as $$
declare
  t jsonb;
  v_at timestamptz;
  v_memo text;
  v_name text;
  v_n int := 0;
  v_row bank_txns;
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
    v_row := null;
    insert into bank_txns (id, gateway, account, amount, content, code, remitter, bank_at, raw)
    values ('p2s:' || left(t ->> 'id', 36), left(coalesce(t ->> 'gateway', ''), 20), left(coalesce(t ->> 'accountNumber', ''), 30),
            round(coalesce((t ->> 'transferAmount')::numeric, 0))::bigint, left(v_memo, 300),
            (regexp_match(upper(v_memo), 'BMD\s*([0-9A-Z]{6})'))[1], left(coalesce(v_name, ''), 80), v_at, t)
    on conflict (id) do nothing
    returning * into v_row;
    if v_row.id is not null then
      v_n := v_n + 1;
      perform _push_bank_txn(v_row);
    end if;
  end loop;
  update bank_feed_config set last_at = now() where id = 1;
  return v_n;
end $$;
revoke execute on function bank_txns_in(jsonb) from public, anon, authenticated;
grant execute on function bank_txns_in(jsonb) to service_role;
