-- Bò Mỹ Đen POS 0002: sizes, components, options/add-ons, stations, VAT by item group,
-- price locked at "Gửi bếp", shared tables (5-A, 5-B) and merged tables (one order on 3+4+5).
-- All money is whole VND. Line and bill maths mirror src/lib/pricing.ts: change both together.
--
-- How clients write after this migration:
--   open an order        insert into orders (table_id, guest_count, position_label)   -> gets its table row + suffix
--   merge at opening     insert into order_tables (order_id, table_id)
--   send to kitchen      rpc send_order_lines(order, lines, batch)   (direct inserts into order_items are closed)
--   move a whole order   update orders set table_id = ...
--   merge / move / split rpc merge_orders, move_items, split_order
--   pay                  rpc pay_order (total rounded, VAT split by rate)
-- Left for later: unmerge / release a table, void with manager PIN, daily stock limits, scheduled price changes,
-- per-size component quantities beyond display, combos, sell-by-weight, kitchen tickets/notices tables.

-- ---------------------------------------------------------------- settings

alter table shop_settings
  add column prices_include_vat boolean not null default true,
  add column service_charge_pct smallint not null default 0 check (service_charge_pct between 0 and 100),
  add column rounding_mode text not null default 'down' check (rounding_mode in ('down', 'nearest')),
  add column rounding_unit int not null default 1000 check (rounding_unit > 0),
  add column max_orders_per_table int not null default 4 check (max_orders_per_table between 1 and 26),
  add column max_merge_tables int not null default 30 check (max_merge_tables >= 1),
  add column business_day_start time not null default '06:00';   -- "hết hôm nay" reopens at this time

-- ---------------------------------------------------------------- stations (replaces the station enum)

create type station_kind as enum ('kitchen', 'bar', 'none');       -- 'none' = Không qua bếp: no ticket

create table stations (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  kind station_kind not null default 'kitchen',
  sort int not null default 0,
  active boolean not null default true
);
insert into stations (code, name, kind, sort) values
  ('grill', 'Bếp nướng', 'kitchen', 1),
  ('hotpot', 'Bếp lẩu', 'kitchen', 2),
  ('bar', 'Bar', 'bar', 3),
  ('none', 'Không qua bếp', 'none', 4);

alter table menu_categories add column default_station_id uuid references stations;
alter table menu_items add column station_id uuid references stations;      -- null = category default
update menu_items m set station_id = s.id from stations s where s.code = m.station::text;
alter table order_items add column station_id uuid references stations;     -- snapshot at send
update order_items i set station_id = s.id from stations s where s.code = i.station::text;
alter table order_items alter column station_id set not null;
alter table menu_items drop column station;
alter table order_items drop column station;
drop type station;

-- ---------------------------------------------------------------- VAT by item group

create table vat_groups (
  code text primary key,
  name text not null
);
insert into vat_groups values ('food', 'Món ăn, đồ uống'), ('alcohol', 'Bia, rượu');

create table vat_rates (
  vat_group text not null references vat_groups on delete cascade,
  valid_from date not null,
  rate smallint not null check (rate in (0, 5, 8, 10)),
  primary key (vat_group, valid_from)
);
-- Food and drinks 8% until 31/12/2026 (NQ 204/2025/QH15), 10% from 2027 unless extended; beer/alcohol 10%.
-- The shop's accountant confirms; add a row to change a rate from a date.
insert into vat_rates values
  ('food', '2025-01-01', 8),
  ('food', '2027-01-01', 10),
  ('alcohol', '2025-01-01', 10);

create function vat_rate_on(p_group text, p_day date) returns smallint
language sql stable set search_path = public as $$
  select rate from vat_rates where vat_group = p_group and valid_from <= p_day order by valid_from desc limit 1
$$;

-- ---------------------------------------------------------------- menu: flags, sizes, options, components

alter table menu_categories
  add column vat_group text not null default 'food' references vat_groups;

alter table menu_items
  add column has_sizes boolean not null default false,       -- true: price is per size and a size must be chosen; menu_items.price is unused
  add column vat_group text references vat_groups,             -- null = category's group
  add column price_includes_vat boolean,                       -- null = shop_settings.prices_include_vat
  add column discountable boolean not null default true,       -- false: a bill % discount skips it (e.g. beer)
  add column service_charge boolean not null default true,     -- counts toward the service charge, if the shop sets one
  add column sold_out_until timestamptz;                       -- null = selling; 'infinity' = until reopened

-- Sizes. No default size: a size-enabled item always needs an explicit choice.
create table menu_item_variants (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references menu_items on delete cascade,
  name text not null,                                          -- '200g', '300g', 'Nhỏ'
  code text,                                                   -- '101-300'
  price int not null check (price >= 0),
  sort int not null default 0,
  sold_out_until timestamptz,
  archived_at timestamptz,                                     -- sold sizes are hidden, never deleted
  unique (item_id, name),
  unique (id, item_id)
);

create type modifier_group_kind as enum ('choice', 'addon');   -- choice: Độ chín, Nước sốt; addon: paid extras per portion
create type receipt_print as enum ('always', 'if_priced', 'never');

create table modifier_groups (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  kind modifier_group_kind not null default 'choice',
  min_select int not null default 0 check (min_select >= 0),   -- Độ chín: 1..1, required before sending
  max_select int check (max_select >= greatest(min_select, 1)), -- null = no limit
  print_receipt receipt_print not null default 'if_priced',
  sort int not null default 0,
  archived_at timestamptz
);

create table modifier_options (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references modifier_groups on delete cascade,
  name text not null,                                          -- 'Medium rare', 'Thêm bánh mì'
  kitchen_name text not null default '',                       -- short ticket text
  price_delta int not null default 0 check (price_delta >= 0),
  max_qty int not null default 1 check (max_qty >= 1),         -- per portion (add-ons: up to 3 eggs)
  is_default boolean not null default false,                   -- pre-ticked in the order screen (sauces); never for Độ chín
  sort int not null default 0,
  sold_out_until timestamptz,
  archived_at timestamptz,
  unique (group_id, name)
);

create table item_modifier_groups (
  item_id uuid not null references menu_items on delete cascade,
  group_id uuid not null references modifier_groups on delete cascade,
  sort int not null default 0,
  min_override int check (min_override >= 0),
  max_override int check (max_override >= 1),
  primary key (item_id, group_id)
);

create table item_option_overrides (
  item_id uuid not null references menu_items on delete cascade,
  option_id uuid not null references modifier_options on delete cascade,
  price_delta int check (price_delta >= 0),                    -- null = the group's price
  hidden boolean not null default false,
  primary key (item_id, option_id)
);

create table item_components (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references menu_items on delete cascade,
  name text not null,                                          -- 'Trứng gà ốp la'
  kitchen_name text not null default '',                       -- 'TRỨNG' -> ticket shows KHÔNG TRỨNG
  qty numeric(8, 2) not null default 1,
  unit text not null default '',
  removable boolean not null default false,                    -- false = main component, cannot be left out
  removal_discount int not null default 0 check (removal_discount >= 0),
  addon_option_id uuid references modifier_options on delete set null,  -- the matching "Thêm trứng", to refuse no egg + extra egg
  sort int not null default 0,
  sold_out_until timestamptz,
  archived_at timestamptz,
  unique (item_id, name),
  check (removable or removal_discount = 0)
);

-- Component amount per size ("1 miếng steak 300g"): display and future stock only, never price.
create table item_component_variant_qty (
  component_id uuid not null references item_components on delete cascade,
  variant_id uuid not null references menu_item_variants on delete cascade,
  qty numeric(8, 2) not null,
  primary key (component_id, variant_id)
);

-- ---------------------------------------------------------------- price history

create table price_history (
  id bigserial primary key,
  entity_type text not null check (entity_type in ('item', 'variant', 'option', 'component_discount')),
  entity_id uuid not null,
  old_value int,
  new_value int,
  changed_by uuid references staff,
  changed_at timestamptz not null default now()
);
create index price_history_entity on price_history (entity_type, entity_id, changed_at);

create function log_price_change() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_old int;
  v_new int := (to_jsonb(new) ->> tg_argv[1])::int;
begin
  if tg_op = 'UPDATE' then v_old := (to_jsonb(old) ->> tg_argv[1])::int; end if;
  if v_old is distinct from v_new then
    insert into price_history (entity_type, entity_id, old_value, new_value, changed_by)
    values (tg_argv[0], new.id, v_old, v_new, (select id from staff where user_id = auth.uid()));
  end if;
  return null;
end $$;

create trigger price_history after insert or update of price on menu_items
  for each row execute function log_price_change('item', 'price');
create trigger price_history after insert or update of price on menu_item_variants
  for each row execute function log_price_change('variant', 'price');
create trigger price_history after insert or update of price_delta on modifier_options
  for each row execute function log_price_change('option', 'price_delta');
create trigger price_history after insert or update of removal_discount on item_components
  for each row execute function log_price_change('component_discount', 'removal_discount');

-- ---------------------------------------------------------------- orders on tables: shared (5-A, 5-B) and merged (3+4+5)

alter type order_status add value if not exists 'merged';      -- folded into another order by merge_orders

alter table orders
  add column position_label text check (char_length(position_label) <= 30),  -- 'đầu bàn', '2 khách áo xanh'; required once a table holds 2+ orders
  add column guest_count int check (guest_count between 1 and 99),
  add column merged_into uuid references orders;

-- Several open orders may now share a table; orders.table_id is the order's primary table.
drop index orders_one_open_per_table;

create table order_tables (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references orders on delete cascade,
  table_id uuid not null references tables,
  suffix text not null check (suffix ~ '^[A-Z]$'),             -- set by trigger: first order on a table 'A', then 'B', 'C'
  joined_at timestamptz not null default now(),
  left_at timestamptz                                          -- set when the order closes, moves away or leaves the group
);
create unique index order_tables_active_suffix on order_tables (table_id, suffix) where left_at is null;
create unique index order_tables_active_member on order_tables (order_id, table_id) where left_at is null;
create index order_tables_order on order_tables (order_id);

-- Existing open orders (at most one per table under 0001) become 'A'.
insert into order_tables (order_id, table_id, suffix, joined_at)
select id, table_id, 'A', opened_at from orders where status = 'open';

-- Every order sharing a table with another must carry a position label.
create function check_shared_labels(p_table uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if (select count(*) from order_tables where table_id = p_table and left_at is null) > 1
     and exists (select 1 from order_tables ot join orders o on o.id = ot.order_id
                 where ot.table_id = p_table and ot.left_at is null and coalesce(btrim(o.position_label), '') = '') then
    raise exception 'Bàn % đang có nhiều đơn: mỗi đơn phải ghi vị trí ngồi', (select name from tables where id = p_table);
  end if;
end $$;

create function order_tables_before_insert() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  s shop_settings;
begin
  select * into s from shop_settings;
  if not exists (select 1 from orders where id = new.order_id and status = 'open') then
    raise exception 'Đơn không còn mở';
  end if;
  perform 1 from tables where id = new.table_id for update;    -- one suffix pick per table at a time
  if (select count(*) from order_tables where table_id = new.table_id and left_at is null) >= s.max_orders_per_table then
    raise exception 'Bàn % đã có đủ % đơn', (select name from tables where id = new.table_id), s.max_orders_per_table;
  end if;
  if (select count(*) from order_tables where order_id = new.order_id and left_at is null) >= s.max_merge_tables then
    raise exception 'Một nhóm gộp tối đa % bàn', s.max_merge_tables;
  end if;
  new.suffix := (select chr(65 + i) from generate_series(0, 25) i
                 where chr(65 + i) not in (select suffix from order_tables where table_id = new.table_id and left_at is null)
                 order by i limit 1);
  new.joined_at := now();
  new.left_at := null;
  return new;
end $$;
create trigger order_tables_before_insert before insert on order_tables
  for each row execute function order_tables_before_insert();

create function order_tables_after_insert() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform check_shared_labels(new.table_id);
  return null;
end $$;
create trigger order_tables_after_insert after insert on order_tables
  for each row execute function order_tables_after_insert();

create function orders_after_insert() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status <> 'open' or new.merged_into is not null then
    raise exception 'Đơn mới phải ở trạng thái mở';
  end if;
  insert into order_tables (order_id, table_id) values (new.id, new.table_id);
  return null;
end $$;
create trigger orders_after_insert after insert on orders
  for each row execute function orders_after_insert();

-- Status guards: paid only through pay_order, merged only through merge_orders, void only when empty, no reopening here.
create function orders_before_update() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if old.status <> 'open' and (new.status is distinct from old.status or new.table_id is distinct from old.table_id) then
    raise exception 'Đơn đã đóng, không mở lại hay chuyển bàn ở đây';
  end if;
  if new.status is distinct from old.status then
    if new.status = 'paid' and not exists (select 1 from bills where order_id = new.id) then
      raise exception 'Chỉ thanh toán qua pay_order';
    elsif new.status::text = 'merged' and new.merged_into is null then
      raise exception 'Chỉ gộp qua merge_orders';
    elsif new.status = 'void' and exists (select 1 from order_items where order_id = new.id and status <> 'void') then
      raise exception 'Đơn còn món: huỷ món trước khi đóng đơn';
    end if;
    new.closed_at := coalesce(new.closed_at, now());
  end if;
  return new;
end $$;
create trigger orders_before_update before update on orders
  for each row execute function orders_before_update();

-- Side effects: closing frees the tables; changing table_id moves the order (chuyển bàn).
create function orders_after_update() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_table uuid;
begin
  if old.status = 'open' and new.status <> 'open' then
    update order_tables set left_at = now() where order_id = new.id and left_at is null;
  elsif new.status = 'open' and new.table_id <> old.table_id
        and not exists (select 1 from order_tables where order_id = new.id and table_id = new.table_id and left_at is null) then
    update order_tables set left_at = now() where order_id = new.id and table_id = old.table_id and left_at is null;
    insert into order_tables (order_id, table_id) values (new.id, new.table_id);
    -- unfinished dishes follow the guests; served ones keep their history
    update order_items set delivery_table_id = new.table_id
    where order_id = new.id and delivery_table_id = old.table_id and status in ('new', 'cooking', 'ready');
  end if;
  -- (table_id moved to a table already in the group = just a new primary table; nothing else changes)
  if new.status = 'open' and new.position_label is distinct from old.position_label then
    for v_table in select table_id from order_tables where order_id = new.id and left_at is null loop
      perform check_shared_labels(v_table);
    end loop;
  end if;
  return null;
end $$;
create trigger orders_after_update after update on orders
  for each row execute function orders_after_update();

-- Display labels. '5' alone; '5-A', '5-B' once the table is shared (or the order is not the first one on it).
create function order_table_label(p_order uuid, p_table uuid) returns text
language sql stable set search_path = public as $$
  select t.name || case when ot.suffix <> 'A'
                          or exists (select 1 from order_tables x where x.table_id = ot.table_id and x.left_at is null and x.id <> ot.id)
                        then '-' || ot.suffix else '' end
  from order_tables ot join tables t on t.id = ot.table_id
  where ot.order_id = p_order and ot.table_id = p_table
  order by ot.left_at is null desc, ot.joined_at desc
  limit 1
$$;

-- 'nhóm gộp 3+4+5' while the order spans several tables, else null.
create function order_group_label(p_order uuid) returns text
language sql stable set search_path = public as $$
  select case when count(*) > 1 then 'nhóm gộp ' || string_agg(t.name, '+' order by t.sort, t.name) end
  from order_tables ot join tables t on t.id = ot.table_id
  where ot.order_id = p_order and ot.left_at is null
$$;

-- ---------------------------------------------------------------- order lines: snapshots and modifiers

alter table order_items
  add column variant_id uuid,
  add column variant_name text,                                -- '300g'
  add column base_price int check (base_price >= 0),           -- size (or item) price at send; price = base + modifiers, floor 0
  add column sent_at timestamptz,                              -- Gửi bếp: price and snapshots are locked from here
  add column send_batch uuid,                                  -- client id of one Gửi bếp tap; resending it is a no-op
  add column delivery_table_id uuid references tables,         -- where the guest actually sits; kitchen prints it big
  add column origin_order_id uuid references orders,           -- order it was rung on (kept across merge/move, for undo)
  add column parent_line_id uuid references order_items,       -- add-on rung after its main dish was sent
  add column vat_rate smallint check (vat_rate in (0, 5, 8, 10)),
  add column price_includes_vat boolean,
  add column discountable boolean not null default true,
  add column service_charge boolean not null default true,
  add constraint order_items_variant_fk foreign key (variant_id, menu_item_id) references menu_item_variants (id, item_id);

update order_items i set
  base_price = i.price,
  sent_at = i.batch_at,
  origin_order_id = i.order_id,
  delivery_table_id = o.table_id,
  vat_rate = coalesce(vat_rate_on(coalesce(m.vat_group, c.vat_group), (i.batch_at at time zone 'Asia/Ho_Chi_Minh')::date), 8),
  price_includes_vat = true
from orders o, menu_items m, menu_categories c
where o.id = i.order_id and m.id = i.menu_item_id and c.id = m.category_id;

alter table order_items
  alter column base_price set not null,
  alter column sent_at set not null,
  alter column sent_at set default now(),
  alter column delivery_table_id set not null,
  alter column vat_rate set not null,
  alter column price_includes_vat set not null;
comment on column order_items.price is 'Unit price per portion locked at send: base_price + modifiers, never below 0.';

create index order_items_order on order_items (order_id);
create index order_items_send_batch on order_items (send_batch) where send_batch is not null;

create type modifier_kind as enum ('option', 'addon', 'removal');

create table order_item_modifiers (
  id uuid primary key default gen_random_uuid(),
  order_item_id uuid not null references order_items on delete cascade,
  kind modifier_kind not null,
  option_id uuid references modifier_options,                  -- option / add-on
  component_id uuid references item_components,                -- removed component
  group_name text not null default '',                         -- snapshots, so old bills never change
  name text not null,
  kitchen_name text not null default '',
  qty int not null default 1 check (qty >= 1),                 -- per portion
  unit_delta int not null,                                     -- per unit: option/add-on price, or −removal discount
  print_receipt receipt_print not null default 'if_priced',
  check (case when kind = 'removal'
              then component_id is not null and option_id is null and unit_delta <= 0
              else option_id is not null and component_id is null and unit_delta >= 0 end)
);
create index order_item_modifiers_line on order_item_modifiers (order_item_id);
create unique index order_item_modifiers_option on order_item_modifiers (order_item_id, option_id);
create unique index order_item_modifiers_component on order_item_modifiers (order_item_id, component_id);

-- A live line must be delivered to one of its order's current tables.
create function order_items_check_delivery() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status in ('new', 'cooking', 'ready')
     and not exists (select 1 from order_tables where order_id = new.order_id and table_id = new.delivery_table_id and left_at is null) then
    raise exception 'Bàn ra món phải là một bàn của đơn';
  end if;
  return new;
end $$;
create trigger order_items_check_delivery before insert or update of order_id, delivery_table_id on order_items
  for each row execute function order_items_check_delivery();

-- ---------------------------------------------------------------- Gửi bếp: the only way lines enter an order

-- p_lines: [{ menu_item_id, variant_id?, qty, note?, delivery_table_id?, parent_line_id?,
--             options: [{ option_id, qty? }], removals: [component_id] }]
-- The server prices every line from the menu (never from the client) and locks it.
create or replace function send_order_lines(p_order uuid, p_lines jsonb, p_batch uuid default null)
returns setof order_items language plpgsql security definer set search_path = public as $$
declare
  v_staff uuid := (select id from staff where user_id = auth.uid() and active and role in ('waiter', 'cashier', 'manager'));
  v_order orders;
  v_shop shop_settings;
  v_now timestamptz := now();
  v_day date := (now() at time zone 'Asia/Ho_Chi_Minh')::date;
  v_ids uuid[] := '{}';
  l jsonb;
  m jsonb;
  v_item menu_items;
  v_cat menu_categories;
  v_var menu_item_variants;
  v_opt modifier_options;
  v_grp modifier_groups;
  v_comp item_components;
  v_station stations;
  v_line uuid;
  v_qty int;
  v_mqty int;
  v_table uuid;
  v_cid uuid;
  v_msg text;
begin
  if v_staff is null then raise exception 'Chỉ phục vụ, thu ngân hoặc quản lý được gửi bếp'; end if;
  select * into v_order from orders where id = p_order for update;
  if not found or v_order.status <> 'open' then raise exception 'Đơn không còn mở'; end if;
  if p_batch is not null and exists (select 1 from order_items where send_batch = p_batch) then
    return query select * from order_items where send_batch = p_batch order by id;
    return;
  end if;
  if jsonb_typeof(p_lines) is distinct from 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'Không có món để gửi';
  end if;
  select * into v_shop from shop_settings;

  for l in select * from jsonb_array_elements(p_lines) loop
    select * into v_item from menu_items where id = (l ->> 'menu_item_id')::uuid;
    if not found or not v_item.available then raise exception 'Món không có trong thực đơn'; end if;
    if v_item.sold_out_until > v_now then raise exception 'Hết món: %', v_item.name; end if;
    select * into v_cat from menu_categories where id = v_item.category_id;
    v_qty := (l ->> 'qty')::int;
    if v_qty is null or v_qty < 1 then raise exception 'Số lượng không hợp lệ: %', v_item.name; end if;

    if v_item.has_sizes then
      select * into v_var from menu_item_variants
      where id = (l ->> 'variant_id')::uuid and item_id = v_item.id and archived_at is null;
      if not found then raise exception 'Chọn size cho món %', v_item.name; end if;
      if v_var.sold_out_until > v_now then raise exception 'Hết size %: %', v_var.name, v_item.name; end if;
    elsif l ->> 'variant_id' is not null then
      raise exception 'Món % không có size', v_item.name;
    else
      v_var := null;
    end if;

    select * into v_station from stations where id = coalesce(v_item.station_id, v_cat.default_station_id);
    if not found then raise exception 'Món % chưa chọn khu chế biến', v_item.name; end if;
    v_table := coalesce((l ->> 'delivery_table_id')::uuid, v_order.table_id);
    if l ->> 'parent_line_id' is not null
       and not exists (select 1 from order_items where id = (l ->> 'parent_line_id')::uuid and order_id = p_order) then
      raise exception 'Món chính không thuộc đơn này';
    end if;

    insert into order_items (order_id, menu_item_id, name, price, qty, note, status, station_id, batch_at, created_by,
                             variant_id, variant_name, base_price, sent_at, send_batch, delivery_table_id, origin_order_id,
                             parent_line_id, vat_rate, price_includes_vat, discountable, service_charge)
    values (p_order, v_item.id, v_item.name, 0, v_qty, coalesce(l ->> 'note', ''),
            case when v_station.kind = 'none' then 'ready' else 'new' end::item_status,   -- no-prep: straight to "chờ bưng"
            v_station.id, v_now, v_staff,
            v_var.id, v_var.name, coalesce(v_var.price, v_item.price), v_now, p_batch, v_table, p_order,
            (l ->> 'parent_line_id')::uuid,
            vat_rate_on(coalesce(v_item.vat_group, v_cat.vat_group), v_day),
            coalesce(v_item.price_includes_vat, v_shop.prices_include_vat), v_item.discountable, v_item.service_charge)
    returning id into v_line;

    -- options and paid add-ons
    for m in select * from jsonb_array_elements(coalesce(l -> 'options', '[]')) loop
      select o.* into v_opt from modifier_options o
      join item_modifier_groups ig on ig.group_id = o.group_id and ig.item_id = v_item.id
      join modifier_groups g on g.id = o.group_id and g.archived_at is null
      where o.id = (m ->> 'option_id')::uuid and o.archived_at is null
        and not exists (select 1 from item_option_overrides x where x.item_id = v_item.id and x.option_id = o.id and x.hidden);
      if not found then raise exception 'Tuỳ chọn không dùng được cho món %', v_item.name; end if;
      if v_opt.sold_out_until > v_now then raise exception 'Hết: %', v_opt.name; end if;
      select * into v_grp from modifier_groups where id = v_opt.group_id;
      v_mqty := coalesce((m ->> 'qty')::int, 1);
      if v_mqty < 1 or v_mqty > (case when v_grp.kind = 'choice' then 1 else v_opt.max_qty end) then
        raise exception 'Số lượng "%" không hợp lệ', v_opt.name;
      end if;
      insert into order_item_modifiers (order_item_id, kind, option_id, group_name, name, kitchen_name, qty, unit_delta, print_receipt)
      values (v_line, case when v_grp.kind = 'choice' then 'option' else 'addon' end::modifier_kind, v_opt.id, v_grp.name,
              v_opt.name, v_opt.kitchen_name, v_mqty,
              coalesce((select price_delta from item_option_overrides where item_id = v_item.id and option_id = v_opt.id), v_opt.price_delta),
              v_grp.print_receipt);
    end loop;

    -- required groups (Độ chín) and selection limits
    select format('Nhóm "%s" của món %s cần chọn từ %s đến %s', g.name, v_item.name,
                  coalesce(ig.min_override, g.min_select), coalesce(coalesce(ig.max_override, g.max_select)::text, 'tuỳ ý'))
      into v_msg
    from item_modifier_groups ig
    join modifier_groups g on g.id = ig.group_id and g.archived_at is null
    cross join lateral (select count(*) as n from order_item_modifiers mo join modifier_options o on o.id = mo.option_id
                        where mo.order_item_id = v_line and o.group_id = g.id) c
    where ig.item_id = v_item.id
      and (c.n < coalesce(ig.min_override, g.min_select) or c.n > coalesce(ig.max_override, g.max_select, c.n))
    limit 1;
    if v_msg is not null then raise exception '%', v_msg; end if;

    -- removed components: discount comes from the menu, only removable ones, never together with the matching add-on
    for v_cid in select x::uuid from jsonb_array_elements_text(coalesce(l -> 'removals', '[]')) x loop
      select * into v_comp from item_components where id = v_cid and item_id = v_item.id and archived_at is null;
      if not found then raise exception 'Thành phần không thuộc món %', v_item.name; end if;
      if not v_comp.removable then raise exception 'Không bỏ được thành phần chính: %', v_comp.name; end if;
      if exists (select 1 from order_item_modifiers where order_item_id = v_line and option_id = v_comp.addon_option_id) then
        raise exception 'Không thể vừa bỏ vừa thêm %', v_comp.name;
      end if;
      insert into order_item_modifiers (order_item_id, kind, component_id, name, kitchen_name, unit_delta, print_receipt)
      values (v_line, 'removal', v_comp.id, v_comp.name, v_comp.kitchen_name, -v_comp.removal_discount, 'always');
    end loop;

    -- sold-out components: a main one stops the dish, a removable one must be left out
    select c.name into v_msg from item_components c
    where c.item_id = v_item.id and c.archived_at is null and c.sold_out_until > v_now
      and not exists (select 1 from order_item_modifiers mo where mo.order_item_id = v_line and mo.component_id = c.id)
    limit 1;
    if found then raise exception 'Hết %: món % chỉ gửi được khi bỏ thành phần này (nếu được bỏ)', v_msg, v_item.name; end if;

    update order_items set price = greatest(0, base_price
             + coalesce((select sum(unit_delta * qty) from order_item_modifiers where order_item_id = v_line), 0))
    where id = v_line;
    v_ids := v_ids || v_line;
  end loop;

  return query select oi.* from unnest(v_ids) with ordinality u(id, n) join order_items oi on oi.id = u.id order by u.n;
end $$;

-- ---------------------------------------------------------------- bill maths (same steps as billTotals in pricing.ts)

-- subtotal -> bill discount spread over discountable lines -> service charge -> VAT per rate -> round the total once.
-- All-VAT-included bill (the default): the rates absorb the rounding before VAT is taken out.
-- Any VAT-excluded line: VAT is added on top and the rounding stays a separate line.
-- Ties in the spreading go by rate ascending, VAT-included first, service-charge lines first (as in pricing.ts).
create or replace function calc_bill(p_order uuid, p_discount int default 0)
returns jsonb language plpgsql stable set search_path = public as $$
declare
  s shop_settings;
  v_base bigint;
  v_out jsonb;
begin
  select * into s from shop_settings;
  select coalesce(sum(price::bigint * qty) filter (where discountable), 0)::bigint into v_base
  from order_items where order_id = p_order and status <> 'void';
  if p_discount is null or p_discount < 0 or p_discount > v_base then
    raise exception 'Giảm giá % không hợp lệ (tối đa %)', p_discount, v_base;
  end if;

  with b as (
    select vat_rate::bigint as r, price_includes_vat as incl, service_charge as sc, discountable as disc,
           sum(price::bigint * qty)::bigint as amt
    from order_items where order_id = p_order and status <> 'void'
    group by 1, 2, 3, 4
  ), d as (
    select b.*,
           case when disc and v_base > 0 then p_discount * amt / v_base else 0 end as fl,
           case when disc and v_base > 0 then p_discount * amt % v_base else 0 end as rem
    from b
  ), d2 as (
    select d.*, p_discount - (sum(fl) over ())::bigint as leftover,
           row_number() over (order by disc desc, rem desc, r, incl desc, sc desc) as rn
    from d
  ), n as (
    select r, incl, sc, amt - fl - case when disc and rn <= leftover then 1 else 0 end as net from d2
  ), g as (
    select r, incl, sum(net)::bigint as net,
           (2 * coalesce(sum(net) filter (where sc), 0)::bigint * s.service_charge_pct + 100) / 200 as charge
    from n group by r, incl
  ), g2 as (
    select r, incl, charge, net + charge as gross,
           case when incl then 0 else (2 * (net + charge) * r + 100) / 200 end as vat_add
    from g
  ), t as (
    select coalesce(sum(gross + vat_add), 0)::bigint as pre from g2
  ), t2 as (
    select pre,
           case s.rounding_mode when 'down' then pre / s.rounding_unit * s.rounding_unit
                else (2 * pre + s.rounding_unit) / (2 * s.rounding_unit) * s.rounding_unit end as total
    from t
  ), ra as (
    select g2.*, t2.total - t2.pre as rnd,
           case when bool_and(incl) over () then (sum(gross) over ())::bigint else 0 end as ibase
    from g2, t2
  ), ra2 as (
    select ra.*,
           case when incl and ibase > 0 then abs(rnd) * gross / ibase else 0 end as fl,
           case when incl and ibase > 0 then abs(rnd) * gross % ibase else 0 end as rem
    from ra
  ), ra3 as (
    select ra2.*, abs(rnd) - (sum(fl) over ())::bigint as leftover,
           row_number() over (order by incl desc, rem desc, r) as rn
    from ra2
  ), f as (
    select r, incl, charge, vat_add,
           gross + (case when rnd < 0 then -1 else 1 end)
                   * (fl + case when incl and ibase > 0 and rn <= leftover then 1 else 0 end) as gross
    from ra3
  ), v as (
    select r, incl, charge, gross,
           case when incl then (2 * gross * r + 100 + r) / (2 * (100 + r)) else vat_add end as vat
    from f
  )
  select jsonb_build_object(
    'subtotal', (select coalesce(sum(amt), 0) from b),
    'discount_base', v_base,
    'discount', p_discount,
    'service_charge', (select coalesce(sum(charge), 0) from v),
    'vat_added', (select coalesce(sum(vat) filter (where not incl), 0) from v),
    'vat_total', (select coalesce(sum(vat), 0) from v),
    'rounding', t2.total - t2.pre,
    'total', t2.total,
    'vat', (select coalesce(jsonb_agg(jsonb_build_object(
              'vat_rate', r, 'price_includes_vat', incl,
              'base', case when incl then gross - vat else gross end, 'vat', vat) order by r, incl desc), '[]')
            from v))
  into v_out from t2;
  return v_out;
end $$;

alter table bills
  add column service_charge int not null default 0 check (service_charge >= 0),
  add column vat_added int not null default 0 check (vat_added >= 0),     -- VAT added on top of VAT-excluded prices
  add column vat_total int not null default 0 check (vat_total >= 0),     -- all VAT on the bill (for "trong đó thuế GTGT")
  add column rounding int not null default 0,                             -- signed
  add column vat_lines jsonb not null default '[]',                       -- [{vat_rate, price_includes_vat, base, vat}]
  add column table_label text not null default '';                        -- '5-B', 'nhóm gộp 3+4+5'
alter table bills drop constraint bills_check;
alter table bills add constraint bills_total_formula
  check (total = subtotal - discount + service_charge + vat_added + rounding);

-- Settle an order: same checks as 0001, total now rounded and VAT split by rate.
-- Unfinished dishes stay on the kitchen screen after payment (no longer forced to 'served').
create or replace function pay_order(p_order uuid, p_discount int, p_payments jsonb)
returns bills language plpgsql security definer set search_path = public as $$
declare
  v_calc jsonb;
  v_total int;
  v_paid int;
  v_bill bills;
  v_order orders;
  v_staff uuid := (select id from staff where user_id = auth.uid());
begin
  if not exists (select 1 from staff where id = v_staff and role in ('cashier', 'manager') and active) then
    raise exception 'Chỉ thu ngân hoặc quản lý được thanh toán';
  end if;
  select * into v_order from orders where id = p_order and status = 'open' for update;
  if not found then raise exception 'Order không còn mở'; end if;

  v_calc := calc_bill(p_order, p_discount);
  v_total := (v_calc ->> 'total')::int;
  select coalesce(sum((p ->> 'amount')::int), 0) into v_paid from jsonb_array_elements(p_payments) p;
  if v_paid <> v_total then
    raise exception 'Tổng thanh toán % khác số phải trả %', v_paid, v_total;
  end if;

  insert into bills (order_id, subtotal, discount, service_charge, vat_added, vat_total, rounding, total, vat_lines,
                     table_label, cashier_id)
  values (p_order, (v_calc ->> 'subtotal')::int, p_discount, (v_calc ->> 'service_charge')::int,
          (v_calc ->> 'vat_added')::int, (v_calc ->> 'vat_total')::int, (v_calc ->> 'rounding')::int, v_total,
          v_calc -> 'vat', coalesce(order_group_label(p_order), order_table_label(p_order, v_order.table_id), ''), v_staff)
  returning * into v_bill;
  insert into payments (bill_id, method, amount, tendered)
  select v_bill.id, (p ->> 'method')::pay_method, (p ->> 'amount')::int, nullif(p ->> 'tendered', '')::int
  from jsonb_array_elements(p_payments) p;

  update orders set status = 'paid', closed_at = now() where id = p_order;
  if p_discount > 0 then
    insert into audit_log (staff_id, action, detail)
    values (v_staff, 'discount', jsonb_build_object('bill', v_bill.bill_no, 'amount', p_discount));
  end if;
  return v_bill;
end $$;

-- ---------------------------------------------------------------- merge, move, split

-- Gộp bàn after ordering: every line moves to the target order and keeps its delivery table and kitchen status
-- (no ticket is resent). Source orders close as 'merged'.
create or replace function merge_orders(p_target uuid, p_sources uuid[])
returns orders language plpgsql security definer set search_path = public as $$
declare
  v_staff uuid := (select id from staff where user_id = auth.uid() and active and role in ('waiter', 'cashier', 'manager'));
  v_sources uuid[] := (select array_agg(distinct x) from unnest(p_sources) x where x is distinct from p_target);
  v_src orders;
  v_table uuid;
  v_target orders;
  v_detail jsonb := '[]';
begin
  if v_staff is null then raise exception 'Không có quyền gộp bàn'; end if;
  if v_sources is null then raise exception 'Chọn đơn cần gộp'; end if;
  perform 1 from orders where id = p_target or id = any(v_sources) order by id for update;
  if (select count(*) from orders o join tables t on t.id = o.table_id
      where (o.id = p_target or o.id = any(v_sources)) and o.status = 'open' and not t.is_takeaway) <> 1 + cardinality(v_sources) then
    raise exception 'Chỉ gộp được các đơn tại bàn đang mở';
  end if;
  select * into v_target from orders where id = p_target;

  for v_src in select * from orders where id = any(v_sources) order by opened_at loop
    v_detail := v_detail || jsonb_build_object(
      'order', v_src.id, 'table', order_table_label(v_src.id, v_src.table_id),
      'amount', (select coalesce(sum(price * qty), 0) from order_items where order_id = v_src.id and status <> 'void'));
    for v_table in select table_id from order_tables where order_id = v_src.id and left_at is null loop
      update order_tables set left_at = now() where order_id = v_src.id and table_id = v_table and left_at is null;
      if not exists (select 1 from order_tables where order_id = p_target and table_id = v_table and left_at is null) then
        insert into order_tables (order_id, table_id) values (p_target, v_table);
      end if;
    end loop;
    update order_items set origin_order_id = coalesce(origin_order_id, order_id), order_id = p_target
    where order_id = v_src.id;
    update orders set status = 'merged', merged_into = p_target, closed_at = now() where id = v_src.id;
    v_target.guest_count := nullif(coalesce(v_target.guest_count, 0) + coalesce(v_src.guest_count, 0), 0);
    v_target.opened_at := least(v_target.opened_at, v_src.opened_at);   -- seating time from the earliest table
  end loop;

  update orders set guest_count = v_target.guest_count, opened_at = v_target.opened_at where id = p_target
  returning * into v_target;
  insert into audit_log (staff_id, action, detail)
  values (v_staff, 'merge_orders', jsonb_build_object('into', p_target, 'from', v_detail));
  return v_target;
end $$;

-- Chuyển món: p_items [{ id, qty? }] (qty < line qty splits the line; price and snapshots travel with it).
-- Waiters move unfinished dishes; moving finished/served ones (money between bills) needs cashier or manager.
create or replace function move_items(p_items jsonb, p_target uuid)
returns setof order_items language plpgsql security definer set search_path = public as $$
declare
  v_role staff_role := my_role();
  v_staff uuid := (select id from staff where user_id = auth.uid());
  v_target orders;
  it jsonb;
  v_line order_items;
  v_qty int;
  v_id uuid;
  v_ids uuid[] := '{}';
begin
  if v_role is null or v_role = 'kitchen' then raise exception 'Không có quyền chuyển món'; end if;
  perform 1 from orders
  where id = p_target or id in (select order_id from order_items where id in (select (x ->> 'id')::uuid from jsonb_array_elements(p_items) x))
  order by id for update;
  select * into v_target from orders where id = p_target;
  if not found or v_target.status <> 'open' then raise exception 'Đơn nhận không còn mở'; end if;

  for it in select * from jsonb_array_elements(p_items) loop
    select * into v_line from order_items where id = (it ->> 'id')::uuid for update;
    if not found then raise exception 'Không tìm thấy món'; end if;
    if not exists (select 1 from orders where id = v_line.order_id and status = 'open') then raise exception 'Đơn nguồn không còn mở'; end if;
    if v_line.order_id = p_target then raise exception 'Món đã ở đơn này'; end if;
    if v_line.status = 'void' then raise exception 'Món đã huỷ'; end if;
    if v_line.status in ('ready', 'served') and v_role = 'waiter' then
      raise exception 'Chuyển món đã xong hoặc đã ra cần thu ngân hoặc quản lý';
    end if;
    v_qty := coalesce((it ->> 'qty')::int, v_line.qty);
    if v_qty < 1 or v_qty > v_line.qty then raise exception 'Số lượng chuyển không hợp lệ: %', v_line.name; end if;

    if v_qty < v_line.qty then
      update order_items set qty = qty - v_qty where id = v_line.id;
      v_id := gen_random_uuid();
      insert into order_items
      select (jsonb_populate_record(null::order_items, to_jsonb(v_line) || jsonb_build_object('id', v_id, 'qty', v_qty))).*;
      insert into order_item_modifiers
      select (jsonb_populate_record(null::order_item_modifiers,
                to_jsonb(mo) || jsonb_build_object('id', gen_random_uuid(), 'order_item_id', v_id))).*
      from order_item_modifiers mo where mo.order_item_id = v_line.id;
    else
      v_id := v_line.id;
    end if;

    update order_items set
      origin_order_id = coalesce(origin_order_id, order_id),
      order_id = p_target,
      delivery_table_id = case when exists (select 1 from order_tables where order_id = p_target and table_id = v_line.delivery_table_id and left_at is null)
                               then delivery_table_id else v_target.table_id end
    where id = v_id;
    v_ids := v_ids || v_id;
    insert into audit_log (staff_id, action, detail)
    values (v_staff, 'move_items', jsonb_build_object('line', v_id, 'name', v_line.name, 'qty', v_qty,
                                                      'from', v_line.order_id, 'to', p_target));
  end loop;

  return query select oi.* from unnest(v_ids) with ordinality u(id, n) join order_items oi on oi.id = u.id order by u.n;
end $$;

-- Tách đơn: chosen lines go to a new order on the same table (5-B), paid separately.
create or replace function split_order(p_order uuid, p_items jsonb, p_position_label text,
                                       p_guest_count int default null, p_source_label text default null)
returns orders language plpgsql security definer set search_path = public as $$
declare
  v_src orders;
  v_new orders;
begin
  if not coalesce(my_role() in ('cashier', 'manager'), false) then raise exception 'Chỉ thu ngân hoặc quản lý được tách đơn'; end if;
  select * into v_src from orders where id = p_order for update;
  if not found or v_src.status <> 'open' then raise exception 'Đơn không còn mở'; end if;
  if exists (select 1 from jsonb_array_elements(p_items) x
             left join order_items oi on oi.id = (x ->> 'id')::uuid
             where oi.order_id is distinct from p_order) then
    raise exception 'Món không thuộc đơn cần tách';
  end if;
  if p_source_label is not null then
    update orders set position_label = p_source_label where id = p_order;
  end if;
  insert into orders (table_id, opened_by, position_label, guest_count)
  values (v_src.table_id, (select id from staff where user_id = auth.uid()), p_position_label, p_guest_count)
  returning * into v_new;
  perform move_items(p_items, v_new.id);
  return v_new;
end $$;

-- ---------------------------------------------------------------- sold out

-- p_kind: item | variant | option | component; p_mode: today (back at business_day_start) | hold | reopen
create or replace function set_sold_out(p_kind text, p_id uuid, p_mode text)
returns timestamptz language plpgsql security definer set search_path = public as $$
declare
  v_local timestamp := now() at time zone 'Asia/Ho_Chi_Minh';
  v_start time := (select business_day_start from shop_settings);
  v_until timestamptz;
begin
  if not coalesce(my_role() in ('kitchen', 'cashier', 'manager'), false) then
    raise exception 'Chỉ bếp, thu ngân hoặc quản lý được báo hết món';
  end if;
  v_until := case p_mode
    when 'today' then ((v_local::date + case when v_local::time < v_start then 0 else 1 end) + v_start) at time zone 'Asia/Ho_Chi_Minh'
    when 'hold' then 'infinity'::timestamptz
    when 'reopen' then null
  end;
  if p_mode is null or p_mode not in ('today', 'hold', 'reopen') then raise exception 'Kiểu báo hết không hợp lệ'; end if;
  case p_kind
    when 'item' then update menu_items set sold_out_until = v_until where id = p_id;
    when 'variant' then update menu_item_variants set sold_out_until = v_until where id = p_id;
    when 'option' then update modifier_options set sold_out_until = v_until where id = p_id;
    when 'component' then update item_components set sold_out_until = v_until where id = p_id;
    else raise exception 'Loại không hợp lệ: %', p_kind;
  end case;
  if not found then raise exception 'Không tìm thấy mục cần báo hết'; end if;
  insert into audit_log (staff_id, action, detail)
  values ((select id from staff where user_id = auth.uid()), case when v_until is null then 'restock' else 'sold_out' end,
          jsonb_build_object('kind', p_kind, 'id', p_id, 'until', v_until));
  return v_until;
end $$;

-- ---------------------------------------------------------------- read models

-- Kitchen: delivery table big ('5', '5-B'), group small ('nhóm gộp 3+4+5'). Merging never changes a line's
-- delivery table or status, so existing tickets stay as they are; only the group line appears.
create view kitchen_queue with (security_invoker = true) as
select oi.id, oi.order_id, oi.station_id, oi.status, oi.sent_at, oi.qty, oi.name, oi.variant_name, oi.note,
       oi.delivery_table_id,
       order_table_label(oi.order_id, oi.delivery_table_id) as delivery_label,
       order_group_label(oi.order_id) as group_label,
       o.position_label,
       (select coalesce(jsonb_agg(jsonb_build_object('kind', mo.kind, 'name', mo.name, 'kitchen_name', mo.kitchen_name, 'qty', mo.qty)
                                  order by mo.kind, mo.name), '[]')
        from order_item_modifiers mo where mo.order_item_id = oi.id) as modifiers
from order_items oi join orders o on o.id = oi.order_id
where oi.status in ('new', 'cooking', 'ready');

-- Floor map / order picker: one row per open order.
create view open_orders with (security_invoker = true) as
select o.id, o.table_id, o.guest_count, o.position_label, o.opened_at,
       order_table_label(o.id, o.table_id) as label,
       order_group_label(o.id) as group_label,
       (select array_agg(ot.table_id order by ot.joined_at) from order_tables ot where ot.order_id = o.id and ot.left_at is null) as table_ids
from orders o
where o.status = 'open';

-- ---------------------------------------------------------------- security

alter table stations enable row level security;
alter table vat_groups enable row level security;
alter table vat_rates enable row level security;
alter table menu_item_variants enable row level security;
alter table modifier_groups enable row level security;
alter table modifier_options enable row level security;
alter table item_modifier_groups enable row level security;
alter table item_option_overrides enable row level security;
alter table item_components enable row level security;
alter table item_component_variant_qty enable row level security;
alter table price_history enable row level security;
alter table order_tables enable row level security;
alter table order_item_modifiers enable row level security;

create policy read_all on stations for select using (my_role() is not null);
create policy read_all on vat_groups for select using (my_role() is not null);
create policy read_all on vat_rates for select using (my_role() is not null);
create policy read_all on menu_item_variants for select using (my_role() is not null);
create policy read_all on modifier_groups for select using (my_role() is not null);
create policy read_all on modifier_options for select using (my_role() is not null);
create policy read_all on item_modifier_groups for select using (my_role() is not null);
create policy read_all on item_option_overrides for select using (my_role() is not null);
create policy read_all on item_components for select using (my_role() is not null);
create policy read_all on item_component_variant_qty for select using (my_role() is not null);
create policy read_mgr on price_history for select using (my_role() = 'manager');
create policy read_all on order_tables for select using (my_role() is not null);
create policy read_all on order_item_modifiers for select using (my_role() is not null);

create policy manage on stations for all using (my_role() = 'manager') with check (my_role() = 'manager');
create policy manage on vat_groups for all using (my_role() = 'manager') with check (my_role() = 'manager');
create policy manage on vat_rates for all using (my_role() = 'manager') with check (my_role() = 'manager');
create policy manage on menu_item_variants for all using (my_role() = 'manager') with check (my_role() = 'manager');
create policy manage on modifier_groups for all using (my_role() = 'manager') with check (my_role() = 'manager');
create policy manage on modifier_options for all using (my_role() = 'manager') with check (my_role() = 'manager');
create policy manage on item_modifier_groups for all using (my_role() = 'manager') with check (my_role() = 'manager');
create policy manage on item_option_overrides for all using (my_role() = 'manager') with check (my_role() = 'manager');
create policy manage on item_components for all using (my_role() = 'manager') with check (my_role() = 'manager');
create policy manage on item_component_variant_qty for all using (my_role() = 'manager') with check (my_role() = 'manager');

-- Gộp bàn at opening = add a table to the order. Leaving a group goes through a function (later).
create policy join_table on order_tables for insert with check (my_role() in ('waiter', 'cashier', 'manager'));

-- Lines enter only through send_order_lines; after that price and snapshots are read-only to clients.
-- Kitchen and floor staff may still change status, void reason and the delivery table.
drop policy add_items on order_items;
revoke insert, update on order_items from anon, authenticated;
grant update (status, void_reason, delivery_table_id) on order_items to authenticated;
-- Orders: status/table/label/guests only; the triggers above guard what each status change may do.
revoke update on orders from anon, authenticated;
grant update (table_id, status, position_label, guest_count) on orders to authenticated;
-- order_item_modifiers and price_history are written only by the functions above.

alter publication supabase_realtime add table order_tables, order_item_modifiers, menu_item_variants, modifier_options, item_components, stations;
