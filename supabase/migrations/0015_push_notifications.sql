-- Bò Mỹ Đen POS 0015: thông báo đẩy (Web Push) cho mọi máy.
--
-- Same events as the bell (src/floor/notify.ts) plus Sửa món, Huỷ đơn, Mở ca / Chốt ca, pushed to every device that
-- turned notifications on (Thông báo → Bật thông báo trên máy này), even when the app is closed or the phone is locked.
-- The device that did it gets no push (its screen already shows it).
--
--   push_subscriptions   one row per browser that turned notifications on (endpoint + keys), tied to the device
--   push_config          edge function URL, shared secret and VAPID keys; no API role can read it
--   push_outbox          events of the running transaction; sent at commit (deferred trigger), then deleted,
--                        so a rolled-back action sends nothing and SỬA món (a new line replacing an old one) is not
--                        also pushed as Gửi bếp
--
-- The edge function push-send (supabase/functions/push-send) receives one event and fans it out. Every trigger here
-- swallows its own errors: a push problem never stops an order, a payment or the kitchen.

create extension if not exists pg_net;

create table push_subscriptions (
  endpoint text primary key check (char_length(endpoint) between 10 and 1000),
  p256dh text not null check (char_length(p256dh) between 10 and 200),
  auth text not null check (char_length(auth) between 10 and 100),
  device_id uuid not null references devices on delete cascade,
  created_at timestamptz not null default now()
);
create index push_subscriptions_device on push_subscriptions (device_id);
alter table push_subscriptions enable row level security;
revoke all on push_subscriptions from anon, authenticated;
grant select, delete on push_subscriptions to service_role;

create table push_config (
  id int primary key default 1 check (id = 1),
  fn_url text not null default '',
  hook_secret text not null default '',
  vapid_public text not null default '',
  vapid_private text not null default '',
  vapid_subject text not null default 'mailto:admin@bomyden.vn'
);
insert into push_config default values;
alter table push_config enable row level security;
revoke all on push_config from anon, authenticated;
grant select on push_config to service_role;

create table push_outbox (
  id bigserial primary key,
  kind text not null,
  title text not null default '',
  body text not null default '',
  url text not null default '#/ban',
  tag text not null default '',
  actor text not null default '',
  exclude_device uuid,
  only_device uuid,
  lines uuid[]
);
alter table push_outbox enable row level security;
revoke all on push_outbox from anon, authenticated;

-- ---------------------------------------------------------------- texts

create function _push_actor() returns text
language sql stable security definer set search_path = public as $$
  select coalesce((select name from staff where id = my_staff_id()), '')
$$;

create function _push_table(p_name text) returns text
language sql immutable as $$
  select case when p_name ~ '^\d' then 'Bàn ' || p_name else p_name end
$$;

-- "Bàn 5", "Bàn 3 + Bàn 4", "MV-03 · chị Lan" (like orderTitle in src/floor/logic.ts)
create function _push_order_title(p_order uuid) returns text
language sql stable security definer set search_path = public as $$
  select coalesce((
    select case when o.kind = 'takeaway'
      then 'MV-' || lpad(coalesce(o.takeaway_no, 0)::text, 2, '0') || coalesce(' · ' || nullif(o.customer_name, ''), '')
      else coalesce(
        (select string_agg(_push_table(t.name) || case when ot.suffix <> 'A' then '-' || ot.suffix else '' end, ' + ' order by t.sort, t.name)
           from order_tables ot join tables t on t.id = ot.table_id where ot.order_id = o.id and ot.left_at is null),
        (select _push_table(t.name) from tables t where t.id = o.table_id), 'Đơn')
        || coalesce(' · ' || nullif(o.position_label, ''), '')
    end
    from orders o where o.id = p_order), 'Đơn')
$$;

create function _push_vnd(p int) returns text
language sql immutable as $$
  select replace(to_char(p, 'FM999,999,999,990'), ',', '.') || 'đ'
$$;

-- "2 Bò bít tết M, 1 Coca" (at most 5 names)
create function _push_names(p_lines uuid[]) returns text
language sql stable security definer set search_path = public as $$
  select string_agg(n, ', ') || case when cardinality(p_lines) > 5 then '…' else '' end
    from (select x.qty || ' ' || x.name || coalesce(' ' || nullif(x.variant_name, ''), '') as n
            from order_items x where x.id = any (p_lines) order by x.parent_line_id nulls first, x.name limit 5) y
$$;

-- ---------------------------------------------------------------- queue and send

create function _push_queue(p_kind text, p_title text, p_body text, p_url text, p_tag text, p_lines uuid[] default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from push_subscriptions) then return; end if;
  insert into push_outbox (kind, title, body, url, tag, actor, exclude_device, lines)
  values (p_kind, p_title, p_body, p_url, p_tag, _push_actor(), my_device_id(), p_lines);
exception when others then
  raise warning 'push queue: %', sqlerrm;
end $$;

-- At commit: build the late texts (Gửi bếp), post to the edge function, drop the row.
create function push_outbox_flush() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  c push_config;
  r push_outbox;
  v_lines uuid[];
  v_qty int;
  v_round int;
begin
  delete from push_outbox where id = new.id returning * into r;
  if not found then return null; end if;
  select * into c from push_config where id = 1;
  if c.fn_url = '' or c.hook_secret = '' then return null; end if;
  if r.kind = 'send' then
    -- lines that replace an older one are SỬA món (pushed from the kitchen notice), not a new order
    select array_agg(x.id), sum(x.qty), max(x.round) into v_lines, v_qty, v_round
      from order_items x
     where x.id = any (r.lines) and x.status <> 'void'
       and not exists (select 1 from order_items y where y.replaced_by = x.id);
    if v_lines is null then return null; end if;
    r.body := format('%sgửi bếp %s: %s', coalesce(nullif(r.actor, '') || ' ', ''), r.title, _push_names(v_lines))
              || case when v_round > 1 then format(' (lượt %s)', v_round) else '' end;
    r.title := format('🧾 Gửi bếp · %s món', v_qty);
  end if;
  perform net.http_post(
    url := c.fn_url,
    body := jsonb_build_object('title', r.title, 'body', r.body, 'url', r.url, 'tag', r.tag,
                               'exclude_device', r.exclude_device, 'only_device', r.only_device),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-push-secret', c.hook_secret),
    timeout_milliseconds := 8000);
  return null;
exception when others then
  raise warning 'push flush: %', sqlerrm;
  return null;
end $$;

create constraint trigger push_outbox_flush after insert on push_outbox
  deferrable initially deferred for each row execute function push_outbox_flush();

-- ---------------------------------------------------------------- events

create function push_on_order_insert() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_actor text := _push_actor();
begin
  perform _push_queue('open',
    case when new.kind = 'takeaway' then '🥡 Đơn mang về' else '🍽️ Mở bàn' end,
    coalesce(nullif(v_actor, '') || ' ', '') || case when new.kind = 'takeaway' then 'tạo đơn ' else 'mở ' end || _push_order_title(new.id),
    '#/ban/don/' || new.id, 'open-' || new.id);
  return null;
exception when others then
  raise warning 'push order insert: %', sqlerrm;
  return null;
end $$;

create function push_on_order_update() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_actor text := _push_actor();
begin
  if new.bill_requested_at is not null and new.bill_requested_at is distinct from old.bill_requested_at then
    perform _push_queue('bill', '🧮 Gọi tính tiền',
      _push_order_title(new.id) || ' gọi tính tiền' || coalesce(' (' || nullif(v_actor, '') || ' in tạm tính)', ''),
      '#/thu-ngan/' || new.id, 'bill-' || new.id);
  end if;
  if new.status = 'void' and old.status = 'open' then
    perform _push_queue('void_order', '🗑️ Huỷ đơn',
      coalesce(nullif(v_actor, '') || ' ', '') || 'huỷ đơn ' || _push_order_title(new.id),
      '#/ban', 'void-order-' || new.id);
  end if;
  return null;
exception when others then
  raise warning 'push order update: %', sqlerrm;
  return null;
end $$;

-- one Gửi bếp per order and send batch (texts are built at commit, see push_outbox_flush)
create function push_on_items_insert() returns trigger
language plpgsql security definer set search_path = public as $$
declare g record;
begin
  for g in select n.order_id, n.send_batch, array_agg(n.id) as ids
             from new_items n where n.sent_at is not null and n.status <> 'void'
            group by n.order_id, n.send_batch loop
    perform _push_queue('send', _push_order_title(g.order_id), '', '#/ban/don/' || g.order_id,
                        'send-' || coalesce(g.send_batch::text, g.order_id::text), g.ids);
  end loop;
  return null;
exception when others then
  raise warning 'push items insert: %', sqlerrm;
  return null;
end $$;

-- Món xong (one push per order) and Huỷ món
create function push_on_items_update() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  g record;
  v_actor text := _push_actor();
begin
  for g in select n.order_id, array_agg(n.id) as ids
             from new_items n join old_items o on o.id = n.id
            where n.ready_at is not null and o.ready_at is null and n.status <> 'void' and n.replaced_by is null
            group by n.order_id loop
    perform _push_queue('ready', '✅ Món xong', _push_order_title(g.order_id) || ': xong ' || _push_names(g.ids),
                        '#/ban/don/' || g.order_id, 'ready-' || g.order_id || '-' || extract(epoch from now())::bigint);
  end loop;
  -- a whole order voided is pushed once as Huỷ đơn
  for g in select n.order_id, array_agg(n.id) as ids, max(n.void_reason) as reason
             from new_items n join old_items o on o.id = n.id
            where n.voided_at is not null and o.voided_at is null and n.replaced_by is null
              and not exists (select 1 from orders x where x.id = n.order_id and x.status = 'void')
            group by n.order_id loop
    perform _push_queue('void', '❌ Huỷ món',
      coalesce(nullif(v_actor, '') || ' ', '') || 'huỷ ' || _push_names(g.ids) || ' · ' || _push_order_title(g.order_id)
        || coalesce(' (' || nullif(g.reason, '') || ')', ''),
      '#/ban/don/' || g.order_id, 'void-' || g.ids[1]);
  end loop;
  return null;
exception when others then
  raise warning 'push items update: %', sqlerrm;
  return null;
end $$;

create function push_on_notice_insert() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_actor text := _push_actor();
begin
  if new.kind = 'chase' then
    perform _push_queue('chase', '⏰ Giục món', coalesce(nullif(v_actor, '') || ' ', '') || 'giục món ' || _push_order_title(new.order_id),
                        '#/ban/don/' || new.order_id, 'chase-' || new.id);
  elsif new.kind = 'modify' then
    perform _push_queue('modify', '✏️ Sửa món', _push_order_title(new.order_id) || ': ' || new.text,
                        '#/ban/don/' || new.order_id, 'modify-' || new.id);
  elsif new.kind = 'modify_rejected' then
    perform _push_queue('modify', '🚫 Bếp không kịp sửa', _push_order_title(new.order_id) || ': ' || new.text,
                        '#/ban/don/' || new.order_id, 'modify-' || new.id);
  end if;
  return null;
exception when others then
  raise warning 'push notice: %', sqlerrm;
  return null;
end $$;

create function push_on_bill_insert() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_actor text := _push_actor();
begin
  perform _push_queue('paid', '💵 Thu tiền ' || _push_vnd(new.total),
    coalesce(nullif(v_actor, '') || ' ', '') || 'thu ' || _push_vnd(new.total) || ' '
      || coalesce(_push_table(nullif(new.table_label, '')), _push_order_title(new.order_id)) || ' (' || new.bill_no || ')',
    '#/thu-ngan/hd/' || new.id, 'paid-' || new.id);
  return null;
exception when others then
  raise warning 'push bill: %', sqlerrm;
  return null;
end $$;

create function push_on_shift() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_actor text := _push_actor();
begin
  if tg_op = 'INSERT' then
    perform _push_queue('shift', '🔓 Mở ca', coalesce(nullif(v_actor, '') || ' ', '') || 'mở ca ' || new.register
                          || ' (tiền lẻ ' || _push_vnd(new.opening_float) || ')', '#/ca', 'shift-' || new.id);
  elsif new.closed_at is not null and old.closed_at is null then
    perform _push_queue('shift', '🔒 Chốt ca', coalesce(nullif(v_actor, '') || ' ', '') || 'chốt ca ' || new.register
                          || ' (tiền mặt đếm được ' || _push_vnd(new.counted_cash) || ')', '#/ca', 'shift-close-' || new.id);
  end if;
  return null;
exception when others then
  raise warning 'push shift: %', sqlerrm;
  return null;
end $$;

-- AFTER triggers run in name order: "zz_" keeps these after the shop's own triggers (order_tables rows exist by then)
create trigger zz_push_order_insert after insert on orders for each row execute function push_on_order_insert();
create trigger zz_push_order_update after update on orders for each row execute function push_on_order_update();
create trigger zz_push_items_insert after insert on order_items referencing new table as new_items
  for each statement execute function push_on_items_insert();
create trigger zz_push_items_update after update on order_items referencing old table as old_items new table as new_items
  for each statement execute function push_on_items_update();
create trigger zz_push_notice_insert after insert on kitchen_notices for each row execute function push_on_notice_insert();
create trigger zz_push_bill_insert after insert on bills for each row execute function push_on_bill_insert();
create trigger zz_push_shift after insert or update on shifts for each row execute function push_on_shift();

-- ---------------------------------------------------------------- API for the app

-- VAPID public key for pushManager.subscribe
create function push_public_key() returns text
language sql stable security definer set search_path = public as $$
  select vapid_public from push_config where id = 1
$$;

-- This browser turns notifications on (any registered device, whoever is signed in).
create function push_subscribe(p_endpoint text, p_p256dh text, p_auth text) returns void
language plpgsql security definer set search_path = public as $$
declare v_device uuid := my_device_id();
begin
  if v_device is null then raise exception 'Máy chưa được đăng ký'; end if;
  insert into push_subscriptions (endpoint, p256dh, auth, device_id) values (p_endpoint, p_p256dh, p_auth, v_device)
  on conflict (endpoint) do update set p256dh = excluded.p256dh, auth = excluded.auth, device_id = excluded.device_id;
end $$;

create function push_unsubscribe(p_endpoint text) returns void
language sql security definer set search_path = public as $$
  delete from push_subscriptions where endpoint = p_endpoint and device_id = my_device_id()
$$;

-- "Gửi thử": a push to this device only, sent at commit like the others
create function push_test() returns void
language plpgsql security definer set search_path = public as $$
declare v_device uuid := my_device_id();
begin
  if v_device is null then raise exception 'Máy chưa được đăng ký'; end if;
  insert into push_outbox (kind, title, body, url, tag, only_device)
  values ('test', '🔔 Bò Mỹ Đen', 'Thông báo đã bật trên máy này.', '#/ban', 'test-' || v_device, v_device);
end $$;

revoke execute on function _push_actor(), _push_order_title(uuid), _push_names(uuid[]),
  _push_queue(text, text, text, text, text, uuid[]), push_outbox_flush(), push_on_order_insert(), push_on_order_update(),
  push_on_items_insert(), push_on_items_update(), push_on_notice_insert(), push_on_bill_insert(), push_on_shift()
  from public, anon, authenticated;
revoke execute on function push_public_key(), push_subscribe(text, text, text), push_unsubscribe(text), push_test() from public, anon;
grant execute on function push_public_key(), push_subscribe(text, text, text), push_unsubscribe(text), push_test() to authenticated;
