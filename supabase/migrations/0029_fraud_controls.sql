-- Bò Mỹ Đen POS 0029: chống thất thoát (kiểm soát tiền), on top of 0001–0028.
--
--   * Đếm két kín: a cashier (no audit.view) closes the shift without seeing the expected cash, so a difference no
--     longer needs a note from them; it is recorded as before and the owner is told (below). Those who see the
--     expected cash (audit.view) still write a reason for a difference. Same rule as closeShift in src/floor/engine.ts.
--   * Nhật ký chi tiết hơn:
--       void_item     + after_bill (huỷ sau khi đã in tạm tính) and in_order (one line of a Huỷ đơn)
--       modify_item   + price_before / price_after (line totals), so a cheaper size shows in money
--       delete        + amount for an order (bill total, else live lines)
--   * Cảnh báo cho chủ: an audit_log row that may hide money (huỷ món đã làm hoặc sau tạm tính, huỷ đơn, giảm giá,
--     két lệch, xoá đơn / ca, đổi quyền) queues a push only to the devices whose last signed-in person can read the
--     audit log (owner / quản lý) — never to the cashier who did it. The owner's own actions send nothing.
--     push-send (edge function) learns `only_devices`.

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
  if v_n = 0 then raise exception '0029: % does not contain: %', p_fn, p_old; end if;
end $$;

-- ---------------------------------------------------------------- đếm két kín

select pg_temp.patch('close_shift',
  $x$if v_counted <> v_expected and v_note = '' then raise exception 'Két lệch so với dự kiến: ghi lý do'; end if;$x$,
  $x$if v_counted <> v_expected and v_note = '' and has_perm('audit.view') then raise exception 'Két lệch so với dự kiến: ghi lý do'; end if;$x$);
select pg_temp.patch('close_shift',
  $x$'difference', v_counted - v_expected));$x$,
  $x$'difference', v_counted - v_expected, 'note', v_note, 'blind', not has_perm('audit.view')));$x$);

-- ---------------------------------------------------------------- huỷ món: sau tạm tính? trong Huỷ đơn?

-- void_item / void_order tell _void_line (transaction-local settings) before the first line clears bill_requested_at.
select pg_temp.patch('void_item',
  $x$  return _void_line(v_line, p_qty, v_reason, v_staff, v_by);$x$,
  $x$  perform set_config('pos.after_bill', case when v_order.bill_requested_at is not null then '1' else '' end, true);
  perform set_config('pos.in_order', '', true);
  return _void_line(v_line, p_qty, v_reason, v_staff, v_by);$x$);
select pg_temp.patch('void_order',
  $x$  for v_line in select * from order_items where order_id = p_order and status <> 'void' order by sent_at, id for update loop$x$,
  $x$  perform set_config('pos.after_bill', case when v_order.bill_requested_at is not null then '1' else '' end, true);
  perform set_config('pos.in_order', '1', true);
  for v_line in select * from order_items where order_id = p_order and status <> 'void' order by sent_at, id for update loop$x$);
select pg_temp.patch('void_order',
  $x$jsonb_build_object('order', p_order, 'lines', v_n, 'amount', v_amount, 'reason', v_reason)$x$,
  $x$jsonb_build_object('order', p_order, 'lines', v_n, 'amount', v_amount, 'reason', v_reason,
                                       'after_bill', v_order.bill_requested_at is not null or current_setting('pos.after_bill', true) = '1',
                                       'name', _push_order_title(p_order))$x$);
select pg_temp.patch('_void_line',
  $x$'amount', p_line.price * p_qty, 'reason', p_reason, 'stage', p_line.status),$x$,
  $x$'amount', p_line.price * p_qty, 'reason', p_reason, 'stage', p_line.status,
                                                 'after_bill', coalesce(current_setting('pos.after_bill', true), '') = '1',
                                                 'in_order', coalesce(current_setting('pos.in_order', true), '') = '1',
                                                 'table', _push_order_title(p_line.order_id)),$x$);

-- ---------------------------------------------------------------- sửa món: giá trước / sau

select pg_temp.patch('modify_item',
  $x$jsonb_build_object('from', p_line, 'to', v_new.id, 'before', v_before, 'after', v_n.text)$x$,
  $x$jsonb_build_object('from', p_line, 'to', v_new.id, 'before', v_before, 'after', v_n.text,
                                       'price_before', v_line.price * v_line.qty, 'price_after', v_new.price * v_new.qty,
                                       'table', _push_order_title(v_line.order_id))$x$);

-- ---------------------------------------------------------------- xoá đơn: số tiền

select pg_temp.patch('admin_delete',
  $x$  v_role text;
begin$x$,
  $x$  v_role text;
  v_amount bigint;
begin$x$);
select pg_temp.patch('admin_delete',
  $x$      perform _purge_orders(format('id = %L', p_id));$x$,
  $x$      v_amount := coalesce((select total from bills where order_id = p_id),
                           (select sum(price * qty) from order_items where order_id = p_id and status <> 'void'), 0);
      perform _purge_orders(format('id = %L', p_id));$x$);
select pg_temp.patch('admin_delete',
  $x$  perform _audit('delete', jsonb_build_object('kind', p_kind, 'name', v_name));$x$,
  $x$  perform _audit('delete', jsonb_build_object('kind', p_kind, 'name', v_name) || case when v_amount is not null then jsonb_build_object('amount', v_amount) else '{}' end);$x$);

-- ---------------------------------------------------------------- cảnh báo cho chủ

alter table push_outbox add column if not exists only_devices uuid[];

select pg_temp.patch('push_outbox_flush',
  $x$'exclude_device', r.exclude_device, 'only_device', r.only_device, 'branch_id', r.branch_id),$x$,
  $x$'exclude_device', r.exclude_device, 'only_device', r.only_device, 'branch_id', r.branch_id,
                               'only_devices', r.only_devices),$x$);

-- Devices with notifications on whose last signed-in person reads the audit log (owner, quản lý), except p_except.
create or replace function _alert_devices(p_except uuid) returns uuid[]
language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(d.device_id), '{}')
  from (select distinct on (ss.device_id) ss.device_id, ss.staff_id
          from staff_sessions ss
         where ss.device_id in (select device_id from push_subscriptions)
         order by ss.device_id, ss.started_at desc) d
  join staff st on st.id = d.staff_id
  where st.active and role_can(st.role::text, 'audit.view') and d.device_id is distinct from p_except
$$;

create or replace function audit_alert() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  d jsonb := coalesce(new.detail, '{}');
  v_role text;
  v_who text;
  v_by text;
  v_title text;
  v_body text;
  v_devs uuid[];
  v_amount bigint := coalesce((d ->> 'amount')::numeric, 0)::bigint;
begin
  select role::text, name into v_role, v_who from staff where id = new.staff_id;
  if v_role = 'owner' then return null; end if;   -- the owner does not need to hear about their own actions
  v_who := coalesce(v_who, 'Không rõ');
  select name into v_by from staff where id = new.approved_by;

  case new.action
    when 'void_item' then
      if coalesce((d ->> 'in_order')::boolean, false) then return null; end if;   -- told once by void_order
      if not (coalesce((d ->> 'after_bill')::boolean, false) or d ->> 'stage' in ('ready', 'served') or new.approved_by is null) then
        return null;
      end if;
      v_title := case when coalesce((d ->> 'after_bill')::boolean, false) then '⚠️ Huỷ món sau tạm tính'
                      when d ->> 'stage' in ('ready', 'served') then '⚠️ Huỷ món đã làm xong'
                      else '⚠️ Huỷ món không cần duyệt' end || ' · ' || _push_vnd(v_amount::int);
      v_body := format('%s huỷ %s %s%s · “%s”%s', v_who, d ->> 'qty', d ->> 'name', coalesce(' · ' || nullif(d ->> 'table', ''), ''), d ->> 'reason',
                       coalesce(' · duyệt: ' || v_by, ''));
    when 'void_order' then
      if v_amount <= 0 then return null; end if;
      v_title := '⚠️ Huỷ cả đơn' || case when coalesce((d ->> 'after_bill')::boolean, false) then ' sau tạm tính' else '' end
                 || ' · ' || _push_vnd(v_amount::int);
      v_body := format('%s huỷ %s · %s món · “%s”%s', v_who, coalesce(d ->> 'name', 'đơn'), d ->> 'lines', d ->> 'reason', coalesce(' · duyệt: ' || v_by, ''));
    when 'discount' then
      v_title := '💸 Giảm giá ' || _push_vnd(v_amount::int);
      v_body := format('%s · HĐ %s · “%s”%s', v_who, d ->> 'bill', d ->> 'reason', coalesce(' · duyệt: ' || v_by, ''));
    when 'close_shift' then
      if coalesce((d ->> 'difference')::numeric, 0) = 0 then return null; end if;
      v_title := '💰 Két lệch ' || case when (d ->> 'difference')::numeric > 0 then '+' else '-' end
                 || _push_vnd(abs((d ->> 'difference')::numeric)::int);
      v_body := format('%s chốt ca: đếm %s, dự kiến %s%s', v_who, _push_vnd((d ->> 'counted')::int), _push_vnd((d ->> 'expected')::int),
                       coalesce(' · “' || nullif(d ->> 'note', '') || '”', ''));
    when 'delete' then
      if d ->> 'kind' not in ('order', 'shift') then return null; end if;
      v_title := '🗑 Xoá vĩnh viễn ' || case when d ->> 'kind' = 'order' then 'đơn / hoá đơn' else 'ca' end;
      v_body := format('%s xoá %s%s', v_who, d ->> 'name', case when v_amount > 0 then ' · ' || _push_vnd(v_amount::int) else '' end);
    when 'permissions' then
      v_title := '🔐 Đổi quyền ' || coalesce(d ->> 'role', '');
      v_body := format('%s · thêm %s · bỏ %s', v_who, coalesce(d ->> 'added', '[]'), coalesce(d ->> 'removed', '[]'));
    else
      return null;
  end case;

  v_devs := _alert_devices(new.device_id);
  if cardinality(v_devs) = 0 then return null; end if;
  insert into push_outbox (kind, title, body, url, tag, actor, exclude_device, only_devices)
  values ('alert', v_title, v_body, '#/kiem-soat', 'alert-' || new.id, v_who, new.device_id, v_devs);
  return null;
exception when others then
  raise warning 'audit alert: %', sqlerrm;   -- a push problem never stops the action
  return null;
end $$;

drop trigger if exists audit_alert on audit_log;
create trigger audit_alert after insert on audit_log for each row execute function audit_alert();

revoke execute on function _alert_devices(uuid), audit_alert() from public, anon, authenticated;
