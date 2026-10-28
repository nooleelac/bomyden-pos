-- Bò Mỹ Đen POS 0016: snappier screens.
--
-- 1. get_menu_state(): the whole menu in one call. The app made 12 requests for it (shop, stations, VAT, categories,
--    dishes, variants, components, groups, options, links, overrides) on every start and every menu change.
--    security invoker: the read policies still apply. Same filters as src/menu/supabaseRepo.ts used.
-- 2. open_table / open_takeaway take the new order's id from the device (p_id), so the order screen opens at once
--    while the call is on its way. Without p_id (older app versions) the server picks the id as before. A table
--    another device opened first still returns that order, as before.

-- ---------------------------------------------------------------- 1. one call for the menu

create or replace function get_menu_state() returns jsonb
language sql stable security invoker set search_path = public as $$
  select jsonb_build_object(
    'shop', (select coalesce(jsonb_agg(jsonb_build_object('prices_include_vat', x.prices_include_vat, 'business_day_start', x.business_day_start,
                'min_price_ratio', x.min_price_ratio)), '[]') from (select * from shop_settings limit 1) x),
    'stations', (select coalesce(jsonb_agg(to_jsonb(x) order by x.sort), '[]') from stations x where x.active),
    'vat_groups', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from vat_groups x),
    'vat_rates', (select coalesce(jsonb_agg(to_jsonb(x) order by x.valid_from), '[]') from vat_rates x
                   where x.valid_from <= (now() at time zone 'Asia/Ho_Chi_Minh')::date),
    'categories', (select coalesce(jsonb_agg(to_jsonb(x) order by x.sort), '[]') from menu_categories x),
    'items', (select coalesce(jsonb_agg(to_jsonb(x) order by x.sort), '[]') from menu_items x),
    'variants', (select coalesce(jsonb_agg(to_jsonb(x) order by x.sort), '[]') from menu_item_variants x),
    'components', (select coalesce(jsonb_agg(to_jsonb(x) order by x.sort), '[]') from item_components x where x.archived_at is null),
    'groups', (select coalesce(jsonb_agg(to_jsonb(x) order by x.sort), '[]') from modifier_groups x where x.archived_at is null),
    'options', (select coalesce(jsonb_agg(to_jsonb(x) order by x.sort), '[]') from modifier_options x where x.archived_at is null),
    'links', (select coalesce(jsonb_agg(to_jsonb(x) order by x.sort), '[]') from item_modifier_groups x),
    'overrides', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from item_option_overrides x))
$$;

revoke execute on function get_menu_state() from public, anon;
grant execute on function get_menu_state() to authenticated;

-- ---------------------------------------------------------------- 2. the device picks the new order's id

drop function open_table(uuid, int, uuid[], text);
create function open_table(p_table uuid, p_guests int, p_extra uuid[] default '{}', p_label text default null, p_id uuid default null)
returns orders language plpgsql security definer set search_path = public as $$
declare
  v_staff uuid := require_floor_staff();
  v_t tables;
  v_o orders;
  v_x uuid;
begin
  select * into v_t from tables where id = p_table for update;        -- two devices opening one table: one order
  if not found or not v_t.active then raise exception 'Bàn không dùng được'; end if;
  select o.* into v_o from order_tables ot join orders o on o.id = ot.order_id
  where ot.table_id = p_table and ot.left_at is null and o.status = 'open' order by ot.suffix limit 1;
  if found then return v_o; end if;
  if not coalesce((select active from areas where id = v_t.area_id), true) then raise exception 'Khu này đang tạm đóng'; end if;
  if p_guests is null or p_guests < 1 or p_guests > 99 then raise exception 'Số khách phải từ 1 đến 99'; end if;
  insert into orders (id, table_id, guest_count, position_label, opened_by)
  values (coalesce(p_id, gen_random_uuid()), p_table, p_guests, nullif(btrim(coalesce(p_label, '')), ''), v_staff) returning * into v_o;
  foreach v_x in array coalesce(p_extra, '{}') loop
    continue when v_x = p_table;
    perform 1 from tables where id = v_x and active for update;
    if not found then raise exception 'Bàn gộp không dùng được'; end if;
    if exists (select 1 from order_tables ot join orders o on o.id = ot.order_id where ot.table_id = v_x and ot.left_at is null and o.status = 'open') then
      raise exception 'Bàn % đang có khách: dùng Gộp bàn sau khi mở', (select name from tables where id = v_x);
    end if;
    insert into order_tables (order_id, table_id) values (v_o.id, v_x);
  end loop;
  update tables set needs_cleaning = false where id = p_table or id = any(coalesce(p_extra, '{}'));
  insert into audit_log (staff_id, action, detail) values (v_staff, 'open_table', jsonb_build_object('order', v_o.id, 'tables', p_table || coalesce(p_extra, '{}')));
  return v_o;
end $$;

drop function open_takeaway(text);
create function open_takeaway(p_customer text default '', p_id uuid default null)
returns orders language plpgsql security definer set search_path = public as $$
declare
  v_staff uuid := require_floor_staff();
  v_o orders;
begin
  insert into orders (id, kind, table_id, customer_name, opened_by)
  values (coalesce(p_id, gen_random_uuid()), 'takeaway', null, left(btrim(coalesce(p_customer, '')), 40), v_staff) returning * into v_o;
  return v_o;
end $$;

revoke execute on function open_table(uuid, int, uuid[], text, uuid) from public, anon;
grant execute on function open_table(uuid, int, uuid[], text, uuid) to authenticated;
revoke execute on function open_takeaway(text, uuid) from public, anon;
grant execute on function open_takeaway(text, uuid) to authenticated;
