-- Bò Mỹ Đen POS 0027: khách đặt giao hàng trên web (dathang.bomyden.vn), nhân viên chốt phí ship rồi mới vào bếp.
--
--   branch_settings.online_order   nhận đơn online on / off for the branch (off until the shop turns it on)
--   branch_settings.online_ship    the shop's price table { base_km, base_fee, per_km, max_km }: the page's estimate
--   online_orders                  pending  -> a guest sent it; staff look up the real fee in Grab, Be or Xanh SM
--                                  quoted   -> staff gave the fee (and the food total); the guest sees the sum
--                                  agreed   -> the guest said yes; if paying by transfer the page shows the VietQR
--                                  accepted -> staff tapped Nhận: the lines went to the kitchen on a takeaway order
--                                  rejected | cancelled
--
-- The guest has no account: the order id the phone picked is what lets it read the order, and online_status returns
-- no name, phone or address. Nothing reaches the kitchen until staff accept. The food total comes from the staff
-- device (quote) and prices are the server's again on Nhận (send_order_lines). The ship fee stays on online_orders and
-- on the order note, not on the bill: it belongs to the carrier, not to the shop's revenue.
-- Distance is the straight line × 1.3: an estimate only, the fee the guest pays is always the one staff enter.

alter table branch_settings
  add column online_order boolean not null default false,
  add column online_ship jsonb not null default '{"base_km": 2, "base_fee": 15000, "per_km": 5000, "max_km": 10}'::jsonb;

create table online_orders (
  id uuid primary key,                                             -- the guest's phone picks it: resending never doubles
  branch_id uuid not null default my_branch_id() references branches on delete cascade,
  lines jsonb not null check (jsonb_typeof(lines) = 'array'),
  note text not null default '' check (char_length(note) <= 120),
  customer_name text not null check (char_length(btrim(customer_name)) between 1 and 40),
  phone text not null check (phone ~ '^0[0-9]{9}$'),
  address text not null check (char_length(btrim(address)) between 8 and 200),
  lat double precision check (lat between -90 and 90),
  lng double precision check (lng between -180 and 180),
  distance_m int check (distance_m >= 0),
  ship_estimate int check (ship_estimate >= 0),
  pay_method text not null check (pay_method in ('transfer', 'cod')),
  food_total int check (food_total >= 0),
  ship_fee int check (ship_fee >= 0),
  carrier text not null default '' check (carrier in ('', 'grab', 'be', 'xanhsm', 'other')),
  status text not null default 'pending' check (status in ('pending', 'quoted', 'agreed', 'accepted', 'rejected', 'cancelled')),
  reason text not null default '' check (char_length(reason) <= 80),
  created_at timestamptz not null default now(),
  quoted_at timestamptz,
  decided_at timestamptz,
  decided_by uuid references staff on delete set null,
  order_id uuid references orders on delete set null
);
create index online_orders_branch on online_orders (branch_id, status);
create index online_orders_phone on online_orders (phone, created_at);

alter table online_orders enable row level security;
revoke all on online_orders from anon, authenticated;
grant select on online_orders to authenticated;
create policy read_all on online_orders for select using ((select reader_role()) is not null);
create policy branch_only on online_orders as restrictive for all
  using (branch_id = (select my_branch_id())) with check (branch_id = (select my_branch_id()));
alter publication supabase_realtime add table online_orders;

-- the floor state carries the open ones and the last 4 hours of finished ones
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
  if v_n = 0 then raise exception '0027: % does not contain: %', p_fn, p_old; end if;
end $$;

select pg_temp.patch('get_floor_state',
  $x$'guest_requests', (select coalesce(jsonb_agg(to_jsonb(x) order by x.created_at), '[]') from guest_requests x, p$x$,
  $x$'online_orders', (select coalesce(jsonb_agg(to_jsonb(x) order by x.created_at), '[]') from online_orders x, p
                        where x.status in ('pending', 'quoted', 'agreed') or x.decided_at > p.since),
    'guest_requests', (select coalesce(jsonb_agg(to_jsonb(x) order by x.created_at), '[]') from guest_requests x, p$x$);

-- ---------------------------------------------------------------- the price table

-- Same rule as shipEstimate in src/lib/ship.ts.
create function _ship_estimate(p_rules jsonb, p_metres double precision) returns int
language sql immutable set search_path = public as $$
  select (p_rules ->> 'base_fee')::int
       + ceil(greatest(p_metres * 1.3 / 1000 - (p_rules ->> 'base_km')::numeric, 0))::int * (p_rules ->> 'per_km')::int
$$;

create function _ship_too_far(p_rules jsonb, p_metres double precision) returns boolean
language sql immutable set search_path = public as $$
  select p_metres * 1.3 / 1000 > (p_rules ->> 'max_km')::numeric
$$;

-- ---------------------------------------------------------------- the guest side (anon)

-- The branch an online guest orders from, made the caller's branch for this transaction (like _guest_table).
create function _online_branch(p_branch uuid) returns branch_settings
language plpgsql security definer set search_path = public as $$
declare
  v_s branch_settings;
begin
  if not exists (select 1 from branches b where b.id = p_branch and b.active) then raise exception 'Chi nhánh đang tạm đóng'; end if;
  select * into v_s from branch_settings where branch_id = p_branch;
  if not found or not v_s.online_order then raise exception 'Chi nhánh này chưa nhận đơn online'; end if;
  perform set_config('app.branch_override', p_branch::text, true);
  return v_s;
end $$;

-- Branches taking orders; with a position, nearest first, with the estimate. The shop's position itself stays private.
create function online_branches(p_lat double precision default null, p_lng double precision default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_pos boolean := p_lat is not null and p_lng is not null and p_lat between -90 and 90 and p_lng between -180 and 180;
  v_out jsonb := '[]'::jsonb;
  r record;
  v_d double precision;
  v_open boolean;
begin
  for r in
    select b.id, b.name, s.shop_name, s.address, s.online_ship, s.guest_geo_lat, s.guest_geo_lng,
           case when v_pos and s.guest_geo_lat is not null and s.guest_geo_lng is not null
                then geo_distance_m(s.guest_geo_lat, s.guest_geo_lng, p_lat, p_lng) end as metres
      from branches b join branch_settings s on s.branch_id = b.id
     where b.active and s.online_order
     order by metres nulls last, b.sort, b.created_at
  loop
    perform set_config('app.branch_override', r.id::text, true);
    v_open := branch_is_open();
    v_d := r.metres;
    v_out := v_out || jsonb_build_object('id', r.id, 'name', r.name, 'shop_name', r.shop_name, 'address', r.address, 'is_open', v_open,
      'distance_m', round(v_d)::int,
      'ship_estimate', case when v_d is not null then _ship_estimate(r.online_ship, v_d) end,
      'too_far', v_d is not null and _ship_too_far(r.online_ship, v_d));
  end loop;
  return v_out;
end $$;

-- The menu of a branch, in the get_menu_state shape (src/menu/supabaseRepo.ts reads it), as in guest_menu.
create function online_menu(p_branch uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_s branch_settings := _online_branch(p_branch);
  v_b uuid := p_branch;
begin
  return jsonb_build_object(
    'shop_name', v_s.shop_name,
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

-- Send an order. Lines are checked for shape here, again by send_order_lines on Nhận. Limits keep a prank small:
-- 3 waiting and 6 an hour per phone, 40 waiting per branch.
create function online_place_order(p_id uuid, p_branch uuid, p_lines jsonb, p_name text, p_phone text, p_address text, p_pay text,
                                   p_note text default '', p_lat double precision default null, p_lng double precision default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_s branch_settings;
  v_r online_orders;
  v_name text := btrim(coalesce(p_name, ''));
  v_phone text := regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g');
  v_addr text := btrim(coalesce(p_address, ''));
  v_note text := btrim(coalesce(p_note, ''));
  v_pos boolean := p_lat is not null and p_lng is not null and p_lat between -90 and 90 and p_lng between -180 and 180;
  v_d double precision;
  l jsonb;
  v_n int := 0;
begin
  if p_id is null then raise exception 'Thiếu mã đơn'; end if;
  select * into v_r from online_orders where id = p_id;
  if found then
    if v_r.branch_id <> p_branch then raise exception 'Mã đơn đã dùng'; end if;
    return jsonb_build_object('id', v_r.id, 'status', v_r.status);       -- the same tap sent twice
  end if;
  v_s := _online_branch(p_branch);
  if v_s.enforce_hours and not branch_is_open() then raise exception 'Quán đang ngoài giờ phục vụ'; end if;
  if char_length(v_name) not between 1 and 40 then raise exception 'Nhập họ tên người nhận (tối đa 40 ký tự)'; end if;
  if v_phone !~ '^0[0-9]{9}$' then raise exception 'Số điện thoại phải có 10 số, bắt đầu bằng 0'; end if;
  if char_length(v_addr) not between 8 and 200 then raise exception 'Nhập địa chỉ giao hàng đầy đủ'; end if;
  if char_length(v_note) > 120 then raise exception 'Ghi chú tối đa 120 ký tự'; end if;
  if p_pay is null or p_pay not in ('transfer', 'cod') then raise exception 'Chọn cách thanh toán'; end if;
  if jsonb_typeof(p_lines) is distinct from 'array' or jsonb_array_length(p_lines) = 0 then raise exception 'Chưa chọn món nào'; end if;
  if jsonb_array_length(p_lines) > 30 then raise exception 'Một lần đặt tối đa 30 dòng món'; end if;
  for l in select * from jsonb_array_elements(p_lines) loop
    if jsonb_typeof(l) <> 'object' or coalesce(l ->> 'menu_item_id', '') !~ '^[0-9a-f-]{36}$' then raise exception 'Món không hợp lệ'; end if;
    if not exists (select 1 from menu_items i where i.id = (l ->> 'menu_item_id')::uuid and i.branch_id = p_branch and i.status::text = 'active') then
      raise exception 'Có món không còn trên thực đơn, mời bạn tải lại trang';
    end if;
    if coalesce(l ->> 'qty', '') !~ '^\d{1,2}$' or (l ->> 'qty')::int not between 1 and 20 then raise exception 'Mỗi món từ 1 đến 20 phần'; end if;
    if char_length(coalesce(l ->> 'note', '')) > 60 then raise exception 'Ghi chú món tối đa 60 ký tự'; end if;
    v_n := v_n + (l ->> 'qty')::int;
  end loop;
  if v_n > 60 then raise exception 'Một lần đặt tối đa 60 phần'; end if;
  if v_pos and v_s.guest_geo_lat is not null and v_s.guest_geo_lng is not null then
    v_d := geo_distance_m(v_s.guest_geo_lat, v_s.guest_geo_lng, p_lat, p_lng);
    if _ship_too_far(v_s.online_ship, v_d) then
      raise exception 'Địa chỉ này xa quá phạm vi giao % km của chi nhánh', v_s.online_ship ->> 'max_km';
    end if;
  end if;
  perform 1 from branches where id = p_branch for update;            -- one order at a time per branch for the limits
  if (select count(*) from online_orders where phone = v_phone and status in ('pending', 'quoted', 'agreed')) >= 3 then
    raise exception 'Số điện thoại này đang có nhiều đơn chờ, mời bạn đợi quán xác nhận';
  end if;
  if (select count(*) from online_orders where phone = v_phone and created_at > now() - interval '1 hour') >= 6 then
    raise exception 'Số điện thoại này đã đặt nhiều đơn, mời bạn gọi quán';
  end if;
  if (select count(*) from online_orders where branch_id = p_branch and status in ('pending', 'quoted', 'agreed')) >= 40 then
    raise exception 'Quán đang nhiều đơn, mời bạn thử lại sau ít phút';
  end if;
  insert into online_orders (id, branch_id, lines, note, customer_name, phone, address, lat, lng, distance_m, ship_estimate, pay_method)
  values (p_id, p_branch, p_lines, v_note, v_name, v_phone, v_addr, case when v_pos then p_lat end, case when v_pos then p_lng end,
          round(v_d)::int, case when v_d is not null then _ship_estimate(v_s.online_ship, v_d) end, p_pay)
  returning * into v_r;
  perform _push_queue('guest', format('🛵 Đơn online · %s', v_name), format('%s phần, cần báo phí ship', v_n), '#/ban/online', 'online-' || v_r.id);
  return jsonb_build_object('id', v_r.id, 'status', v_r.status);
end $$;

-- What the guest's phone shows for its own orders, by id. Never the name, phone or address.
create function online_status(p_ids uuid[]) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', o.id, 'status', o.status, 'reason', o.reason, 'created_at', o.created_at,
           'pay_method', o.pay_method, 'food_total', o.food_total, 'ship_fee', o.ship_fee, 'carrier', o.carrier, 'ship_estimate', o.ship_estimate,
           'shop_name', s.shop_name, 'phone', s.phone,
           'bank', case when o.pay_method = 'transfer' and o.status = 'agreed'
                        then jsonb_build_object('bin', s.bank_bin, 'bank_name', s.bank_name, 'account', s.bank_account, 'holder', s.bank_account_name) end)
           order by o.created_at), '[]'::jsonb)
    from online_orders o join branch_settings s on s.branch_id = o.branch_id
   where o.id = any (coalesce(p_ids[1:20], '{}'))
$$;

-- Đồng ý: p_fee is the fee the guest saw, so a fee changed a moment ago is not agreed to by accident.
create function online_agree(p_id uuid, p_fee int) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_r online_orders;
begin
  select * into v_r from online_orders where id = p_id for update;
  if not found then raise exception 'Không tìm thấy đơn'; end if;
  if v_r.status in ('agreed', 'accepted') then return; end if;
  if v_r.status <> 'quoted' then raise exception 'Đơn này không còn chờ bạn xác nhận'; end if;
  if v_r.ship_fee is distinct from p_fee then raise exception 'Quán vừa đổi phí ship, mời bạn xem lại'; end if;
  perform set_config('app.branch_override', v_r.branch_id::text, true);
  update online_orders set status = 'agreed' where id = p_id;
  perform _push_queue('guest', format('✅ %s đồng ý phí ship', v_r.customer_name),
                      case v_r.pay_method when 'transfer' then 'Kiểm tra tiền chuyển khoản rồi nhận đơn' else 'Thu tiền khi giao: nhận đơn để gửi bếp' end,
                      '#/ban/online', 'online-' || v_r.id);
end $$;

-- Huỷ đơn: only before the kitchen has it.
create function online_cancel(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_r online_orders;
begin
  select * into v_r from online_orders where id = p_id for update;
  if not found then raise exception 'Không tìm thấy đơn'; end if;
  if v_r.status = 'cancelled' then return; end if;
  if v_r.status not in ('pending', 'quoted', 'agreed') then raise exception 'Quán đã nhận đơn, mời bạn gọi quán để huỷ'; end if;
  update online_orders set status = 'cancelled', decided_at = now() where id = p_id;
end $$;

-- ---------------------------------------------------------------- the staff side

-- Báo phí: again until the guest has agreed.
create function quote_online_order(p_id uuid, p_fee int, p_carrier text, p_food_total int) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_r online_orders;
begin
  perform _need('order.take');
  select * into v_r from online_orders where id = p_id and branch_id = my_branch_id() for update;
  if not found then raise exception 'Không tìm thấy đơn online'; end if;
  if v_r.status not in ('pending', 'quoted') then raise exception 'Đơn này đã được xử lý'; end if;
  if p_fee is null or p_fee not between 0 and 1000000 then raise exception 'Phí ship từ 0 đến 1.000.000đ'; end if;
  if p_food_total is null or p_food_total < 0 then raise exception 'Tiền món không hợp lệ'; end if;
  if p_carrier is null or p_carrier not in ('grab', 'be', 'xanhsm', 'other') then raise exception 'Chọn hãng giao hàng'; end if;
  update online_orders set status = 'quoted', ship_fee = p_fee, carrier = p_carrier, food_total = p_food_total, quoted_at = now() where id = p_id;
  perform _audit('online_quote', jsonb_build_object('order', p_id, 'fee', p_fee, 'carrier', p_carrier));
end $$;

-- Nhận: a takeaway order named after the guest, the lines as one round. The ship fee goes on the note, not the bill.
create function accept_online_order(p_id uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_r online_orders;
  v_o orders;
begin
  perform _need('order.take');
  select * into v_r from online_orders where id = p_id and branch_id = my_branch_id() for update;
  if not found then raise exception 'Không tìm thấy đơn online'; end if;
  if v_r.status = 'accepted' then return v_r.order_id; end if;
  if v_r.status <> 'agreed' then raise exception 'Khách chưa đồng ý phí ship'; end if;
  v_o := open_takeaway(left(v_r.customer_name || ' ' || v_r.phone, 40));
  update orders set note = left(format('Online %s · ship %s · %s', upper(left(v_r.id::text, 6)),
                                       to_char(v_r.ship_fee, 'FM999G999G999') || 'đ',
                                       case v_r.pay_method when 'cod' then 'thu khi giao' else 'đã chuyển khoản' end), 60)
   where id = v_o.id;
  perform send_order_lines(v_o.id, v_r.lines, v_r.id, null);
  update online_orders set status = 'accepted', decided_at = now(), decided_by = my_staff_id(), order_id = v_o.id where id = p_id;
  perform _audit('online_accept', jsonb_build_object('online', p_id, 'order', v_o.id));
  return v_o.id;
end $$;

create function reject_online_order(p_id uuid, p_reason text default '') returns void
language plpgsql security definer set search_path = public as $$
declare
  v_r online_orders;
begin
  perform _need('order.take');
  select * into v_r from online_orders where id = p_id and branch_id = my_branch_id() for update;
  if not found then raise exception 'Không tìm thấy đơn online'; end if;
  if v_r.status not in ('pending', 'quoted', 'agreed') then raise exception 'Đơn này đã được xử lý'; end if;
  update online_orders set status = 'rejected', reason = left(btrim(coalesce(p_reason, '')), 80), decided_at = now(), decided_by = my_staff_id()
   where id = p_id;
  perform _audit('online_reject', jsonb_build_object('order', p_id, 'reason', p_reason));
end $$;

-- Same rules as shipRulesProblem in src/lib/ship.ts.
create function set_online_settings(p_on boolean, p_ship jsonb) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform _need('settings.edit');
  if jsonb_typeof(p_ship) is distinct from 'object'
     or coalesce(p_ship ->> 'base_km', '') !~ '^\d{1,2}(\.\d)?$'
     or coalesce(p_ship ->> 'base_fee', '') !~ '^\d{1,7}$'
     or coalesce(p_ship ->> 'per_km', '') !~ '^\d{1,7}$'
     or coalesce(p_ship ->> 'max_km', '') !~ '^\d{1,3}(\.\d)?$'
     or (p_ship ->> 'max_km')::numeric <= 0 then
    raise exception 'Bảng giá ship không hợp lệ';
  end if;
  update branch_settings set online_order = coalesce(p_on, false),
    online_ship = jsonb_build_object('base_km', (p_ship ->> 'base_km')::numeric, 'base_fee', (p_ship ->> 'base_fee')::int,
                                     'per_km', (p_ship ->> 'per_km')::int, 'max_km', (p_ship ->> 'max_km')::numeric)
   where branch_id = my_branch_id();
  perform _audit('online_settings', jsonb_build_object('on', p_on, 'ship', p_ship));
end $$;

revoke execute on function _online_branch(uuid), _ship_estimate(jsonb, double precision), _ship_too_far(jsonb, double precision) from public, anon, authenticated;
revoke execute on function online_branches(double precision, double precision), online_menu(uuid),
  online_place_order(uuid, uuid, jsonb, text, text, text, text, text, double precision, double precision),
  online_status(uuid[]), online_agree(uuid, int), online_cancel(uuid),
  quote_online_order(uuid, int, text, int), accept_online_order(uuid), reject_online_order(uuid, text), set_online_settings(boolean, jsonb) from public;
revoke execute on function quote_online_order(uuid, int, text, int), accept_online_order(uuid), reject_online_order(uuid, text), set_online_settings(boolean, jsonb) from anon;
grant execute on function online_branches(double precision, double precision), online_menu(uuid),
  online_place_order(uuid, uuid, jsonb, text, text, text, text, text, double precision, double precision),
  online_status(uuid[]), online_agree(uuid, int), online_cancel(uuid) to anon, authenticated;
grant execute on function quote_online_order(uuid, int, text, int), accept_online_order(uuid), reject_online_order(uuid, text), set_online_settings(boolean, jsonb) to authenticated;
