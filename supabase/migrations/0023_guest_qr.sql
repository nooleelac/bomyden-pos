-- Bò Mỹ Đen POS 0023: khách quét mã QR trên bàn để tự gọi món.
--
--   tables.qr_token      the secret in the table's QR link (order.bomyden.vn/#/goi/<token>); null = no QR yet.
--                        Đổi mã makes a new one, so a photo of the old sticker stops working
--   branch_settings.guest_order   khách tự gọi món on / off for the branch (on by default)
--   guest_requests       what a guest sent: the lines in send_order_lines form, a note and the guest count.
--                        pending -> accepted (a waiter tapped Nhận: the lines went to the kitchen on the table's
--                        order, opened if the table was free) | rejected (with a reason the guest sees)
--
-- Guests have no device and no PIN: they call only guest_menu, guest_place_order and guest_status (anon), which
-- find the branch from the token and read that branch's rows only. Nothing reaches the kitchen until a waiter
-- accepts it, so a stranger with a photo of the QR cannot send dishes. Prices are always the server's
-- (send_order_lines prices the lines when the waiter accepts).

alter table tables add column qr_token text;
create unique index tables_qr_token on tables (qr_token) where qr_token is not null;
alter table branch_settings add column guest_order boolean not null default true;

create table guest_requests (
  id uuid primary key,                                             -- the guest's phone picks it: resending never doubles
  branch_id uuid not null default my_branch_id() references branches on delete cascade,
  table_id uuid not null references tables on delete cascade,
  lines jsonb not null check (jsonb_typeof(lines) = 'array'),
  note text not null default '' check (char_length(note) <= 60),
  guest_count int check (guest_count between 1 and 99),
  status text not null default 'pending' check (status in ('pending', 'accepted', 'rejected')),
  reason text not null default '' check (char_length(reason) <= 80),
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  decided_by uuid references staff on delete set null,
  order_id uuid references orders on delete set null
);
create index guest_requests_table on guest_requests (table_id, created_at);
create index guest_requests_branch on guest_requests (branch_id, status);

alter table guest_requests enable row level security;
revoke all on guest_requests from anon, authenticated;
grant select on guest_requests to authenticated;
create policy read_all on guest_requests for select using ((select reader_role()) is not null);
create policy branch_only on guest_requests as restrictive for all
  using (branch_id = (select my_branch_id())) with check (branch_id = (select my_branch_id()));
alter publication supabase_realtime add table guest_requests;

-- the floor state carries pending requests and the last 4 hours of decided ones
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
  if v_n = 0 then raise exception '0023: % does not contain: %', p_fn, p_old; end if;
end $$;

select pg_temp.patch('get_floor_state',
  $x$'tables', (select coalesce(jsonb_agg(to_jsonb(x) order by x.sort), '[]') from tables x),$x$,
  $x$'tables', (select coalesce(jsonb_agg(to_jsonb(x) order by x.sort), '[]') from tables x),
    'guest_requests', (select coalesce(jsonb_agg(to_jsonb(x) order by x.created_at), '[]') from guest_requests x, p
                        where x.status = 'pending' or x.decided_at > p.since),$x$);

-- ---------------------------------------------------------------- the guest side (anon)

-- The table a token belongs to, with its branch made the caller's branch for this transaction (my_branch_id(),
-- shop_settings and every default then work on that branch). Raises the guest-facing message when it cannot order.
create function _guest_table(p_token text) returns tables
language plpgsql security definer set search_path = public as $$
declare
  v_t tables;
begin
  if coalesce(p_token, '') !~ '^[0-9a-f]{20,40}$' then raise exception 'Mã QR không đúng'; end if;
  select * into v_t from tables where qr_token = p_token;
  if not found or not v_t.active then raise exception 'Mã QR này không còn dùng được, mời bạn gọi nhân viên'; end if;
  if not (select b.active from branches b where b.id = v_t.branch_id) then raise exception 'Chi nhánh đang tạm đóng'; end if;
  perform set_config('app.branch_override', v_t.branch_id::text, true);
  if not coalesce((select guest_order from branch_settings where branch_id = v_t.branch_id), false) then
    raise exception 'Quán đang tắt gọi món qua mã QR, mời bạn gọi nhân viên';
  end if;
  return v_t;
end $$;

-- The menu a guest sees: dishes on sale in visible groups, in the get_menu_state shape (src/menu/supabaseRepo.ts
-- reads both), plus the shop name and the table.
create function guest_menu(p_token text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_t tables := _guest_table(p_token);
  v_b uuid := v_t.branch_id;
begin
  return jsonb_build_object(
    'table', jsonb_build_object('id', v_t.id, 'name', v_t.name),
    'shop_name', (select shop_name from branch_settings where branch_id = v_b),
    'is_open', branch_is_open(),
    'menu', jsonb_build_object(
      'shop', (select coalesce(jsonb_agg(jsonb_build_object('prices_include_vat', x.prices_include_vat, 'business_day_start', x.business_day_start,
                  'min_price_ratio', x.min_price_ratio)), '[]') from branch_settings x where x.branch_id = v_b),
      'stations', (select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'code', x.code, 'name', x.name, 'kind', x.kind, 'sort', x.sort) order by x.sort), '[]')
                     from stations x where x.branch_id = v_b and x.active),
      'vat_groups', '[]'::jsonb,
      'vat_rates', '[]'::jsonb,
      'categories', (select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'parent_id', x.parent_id, 'name', x.name, 'sort', x.sort, 'color', x.color,
                       'visible', x.visible, 'default_station_id', x.default_station_id, 'vat_group', x.vat_group) order by x.sort), '[]')
                       from menu_categories x where x.branch_id = v_b and x.visible),
      'items', (select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'category_id', x.category_id, 'name', x.name, 'short_name', x.short_name,
                  'code', x.code, 'unit', x.unit, 'station_id', x.station_id, 'status', x.status, 'description', x.description, 'keywords', x.keywords,
                  'image_url', x.image_url, 'price', x.price, 'has_sizes', x.has_sizes, 'sold_out_until', x.sold_out_until, 'sort', x.sort) order by x.sort), '[]')
                  from menu_items x where x.branch_id = v_b and x.status::text = 'active'),
      'variants', (select coalesce(jsonb_agg(to_jsonb(x) order by x.sort), '[]') from menu_item_variants x
                    where x.branch_id = v_b and x.archived_at is null),
      'components', (select coalesce(jsonb_agg(to_jsonb(x) order by x.sort), '[]') from item_components x where x.branch_id = v_b and x.archived_at is null),
      'groups', (select coalesce(jsonb_agg(to_jsonb(x) order by x.sort), '[]') from modifier_groups x where x.branch_id = v_b and x.archived_at is null),
      'options', (select coalesce(jsonb_agg(to_jsonb(x) order by x.sort), '[]') from modifier_options x where x.branch_id = v_b and x.archived_at is null),
      'links', (select coalesce(jsonb_agg(to_jsonb(x) order by x.sort), '[]') from item_modifier_groups x where x.branch_id = v_b),
      'overrides', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from item_option_overrides x where x.branch_id = v_b)));
end $$;

-- Send a request. The lines are checked for shape here; prices, sizes, options and sold-out are checked again by
-- send_order_lines when a waiter accepts. At most 5 waiting and 12 an hour per table, so a prank stays small.
create function guest_place_order(p_token text, p_id uuid, p_lines jsonb, p_note text default '', p_guests int default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_t tables := _guest_table(p_token);
  v_r guest_requests;
  l jsonb;
  v_n int := 0;
begin
  if p_id is null then raise exception 'Thiếu mã yêu cầu'; end if;
  select * into v_r from guest_requests where id = p_id;
  if found then
    if v_r.table_id <> v_t.id then raise exception 'Mã yêu cầu đã dùng'; end if;
    return to_jsonb(v_r);                                             -- the same tap sent twice
  end if;
  if coalesce((select enforce_hours from branch_settings where branch_id = v_t.branch_id), false) and not branch_is_open() then
    raise exception 'Quán đang ngoài giờ phục vụ';
  end if;
  if jsonb_typeof(p_lines) is distinct from 'array' or jsonb_array_length(p_lines) = 0 then raise exception 'Chưa chọn món nào'; end if;
  if jsonb_array_length(p_lines) > 30 then raise exception 'Một lần gọi tối đa 30 dòng món'; end if;
  for l in select * from jsonb_array_elements(p_lines) loop
    if jsonb_typeof(l) <> 'object' or coalesce(l ->> 'menu_item_id', '') !~ '^[0-9a-f-]{36}$' then raise exception 'Món không hợp lệ'; end if;
    if not exists (select 1 from menu_items i where i.id = (l ->> 'menu_item_id')::uuid and i.branch_id = v_t.branch_id and i.status::text = 'active') then
      raise exception 'Có món không còn trên thực đơn, mời bạn tải lại trang';
    end if;
    if coalesce(l ->> 'qty', '') !~ '^\d{1,2}$' or (l ->> 'qty')::int not between 1 and 20 then raise exception 'Mỗi món từ 1 đến 20 phần'; end if;
    if char_length(coalesce(l ->> 'note', '')) > 60 then raise exception 'Ghi chú món tối đa 60 ký tự'; end if;
    v_n := v_n + (l ->> 'qty')::int;
  end loop;
  if v_n > 60 then raise exception 'Một lần gọi tối đa 60 phần'; end if;
  if char_length(btrim(coalesce(p_note, ''))) > 60 then raise exception 'Ghi chú tối đa 60 ký tự'; end if;
  if p_guests is not null and p_guests not between 1 and 99 then raise exception 'Số người từ 1 đến 99'; end if;
  perform 1 from tables where id = v_t.id for update;                -- one request at a time per table for the limits
  if (select count(*) from guest_requests where table_id = v_t.id and status = 'pending') >= 5 then
    raise exception 'Bàn đang có nhiều yêu cầu chờ, nhân viên sẽ tới ngay';
  end if;
  if (select count(*) from guest_requests where table_id = v_t.id and created_at > now() - interval '1 hour') >= 12 then
    raise exception 'Bàn đã gửi nhiều yêu cầu, mời bạn gọi nhân viên';
  end if;
  insert into guest_requests (id, branch_id, table_id, lines, note, guest_count)
  values (p_id, v_t.branch_id, v_t.id, p_lines, btrim(coalesce(p_note, '')), p_guests)
  returning * into v_r;
  perform _push_queue('guest', format('🙋 Khách gọi món · %s', _push_table(v_t.name)), format('%s phần, chờ nhân viên xác nhận', v_n),
                      '#/ban', 'guest-' || v_r.id);
  return to_jsonb(v_r);
end $$;

-- What the guest's phone shows: its own requests (by id) and the dishes already on the table's open orders.
create function guest_status(p_token text, p_ids uuid[]) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_t tables := _guest_table(p_token);
begin
  return jsonb_build_object(
    'requests', (select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'status', r.status, 'reason', r.reason,
                   'created_at', r.created_at, 'decided_at', r.decided_at) order by r.created_at), '[]')
                   from guest_requests r where r.table_id = v_t.id and r.id = any (coalesce(p_ids, '{}'))),
    'lines', (select coalesce(jsonb_agg(jsonb_build_object('name', i.name, 'variant_name', i.variant_name, 'qty', i.qty, 'price', i.price,
                'status', i.status, 'sent_at', i.sent_at) order by i.sent_at, i.name), '[]')
                from order_items i
               where i.status::text <> 'void' and i.replaced_by is null
                 and i.order_id in (select ot.order_id from order_tables ot join orders o on o.id = ot.order_id
                                     where ot.table_id = v_t.id and ot.left_at is null and o.status = 'open')));
end $$;

-- ---------------------------------------------------------------- the staff side

-- Nhận: open the table if it is free (guest count from the request, else the seats), then send the lines on its
-- order as one round. The request id is the send batch, so a second tap (or a second device) sends nothing more.
create function accept_guest_request(p_id uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_r guest_requests;
  v_t tables;
  v_o orders;
begin
  perform _need('order.take');
  select * into v_r from guest_requests where id = p_id and branch_id = my_branch_id() for update;
  if not found then raise exception 'Không tìm thấy yêu cầu của khách'; end if;
  if v_r.status = 'accepted' then return v_r.order_id; end if;
  if v_r.status <> 'pending' then raise exception 'Yêu cầu này đã bị từ chối'; end if;
  select * into v_t from tables where id = v_r.table_id;
  v_o := open_table(v_r.table_id, coalesce(v_r.guest_count, least(99, greatest(1, v_t.seats))));
  if v_r.note <> '' and coalesce(v_o.note, '') = '' then update orders set note = left(v_r.note, 60) where id = v_o.id; end if;
  perform send_order_lines(v_o.id, v_r.lines, v_r.id, null);
  update guest_requests set status = 'accepted', decided_at = now(), decided_by = my_staff_id(), order_id = v_o.id where id = p_id;
  perform _audit('guest_accept', jsonb_build_object('request', p_id, 'order', v_o.id, 'table', v_r.table_id));
  return v_o.id;
end $$;

create function reject_guest_request(p_id uuid, p_reason text default '') returns void
language plpgsql security definer set search_path = public as $$
declare
  v_r guest_requests;
begin
  perform _need('order.take');
  select * into v_r from guest_requests where id = p_id and branch_id = my_branch_id() for update;
  if not found then raise exception 'Không tìm thấy yêu cầu của khách'; end if;
  if v_r.status <> 'pending' then raise exception 'Yêu cầu này đã được xử lý'; end if;
  update guest_requests set status = 'rejected', reason = left(btrim(coalesce(p_reason, '')), 80), decided_at = now(), decided_by = my_staff_id()
   where id = p_id;
  perform _audit('guest_reject', jsonb_build_object('request', p_id, 'table', v_r.table_id, 'reason', p_reason));
end $$;

-- Mã QR: give every table of the branch without one a token (p_table null), or a new token to one table (Đổi mã).
create function table_qr_tokens(p_table uuid default null) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform _need('tables.edit');
  if p_table is null then
    update tables set qr_token = replace(gen_random_uuid()::text, '-', '') where branch_id = my_branch_id() and qr_token is null;
  else
    update tables set qr_token = replace(gen_random_uuid()::text, '-', '') where id = p_table and branch_id = my_branch_id();
    if not found then raise exception 'Không tìm thấy bàn'; end if;
    perform _audit('table_qr_renew', jsonb_build_object('table', p_table));
  end if;
end $$;

create function set_guest_order(p_on boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform _need('settings.edit');
  update branch_settings set guest_order = coalesce(p_on, false) where branch_id = my_branch_id();
  perform _audit('guest_order', jsonb_build_object('on', p_on));
end $$;

revoke execute on function _guest_table(text) from public, anon, authenticated;
revoke execute on function guest_menu(text), guest_place_order(text, uuid, jsonb, text, int), guest_status(text, uuid[]),
  accept_guest_request(uuid), reject_guest_request(uuid, text), table_qr_tokens(uuid), set_guest_order(boolean) from public;
revoke execute on function accept_guest_request(uuid), reject_guest_request(uuid, text), table_qr_tokens(uuid), set_guest_order(boolean) from anon;
grant execute on function guest_menu(text), guest_place_order(text, uuid, jsonb, text, int), guest_status(text, uuid[]) to anon, authenticated;
grant execute on function accept_guest_request(uuid), reject_guest_request(uuid, text), table_qr_tokens(uuid), set_guest_order(boolean) to authenticated;
