-- Bò Mỹ Đen POS 0025: the quick picks a guest taps on Gọi phục vụ ("Thêm nước đá", "Dọn bàn") and Gọi thanh toán
-- ("Tiền mặt", "Chuyển khoản") are the branch's own (Cài đặt → Mã QR gọi món).
--
--   branch_settings.guest_call_chips   {"service": [...], "bill": [...]}; a missing key = the app's defaults, [] = none.
--                                      At most 12 per list, each 1–30 characters
--   set_guest_call_chips(p)            settings.edit
--   guest_menu                         also returns them (call_chips) to the guest's phone

alter table branch_settings add column guest_call_chips jsonb not null default '{}'::jsonb;

create function guest_call_chips_ok(p jsonb) returns boolean
language sql immutable set search_path = public as $$
  select jsonb_typeof(p) = 'object'
     and not exists (select 1 from jsonb_object_keys(p) k where k not in ('service', 'bill'))
     and not exists (
       select 1 from jsonb_each(p) e
        where jsonb_typeof(e.value) <> 'array' or jsonb_array_length(e.value) > 12
           or exists (select 1 from jsonb_array_elements(e.value) x
                       where jsonb_typeof(x) <> 'string' or char_length(btrim(x #>> '{}')) not between 1 and 30))
$$;
alter table branch_settings add constraint branch_settings_call_chips check (guest_call_chips_ok(guest_call_chips));

create function set_guest_call_chips(p jsonb) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform _need('settings.edit');
  if not guest_call_chips_ok(coalesce(p, '{}'::jsonb)) then
    raise exception 'Mỗi danh sách tối đa 12 câu gợi ý, mỗi câu 1–30 ký tự';
  end if;
  update branch_settings set guest_call_chips = coalesce(p, '{}'::jsonb) where branch_id = my_branch_id();
  perform _audit('guest_call_chips', jsonb_build_object('chips', p));
end $$;

-- guest_menu as in 0023, plus call_chips
create or replace function guest_menu(p_token text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_t tables := _guest_table(p_token);
  v_b uuid := v_t.branch_id;
begin
  return jsonb_build_object(
    'table', jsonb_build_object('id', v_t.id, 'name', v_t.name),
    'shop_name', (select shop_name from branch_settings where branch_id = v_b),
    'call_chips', (select guest_call_chips from branch_settings where branch_id = v_b),
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

revoke execute on function set_guest_call_chips(jsonb), guest_call_chips_ok(jsonb) from public, anon;
grant execute on function set_guest_call_chips(jsonb), guest_call_chips_ok(jsonb) to authenticated;
