-- Bò Mỹ Đen POS 0026: chống phá bằng vị trí. With a shop position and a radius set (Cài đặt → Mã QR gọi món, the
-- radius by the size of the place), a guest orders or calls only from within that distance: the QR page asks for the
-- phone's GPS as soon as it opens, and the server checks every request again.
--
--   branch_settings.guest_geo_lat / guest_geo_lng / guest_geo_radius   all set = on; radius 20–5000 m
--   _guest_geo_check     raises the guest-facing message when the position is missing or too far. The GPS accuracy
--                        counts in the guest's favour up to 150 m (indoors a phone is often 30–80 m off)
--   guest_geo            anon: is this position close enough (the QR page shows the menu only then)
--   guest_place_order, guest_call   take p_lat, p_lng, p_acc (the old signatures are replaced)
--   set_guest_geo        settings.edit
--   guest_menu           also says whether the position is needed (geo_required, geo_radius); never the shop's position
--
-- A phone can fake its GPS: this keeps out people who photographed the QR and are not in the shop, not a determined
-- attacker. Waiters still confirm every order (0023).

alter table branch_settings
  add column guest_geo_lat double precision check (guest_geo_lat between -90 and 90),
  add column guest_geo_lng double precision check (guest_geo_lng between -180 and 180),
  add column guest_geo_radius int check (guest_geo_radius between 20 and 5000);

-- metres between two points (haversine)
create function geo_distance_m(lat1 double precision, lng1 double precision, lat2 double precision, lng2 double precision) returns double precision
language sql immutable set search_path = public as $$
  select 2 * 6371000 * asin(sqrt(power(sin(radians(lat2 - lat1) / 2), 2)
                                 + cos(radians(lat1)) * cos(radians(lat2)) * power(sin(radians(lng2 - lng1) / 2), 2)))
$$;

-- null = fine (no geofence, or close enough); else what the guest is told
create function _guest_geo_problem(p_branch uuid, p_lat double precision, p_lng double precision, p_acc double precision)
returns text language plpgsql stable security definer set search_path = public as $$
declare
  v branch_settings;
  v_d double precision;
begin
  select * into v from branch_settings where branch_id = p_branch;
  if v.guest_geo_lat is null or v.guest_geo_lng is null or v.guest_geo_radius is null then return null; end if;
  if p_lat is null or p_lng is null or p_lat not between -90 and 90 or p_lng not between -180 and 180 then
    return 'Cần bật định vị (GPS) để gọi món: quán chỉ nhận món của khách đang ở quán';
  end if;
  v_d := geo_distance_m(v.guest_geo_lat, v.guest_geo_lng, p_lat, p_lng);
  if v_d - least(greatest(coalesce(p_acc, 0), 0), 150) > v.guest_geo_radius then
    return format('Bạn đang cách quán khoảng %s m: chỉ gọi được khi ở trong quán (trong %s m)',
                  case when v_d >= 1000 then (round(v_d / 100) * 100)::int::text else round(v_d)::int::text end, v.guest_geo_radius);
  end if;
  return null;
end $$;

create function _guest_geo_check(p_branch uuid, p_lat double precision, p_lng double precision, p_acc double precision) returns void
language plpgsql stable security definer set search_path = public as $$
declare
  v_msg text := _guest_geo_problem(p_branch, p_lat, p_lng, p_acc);
begin
  if v_msg is not null then raise exception '%', v_msg; end if;
end $$;

-- The QR page asks this with each new GPS fix before it shows the menu.
create function guest_geo(p_token text, p_lat double precision, p_lng double precision, p_acc double precision default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_t tables := _guest_table(p_token);
  v_msg text := _guest_geo_problem(v_t.branch_id, p_lat, p_lng, p_acc);
begin
  return jsonb_build_object('ok', v_msg is null, 'message', v_msg);
end $$;

create function set_guest_geo(p_lat double precision, p_lng double precision, p_radius int) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform _need('settings.edit');
  if p_radius is not null and (p_lat is null or p_lng is null) then raise exception 'Lấy vị trí quán trước khi bật giới hạn khoảng cách'; end if;
  if p_lat is not null and p_lat not between -90 and 90 or p_lng is not null and p_lng not between -180 and 180 then
    raise exception 'Vị trí quán không hợp lệ';
  end if;
  if p_radius is not null and p_radius not between 20 and 5000 then raise exception 'Bán kính từ 20 đến 5000 m'; end if;
  update branch_settings set guest_geo_lat = p_lat, guest_geo_lng = p_lng, guest_geo_radius = p_radius where branch_id = my_branch_id();
  perform _audit('guest_geo', jsonb_build_object('lat', p_lat, 'lng', p_lng, 'radius', p_radius));
end $$;

-- ---------------------------------------------------------------- 0023 / 0024 requests, now with the position

drop function guest_place_order(text, uuid, jsonb, text, int);
create function guest_place_order(p_token text, p_id uuid, p_lines jsonb, p_note text default '', p_guests int default null,
                                  p_lat double precision default null, p_lng double precision default null, p_acc double precision default null)
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
    return to_jsonb(v_r);
  end if;
  perform _guest_geo_check(v_t.branch_id, p_lat, p_lng, p_acc);
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
  perform 1 from tables where id = v_t.id for update;
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

drop function guest_call(text, uuid, text, text);
create function guest_call(p_token text, p_id uuid, p_kind text, p_note text default '',
                           p_lat double precision default null, p_lng double precision default null, p_acc double precision default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_t tables := _guest_table(p_token);
  v_r guest_requests;
begin
  if p_id is null then raise exception 'Thiếu mã yêu cầu'; end if;
  if p_kind is null or p_kind not in ('bill', 'service') then raise exception 'Yêu cầu không hợp lệ'; end if;
  select * into v_r from guest_requests where id = p_id;
  if found then
    if v_r.table_id <> v_t.id then raise exception 'Mã yêu cầu đã dùng'; end if;
    return to_jsonb(v_r);
  end if;
  perform _guest_geo_check(v_t.branch_id, p_lat, p_lng, p_acc);
  if char_length(btrim(coalesce(p_note, ''))) > 60 then raise exception 'Ghi chú tối đa 60 ký tự'; end if;
  perform 1 from tables where id = v_t.id for update;
  select * into v_r from guest_requests where table_id = v_t.id and kind = p_kind and status = 'pending' order by created_at desc limit 1;
  if found then return to_jsonb(v_r); end if;
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

-- guest_menu as in 0025, plus whether the QR page must get the position first
create or replace function guest_menu(p_token text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_t tables := _guest_table(p_token);
  v_b uuid := v_t.branch_id;
  v_s branch_settings;
begin
  select * into v_s from branch_settings where branch_id = v_b;
  return jsonb_build_object(
    'table', jsonb_build_object('id', v_t.id, 'name', v_t.name),
    'shop_name', v_s.shop_name,
    'call_chips', v_s.guest_call_chips,
    'geo_required', v_s.guest_geo_lat is not null and v_s.guest_geo_lng is not null and v_s.guest_geo_radius is not null,
    'geo_radius', v_s.guest_geo_radius,
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

revoke execute on function _guest_geo_problem(uuid, double precision, double precision, double precision),
  _guest_geo_check(uuid, double precision, double precision, double precision) from public, anon, authenticated;
revoke execute on function guest_geo(text, double precision, double precision, double precision),
  guest_place_order(text, uuid, jsonb, text, int, double precision, double precision, double precision),
  guest_call(text, uuid, text, text, double precision, double precision, double precision),
  set_guest_geo(double precision, double precision, int) from public;
revoke execute on function set_guest_geo(double precision, double precision, int) from anon;
grant execute on function guest_geo(text, double precision, double precision, double precision),
  guest_place_order(text, uuid, jsonb, text, int, double precision, double precision, double precision),
  guest_call(text, uuid, text, text, double precision, double precision, double precision) to anon, authenticated;
grant execute on function set_guest_geo(double precision, double precision, int) to authenticated;
