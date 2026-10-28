-- Bò Mỹ Đen POS 0024: from the table QR page the guest also calls for the bill (Gọi thanh toán) or for a waiter
-- (Gọi phục vụ, with a short note: "thêm đá", "dọn bàn").
--
--   guest_requests.kind   'order' (0023: dishes) | 'bill' | 'service'. A call has no lines; it waits in QR order until
--                         a waiter taps Đã xử lý (accept_guest_request marks it accepted, nothing goes to the kitchen)
--   guest_call            anon, like guest_place_order. The same call still waiting at the table is returned instead
--                         of a second one; Gọi thanh toán needs dishes on the table

alter table guest_requests add column kind text not null default 'order' check (kind in ('order', 'bill', 'service'));

create function guest_call(p_token text, p_id uuid, p_kind text, p_note text default '') returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_t tables := _guest_table(p_token);
  v_r guest_requests;
begin
  if p_id is null then raise exception 'Thiếu mã yêu cầu'; end if;
  if p_kind is null or p_kind not in ('bill', 'service') then raise exception 'Yêu cầu không hợp lệ'; end if;
  select * into v_r from guest_requests where id = p_id;
  if found then
    if v_r.table_id <> v_t.id then raise exception 'Mã yêu cầu đã dùng'; end if;
    return to_jsonb(v_r);                                             -- the same tap sent twice
  end if;
  if char_length(btrim(coalesce(p_note, ''))) > 60 then raise exception 'Ghi chú tối đa 60 ký tự'; end if;
  perform 1 from tables where id = v_t.id for update;
  select * into v_r from guest_requests where table_id = v_t.id and kind = p_kind and status = 'pending' order by created_at desc limit 1;
  if found then return to_jsonb(v_r); end if;                          -- already called: staff are on their way
  if p_kind = 'bill' and not exists (
       select 1 from order_items i
        where i.status::text <> 'void'
          and i.order_id in (select ot.order_id from order_tables ot join orders o on o.id = ot.order_id
                              where ot.table_id = v_t.id and ot.left_at is null and o.status = 'open')) then
    raise exception 'Bàn chưa có món nào để thanh toán';
  end if;
  if (select count(*) from guest_requests where table_id = v_t.id and created_at > now() - interval '1 hour') >= 12 then
    raise exception 'Bàn đã gửi nhiều yêu cầu, mời bạn gọi nhân viên';
  end if;
  insert into guest_requests (id, branch_id, table_id, kind, lines, note)
  values (p_id, v_t.branch_id, v_t.id, p_kind, '[]'::jsonb, btrim(coalesce(p_note, '')))
  returning * into v_r;
  perform _push_queue('guest',
    case p_kind when 'bill' then format('🧾 %s gọi thanh toán', _push_table(v_t.name)) else format('🙋 %s gọi phục vụ', _push_table(v_t.name)) end,
    coalesce(nullif(v_r.note, ''), 'Khách đang chờ nhân viên'), '#/ban/khach', 'guest-' || v_r.id);
  return to_jsonb(v_r);
end $$;

-- Nhận (dishes, as 0023) or Đã xử lý (a call: only marked done, with the table's order for the cashier link)
create or replace function accept_guest_request(p_id uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_r guest_requests;
  v_t tables;
  v_o orders;
  v_oid uuid;
begin
  perform _need('order.take');
  select * into v_r from guest_requests where id = p_id and branch_id = my_branch_id() for update;
  if not found then raise exception 'Không tìm thấy yêu cầu của khách'; end if;
  if v_r.status = 'accepted' then return v_r.order_id; end if;
  if v_r.status <> 'pending' then raise exception 'Yêu cầu này đã bị từ chối'; end if;
  if v_r.kind <> 'order' then
    select o.id into v_oid from order_tables ot join orders o on o.id = ot.order_id
     where ot.table_id = v_r.table_id and ot.left_at is null and o.status = 'open' order by ot.suffix limit 1;
    update guest_requests set status = 'accepted', decided_at = now(), decided_by = my_staff_id(), order_id = v_oid where id = p_id;
    perform _audit('guest_call_done', jsonb_build_object('request', p_id, 'kind', v_r.kind, 'table', v_r.table_id));
    return v_oid;
  end if;
  select * into v_t from tables where id = v_r.table_id;
  v_o := open_table(v_r.table_id, coalesce(v_r.guest_count, least(99, greatest(1, v_t.seats))));
  if v_r.note <> '' and coalesce(v_o.note, '') = '' then update orders set note = left(v_r.note, 60) where id = v_o.id; end if;
  perform send_order_lines(v_o.id, v_r.lines, v_r.id, null);
  update guest_requests set status = 'accepted', decided_at = now(), decided_by = my_staff_id(), order_id = v_o.id where id = p_id;
  perform _audit('guest_accept', jsonb_build_object('request', p_id, 'order', v_o.id, 'table', v_r.table_id));
  return v_o.id;
end $$;

-- the guest's phone also needs the kind of each request
create or replace function guest_status(p_token text, p_ids uuid[]) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_t tables := _guest_table(p_token);
begin
  return jsonb_build_object(
    'requests', (select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'kind', r.kind, 'status', r.status, 'reason', r.reason,
                   'created_at', r.created_at, 'decided_at', r.decided_at) order by r.created_at), '[]')
                   from guest_requests r where r.table_id = v_t.id and r.id = any (coalesce(p_ids, '{}'))),
    'lines', (select coalesce(jsonb_agg(jsonb_build_object('name', i.name, 'variant_name', i.variant_name, 'qty', i.qty, 'price', i.price,
                'status', i.status, 'sent_at', i.sent_at) order by i.sent_at, i.name), '[]')
                from order_items i
               where i.status::text <> 'void' and i.replaced_by is null
                 and i.order_id in (select ot.order_id from order_tables ot join orders o on o.id = ot.order_id
                                     where ot.table_id = v_t.id and ot.left_at is null and o.status = 'open')));
end $$;

revoke execute on function guest_call(text, uuid, text, text) from public;
grant execute on function guest_call(text, uuid, text, text) to anon, authenticated;
