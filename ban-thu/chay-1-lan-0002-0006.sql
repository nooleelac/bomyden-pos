-- Bò Mỹ Đen: chạy một lần trong SQL Editor của dự án bomyden-pos-thu (0001 đã có sẵn)

-- ===== 0002_menu_and_tables.sql =====
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


-- ===== 0003_menu_profile.sql =====
-- Bò Mỹ Đen POS 0003: what the menu management screens need on top of 0002.
-- Categories: 2 levels, colour, hide. Items: code, short name, unit, prep time, status draft/active/archived.
-- The screens read and write these through src/menu/supabaseRepo.ts.

-- ---------------------------------------------------------------- categories

alter table menu_categories
  add column parent_id uuid references menu_categories on delete restrict,
  add column color text not null default '#757575' check (color ~ '^#[0-9a-fA-F]{6}$'),
  add column visible boolean not null default true;               -- hidden: its items leave the order screen, history stays

create index menu_categories_parent on menu_categories (parent_id);

-- At most 2 levels (Đồ uống -> Bia). More levels mean more taps for the waiter.
create function menu_categories_check_depth() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.parent_id is not null then
    if new.parent_id = new.id then raise exception 'Nhóm không thể là nhóm con của chính nó'; end if;
    if (select parent_id from menu_categories where id = new.parent_id) is not null then
      raise exception 'Chỉ có 2 cấp: nhóm lớn và nhóm con';
    end if;
    if exists (select 1 from menu_categories where parent_id = new.id) then
      raise exception 'Nhóm % đang có nhóm con nên không làm nhóm con được', new.name;
    end if;
  end if;
  return new;
end $$;
create trigger menu_categories_check_depth before insert or update of parent_id on menu_categories
  for each row execute function menu_categories_check_depth();

-- ---------------------------------------------------------------- item profile

create type menu_item_status as enum ('draft', 'active', 'archived');   -- Nháp -> Đang bán -> Ngừng kinh doanh

alter table menu_items
  add column code text,                                            -- '101', 'STB'; typed in the search box
  add column short_name text not null default '',                  -- kitchen ticket, printed in capitals
  add column unit text not null default 'phần'
    check (unit in ('phần', 'đĩa', 'nồi', 'chai', 'lon', 'ly', 'kg', 'gram')),
  add column prep_minutes int check (prep_minutes between 1 and 240),  -- per-item "late" mark on the kitchen screen
  add column status menu_item_status not null default 'active',
  add column description text not null default '',                 -- shown to staff on long-press
  add column keywords text[] not null default '{}',                 -- extra search words: 'bít tết'
  add constraint menu_items_name_len check (char_length(name) <= 40) not valid,       -- 2 lines on 80mm paper
  add constraint menu_items_short_name_len check (char_length(short_name) <= 20);

-- Codes are unique (ignoring case and outer spaces) within items and within sizes. The editor also stops
-- an item code from matching another item's size code.
create unique index menu_items_code on menu_items (lower(btrim(code))) where coalesce(btrim(code), '') <> '';
create unique index menu_item_variants_code on menu_item_variants (lower(btrim(code))) where coalesce(btrim(code), '') <> '';

-- Existing rows: available -> active, otherwise archived. From now on `available` follows status, so
-- send_order_lines (which checks available) refuses drafts and archived items without being rewritten.
update menu_items set status = case when available then 'active' else 'archived' end::menu_item_status;

create function menu_items_sync_available() returns trigger
language plpgsql set search_path = public as $$
begin
  new.available := new.status = 'active';
  return new;
end $$;
create trigger menu_items_sync_available before insert or update on menu_items
  for each row execute function menu_items_sync_available();

-- "At least one size when sizes are on" is checked by the editor (validate.ts); the database does not
-- enforce it because the item and its sizes are saved in separate requests. send_order_lines still refuses
-- a size-enabled line without a live size ("Chọn size cho món ...").

-- ---------------------------------------------------------------- removal floor

-- Removing components may not take a portion below this share of its size price (spec: 50%).
-- The picker enforces it today; send_order_lines does not read it yet.
alter table shop_settings
  add column min_price_ratio numeric(3, 2) not null default 0.50 check (min_price_ratio between 0 and 1);

-- ---------------------------------------------------------------- live updates on every device

alter publication supabase_realtime add table menu_categories, modifier_groups, item_modifier_groups, item_option_overrides;


-- ===== 0004_floor_kitchen.sql =====
-- Bò Mỹ Đen POS 0004: what the floor map, order screen and kitchen display need on top of 0001–0003.
-- Same rules as src/floor/engine.ts (the sample repo); keep both in step.
--
-- Table states (computed, never stored by hand): Trống, Đang ngồi, Chờ thanh toán (bill_requested_at),
-- Đang thanh toán (paying_at), Chờ dọn (tables.needs_cleaning, "Dọn xong" -> Trống).
-- Kitchen item states: new = Chờ làm -> cooking = Đang làm -> ready = Xong -> served = Đã bưng; void = Huỷ.
-- A kitchen ticket = one send batch x one station x one order x one delivery table; its key is
-- 'send_batch|station_id|order_id|delivery_table_id' (as ticketKey in src/floor/logic.ts).
--
-- How clients write after this migration (all RPCs, security definer, role-checked):
--   open_table, add_shared_order, open_takeaway, send_order_lines (now with p_rush_reason), void_item,
--   modify_item, decide_modify, ack_notice, set_item_status, bump_ticket, recall_ticket, chase_order,
--   merge_orders / move_items / split_order (0002), move_order, release_table, split_table_from_group,
--   request_bill, begin_payment, cancel_payment, pay_order (0002), mark_table_clean.
--   Direct updates: orders.guest_count / position_label / note / allergy / customer_name, orders.status = 'void'
--   for an empty order; areas and tables by managers (cashiers may add a temporary table).
-- Left for later: manager PIN at a waiter's device (verify_manager_pin; today an after-start void needs a manager
-- signed in), partial "Xong 2 of 4", per-item extra minutes, print jobs, undo of a whole merge, deposits.

-- ---------------------------------------------------------------- settings, areas, tables, stations

alter table shop_settings
  add column require_table_cleaning boolean not null default true,   -- paid tables wait for "Dọn xong"
  add column waiter_sees_amounts boolean not null default false;

alter table areas add column active boolean not null default true;   -- false = tạm đóng (grey, no new orders)

alter table tables
  add column seats int not null default 4 check (seats between 1 and 99),
  add column active boolean not null default true,                   -- used tables are never deleted
  add column is_temporary boolean not null default false,            -- bàn tạm (kê thêm)
  add column needs_cleaning boolean not null default false;

-- Example thresholds in minutes (the shop sets its own): yellow, red.
alter table stations
  add column sla_warn_min int not null default 10 check (sla_warn_min > 0),
  add column sla_late_min int not null default 15 check (sla_late_min > 0);
update stations set sla_warn_min = 12, sla_late_min = 20 where code = 'grill';
update stations set sla_warn_min = 7, sla_late_min = 12 where code = 'hotpot';
update stations set sla_warn_min = 5, sla_late_min = 10 where code = 'bar';

-- Who is calling, as staff.id (null for none or inactive).
create function my_staff_id() returns uuid
language sql stable security definer set search_path = public as $$
  select id from staff where user_id = auth.uid() and active
$$;

create function require_floor_staff() returns uuid
language plpgsql stable security definer set search_path = public as $$
declare
  v uuid := (select id from staff where user_id = auth.uid() and active and role in ('waiter', 'cashier', 'manager'));
begin
  if v is null then raise exception 'Chỉ phục vụ, thu ngân hoặc quản lý được thao tác đơn'; end if;
  return v;
end $$;

create function require_kitchen_or_manager() returns uuid
language plpgsql stable security definer set search_path = public as $$
declare
  v uuid := (select id from staff where user_id = auth.uid() and active and role in ('kitchen', 'manager'));
begin
  if v is null then raise exception 'Chỉ máy bếp, bar hoặc quản lý được đổi trạng thái này'; end if;
  return v;
end $$;

-- A table or area with an open order cannot be put out of use.
create function tables_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if old.active and not new.active
     and exists (select 1 from order_tables ot join orders o on o.id = ot.order_id
                 where ot.table_id = new.id and ot.left_at is null and o.status = 'open') then
    raise exception 'Bàn còn đơn chưa thanh toán: chưa ngừng dùng được';
  end if;
  return new;
end $$;
create trigger tables_guard before update of active on tables for each row execute function tables_guard();

create function areas_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if old.active and not new.active
     and exists (select 1 from tables t join order_tables ot on ot.table_id = t.id and ot.left_at is null
                 join orders o on o.id = ot.order_id and o.status = 'open' where t.area_id = new.id) then
    raise exception 'Khu còn đơn chưa thanh toán: chưa tạm đóng được';
  end if;
  return new;
end $$;
create trigger areas_guard before update of active on areas for each row execute function areas_guard();

create policy temp_table on tables for insert with check (my_role() = 'cashier' and is_temporary);

-- ---------------------------------------------------------------- orders: takeaway, note, bill and payment state

create type order_kind as enum ('dine_in', 'takeaway');

alter table orders
  add column kind order_kind not null default 'dine_in',
  add column takeaway_no int,                                        -- MV-01, MV-02 … per business day
  add column customer_name text not null default '' check (char_length(customer_name) <= 40),
  add column note text not null default '' check (char_length(note) <= 60),   -- boxed on top of every ticket
  add column allergy boolean not null default false,
  add column rounds int not null default 0,                           -- Lượt 1, Lượt 2 …
  add column bill_requested_at timestamptz,                           -- In tạm tính: Chờ thanh toán
  add column bill_print_count int not null default 0,
  add column paying_at timestamptz,                                   -- Đang thanh toán (locks the order)
  add column paying_by uuid references staff,
  add column chased_at timestamptz,
  add column chase_count int not null default 0;
alter table orders alter column table_id drop not null;
alter table orders add constraint orders_kind_table check ((kind = 'takeaway') = (table_id is null));

-- Takeaway orders take no table; dine-in orders get their order_tables row as before.
create or replace function orders_after_insert() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status <> 'open' or new.merged_into is not null then
    raise exception 'Đơn mới phải ở trạng thái mở';
  end if;
  if new.kind = 'dine_in' then
    insert into order_tables (order_id, table_id) values (new.id, new.table_id);
  end if;
  return null;
end $$;

-- MV number: next of the business day (starting at shop_settings.business_day_start, Vietnam time).
create function orders_before_insert() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_start time := (select business_day_start from shop_settings);
  v_local timestamp := now() at time zone 'Asia/Ho_Chi_Minh';
  v_from timestamptz;
begin
  if new.kind = 'takeaway' then
    perform 1 from shop_settings for update;                          -- one number at a time
    v_from := ((v_local::date - case when v_local::time < v_start then 1 else 0 end) + v_start) at time zone 'Asia/Ho_Chi_Minh';
    new.takeaway_no := coalesce((select max(takeaway_no) from orders where kind = 'takeaway' and opened_at >= v_from), 0) + 1;
  else
    new.takeaway_no := null;
  end if;
  return new;
end $$;
create trigger orders_before_insert before insert on orders for each row execute function orders_before_insert();

-- Paid tables wait for "Dọn xong" when the shop turns cleaning on (only once no other order sits there).
create function orders_set_cleaning() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if old.status = 'open' and new.status = 'paid' and (select require_table_cleaning from shop_settings) then
    update tables t set needs_cleaning = true
    where t.id in (select table_id from order_tables where order_id = new.id)
      and not exists (select 1 from order_tables x join orders o on o.id = x.order_id
                      where x.table_id = t.id and x.left_at is null and o.status = 'open');
  end if;
  return null;
end $$;
create trigger orders_set_cleaning after update of status on orders for each row execute function orders_set_cleaning();

grant update (note, allergy, customer_name) on orders to authenticated;

-- Display label of an order: 'MV-07' for takeaway, else the table label of its primary table.
create function order_label(p_order uuid) returns text
language sql stable set search_path = public as $$
  select case when o.kind = 'takeaway' then 'MV-' || lpad(o.takeaway_no::text, 2, '0')
              else order_table_label(o.id, o.table_id) end
  from orders o where o.id = p_order
$$;

-- ---------------------------------------------------------------- order lines: round, rush, kitchen times, SỬA, moves

alter table order_items
  add column round int not null default 1,
  add column rush boolean not null default false,
  add column rush_reason text not null default '',
  add column started_at timestamptz,
  add column ready_at timestamptz,
  add column served_at timestamptz,
  add column voided_at timestamptz,
  add column voided_by uuid references staff,
  add column void_stage item_status,                                  -- kitchen state when voided
  add column replaced_by uuid references order_items,                 -- SỬA: the line that replaced this one
  add column moved_from_label text not null default '',               -- CHUYỂN TỪ 5 (15 minutes on the ticket)
  add column moved_at timestamptz,
  add constraint order_items_note_len check (char_length(note) <= 60) not valid;
alter table order_items alter column delivery_table_id drop not null;  -- takeaway lines have no table

-- Lines sent before 0004 without a batch: one batch per order and send time, so they form tickets.
update order_items i set send_batch = b.batch
from (select order_id, batch_at, gen_random_uuid() as batch from order_items where send_batch is null group by 1, 2) b
where i.send_batch is null and i.order_id = b.order_id and i.batch_at = b.batch_at;

-- A live dine-in line must be delivered to one of its order's tables; takeaway lines to none.
create or replace function order_items_check_delivery() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_kind order_kind := (select kind from orders where id = new.order_id);
begin
  if v_kind = 'takeaway' then
    new.delivery_table_id := null;
  elsif new.status in ('new', 'cooking', 'ready')
     and not exists (select 1 from order_tables where order_id = new.order_id and table_id = new.delivery_table_id and left_at is null) then
    raise exception 'Bàn ra món phải là một bàn của đơn';
  end if;
  return new;
end $$;

-- Moves: remember the label the kitchen knew ("CHUYỂN TỪ 5") when an unfinished line changes table or order.
create function order_items_mark_moved() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_old text;
  v_new text;
begin
  -- A merge (same table, the group's only order there) is not a move; a split to 5-B or a move to 7 is.
  if new.status in ('new', 'cooking', 'ready') and new.replaced_by is null
     and (new.delivery_table_id is distinct from old.delivery_table_id
          or (new.order_id is distinct from old.order_id
              and (select count(*) from order_tables x join orders o on o.id = x.order_id
                   where x.table_id = new.delivery_table_id and x.left_at is null and o.status = 'open') > 1)) then
    v_old := coalesce(order_table_label(old.order_id, old.delivery_table_id), order_label(old.order_id));
    v_new := coalesce(order_table_label(new.order_id, new.delivery_table_id), order_label(new.order_id));
    if v_old is distinct from v_new then
      new.moved_from_label := coalesce(v_old, '');
      new.moved_at := now();
    end if;
  end if;
  return new;
end $$;
create trigger order_items_mark_moved before update of order_id, delivery_table_id on order_items
  for each row execute function order_items_mark_moved();

-- Payment lock: while a cashier has the payment screen open, nobody else adds, voids or moves lines.
-- Kitchen status changes still go through. Any change to the bill makes the printed pre-bill stale.
create function order_items_bill_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_me uuid := my_staff_id();
  v_id uuid;
  v_changes_bill boolean := tg_op = 'INSERT'
    or new.order_id is distinct from old.order_id or new.qty is distinct from old.qty or new.price is distinct from old.price
    or (new.status = 'void' and old.status <> 'void');
begin
  if not v_changes_bill then return new; end if;
  for v_id in select x from unnest(array[new.order_id, case when tg_op = 'UPDATE' then old.order_id end]) x where x is not null loop
    if exists (select 1 from orders where id = v_id and paying_at is not null and paying_by is distinct from v_me and status = 'open') then
      raise exception 'Đơn đang thanh toán: chưa sửa được';
    end if;
    update orders set bill_requested_at = null where id = v_id and bill_requested_at is not null;
  end loop;
  return new;
end $$;
create trigger order_items_bill_guard before insert or update on order_items
  for each row execute function order_items_bill_guard();

-- Kitchen text of one line: 'Steak bò nướng – 300g · MEDIUM · KHÔNG TRỨNG · + TRỨNG x2 · ít muối'.
create function order_item_text(p_line uuid) returns text
language sql stable set search_path = public as $$
  select concat_ws(' · ',
    i.name || coalesce(' – ' || nullif(i.variant_name, ''), ''),
    (select string_agg(upper(coalesce(nullif(m.kitchen_name, ''), m.name)), ' · ' order by m.name) from order_item_modifiers m where m.order_item_id = i.id and m.kind = 'option'),
    (select string_agg('KHÔNG ' || upper(coalesce(nullif(m.kitchen_name, ''), m.name)), ' · ' order by m.name) from order_item_modifiers m where m.order_item_id = i.id and m.kind = 'removal'),
    (select string_agg(upper(coalesce(nullif(m.kitchen_name, ''), m.name)) || case when m.qty > 1 then ' x' || m.qty else '' end, ' · ' order by m.name)
       from order_item_modifiers m where m.order_item_id = i.id and m.kind = 'addon'),
    nullif(i.note, ''))
  from order_items i where i.id = p_line
$$;

-- ---------------------------------------------------------------- kitchen notices and ticket state

create type notice_kind as enum ('void', 'modify', 'chase', 'modify_rejected');

-- HUỶ, SỬA and GIỤC wait for "Đã biết" / "Đã nhận". A SỬA on a dish already cooking waits for a decision.
create table kitchen_notices (
  id uuid primary key default gen_random_uuid(),
  kind notice_kind not null,
  order_id uuid not null references orders,
  order_item_id uuid references order_items,
  station_id uuid references stations,
  send_batch uuid,
  text text not null,
  before text not null default '',                                   -- SỬA: old content, struck through
  status text not null default 'done' check (status in ('done', 'pending', 'accepted', 'rejected')),
  payload jsonb,                                                      -- pending SỬA: the new line
  created_by uuid references staff,
  created_at timestamptz not null default now(),
  ack_by uuid references staff,
  ack_at timestamptz
);
create index kitchen_notices_open on kitchen_notices (created_at) where ack_at is null;
create index kitchen_notices_order on kitchen_notices (order_id);

create table ticket_states (
  key text primary key,                                               -- 'batch|station|order|delivery table'
  bumped_at timestamptz,
  bumped_by uuid references staff,
  recalled_at timestamptz,
  recall_count int not null default 0
);

alter table kitchen_notices enable row level security;
alter table ticket_states enable row level security;
create policy read_all on kitchen_notices for select using (my_role() is not null);
create policy read_all on ticket_states for select using (my_role() is not null);
-- written only by the functions below

create function ticket_key(i order_items) returns text
language sql immutable as $$
  select i.send_batch::text || '|' || i.station_id::text || '|' || i.order_id::text || '|' || coalesce(i.delivery_table_id::text, '')
$$;

-- ---------------------------------------------------------------- open, ghép, mang về

create function open_table(p_table uuid, p_guests int, p_extra uuid[] default '{}', p_label text default null)
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
  insert into orders (table_id, guest_count, position_label, opened_by)
  values (p_table, p_guests, nullif(btrim(coalesce(p_label, '')), ''), v_staff) returning * into v_o;
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

-- Ghép bàn (khách lạ ngồi chung): a separate order on an occupied table -> 5-B. p_existing: {order_id: label}
-- for orders on the table that have no position label yet.
create function add_shared_order(p_table uuid, p_guests int, p_label text, p_existing jsonb default '{}')
returns orders language plpgsql security definer set search_path = public as $$
declare
  v_staff uuid := require_floor_staff();
  v_o orders;
  k text;
begin
  perform 1 from tables where id = p_table for update;
  if not exists (select 1 from order_tables ot join orders o on o.id = ot.order_id where ot.table_id = p_table and ot.left_at is null and o.status = 'open') then
    raise exception 'Bàn đang trống: mở bàn bình thường';
  end if;
  if p_guests is null or p_guests < 1 or p_guests > 99 then raise exception 'Số khách phải từ 1 đến 99'; end if;
  if coalesce(btrim(p_label), '') = '' then raise exception 'Ghi vị trí ngồi cho đơn ghép (ví dụ: 2 khách áo xanh)'; end if;
  for k in select jsonb_object_keys(coalesce(p_existing, '{}')) loop
    update orders set position_label = left(btrim(p_existing ->> k), 30)
    where id = k::uuid and status = 'open' and coalesce(btrim(p_existing ->> k), '') <> ''
      and id in (select order_id from order_tables where table_id = p_table and left_at is null);
  end loop;
  insert into orders (table_id, guest_count, position_label, opened_by)
  values (p_table, p_guests, left(btrim(p_label), 30), v_staff) returning * into v_o;
  insert into audit_log (staff_id, action, detail) values (v_staff, 'add_shared_order', jsonb_build_object('order', v_o.id, 'table', p_table));
  return v_o;
end $$;

create function open_takeaway(p_customer text default '')
returns orders language plpgsql security definer set search_path = public as $$
declare
  v_staff uuid := require_floor_staff();
  v_o orders;
begin
  insert into orders (kind, table_id, customer_name, opened_by)
  values ('takeaway', null, left(btrim(coalesce(p_customer, '')), 40), v_staff) returning * into v_o;
  return v_o;
end $$;

-- ---------------------------------------------------------------- Gửi bếp (rounds, rush, notes ≤ 60)

-- Internal: price and insert lines for p_staff. Same checks as 0002's send_order_lines plus note length,
-- rounds and rush. Not callable by clients (see the revoke below).
create function _send_lines(p_order uuid, p_lines jsonb, p_batch uuid, p_staff uuid, p_rush_reason text default null, p_new_round boolean default true)
returns setof order_items language plpgsql security definer set search_path = public as $$
declare
  v_order orders;
  v_shop shop_settings;
  v_now timestamptz := now();
  v_day date := (now() at time zone 'Asia/Ho_Chi_Minh')::date;
  v_ids uuid[] := '{}';
  v_round int;
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
  select * into v_order from orders where id = p_order for update;
  if not found or v_order.status <> 'open' then raise exception 'Đơn không còn mở'; end if;
  if p_batch is not null and exists (select 1 from order_items where send_batch = p_batch) then
    return query select * from order_items where send_batch = p_batch order by id;
    return;
  end if;
  if jsonb_typeof(p_lines) is distinct from 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'Không có món để gửi';
  end if;
  if p_rush_reason is not null and p_rush_reason not in ('Khách vội', 'Trẻ em', 'Khách quen', 'Làm lại', 'Khác') then
    raise exception 'Chọn lý do GẤP';
  end if;
  select * into v_shop from shop_settings;
  v_round := v_order.rounds + case when p_new_round then 1 else 0 end;
  p_batch := coalesce(p_batch, gen_random_uuid());

  for l in select * from jsonb_array_elements(p_lines) loop
    select * into v_item from menu_items where id = (l ->> 'menu_item_id')::uuid;
    if not found or not v_item.available then raise exception 'Món không có trong thực đơn'; end if;
    if v_item.sold_out_until > v_now then raise exception 'Hết món: %', v_item.name; end if;
    select * into v_cat from menu_categories where id = v_item.category_id;
    v_qty := (l ->> 'qty')::int;
    if v_qty is null or v_qty < 1 then raise exception 'Số lượng không hợp lệ: %', v_item.name; end if;
    if char_length(coalesce(l ->> 'note', '')) > 60 then raise exception 'Ghi chú tối đa 60 ký tự'; end if;

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
    v_table := case when v_order.kind = 'takeaway' then null else coalesce((l ->> 'delivery_table_id')::uuid, v_order.table_id) end;
    if l ->> 'parent_line_id' is not null
       and not exists (select 1 from order_items where id = (l ->> 'parent_line_id')::uuid and order_id = p_order) then
      raise exception 'Món chính không thuộc đơn này';
    end if;

    insert into order_items (order_id, menu_item_id, name, price, qty, note, status, station_id, batch_at, created_by,
                             variant_id, variant_name, base_price, sent_at, send_batch, delivery_table_id, origin_order_id,
                             parent_line_id, vat_rate, price_includes_vat, discountable, service_charge,
                             round, rush, rush_reason, ready_at)
    values (p_order, v_item.id, v_item.name, 0, v_qty, btrim(coalesce(l ->> 'note', '')),
            case when v_station.kind = 'none' then 'ready' else 'new' end::item_status,   -- no-prep: straight to "chờ bưng"
            v_station.id, v_now, p_staff,
            v_var.id, v_var.name, coalesce(v_var.price, v_item.price), v_now, p_batch, v_table, p_order,
            (l ->> 'parent_line_id')::uuid,
            vat_rate_on(coalesce(v_item.vat_group, v_cat.vat_group), v_day),
            coalesce(v_item.price_includes_vat, v_shop.prices_include_vat), v_item.discountable, v_item.service_charge,
            v_round, p_rush_reason is not null, coalesce(p_rush_reason, ''),
            case when v_station.kind = 'none' then v_now end)
    returning id into v_line;

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

  if p_new_round then update orders set rounds = v_round where id = p_order; end if;
  return query select oi.* from unnest(v_ids) with ordinality u(id, n) join order_items oi on oi.id = u.id order by u.n;
end $$;
revoke execute on function _send_lines(uuid, jsonb, uuid, uuid, text, boolean) from public, anon, authenticated;

-- Gửi bếp. Same contract as 0002 plus p_rush_reason (GẤP). Resending a batch is a no-op.
drop function send_order_lines(uuid, jsonb, uuid);
create function send_order_lines(p_order uuid, p_lines jsonb, p_batch uuid default null, p_rush_reason text default null)
returns setof order_items language plpgsql security definer set search_path = public as $$
declare
  v_staff uuid := (select id from staff where user_id = auth.uid() and active and role in ('waiter', 'cashier', 'manager'));
begin
  if v_staff is null then raise exception 'Chỉ phục vụ, thu ngân hoặc quản lý được gửi bếp'; end if;
  return query select * from _send_lines(p_order, p_lines, p_batch, v_staff, p_rush_reason, true);
end $$;

-- ---------------------------------------------------------------- huỷ món

-- Not started: any floor staff with a reason. Started, done or served: a manager (signed in on this device).
-- TODO(manager PIN): verify_manager_pin(pin) returning a short-lived approval token, so a manager can approve at a
-- waiter's phone. The kitchen is told only while it still has the dish to make.
create function void_item(p_line uuid, p_qty int, p_reason text, p_note text default null)
returns order_items language plpgsql security definer set search_path = public as $$
declare
  v_staff uuid := require_floor_staff();
  v_role staff_role := my_role();
  v_line order_items;
  v_order orders;
  v_id uuid;
  v_reason text;
  v_note text := btrim(coalesce(p_note, ''));
  v_out order_items;
begin
  select * into v_line from order_items where id = p_line for update;
  if not found then raise exception 'Không tìm thấy món'; end if;
  select * into v_order from orders where id = v_line.order_id for update;
  if v_order.status <> 'open' then raise exception 'Đơn không còn mở'; end if;
  if v_line.status = 'void' then raise exception 'Món đã huỷ'; end if;
  if p_reason is null or p_reason not in ('Khách đổi ý', 'Gọi nhầm', 'Hết món', 'Ra quá lâu', 'Món lỗi', 'Khác') then raise exception 'Chọn lý do huỷ'; end if;
  if p_reason = 'Khác' and v_note = '' then raise exception 'Lý do "Khác": ghi rõ lý do'; end if;
  if p_qty is null or p_qty < 1 or p_qty > v_line.qty then raise exception 'Số lượng huỷ không hợp lệ'; end if;
  if v_line.status in ('cooking', 'ready', 'served') and v_role <> 'manager' then raise exception 'Món bếp đã làm: cần quản lý nhập mã PIN'; end if;
  if v_order.bill_requested_at is not null and v_role = 'waiter' then raise exception 'Đơn đã in tạm tính: huỷ món cần thu ngân hoặc quản lý'; end if;
  v_reason := case when p_reason = 'Khác' then v_note when v_note <> '' then p_reason || ': ' || v_note else p_reason end;

  if p_qty < v_line.qty then
    update order_items set qty = qty - p_qty where id = v_line.id;
    v_id := gen_random_uuid();
    insert into order_items
    select (jsonb_populate_record(null::order_items, to_jsonb(v_line) || jsonb_build_object('id', v_id, 'qty', p_qty))).*;
    insert into order_item_modifiers
    select (jsonb_populate_record(null::order_item_modifiers,
              to_jsonb(mo) || jsonb_build_object('id', gen_random_uuid(), 'order_item_id', v_id))).*
    from order_item_modifiers mo where mo.order_item_id = v_line.id;
  else
    v_id := v_line.id;
  end if;
  update order_items set status = 'void', void_reason = v_reason, voided_at = now(), voided_by = v_staff, void_stage = v_line.status
  where id = v_id returning * into v_out;

  if v_line.status in ('new', 'cooking') then
    insert into kitchen_notices (kind, order_id, order_item_id, station_id, send_batch, text, created_by)
    values ('void', v_order.id, v_id, v_line.station_id, v_line.send_batch,
            format('HUỶ %s %s%s – %s', p_qty, upper(v_line.name),
                   case when p_qty < v_line.qty then format(' (bớt %s, còn %s)', p_qty, v_line.qty - p_qty) else '' end, v_reason),
            v_staff);
  end if;
  insert into audit_log (staff_id, action, detail)
  values (v_staff, 'void_item', jsonb_build_object('line', v_id, 'name', v_line.name, 'qty', p_qty, 'amount', v_line.price * p_qty,
                                                    'reason', v_reason, 'stage', v_line.status));
  return v_out;
end $$;

-- ---------------------------------------------------------------- SỬA món đã gửi

-- Internal: replace a line by a newly priced one (same dish, same qty, same ticket, same kitchen state).
create function _apply_modify(p_line uuid, p_new jsonb, p_staff uuid)
returns order_items language plpgsql security definer set search_path = public as $$
declare
  v_old order_items;
  v_new order_items;
begin
  select * into v_old from order_items where id = p_line for update;
  select * into v_new from _send_lines(v_old.order_id,
    jsonb_build_array(p_new || jsonb_build_object('qty', v_old.qty, 'delivery_table_id', v_old.delivery_table_id)), null, p_staff, null, false);
  if v_new.menu_item_id <> v_old.menu_item_id then raise exception 'Sửa món chỉ đổi size, tuỳ chọn và ghi chú; đổi món khác thì huỷ rồi gọi mới'; end if;
  update order_items set status = 'void', void_reason = 'Sửa món', voided_at = now(), voided_by = p_staff, void_stage = v_old.status, replaced_by = v_new.id
  where id = v_old.id;
  update order_items set send_batch = v_old.send_batch, round = v_old.round, sent_at = v_old.sent_at, batch_at = v_old.batch_at,
         created_by = v_old.created_by, status = v_old.status, started_at = v_old.started_at, rush = v_old.rush, rush_reason = v_old.rush_reason,
         origin_order_id = v_old.origin_order_id
  where id = v_new.id returning * into v_new;
  update kitchen_notices set order_item_id = v_new.id where order_item_id = v_old.id;
  return v_new;
end $$;
revoke execute on function _apply_modify(uuid, jsonb, uuid) from public, anon, authenticated;

-- Chờ làm: applied now (kitchen taps Đã biết). Đang làm: waits for Nhận sửa / Không kịp. Xong / Đã bưng: refused.
create function modify_item(p_line uuid, p_new jsonb)
returns kitchen_notices language plpgsql security definer set search_path = public as $$
declare
  v_staff uuid := require_floor_staff();
  v_line order_items;
  v_new order_items;
  v_before text;
  v_after text;
  v_n kitchen_notices;
begin
  select * into v_line from order_items where id = p_line for update;
  if not found then raise exception 'Không tìm thấy món'; end if;
  if not exists (select 1 from orders where id = v_line.order_id and status = 'open') then raise exception 'Đơn không còn mở'; end if;
  if v_line.status in ('ready', 'served') then raise exception 'Món đã xong: huỷ món rồi gọi món mới'; end if;
  if v_line.status = 'void' then raise exception 'Món đã huỷ'; end if;
  if (p_new ->> 'qty')::int is distinct from v_line.qty then raise exception 'Đổi số lượng không phải là sửa: tăng thì gọi thêm, giảm thì huỷ bớt'; end if;
  if (p_new ->> 'menu_item_id')::uuid is distinct from v_line.menu_item_id then raise exception 'Sửa món chỉ đổi size, tuỳ chọn và ghi chú; đổi món khác thì huỷ rồi gọi mới'; end if;
  if exists (select 1 from kitchen_notices where order_item_id = p_line and kind = 'modify' and status = 'pending') then
    raise exception 'Đang chờ bếp xác nhận lần sửa trước';
  end if;
  v_before := order_item_text(p_line);
  if v_line.status = 'cooking' then
    -- Dry run: price and describe the new line, then roll the sub-transaction back (menu errors still surface).
    begin
      v_new := _apply_modify(p_line, p_new, v_staff);
      v_after := order_item_text(v_new.id);
      raise exception using errcode = 'P0099', message = 'dry run';
    exception when sqlstate 'P0099' then
      null;
    end;
    if v_after = v_before then raise exception 'Chưa có gì thay đổi'; end if;
    insert into kitchen_notices (kind, order_id, order_item_id, station_id, send_batch, text, before, status, payload, created_by)
    values ('modify', v_line.order_id, p_line, v_line.station_id, v_line.send_batch, v_after, v_before, 'pending', p_new, v_staff)
    returning * into v_n;
    return v_n;
  end if;
  v_new := _apply_modify(p_line, p_new, v_staff);
  if order_item_text(v_new.id) = v_before then raise exception 'Chưa có gì thay đổi'; end if;
  insert into kitchen_notices (kind, order_id, order_item_id, station_id, send_batch, text, before, created_by)
  values ('modify', v_new.order_id, v_new.id, v_new.station_id, v_new.send_batch, order_item_text(v_new.id), v_before, v_staff)
  returning * into v_n;
  insert into audit_log (staff_id, action, detail) values (v_staff, 'modify_item', jsonb_build_object('from', p_line, 'to', v_new.id, 'before', v_before, 'after', v_n.text));
  return v_n;
end $$;

create function decide_modify(p_notice uuid, p_accept boolean)
returns kitchen_notices language plpgsql security definer set search_path = public as $$
declare
  v_staff uuid := require_kitchen_or_manager();
  v_n kitchen_notices;
  v_line order_items;
  v_new order_items;
begin
  select * into v_n from kitchen_notices where id = p_notice for update;
  if not found or v_n.kind <> 'modify' or v_n.status <> 'pending' then raise exception 'Thông báo này không chờ xác nhận'; end if;
  select * into v_line from order_items where id = v_n.order_item_id;
  if not p_accept or v_line.status = 'void' then
    update kitchen_notices set status = 'rejected', ack_at = now(), ack_by = v_staff where id = p_notice returning * into v_n;
    insert into kitchen_notices (kind, order_id, order_item_id, station_id, text, created_by)
    values ('modify_rejected', v_n.order_id, v_n.order_item_id, null, 'Bếp không kịp sửa: ' || order_item_text(v_line.id), v_staff);
    return v_n;
  end if;
  v_new := _apply_modify(v_line.id, v_n.payload, v_n.created_by);
  update kitchen_notices set status = 'accepted', ack_at = now(), ack_by = v_staff, order_item_id = v_new.id, text = order_item_text(v_new.id)
  where id = p_notice returning * into v_n;
  return v_n;
end $$;

create function ack_notice(p_notice uuid)
returns kitchen_notices language plpgsql security definer set search_path = public as $$
declare
  v_n kitchen_notices;
  v_staff uuid;
begin
  select * into v_n from kitchen_notices where id = p_notice for update;
  if not found then raise exception 'Không tìm thấy thông báo'; end if;
  v_staff := case when v_n.kind = 'modify_rejected' then require_floor_staff() else require_kitchen_or_manager() end;
  if v_n.status = 'pending' then raise exception 'Chọn Nhận sửa hoặc Không kịp'; end if;
  update kitchen_notices set ack_at = coalesce(ack_at, now()), ack_by = coalesce(ack_by, v_staff) where id = p_notice returning * into v_n;
  return v_n;
end $$;

-- ---------------------------------------------------------------- trạng thái món, xong phiếu, gọi lại, giục

-- Kitchen: Chờ làm -> Đang làm -> Xong (or straight to Xong), one step back within 2 minutes (manager any time).
-- Floor: Xong -> Đã bưng.
create function set_item_status(p_ids uuid[], p_to item_status)
returns setof order_items language plpgsql security definer set search_path = public as $$
declare
  v_role staff_role := my_role();
  v_staff uuid := my_staff_id();
  v_l order_items;
  v_back boolean;
begin
  if v_role is null then raise exception 'Không có quyền'; end if;
  for v_l in select * from order_items where id = any(p_ids) order by id for update loop
    continue when v_l.status = p_to;
    if v_l.status = 'void' then raise exception 'Món đã huỷ'; end if;
    if p_to = 'served' then
      if v_role = 'kitchen' then raise exception 'Tài khoản bếp không bấm Đã bưng'; end if;
      if v_l.status <> 'ready' then raise exception 'Chỉ bưng món đã xong'; end if;
      update order_items set status = 'served', served_at = now() where id = v_l.id;
      continue;
    end if;
    if v_role not in ('kitchen', 'manager') then raise exception 'Chỉ máy bếp, bar hoặc quản lý được đổi trạng thái này'; end if;
    v_back := (v_l.status = 'cooking' and p_to = 'new') or (v_l.status = 'ready' and p_to = 'cooking');
    if not (v_back or (v_l.status = 'new' and p_to in ('cooking', 'ready')) or (v_l.status = 'cooking' and p_to = 'ready')) then
      raise exception 'Không đổi được trạng thái này';
    end if;
    if v_back and v_role <> 'manager'
       and coalesce(case when v_l.status = 'ready' then v_l.ready_at else v_l.started_at end, '-infinity') < now() - interval '2 minutes' then
      raise exception 'Quá 2 phút: chỉ quản lý lùi được trạng thái';
    end if;
    update order_items set status = p_to,
      started_at = case when p_to = 'new' then null when v_l.status = 'new' then now() else started_at end,
      ready_at = case when p_to = 'ready' then now() else null end
    where id = v_l.id;
  end loop;
  insert into audit_log (staff_id, action, detail)
  values (v_staff, 'item_status', jsonb_build_object('lines', p_ids, 'to', p_to));
  return query select * from order_items where id = any(p_ids);
end $$;

create function bump_ticket(p_key text)
returns ticket_states language plpgsql security definer set search_path = public as $$
declare
  v_staff uuid := require_kitchen_or_manager();
  v_ids uuid[];
  v_order uuid := split_part(p_key, '|', 3)::uuid;
  v_station uuid := split_part(p_key, '|', 2)::uuid;
  v_t ticket_states;
begin
  select array_agg(id) into v_ids from order_items i where ticket_key(i) = p_key and replaced_by is null;
  if v_ids is null then raise exception 'Không tìm thấy phiếu'; end if;
  if exists (select 1 from kitchen_notices where order_item_id = any(v_ids) and ack_at is null and kind in ('void', 'modify')) then
    raise exception 'Bấm Đã biết HUỶ / SỬA trước khi báo xong phiếu';
  end if;
  update order_items set status = 'ready', started_at = coalesce(started_at, now()), ready_at = now()
  where id = any(v_ids) and status in ('new', 'cooking');
  update kitchen_notices set ack_at = now(), ack_by = v_staff
  where kind = 'chase' and ack_at is null and order_id = v_order and station_id = v_station;
  insert into ticket_states (key, bumped_at, bumped_by) values (p_key, now(), v_staff)
  on conflict (key) do update set bumped_at = now(), bumped_by = v_staff
  returning * into v_t;
  return v_t;
end $$;

-- Gọi lại: dishes not yet carried out go back to Đang làm; the timer keeps counting from the original send.
create function recall_ticket(p_key text)
returns ticket_states language plpgsql security definer set search_path = public as $$
declare
  v_staff uuid := require_kitchen_or_manager();
  v_done timestamptz;
  v_t ticket_states;
begin
  select coalesce(t.bumped_at, (select max(ready_at) from order_items i where ticket_key(i) = p_key)) into v_done
  from (select 1) x left join ticket_states t on t.key = p_key;
  if v_done < now() - interval '30 minutes' and my_role() <> 'manager' then raise exception 'Phiếu xong quá 30 phút: cần quản lý gọi lại'; end if;
  update order_items i set status = 'cooking', ready_at = null
  where ticket_key(i) = p_key and replaced_by is null and status = 'ready';
  if not found then raise exception 'Món của phiếu đã bưng hết'; end if;
  insert into ticket_states (key, recalled_at, recall_count) values (p_key, now(), 1)
  on conflict (key) do update set recalled_at = now(), recall_count = ticket_states.recall_count + 1, bumped_at = null
  returning * into v_t;
  insert into audit_log (staff_id, action, detail) values (v_staff, 'recall_ticket', jsonb_build_object('ticket', p_key));
  return v_t;
end $$;

-- Giục: one notice per station with unfinished dishes; at least 3 minutes between two chases.
create function chase_order(p_order uuid)
returns orders language plpgsql security definer set search_path = public as $$
declare
  v_staff uuid := require_floor_staff();
  v_o orders;
begin
  select * into v_o from orders where id = p_order for update;
  if not found or v_o.status <> 'open' then raise exception 'Đơn không còn mở'; end if;
  if v_o.chased_at > now() - interval '3 minutes' then raise exception 'Vừa giục xong: chờ 3 phút rồi giục lại'; end if;
  if not exists (select 1 from order_items where order_id = p_order and status in ('new', 'cooking')) then
    raise exception 'Không có món nào đang chờ bếp';
  end if;
  insert into kitchen_notices (kind, order_id, station_id, text, created_by)
  select distinct 'chase'::notice_kind, p_order, station_id, 'GIỤC lần ' || (v_o.chase_count + 1), v_staff
  from order_items where order_id = p_order and status in ('new', 'cooking');
  update orders set chased_at = now(), chase_count = chase_count + 1 where id = p_order returning * into v_o;
  return v_o;
end $$;

-- ---------------------------------------------------------------- chuyển bàn, trả bàn, tách bàn khỏi nhóm

-- p_mode 'move': to a free table. 'shared': to an occupied table as a separate order (next suffix), with position
-- labels. p_from: which table of a group to swap (default the primary table). Unfinished dishes follow the guests.
create function move_order(p_order uuid, p_to uuid, p_from uuid default null, p_mode text default 'move',
                           p_label text default null, p_existing jsonb default '{}')
returns orders language plpgsql security definer set search_path = public as $$
declare
  v_staff uuid := require_floor_staff();
  v_o orders;
  v_from uuid;
  v_busy boolean;
  k text;
begin
  select * into v_o from orders where id = p_order for update;
  if not found or v_o.status <> 'open' then raise exception 'Đơn không còn mở'; end if;
  if v_o.kind <> 'dine_in' then raise exception 'Đơn mang về không có bàn'; end if;
  if v_o.paying_at is not null and v_o.paying_by is distinct from v_staff then raise exception 'Đơn đang thanh toán: chưa sửa được'; end if;
  v_from := coalesce(p_from, v_o.table_id);
  if not exists (select 1 from order_tables where order_id = p_order and table_id = v_from and left_at is null) then raise exception 'Bàn cũ không thuộc đơn'; end if;
  if exists (select 1 from order_tables where order_id = p_order and table_id = p_to and left_at is null) then raise exception 'Đơn đã ở bàn này'; end if;
  perform 1 from tables where id = p_to and active for update;
  if not found then raise exception 'Bàn đã ngừng sử dụng'; end if;
  v_busy := exists (select 1 from order_tables ot join orders o on o.id = ot.order_id where ot.table_id = p_to and ot.left_at is null and o.status = 'open');
  if p_mode = 'move' and v_busy then raise exception 'Bàn % đang có khách: chọn Gộp vào đơn hoặc Thành đơn ghép', (select name from tables where id = p_to); end if;
  if p_mode = 'shared' then
    if not v_busy then raise exception 'Bàn mới đang trống: chuyển bình thường'; end if;
    for k in select jsonb_object_keys(coalesce(p_existing, '{}')) loop
      update orders set position_label = left(btrim(p_existing ->> k), 30)
      where id = k::uuid and status = 'open' and coalesce(btrim(p_existing ->> k), '') <> '';
    end loop;
    if coalesce(btrim(p_label), '') <> '' then update orders set position_label = left(btrim(p_label), 30) where id = p_order; end if;
  elsif p_mode <> 'move' then
    raise exception 'Kiểu chuyển không hợp lệ';
  end if;

  if v_from = v_o.table_id then
    update orders set table_id = p_to where id = p_order;               -- orders_after_update moves tables and dishes
  else
    update order_tables set left_at = now() where order_id = p_order and table_id = v_from and left_at is null;
    insert into order_tables (order_id, table_id) values (p_order, p_to);
    update order_items set delivery_table_id = p_to
    where order_id = p_order and delivery_table_id = v_from and status in ('new', 'cooking', 'ready');
  end if;
  update tables set needs_cleaning = false where id = p_to;
  insert into audit_log (staff_id, action, detail)
  values (v_staff, 'move_order', jsonb_build_object('order', p_order, 'from', v_from, 'to', p_to, 'mode', p_mode));
  select * into v_o from orders where id = p_order;
  return v_o;
end $$;

-- Trả bớt bàn: a table leaves the group once no unfinished dish is still headed there.
create function release_table(p_order uuid, p_table uuid)
returns orders language plpgsql security definer set search_path = public as $$
declare
  v_staff uuid := require_floor_staff();
  v_o orders;
  v_n int;
begin
  select * into v_o from orders where id = p_order for update;
  if not found or v_o.status <> 'open' then raise exception 'Đơn không còn mở'; end if;
  if (select count(*) from order_tables where order_id = p_order and left_at is null) < 2 then
    raise exception 'Đơn chỉ có một bàn: dùng Chuyển bàn hoặc thanh toán';
  end if;
  if not exists (select 1 from order_tables where order_id = p_order and table_id = p_table and left_at is null) then raise exception 'Bàn không thuộc nhóm'; end if;
  select count(*) into v_n from order_items where order_id = p_order and delivery_table_id = p_table and status in ('new', 'cooking', 'ready');
  if v_n > 0 then raise exception 'Còn % món sẽ ra bàn %: chuyển bàn ra món trước', v_n, (select name from tables where id = p_table); end if;
  if v_o.table_id = p_table then
    update orders set table_id = (select table_id from order_tables where order_id = p_order and left_at is null and table_id <> p_table order by joined_at limit 1)
    where id = p_order;                                                -- new primary is already in the group: no move
  end if;
  update order_tables set left_at = now() where order_id = p_order and table_id = p_table and left_at is null;
  insert into audit_log (staff_id, action, detail) values (v_staff, 'release_table', jsonb_build_object('order', p_order, 'table', p_table));
  select * into v_o from orders where id = p_order;
  return v_o;
end $$;

-- Tách một bàn khỏi nhóm gộp: dishes delivered to that table go back to an order of its own (cashier, manager).
create function split_table_from_group(p_order uuid, p_table uuid, p_guests int)
returns orders language plpgsql security definer set search_path = public as $$
declare
  v_staff uuid := require_floor_staff();
  v_o orders;
  v_new orders;
begin
  if my_role() not in ('cashier', 'manager') then raise exception 'Chỉ thu ngân hoặc quản lý được tách bàn khỏi nhóm'; end if;
  if p_guests is null or p_guests < 1 or p_guests > 99 then raise exception 'Số khách phải từ 1 đến 99'; end if;
  select * into v_o from orders where id = p_order for update;
  if not found or v_o.status <> 'open' then raise exception 'Đơn không còn mở'; end if;
  if (select count(*) from order_tables where order_id = p_order and left_at is null) < 2 then raise exception 'Đơn không phải nhóm gộp'; end if;
  if not exists (select 1 from order_tables where order_id = p_order and table_id = p_table and left_at is null) then raise exception 'Bàn không thuộc nhóm'; end if;
  if v_o.table_id = p_table then
    update orders set table_id = (select table_id from order_tables where order_id = p_order and left_at is null and table_id <> p_table order by joined_at limit 1)
    where id = p_order;
  end if;
  update order_tables set left_at = now() where order_id = p_order and table_id = p_table and left_at is null;
  update orders set guest_count = greatest(1, coalesce(guest_count, 0) - p_guests), bill_requested_at = null where id = p_order;
  insert into orders (table_id, guest_count, opened_by, opened_at) values (p_table, p_guests, v_staff, v_o.opened_at) returning * into v_new;
  update order_items set origin_order_id = coalesce(origin_order_id, order_id), order_id = v_new.id
  where order_id = p_order and delivery_table_id = p_table;
  insert into audit_log (staff_id, action, detail) values (v_staff, 'split_table_from_group', jsonb_build_object('from', p_order, 'table', p_table, 'order', v_new.id));
  return v_new;
end $$;

-- ---------------------------------------------------------------- tạm tính, thanh toán, dọn bàn

create function request_bill(p_order uuid)
returns orders language plpgsql security definer set search_path = public as $$
declare
  v_staff uuid := require_floor_staff();
  v_o orders;
begin
  select * into v_o from orders where id = p_order for update;
  if not found or v_o.status <> 'open' then raise exception 'Đơn không còn mở'; end if;
  if not exists (select 1 from order_items where order_id = p_order and status <> 'void') then raise exception 'Đơn chưa có món'; end if;
  update orders set bill_requested_at = now(), bill_print_count = bill_print_count + 1 where id = p_order returning * into v_o;
  insert into audit_log (staff_id, action, detail) values (v_staff, 'request_bill', jsonb_build_object('order', p_order, 'print', v_o.bill_print_count));
  return v_o;
end $$;

-- Đang thanh toán: locks the order for other devices until pay_order or cancel_payment.
create function begin_payment(p_order uuid)
returns orders language plpgsql security definer set search_path = public as $$
declare
  v_staff uuid := my_staff_id();
  v_o orders;
begin
  if my_role() not in ('cashier', 'manager') then raise exception 'Chỉ thu ngân hoặc quản lý được thanh toán'; end if;
  select * into v_o from orders where id = p_order for update;
  if not found or v_o.status <> 'open' then raise exception 'Đơn không còn mở'; end if;
  if v_o.paying_at is not null and v_o.paying_by <> v_staff then raise exception 'Đơn đang thanh toán ở máy khác'; end if;
  update orders set paying_at = now(), paying_by = v_staff where id = p_order returning * into v_o;
  return v_o;
end $$;

create function cancel_payment(p_order uuid)
returns orders language plpgsql security definer set search_path = public as $$
declare
  v_o orders;
begin
  if my_role() not in ('cashier', 'manager') then raise exception 'Chỉ thu ngân hoặc quản lý được thanh toán'; end if;
  update orders set paying_at = null, paying_by = null where id = p_order returning * into v_o;
  return v_o;
end $$;

create function mark_table_clean(p_table uuid)
returns tables language plpgsql security definer set search_path = public as $$
declare
  v_t tables;
begin
  perform require_floor_staff();
  update tables set needs_cleaning = false where id = p_table returning * into v_t;
  return v_t;
end $$;

-- Shop time for client timers (devices with a wrong clock still show the right minutes).
create function server_now() returns timestamptz language sql stable as $$ select now() $$;

-- ---------------------------------------------------------------- grants and realtime

-- Status and void reason now change only through set_item_status / void_item / bump_ticket.
revoke update (status, void_reason) on order_items from authenticated;

alter publication supabase_realtime add table areas, tables, kitchen_notices, ticket_states;


-- ===== 0005_cashier.sql =====
-- Bò Mỹ Đen POS 0005: cashier (thu ngân) and shifts (ca) on top of 0001–0004.
-- Same rules as src/floor/engine.ts (payOrder, printBill, openShift, closeShift) and src/cashier/shift.ts
-- (shiftSummary); bill maths stay in calc_bill (0002) = billTotals in src/lib/pricing.ts. Keep them in step.
--
-- How clients write after this migration (all RPCs, security definer, role-checked):
--   open_shift(float, register)                       Mở ca: one open shift per register, opening float
--   pay_order(order, discount, payments, reason, register)
--                                                     one bill, any mix of cash / bank / card; amounts add up to
--                                                     calc_bill's total exactly; only cash carries `tendered`
--                                                     (change); transfer + card never above the total;
--                                                     a bill discount needs a reason; money goes into the open shift
--   print_bill(bill)                                  counts receipt prints; the 2nd+ print says IN LẠI
--   shift_summary(shift)                              totals by method, expected cash (read-only)
--   close_shift(shift, count by note, note)           expected vs counted; a difference needs a note
-- Left for later: verify_manager_pin (a bill discount is allowed for cashiers here; the PIN is checked on the
-- device only), petty cash in/out (phiếu thu/chi), deposits, e-invoice, refunds and reopening a bill.

-- ---------------------------------------------------------------- settings

alter table shop_settings add column bank_name text not null default '';   -- printed under the VietQR

-- ---------------------------------------------------------------- shifts

create table shifts (
  id uuid primary key default gen_random_uuid(),
  register text not null default 'Quầy 1' check (char_length(register) between 1 and 30),
  opened_by uuid not null references staff,
  opened_at timestamptz not null default now(),
  opening_float int not null check (opening_float >= 0),               -- tiền lẻ đầu ca
  closed_at timestamptz,
  closed_by uuid references staff,
  counted_cash int check (counted_cash >= 0),
  counted_detail jsonb not null default '{}',                           -- {"500000": 3, "10000": 2}
  expected_cash int,                                                    -- float + cash taken, at close
  note text not null default '' check (char_length(note) <= 200),
  check ((closed_at is null) = (counted_cash is null) and (closed_at is null) = (expected_cash is null))
);
create unique index shifts_one_open on shifts (register) where closed_at is null;
create index shifts_opened on shifts (opened_at);

alter table bills
  add column shift_id uuid references shifts,
  add column discount_reason text not null default '',
  add column print_count int not null default 0 check (print_count >= 0),
  add column last_print_at timestamptz,
  add column last_print_by uuid references staff;
create index bills_shift on bills (shift_id);
create index bills_paid_at on bills (paid_at);

alter table payments
  add column shift_id uuid references shifts,
  add column ref text not null default '' check (char_length(ref) <= 40),   -- card last 4 / slip no., bank ref
  add column received_by uuid references staff,
  add column received_at timestamptz not null default now();
create index payments_bill on payments (bill_id);

-- ---------------------------------------------------------------- pay

drop function pay_order(uuid, int, jsonb);

create function pay_order(p_order uuid, p_discount int, p_payments jsonb, p_discount_reason text default null,
                          p_register text default 'Quầy 1')
returns bills language plpgsql security definer set search_path = public as $$
declare
  v_staff uuid := my_staff_id();
  v_order orders;
  v_shift shifts;
  v_calc jsonb;
  v_total int;
  v_paid numeric;
  v_noncash numeric;
  v_bill bills;
  v_reason text := btrim(coalesce(p_discount_reason, ''));
  p jsonb;
begin
  if my_role() is null or my_role() not in ('cashier', 'manager') then raise exception 'Chỉ thu ngân hoặc quản lý được thanh toán'; end if;
  select * into v_order from orders where id = p_order for update;
  if not found or v_order.status <> 'open' then raise exception 'Đơn không còn mở'; end if;
  if v_order.paying_at is not null and v_order.paying_by is distinct from v_staff then raise exception 'Đơn đang thanh toán ở máy khác'; end if;
  -- share lock: payments run side by side, close_shift waits for them
  select * into v_shift from shifts where register = p_register and closed_at is null for share;
  if not found then raise exception 'Chưa mở ca thu ngân: mở ca trước khi thu tiền'; end if;
  if not exists (select 1 from order_items where order_id = p_order and status <> 'void') then raise exception 'Đơn chưa có món'; end if;
  if coalesce(p_discount, 0) > 0 and v_reason = '' then raise exception 'Chọn lý do giảm giá'; end if;
  -- TODO(manager PIN): require an approval token from verify_manager_pin for a cashier's discount.

  if p_payments is null or jsonb_typeof(p_payments) <> 'array' then raise exception 'Danh sách thanh toán không hợp lệ'; end if;
  for p in select value from jsonb_array_elements(p_payments) loop
    if coalesce(p ->> 'method', '') not in ('cash', 'bank', 'card') then raise exception 'Cách trả không hợp lệ'; end if;
    if jsonb_typeof(p -> 'amount') is distinct from 'number' or (p ->> 'amount')::numeric <= 0
       or (p ->> 'amount')::numeric <> trunc((p ->> 'amount')::numeric) then
      raise exception 'Số tiền mỗi khoản phải là số đồng dương';
    end if;
    if jsonb_typeof(p -> 'tendered') = 'number'
       and (p ->> 'method' <> 'cash' or (p ->> 'tendered')::numeric < (p ->> 'amount')::numeric
            or (p ->> 'tendered')::numeric <> trunc((p ->> 'tendered')::numeric)) then
      raise exception 'Tiền khách đưa chỉ ghi cho tiền mặt và không nhỏ hơn số thu';
    end if;
  end loop;

  v_calc := calc_bill(p_order, coalesce(p_discount, 0));
  v_total := (v_calc ->> 'total')::int;
  select coalesce(sum((value ->> 'amount')::numeric), 0), coalesce(sum((value ->> 'amount')::numeric) filter (where value ->> 'method' <> 'cash'), 0)
  into v_paid, v_noncash from jsonb_array_elements(p_payments);
  if v_noncash > v_total then raise exception 'Chuyển khoản và thẻ không được vượt số phải thu'; end if;
  if v_paid <> v_total then raise exception 'Tổng thanh toán % khác số phải trả %', v_paid, v_total; end if;

  insert into bills (order_id, subtotal, discount, service_charge, vat_added, vat_total, rounding, total, vat_lines,
                     table_label, cashier_id, shift_id, discount_reason)
  values (p_order, (v_calc ->> 'subtotal')::int, coalesce(p_discount, 0), (v_calc ->> 'service_charge')::int,
          (v_calc ->> 'vat_added')::int, (v_calc ->> 'vat_total')::int, (v_calc ->> 'rounding')::int, v_total,
          v_calc -> 'vat', coalesce(order_group_label(p_order), order_label(p_order), ''), v_staff, v_shift.id,
          case when coalesce(p_discount, 0) > 0 then left(v_reason, 60) else '' end)
  returning * into v_bill;
  insert into payments (bill_id, method, amount, tendered, ref, shift_id, received_by)
  select v_bill.id, (value ->> 'method')::pay_method, (value ->> 'amount')::int,
         case when value ->> 'method' = 'cash' and jsonb_typeof(value -> 'tendered') = 'number'
                   and (value ->> 'tendered')::int > (value ->> 'amount')::int then (value ->> 'tendered')::int end,
         left(coalesce(value ->> 'ref', ''), 40), v_shift.id, v_staff
  from jsonb_array_elements(p_payments) with ordinality;

  update orders set status = 'paid', closed_at = now(), paying_at = null, paying_by = null where id = p_order;
  if coalesce(p_discount, 0) > 0 then
    insert into audit_log (staff_id, action, detail)
    values (v_staff, 'discount', jsonb_build_object('bill', v_bill.bill_no, 'amount', p_discount, 'reason', v_bill.discount_reason));
  end if;
  return v_bill;
end $$;

-- In hoá đơn: one more print. Reprints are logged.
create function print_bill(p_bill uuid)
returns int language plpgsql security definer set search_path = public as $$
declare
  v_staff uuid := my_staff_id();
  v_b bills;
begin
  if my_role() is null or my_role() not in ('cashier', 'manager') then raise exception 'Chỉ thu ngân hoặc quản lý được in hoá đơn'; end if;
  update bills set print_count = print_count + 1, last_print_at = now(), last_print_by = v_staff where id = p_bill returning * into v_b;
  if not found then raise exception 'Không tìm thấy hoá đơn'; end if;
  if v_b.print_count > 1 then
    insert into audit_log (staff_id, action, detail) values (v_staff, 'reprint', jsonb_build_object('bill', v_b.bill_no, 'print', v_b.print_count));
  end if;
  return v_b.print_count;
end $$;

-- ---------------------------------------------------------------- shifts

create function open_shift(p_float int, p_register text default 'Quầy 1')
returns shifts language plpgsql security definer set search_path = public as $$
declare
  v_staff uuid := my_staff_id();
  v_s shifts;
begin
  if my_role() is null or my_role() not in ('cashier', 'manager') then raise exception 'Chỉ thu ngân hoặc quản lý được mở ca'; end if;
  if p_float is null or p_float < 0 then raise exception 'Tiền đầu ca phải là số đồng không âm'; end if;
  if exists (select 1 from shifts where register = p_register and closed_at is null) then
    raise exception '% đang có ca mở: chốt ca cũ trước', p_register;
  end if;
  insert into shifts (register, opened_by, opening_float) values (p_register, v_staff, p_float) returning * into v_s;
  insert into audit_log (staff_id, action, detail) values (v_staff, 'open_shift', jsonb_build_object('shift', v_s.id, 'float', p_float));
  return v_s;
end $$;

-- Totals of a shift (shiftSummary in src/cashier/shift.ts).
create function shift_summary(p_shift uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  with b as (select * from bills where shift_id = p_shift),
       p as (select pm.* from payments pm join b on b.id = pm.bill_id)
  select jsonb_build_object(
    'bills', (select count(*) from b),
    'subtotal', (select coalesce(sum(subtotal), 0) from b),
    'discount', (select coalesce(sum(discount), 0) from b),
    'service_charge', (select coalesce(sum(service_charge), 0) from b),
    'rounding', (select coalesce(sum(rounding), 0) from b),
    'sales', (select coalesce(sum(total), 0) from b),
    'vat_total', (select coalesce(sum(vat_total), 0) from b),
    'by_method', jsonb_build_object(
      'cash', (select coalesce(sum(amount), 0) from p where method = 'cash'),
      'bank', (select coalesce(sum(amount), 0) from p where method = 'bank'),
      'card', (select coalesce(sum(amount), 0) from p where method = 'card')),
    'cash_tendered', (select coalesce(sum(coalesce(tendered, amount)), 0) from p where method = 'cash'),
    'change_given', (select coalesce(sum(coalesce(tendered, amount) - amount), 0) from p where method = 'cash'),
    'opening_float', s.opening_float,
    'expected_cash', s.opening_float + (select coalesce(sum(amount), 0) from p where method = 'cash'))
  from shifts s where s.id = p_shift
$$;

-- Chốt ca: count by note, compare with float + cash taken; a difference needs a note.
create function close_shift(p_shift uuid, p_detail jsonb, p_note text default '')
returns shifts language plpgsql security definer set search_path = public as $$
declare
  v_staff uuid := my_staff_id();
  v_s shifts;
  v_counted bigint := 0;
  v_expected int;
  v_note text := btrim(coalesce(p_note, ''));
  k text;
  v jsonb;
begin
  if my_role() is null or my_role() not in ('cashier', 'manager') then raise exception 'Chỉ thu ngân hoặc quản lý được chốt ca'; end if;
  select * into v_s from shifts where id = p_shift for update;   -- waits for payments still running
  if not found then raise exception 'Không tìm thấy ca'; end if;
  if v_s.closed_at is not null then raise exception 'Ca đã chốt'; end if;
  if exists (select 1 from orders where status = 'open' and paying_at is not null) then
    raise exception 'Còn đơn đang thanh toán: thu xong hoặc huỷ thanh toán trước khi chốt ca';
  end if;
  if p_detail is null or jsonb_typeof(p_detail) <> 'object' then raise exception 'Số tờ không hợp lệ'; end if;
  for k, v in select key, value from jsonb_each(p_detail) loop
    if k not in ('500000', '200000', '100000', '50000', '20000', '10000', '5000', '2000', '1000') then
      raise exception 'Mệnh giá không hợp lệ: %', k;
    end if;
    if jsonb_typeof(v) <> 'number' or v::numeric < 0 or v::numeric <> trunc(v::numeric) then raise exception 'Số tờ không hợp lệ: %', v; end if;
    v_counted := v_counted + k::bigint * v::bigint;
  end loop;
  v_expected := (shift_summary(p_shift) ->> 'expected_cash')::int;
  if v_counted <> v_expected and v_note = '' then raise exception 'Két lệch so với dự kiến: ghi lý do'; end if;
  update shifts set closed_at = now(), closed_by = v_staff, counted_cash = v_counted, expected_cash = v_expected, note = v_note,
                    counted_detail = coalesce((select jsonb_object_agg(key, value) from jsonb_each(p_detail) where value::numeric > 0), '{}')
  where id = p_shift returning * into v_s;
  insert into audit_log (staff_id, action, detail)
  values (v_staff, 'close_shift', jsonb_build_object('shift', p_shift, 'counted', v_counted, 'expected', v_expected, 'difference', v_counted - v_expected));
  return v_s;
end $$;

-- ---------------------------------------------------------------- security and realtime

alter table shifts enable row level security;
create policy read_all on shifts for select using (my_role() is not null);
-- shifts, bills and payments are only written through the RPCs above (no insert/update policies).

alter publication supabase_realtime add table bills, shifts;


-- ===== 0006_staff_auth.sql =====
-- Bò Mỹ Đen POS 0006: staff sign-in on shared devices, PINs, manager approval and audit on top of 0001–0005.
-- Same rules as src/auth/memoryRepo.ts and src/floor/engine.ts (the sample engines); keep them in step.
--
-- Who is calling (after this migration):
--   * A registered device (tablet, POS, kitchen screen) is one Supabase auth user (anonymous sign-in is enough)
--     with a row in `devices`. It is registered once with a one-time code from a manager (create_device_code),
--     or for the very first device with admin_create_device_code() run in the SQL editor.
--   * On that device staff pick their name and enter a 4–6 digit PIN (staff_sign_in). The PIN is stored only as a
--     bcrypt hash (pgcrypto crypt/gen_salt('bf')) in staff_secrets, which no API role can read.
--     staff_sign_in returns a session token; the client sends it on every request as the `x-staff-session` header.
--     my_staff_id() / my_role() resolve that token (hash lookup, same device, not ended, not idle-expired).
--   * Idle sign-out: a session expires `idle_signout_min` after its last touch_session(); kitchen accounts
--     never expire (the kitchen display stays signed in until someone taps Đổi người).
--   * A staff row with its own user_id (owner's phone with an email login) still works as before.
--   * Realtime cannot send headers, so read policies also accept the device's current session (reader_role()).
--     Every write still needs the session token.
--
-- Roles: waiter, kitchen, cashier, manager, owner. Owner can do everything a manager can (my_role() maps
-- owner -> manager so the 0001–0005 policies keep working); only an owner manages managers and owners.
--
-- Manager approval (verified here, not on the device):
--   verify_manager_pin(manager, pin, action, order, detail) -> short-lived single-use token, bound to the action,
--   the order, the person who asked and (discount) the maximum amount / (void_item) the line. Passed as p_approval to
--     pay_order   a bill discount by anyone but a manager/owner
--     void_item   huỷ / bớt a sent line (shop_settings.void_approval: 'sent' = every sent line, 'started' = only
--                 lines the kitchen started, done or served)
--     void_order  huỷ cả đơn: every live line of an order with one reason and one approval
--   Wrong PINs count per person (sign-in and approvals together): `pin_max_attempts` misses lock the PIN for
--   `pin_lock_min` minutes. Sign-in, failures, lockouts, approvals and staff changes go to audit_log
--   (staff_id = who, approved_by = which manager, device_id = where, at = when).
--
-- Left for later: rate limit on device codes per IP, PIN change by the staff member themselves, sessions list UI.

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

-- New enum value: usable only after this transaction commits, so everything below compares role::text.
alter type staff_role add value if not exists 'owner';

-- ---------------------------------------------------------------- settings

alter table shop_settings
  add column idle_signout_min int not null default 5 check (idle_signout_min between 1 and 240),
  add column pin_max_attempts int not null default 5 check (pin_max_attempts between 3 and 10),
  add column pin_lock_min int not null default 5 check (pin_lock_min between 1 and 120),
  add column approval_ttl_sec int not null default 120 check (approval_ttl_sec between 30 and 600),
  add column void_approval text not null default 'sent' check (void_approval in ('sent', 'started'));

-- ---------------------------------------------------------------- tables

alter table staff
  add column updated_at timestamptz not null default now(),
  add constraint staff_name_len check (char_length(btrim(name)) between 1 and 40);

-- PIN hashes and the failed-PIN counter. No API role can read or write this table.
create table staff_secrets (
  staff_id uuid primary key references staff on delete cascade,
  pin_hash text not null,                        -- bcrypt, from extensions.crypt(pin, extensions.gen_salt('bf', 8))
  pin_set_at timestamptz not null default now(),
  failed_count int not null default 0 check (failed_count >= 0),
  locked_until timestamptz
);

create table devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 40),
  kind text not null default 'pos' check (kind in ('pos', 'kitchen')),
  active boolean not null default true,
  registered_by uuid references staff,
  registered_at timestamptz not null default now(),
  last_seen_at timestamptz
);

create table device_codes (
  code_hash text primary key,                    -- sha256 of the code; the code itself is shown once
  name text not null,
  kind text not null check (kind in ('pos', 'kitchen')),
  created_by uuid references staff,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz,
  device_id uuid references devices on delete set null
);

create table staff_sessions (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique,               -- sha256 of the token the device holds
  device_id uuid not null references devices on delete cascade,
  staff_id uuid not null references staff on delete cascade,
  started_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at timestamptz,                        -- null = no idle sign-out (kitchen accounts)
  ended_at timestamptz,
  end_reason text check (end_reason in ('sign_out', 'switched', 'disabled', 'device_off', 'pin_reset'))
);
create index staff_sessions_device on staff_sessions (device_id) where ended_at is null;
create index staff_sessions_staff on staff_sessions (staff_id) where ended_at is null;

create table approvals (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique,
  action text not null check (action in ('discount', 'void_item', 'void_order')),
  order_id uuid not null references orders on delete cascade,
  detail jsonb not null default '{}',            -- discount: {"amount": max đồng}; void_item: {"line": id}
  manager_id uuid not null references staff,
  requested_by uuid not null references staff,
  device_id uuid references devices on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz
);

alter table audit_log
  add column approved_by uuid references staff,
  add column device_id uuid references devices on delete set null;
create index audit_log_at on audit_log (at desc);

-- ---------------------------------------------------------------- identity

create function session_token_hash() returns text
language plpgsql stable set search_path = public as $$
declare
  v_h text := current_setting('request.headers', true);
  v_t text;
begin
  if v_h is null or v_h = '' then return null; end if;
  v_t := nullif(btrim(v_h::json ->> 'x-staff-session'), '');
  if v_t is null then return null; end if;
  return encode(extensions.digest(v_t, 'sha256'), 'hex');
exception when others then
  return null;   -- malformed header: not signed in
end $$;

-- The calling device (null when this auth user is not an active device).
create function my_device_id() returns uuid
language sql stable security definer set search_path = public as $$
  select id from devices where user_id = auth.uid() and active
$$;

-- staff.id of the caller: the device session named by the x-staff-session header, else a personal login.
create or replace function my_staff_id() returns uuid
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select s.staff_id
       from staff_sessions s
       join devices d on d.id = s.device_id and d.active and d.user_id = auth.uid()
       join staff st on st.id = s.staff_id and st.active
      where s.token_hash = session_token_hash() and s.ended_at is null and (s.expires_at is null or s.expires_at > now())),
    (select id from staff where user_id = auth.uid() and active))
$$;

-- The caller's real role, as text ('owner' included).
create function my_real_role() returns text
language sql stable security definer set search_path = public as $$
  select role::text from staff where id = my_staff_id()
$$;

-- Role for permission checks: an owner counts as a manager everywhere 0001–0005 check 'manager'.
create or replace function my_role() returns staff_role
language sql stable security definer set search_path = public as $$
  select case when role::text = 'owner' then 'manager'::staff_role else role end from staff where id = my_staff_id()
$$;

-- For read policies (and Realtime, which sends no headers): the caller's role, else the role of the device's
-- current session.
create function reader_role() returns staff_role
language sql stable security definer set search_path = public as $$
  select coalesce(my_role(), (
    select case when st.role::text = 'owner' then 'manager'::staff_role else st.role end
      from devices d
      join staff_sessions s on s.device_id = d.id and s.ended_at is null and (s.expires_at is null or s.expires_at > now())
      join staff st on st.id = s.staff_id and st.active
     where d.user_id = auth.uid() and d.active
     order by s.started_at desc limit 1))
$$;

create or replace function require_floor_staff() returns uuid
language plpgsql stable security definer set search_path = public as $$
declare
  v uuid := my_staff_id();
begin
  if v is null or my_role() not in ('waiter', 'cashier', 'manager') then raise exception 'Chỉ phục vụ, thu ngân hoặc quản lý được thao tác đơn'; end if;
  return v;
end $$;

create or replace function require_kitchen_or_manager() returns uuid
language plpgsql stable security definer set search_path = public as $$
declare
  v uuid := my_staff_id();
begin
  if v is null or my_role() not in ('kitchen', 'manager') then raise exception 'Chỉ máy bếp, bar hoặc quản lý được đổi trạng thái này'; end if;
  return v;
end $$;

create or replace function send_order_lines(p_order uuid, p_lines jsonb, p_batch uuid default null, p_rush_reason text default null)
returns setof order_items language plpgsql security definer set search_path = public as $$
declare
  v_staff uuid := my_staff_id();
begin
  if v_staff is null or my_role() not in ('waiter', 'cashier', 'manager') then raise exception 'Chỉ phục vụ, thu ngân hoặc quản lý được gửi bếp'; end if;
  return query select * from _send_lines(p_order, p_lines, p_batch, v_staff, p_rush_reason, true);
end $$;

-- 0002 functions that looked the caller up by staff.user_id: same bodies, caller from my_staff_id(), owner allowed.
do $$
declare
  f text;
  v_def text;
  v_new text;
begin
  foreach f in array array['log_price_change', 'merge_orders', 'move_items', 'split_order', 'set_sold_out'] loop
    select pg_get_functiondef(p.oid) into v_def from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = f;
    if v_def is null then raise exception '0006: function % not found', f; end if;
    v_new := replace(v_def, 'user_id = auth.uid()', 'id = my_staff_id()');
    v_new := replace(v_new, 'role in (''waiter'', ''cashier'', ''manager'')', 'role::text in (''waiter'', ''cashier'', ''manager'', ''owner'')');
    if v_new = v_def then raise exception '0006: nothing to change in %', f; end if;
    execute v_new;
  end loop;
  -- nothing else may identify the caller by staff.user_id
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and p.prosrc like '%auth.uid()%'
                and p.proname not in ('my_staff_id', 'my_device_id', 'reader_role')) then
    raise exception '0006: a function still reads auth.uid(): %', (
      select string_agg(p.proname, ', ') from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.prosrc like '%auth.uid()%' and p.proname not in ('my_staff_id', 'my_device_id', 'reader_role'));
  end if;
end $$;

-- ---------------------------------------------------------------- helpers

create function _token() returns text language sql volatile as $$ select encode(extensions.gen_random_bytes(24), 'hex') $$;
create function _hash(p text) returns text language sql immutable as $$ select encode(extensions.digest(p, 'sha256'), 'hex') $$;

create function _audit(p_action text, p_detail jsonb, p_staff uuid default null, p_approved_by uuid default null)
returns void language sql security definer set search_path = public as $$
  insert into audit_log (staff_id, action, detail, approved_by, device_id)
  values (coalesce(p_staff, my_staff_id()), p_action, coalesce(p_detail, '{}'), p_approved_by, my_device_id())
$$;

-- 4–6 digits; not all the same digit; not a straight run (1234, 98765).
create function pin_problem(p_pin text) returns text
language plpgsql immutable as $$
declare
  i int;
  up boolean := true;
  down boolean := true;
begin
  if p_pin is null or p_pin !~ '^[0-9]{4,6}$' then return 'Mã PIN gồm 4 đến 6 chữ số'; end if;
  if p_pin ~ '^(.)\1*$' then return 'Mã PIN không được toàn một chữ số'; end if;
  for i in 2 .. length(p_pin) loop
    if substr(p_pin, i, 1)::int <> (substr(p_pin, i - 1, 1)::int + 1) % 10 then up := false; end if;
    if substr(p_pin, i, 1)::int <> (substr(p_pin, i - 1, 1)::int + 9) % 10 then down := false; end if;
  end loop;
  if up or down then return 'Mã PIN không được là dãy liên tiếp (1234, 4321…)'; end if;
  return null;
end $$;

create function _set_pin(p_staff uuid, p_pin text) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_bad text := pin_problem(p_pin);
begin
  if v_bad is not null then raise exception '%', v_bad; end if;
  insert into staff_secrets (staff_id, pin_hash) values (p_staff, extensions.crypt(p_pin, extensions.gen_salt('bf', 8)))
  on conflict (staff_id) do update set pin_hash = excluded.pin_hash, pin_set_at = now(), failed_count = 0, locked_until = null;
end $$;

-- Check a PIN with the lockout. Never raises for a wrong PIN (the failed count must commit): returns
-- {"ok":true} or {"ok":false,"error":...,"attempts_left":n | "locked_until":ts}.
create function _check_pin(p_staff uuid, p_pin text, p_purpose text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_sec staff_secrets;
  v_max int;
  v_lock int;
  v_left int;
  v_until timestamptz;
begin
  select pin_max_attempts, pin_lock_min into v_max, v_lock from shop_settings;
  select * into v_sec from staff_secrets where staff_id = p_staff for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'Chưa có mã PIN: nhờ quản lý đặt PIN'); end if;
  if v_sec.locked_until > now() then
    return jsonb_build_object('ok', false, 'locked_until', v_sec.locked_until,
      'error', format('Nhập sai quá nhiều lần: khoá đến %s', to_char(v_sec.locked_until at time zone 'Asia/Ho_Chi_Minh', 'HH24:MI')));
  end if;
  if p_pin ~ '^[0-9]{4,6}$' and v_sec.pin_hash = extensions.crypt(p_pin, v_sec.pin_hash) then
    update staff_secrets set failed_count = 0, locked_until = null where staff_id = p_staff;
    return jsonb_build_object('ok', true);
  end if;
  v_left := v_max - v_sec.failed_count - 1;
  if v_left <= 0 then
    v_until := now() + make_interval(mins => v_lock);
    update staff_secrets set failed_count = 0, locked_until = v_until where staff_id = p_staff;
    perform _audit('pin_locked', jsonb_build_object('purpose', p_purpose, 'by', my_staff_id(), 'until', v_until), p_staff);
    return jsonb_build_object('ok', false, 'locked_until', v_until,
      'error', format('Sai mã PIN %s lần: khoá %s phút', v_max, v_lock));
  end if;
  update staff_secrets set failed_count = failed_count + 1 where staff_id = p_staff;
  perform _audit('pin_failed', jsonb_build_object('purpose', p_purpose, 'by', my_staff_id(), 'left', v_left), p_staff);
  return jsonb_build_object('ok', false, 'attempts_left', v_left, 'error', format('Mã PIN không đúng (còn %s lần thử)', v_left));
end $$;

-- ---------------------------------------------------------------- devices

create function _new_device_code(p_name text, p_kind text, p_by uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_alphabet text := '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';   -- no 0/O, 1/I
  v_code text := '';
  v_b bytea := extensions.gen_random_bytes(8);
  v_exp timestamptz := now() + interval '30 minutes';
  i int;
begin
  if char_length(btrim(coalesce(p_name, ''))) not between 1 and 40 then raise exception 'Đặt tên máy (1–40 ký tự)'; end if;
  if p_kind is null or p_kind not in ('pos', 'kitchen') then raise exception 'Loại máy không hợp lệ'; end if;
  for i in 0 .. 7 loop
    v_code := v_code || substr(v_alphabet, get_byte(v_b, i) % 32 + 1, 1);
  end loop;
  v_code := substr(v_code, 1, 4) || '-' || substr(v_code, 5, 4);
  insert into device_codes (code_hash, name, kind, created_by, expires_at) values (_hash(v_code), btrim(p_name), p_kind, p_by, v_exp);
  return jsonb_build_object('code', v_code, 'name', btrim(p_name), 'kind', p_kind, 'expires_at', v_exp);
end $$;

-- Manager / owner: a one-time code (30 minutes) to register a new device.
create function create_device_code(p_name text, p_kind text default 'pos') returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v jsonb;
begin
  if my_role() is distinct from 'manager' then raise exception 'Chỉ quản lý hoặc chủ quán được thêm máy'; end if;
  v := _new_device_code(p_name, p_kind, my_staff_id());
  perform _audit('device_code', jsonb_build_object('name', v ->> 'name', 'kind', p_kind));
  return v;
end $$;

-- First device of a new shop: run in the SQL editor (not callable through the API).
create function admin_create_device_code(p_name text, p_kind text default 'pos') returns text
language sql security definer set search_path = public as $$
  select _new_device_code(p_name, p_kind, null) ->> 'code'
$$;

-- Bootstrap staff (SQL editor only): select admin_add_staff('Chủ quán', 'owner', '2468');
create function admin_add_staff(p_name text, p_role text, p_pin text) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v uuid;
begin
  insert into staff (name, role) values (btrim(p_name), p_role::staff_role) returning id into v;
  perform _set_pin(v, p_pin);
  return v;
end $$;

-- This auth user becomes a device, with a code from create_device_code.
create function register_device(p_code text) returns devices
language plpgsql security definer set search_path = public as $$
declare
  v_c device_codes;
  v_d devices;
begin
  if auth.uid() is null then raise exception 'Máy chưa kết nối'; end if;
  if exists (select 1 from devices where user_id = auth.uid()) then raise exception 'Máy này đã được đăng ký'; end if;
  select * into v_c from device_codes where code_hash = _hash(upper(btrim(coalesce(p_code, '')))) for update;
  if not found or v_c.used_at is not null or v_c.expires_at < now() then raise exception 'Mã đăng ký máy không đúng hoặc đã hết hạn'; end if;
  insert into devices (user_id, name, kind, registered_by) values (auth.uid(), v_c.name, v_c.kind, v_c.created_by) returning * into v_d;
  update device_codes set used_at = now(), device_id = v_d.id where code_hash = v_c.code_hash;
  insert into audit_log (staff_id, action, detail, device_id) values (v_c.created_by, 'device_registered', jsonb_build_object('name', v_d.name, 'kind', v_d.kind), v_d.id);
  return v_d;
end $$;

-- The calling device, or null (also for a disabled one: the screen then says so).
create function my_device() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('id', id, 'name', name, 'kind', kind, 'active', active,
                            'idle_min', (select idle_signout_min from shop_settings))
  from devices where user_id = auth.uid()
$$;

create function device_set_active(p_device uuid, p_active boolean) returns devices
language plpgsql security definer set search_path = public as $$
declare
  v devices;
begin
  if my_role() is distinct from 'manager' then raise exception 'Chỉ quản lý hoặc chủ quán được khoá máy'; end if;
  update devices set active = p_active where id = p_device returning * into v;
  if not found then raise exception 'Không tìm thấy máy'; end if;
  if not p_active then
    update staff_sessions set ended_at = now(), end_reason = 'device_off' where device_id = p_device and ended_at is null;
  end if;
  perform _audit(case when p_active then 'device_on' else 'device_off' end, jsonb_build_object('device', v.name));
  return v;
end $$;

-- ---------------------------------------------------------------- sign-in

-- Names on the sign-in screen of this device. Kitchen devices list kitchen accounts and managers only.
create function signin_roster()
returns table (id uuid, name text, role text, has_pin boolean, locked_until timestamptz)
language plpgsql stable security definer set search_path = public as $$
declare
  v_d devices;
begin
  select * into v_d from devices where user_id = auth.uid() and active;
  if not found then raise exception 'Máy này chưa được đăng ký hoặc đã bị khoá'; end if;
  return query
    select s.id, s.name, s.role::text, sec.staff_id is not null, case when sec.locked_until > now() then sec.locked_until end
      from staff s left join staff_secrets sec on sec.staff_id = s.id
     where s.active and (v_d.kind = 'pos' or s.role::text in ('kitchen', 'manager', 'owner'))
     order by array_position(array['waiter', 'cashier', 'kitchen', 'manager', 'owner'], s.role::text), s.name;
end $$;

-- Pick a name, enter the PIN. Ends whoever was signed in on this device. Returns
-- {"ok":true,"token":...,"staff":{id,name,role},"expires_at":ts|null,"idle_min":n} or {"ok":false,"error":...}.
create function staff_sign_in(p_staff uuid, p_pin text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_d devices;
  v_s staff;
  v_chk jsonb;
  v_tok text := _token();
  v_idle int := (select idle_signout_min from shop_settings);
  v_exp timestamptz;
begin
  select * into v_d from devices where user_id = auth.uid() and active;
  if not found then raise exception 'Máy này chưa được đăng ký hoặc đã bị khoá'; end if;
  select * into v_s from staff where id = p_staff and active;
  if not found then return jsonb_build_object('ok', false, 'error', 'Không tìm thấy nhân viên hoặc đã ngừng làm'); end if;
  if v_d.kind = 'kitchen' and v_s.role::text not in ('kitchen', 'manager', 'owner') then
    return jsonb_build_object('ok', false, 'error', 'Máy bếp chỉ đăng nhập tài khoản bếp hoặc quản lý');
  end if;
  v_chk := _check_pin(v_s.id, p_pin, 'sign_in');
  if not (v_chk ->> 'ok')::boolean then return v_chk; end if;
  update staff_sessions set ended_at = now(), end_reason = 'switched' where device_id = v_d.id and ended_at is null;
  v_exp := case when v_s.role::text = 'kitchen' then null else now() + make_interval(mins => v_idle) end;
  insert into staff_sessions (token_hash, device_id, staff_id, expires_at) values (_hash(v_tok), v_d.id, v_s.id, v_exp);
  update devices set last_seen_at = now() where id = v_d.id;
  insert into audit_log (staff_id, action, detail, device_id) values (v_s.id, 'sign_in', jsonb_build_object('device', v_d.name), v_d.id);
  return jsonb_build_object('ok', true, 'token', v_tok, 'expires_at', v_exp, 'idle_min', v_idle,
                            'staff', jsonb_build_object('id', v_s.id, 'name', v_s.name, 'role', v_s.role::text));
end $$;

-- Activity on the device: push the idle sign-out back. Returns the new expiry (null = none) or raises when
-- the session is already over (the screen goes back to the names).
create function touch_session() returns timestamptz
language plpgsql security definer set search_path = public as $$
declare
  v staff_sessions;
begin
  update staff_sessions s set last_seen_at = now(),
         expires_at = case when s.expires_at is null then null else now() + make_interval(mins => (select idle_signout_min from shop_settings)) end
   where s.token_hash = session_token_hash() and s.ended_at is null and (s.expires_at is null or s.expires_at > now())
     and s.device_id = my_device_id()
  returning * into v;
  if not found then raise exception 'Phiên đăng nhập đã hết: đăng nhập lại'; end if;
  return v.expires_at;
end $$;

create function staff_sign_out() returns void
language plpgsql security definer set search_path = public as $$
declare
  v staff_sessions;
begin
  update staff_sessions set ended_at = now(), end_reason = 'sign_out'
   where token_hash = session_token_hash() and ended_at is null and device_id = my_device_id()
  returning * into v;
  if found then
    insert into audit_log (staff_id, action, detail, device_id) values (v.staff_id, 'sign_out', '{}', v.device_id);
  end if;
end $$;

-- ---------------------------------------------------------------- manager approval

-- A manager or owner enters their PIN on the asking device. Returns {"ok":true,"token":...,"manager":{id,name},
-- "expires_at":ts} or {"ok":false,"error":...}. The token is single-use, for this action, order and asker only.
create function verify_manager_pin(p_manager uuid, p_pin text, p_action text, p_order uuid, p_detail jsonb default '{}')
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_me uuid := my_staff_id();
  v_m staff;
  v_chk jsonb;
  v_tok text := _token();
  v_exp timestamptz := now() + make_interval(secs => (select approval_ttl_sec from shop_settings));
  v_detail jsonb := coalesce(p_detail, '{}');
begin
  if v_me is null then raise exception 'Đăng nhập trước khi xin quản lý duyệt'; end if;
  if p_action is null or p_action not in ('discount', 'void_item', 'void_order') then raise exception 'Việc cần duyệt không hợp lệ'; end if;
  if not exists (select 1 from orders where id = p_order) then raise exception 'Không tìm thấy đơn'; end if;
  if p_action = 'discount' and jsonb_typeof(v_detail -> 'amount') is distinct from 'number' then raise exception 'Ghi số tiền giảm cần duyệt'; end if;
  if p_action = 'void_item' and not exists (select 1 from order_items where id = (v_detail ->> 'line')::uuid and order_id = p_order) then
    raise exception 'Món cần duyệt không thuộc đơn';
  end if;
  select * into v_m from staff where id = p_manager and active and role::text in ('manager', 'owner');
  if not found then return jsonb_build_object('ok', false, 'error', 'Chỉ quản lý hoặc chủ quán duyệt được'); end if;
  v_chk := _check_pin(v_m.id, p_pin, 'approve_' || p_action);
  if not (v_chk ->> 'ok')::boolean then return v_chk; end if;
  insert into approvals (token_hash, action, order_id, detail, manager_id, requested_by, device_id, expires_at)
  values (_hash(v_tok), p_action, p_order, v_detail, v_m.id, v_me, my_device_id(), v_exp);
  perform _audit('approval', jsonb_build_object('for', p_action, 'order', p_order) || v_detail, v_me, v_m.id);
  return jsonb_build_object('ok', true, 'token', v_tok, 'expires_at', v_exp, 'manager', jsonb_build_object('id', v_m.id, 'name', v_m.name));
end $$;

-- Who approves this action: the caller when a manager/owner, else the manager behind a valid token (used up here).
create function _approver(p_token text, p_action text, p_order uuid, p_missing text, p_amount int default null, p_line uuid default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_me uuid := my_staff_id();
  v_a approvals;
begin
  if my_role() = 'manager' then return v_me; end if;
  if p_token is null or btrim(p_token) = '' then raise exception '%', p_missing; end if;
  update approvals set used_at = now()
   where token_hash = _hash(p_token) and action = p_action and order_id = p_order and requested_by = v_me
     and used_at is null and expires_at > now()
     and (p_amount is null or (detail ->> 'amount')::numeric >= p_amount)
     and (p_line is null or (detail ->> 'line')::uuid = p_line)
  returning * into v_a;
  if not found then raise exception 'Mã duyệt của quản lý không hợp lệ, đã dùng hoặc đã hết hạn: nhập PIN lại'; end if;
  if not exists (select 1 from staff where id = v_a.manager_id and active and role::text in ('manager', 'owner')) then
    raise exception 'Người duyệt không còn là quản lý';
  end if;
  return v_a.manager_id;
end $$;

-- ---------------------------------------------------------------- pay_order with approval

drop function pay_order(uuid, int, jsonb, text, text);

create function pay_order(p_order uuid, p_discount int, p_payments jsonb, p_discount_reason text default null,
                          p_register text default 'Quầy 1', p_approval text default null)
returns bills language plpgsql security definer set search_path = public as $$
declare
  v_staff uuid := my_staff_id();
  v_order orders;
  v_shift shifts;
  v_calc jsonb;
  v_total int;
  v_paid numeric;
  v_noncash numeric;
  v_bill bills;
  v_reason text := btrim(coalesce(p_discount_reason, ''));
  v_by uuid;
  p jsonb;
begin
  if v_staff is null or my_role() not in ('cashier', 'manager') then raise exception 'Chỉ thu ngân hoặc quản lý được thanh toán'; end if;
  select * into v_order from orders where id = p_order for update;
  if not found or v_order.status <> 'open' then raise exception 'Đơn không còn mở'; end if;
  if v_order.paying_at is not null and v_order.paying_by is distinct from v_staff then raise exception 'Đơn đang thanh toán ở máy khác'; end if;
  -- share lock: payments run side by side, close_shift waits for them
  select * into v_shift from shifts where register = p_register and closed_at is null for share;
  if not found then raise exception 'Chưa mở ca thu ngân: mở ca trước khi thu tiền'; end if;
  if not exists (select 1 from order_items where order_id = p_order and status <> 'void') then raise exception 'Đơn chưa có món'; end if;
  if coalesce(p_discount, 0) > 0 then
    if v_reason = '' then raise exception 'Chọn lý do giảm giá'; end if;
    v_by := _approver(p_approval, 'discount', p_order, 'Giảm giá hoá đơn cần quản lý nhập mã PIN', p_discount);
  end if;

  if p_payments is null or jsonb_typeof(p_payments) <> 'array' then raise exception 'Danh sách thanh toán không hợp lệ'; end if;
  for p in select value from jsonb_array_elements(p_payments) loop
    if coalesce(p ->> 'method', '') not in ('cash', 'bank', 'card') then raise exception 'Cách trả không hợp lệ'; end if;
    if jsonb_typeof(p -> 'amount') is distinct from 'number' or (p ->> 'amount')::numeric <= 0
       or (p ->> 'amount')::numeric <> trunc((p ->> 'amount')::numeric) then
      raise exception 'Số tiền mỗi khoản phải là số đồng dương';
    end if;
    if jsonb_typeof(p -> 'tendered') = 'number'
       and (p ->> 'method' <> 'cash' or (p ->> 'tendered')::numeric < (p ->> 'amount')::numeric
            or (p ->> 'tendered')::numeric <> trunc((p ->> 'tendered')::numeric)) then
      raise exception 'Tiền khách đưa chỉ ghi cho tiền mặt và không nhỏ hơn số thu';
    end if;
  end loop;

  v_calc := calc_bill(p_order, coalesce(p_discount, 0));
  v_total := (v_calc ->> 'total')::int;
  select coalesce(sum((value ->> 'amount')::numeric), 0), coalesce(sum((value ->> 'amount')::numeric) filter (where value ->> 'method' <> 'cash'), 0)
  into v_paid, v_noncash from jsonb_array_elements(p_payments);
  if v_noncash > v_total then raise exception 'Chuyển khoản và thẻ không được vượt số phải thu'; end if;
  if v_paid <> v_total then raise exception 'Tổng thanh toán % khác số phải trả %', v_paid, v_total; end if;

  insert into bills (order_id, subtotal, discount, service_charge, vat_added, vat_total, rounding, total, vat_lines,
                     table_label, cashier_id, shift_id, discount_reason)
  values (p_order, (v_calc ->> 'subtotal')::int, coalesce(p_discount, 0), (v_calc ->> 'service_charge')::int,
          (v_calc ->> 'vat_added')::int, (v_calc ->> 'vat_total')::int, (v_calc ->> 'rounding')::int, v_total,
          v_calc -> 'vat', coalesce(order_group_label(p_order), order_label(p_order), ''), v_staff, v_shift.id,
          case when coalesce(p_discount, 0) > 0 then left(v_reason, 60) else '' end)
  returning * into v_bill;
  insert into payments (bill_id, method, amount, tendered, ref, shift_id, received_by)
  select v_bill.id, (value ->> 'method')::pay_method, (value ->> 'amount')::int,
         case when value ->> 'method' = 'cash' and jsonb_typeof(value -> 'tendered') = 'number'
                   and (value ->> 'tendered')::int > (value ->> 'amount')::int then (value ->> 'tendered')::int end,
         left(coalesce(value ->> 'ref', ''), 40), v_shift.id, v_staff
  from jsonb_array_elements(p_payments) with ordinality;

  update orders set status = 'paid', closed_at = now(), paying_at = null, paying_by = null where id = p_order;
  if coalesce(p_discount, 0) > 0 then
    perform _audit('discount', jsonb_build_object('bill', v_bill.bill_no, 'amount', p_discount, 'reason', v_bill.discount_reason), v_staff, v_by);
  end if;
  return v_bill;
end $$;

-- ---------------------------------------------------------------- huỷ món / huỷ đơn with approval

-- Internal: void p_qty of a line (split off when partial), tell the kitchen while it still has the dish to make.
create function _void_line(p_line order_items, p_qty int, p_reason text, p_staff uuid, p_approved_by uuid)
returns order_items language plpgsql security definer set search_path = public as $$
declare
  v_id uuid;
  v_out order_items;
begin
  if p_qty < p_line.qty then
    update order_items set qty = qty - p_qty where id = p_line.id;
    v_id := gen_random_uuid();
    insert into order_items
    select (jsonb_populate_record(null::order_items, to_jsonb(p_line) || jsonb_build_object('id', v_id, 'qty', p_qty))).*;
    insert into order_item_modifiers
    select (jsonb_populate_record(null::order_item_modifiers,
              to_jsonb(mo) || jsonb_build_object('id', gen_random_uuid(), 'order_item_id', v_id))).*
    from order_item_modifiers mo where mo.order_item_id = p_line.id;
  else
    v_id := p_line.id;
  end if;
  update order_items set status = 'void', void_reason = p_reason, voided_at = now(), voided_by = p_staff, void_stage = p_line.status
  where id = v_id returning * into v_out;

  if p_line.status in ('new', 'cooking') then
    insert into kitchen_notices (kind, order_id, order_item_id, station_id, send_batch, text, created_by)
    values ('void', p_line.order_id, v_id, p_line.station_id, p_line.send_batch,
            format('HUỶ %s %s%s – %s', p_qty, upper(p_line.name),
                   case when p_qty < p_line.qty then format(' (bớt %s, còn %s)', p_qty, p_line.qty - p_qty) else '' end, p_reason),
            p_staff);
  end if;
  perform _audit('void_item', jsonb_build_object('line', v_id, 'order', p_line.order_id, 'name', p_line.name, 'qty', p_qty,
                                                 'amount', p_line.price * p_qty, 'reason', p_reason, 'stage', p_line.status),
                 p_staff, p_approved_by);
  return v_out;
end $$;
revoke execute on function _void_line(order_items, int, text, uuid, uuid) from public, anon, authenticated;

create function _void_reason(p_reason text, p_note text) returns text
language plpgsql immutable as $$
declare
  v_note text := btrim(coalesce(p_note, ''));
begin
  if p_reason is null or p_reason not in ('Khách đổi ý', 'Gọi nhầm', 'Hết món', 'Ra quá lâu', 'Món lỗi', 'Khác') then raise exception 'Chọn lý do huỷ'; end if;
  if p_reason = 'Khác' and v_note = '' then raise exception 'Lý do "Khác": ghi rõ lý do'; end if;
  return case when p_reason = 'Khác' then left(v_note, 60) when v_note <> '' then p_reason || ': ' || left(v_note, 60) else p_reason end;
end $$;

-- Does voiding this line need a manager? (shop_settings.void_approval)
create function void_needs_approval(p_status item_status) returns boolean
language sql stable security definer set search_path = public as $$
  select p_status in ('cooking', 'ready', 'served') or (p_status = 'new' and (select void_approval from shop_settings) = 'sent')
$$;

drop function void_item(uuid, int, text, text);

-- Huỷ / bớt a sent line, with a reason; a manager approves (PIN token) unless the caller is one.
create function void_item(p_line uuid, p_qty int, p_reason text, p_note text default null, p_approval text default null)
returns order_items language plpgsql security definer set search_path = public as $$
declare
  v_staff uuid := require_floor_staff();
  v_line order_items;
  v_order orders;
  v_reason text;
  v_by uuid;
begin
  select * into v_line from order_items where id = p_line for update;
  if not found then raise exception 'Không tìm thấy món'; end if;
  select * into v_order from orders where id = v_line.order_id for update;
  if v_order.status <> 'open' then raise exception 'Đơn không còn mở'; end if;
  if v_line.status = 'void' then raise exception 'Món đã huỷ'; end if;
  v_reason := _void_reason(p_reason, p_note);
  if p_qty is null or p_qty < 1 or p_qty > v_line.qty then raise exception 'Số lượng huỷ không hợp lệ'; end if;
  if v_order.bill_requested_at is not null and my_role() = 'waiter' then raise exception 'Đơn đã in tạm tính: huỷ món cần thu ngân hoặc quản lý'; end if;
  if void_needs_approval(v_line.status) then
    v_by := _approver(p_approval, 'void_item', v_order.id,
                      case when v_line.status = 'new' then 'Huỷ món đã gửi bếp: cần quản lý nhập mã PIN' else 'Món bếp đã làm: cần quản lý nhập mã PIN' end,
                      null, v_line.id);
  end if;
  return _void_line(v_line, p_qty, v_reason, v_staff, v_by);
end $$;

-- Huỷ cả đơn after Gửi bếp: every live line with one reason (and one approval), then the order is closed as void.
create function void_order(p_order uuid, p_reason text, p_note text default null, p_approval text default null)
returns orders language plpgsql security definer set search_path = public as $$
declare
  v_staff uuid := require_floor_staff();
  v_order orders;
  v_reason text;
  v_by uuid;
  v_line order_items;
  v_n int := 0;
  v_amount bigint := 0;
begin
  select * into v_order from orders where id = p_order for update;
  if not found or v_order.status <> 'open' then raise exception 'Đơn không còn mở'; end if;
  if v_order.paying_at is not null and v_order.paying_by is distinct from v_staff then raise exception 'Đơn đang thanh toán: chưa sửa được'; end if;
  v_reason := _void_reason(p_reason, p_note);
  if v_order.bill_requested_at is not null and my_role() = 'waiter' then raise exception 'Đơn đã in tạm tính: huỷ đơn cần thu ngân hoặc quản lý'; end if;
  if exists (select 1 from order_items where order_id = p_order and status <> 'void' and void_needs_approval(status)) then
    v_by := _approver(p_approval, 'void_order', p_order, 'Huỷ đơn đã gửi bếp: cần quản lý nhập mã PIN');
  end if;
  for v_line in select * from order_items where order_id = p_order and status <> 'void' order by sent_at, id for update loop
    perform _void_line(v_line, v_line.qty, v_reason, v_staff, v_by);
    v_n := v_n + 1;
    v_amount := v_amount + v_line.price * v_line.qty;
  end loop;
  update orders set status = 'void', closed_at = now(), paying_at = null, paying_by = null where id = p_order returning * into v_order;
  perform _audit('void_order', jsonb_build_object('order', p_order, 'lines', v_n, 'amount', v_amount, 'reason', v_reason), v_staff, v_by);
  return v_order;
end $$;

-- ---------------------------------------------------------------- staff management

-- Managers manage waiters, kitchen and cashiers (and their own PIN); owners manage everyone.
create function _may_manage(p_target_role text, p_target uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(case my_real_role()
    when 'owner' then true
    when 'manager' then p_target_role in ('waiter', 'kitchen', 'cashier') or p_target is not distinct from my_staff_id() and p_target is not null
    else false end, false)
$$;

-- For the staff screen (managers): who has a PIN, who is locked out, who is signed in where.
create function staff_admin_list()
returns table (id uuid, name text, role text, active boolean, has_pin boolean, pin_set_at timestamptz, locked_until timestamptz,
               signed_in_on text, last_seen_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
begin
  if my_role() is distinct from 'manager' then raise exception 'Chỉ quản lý hoặc chủ quán xem được danh sách này'; end if;
  return query
    select s.id, s.name, s.role::text, s.active, sec.staff_id is not null, sec.pin_set_at,
           case when sec.locked_until > now() then sec.locked_until end,
           (select d.name from staff_sessions ss join devices d on d.id = ss.device_id
             where ss.staff_id = s.id and ss.ended_at is null and (ss.expires_at is null or ss.expires_at > now())
             order by ss.started_at desc limit 1),
           (select max(ss.last_seen_at) from staff_sessions ss where ss.staff_id = s.id)
      from staff s left join staff_secrets sec on sec.staff_id = s.id
     order by s.active desc, array_position(array['owner', 'manager', 'cashier', 'waiter', 'kitchen'], s.role::text), s.name;
end $$;

-- Add (p_id null, PIN required) or edit a staff member; a PIN given on edit replaces the old one.
create function staff_save(p_id uuid, p_name text, p_role text, p_pin text default null) returns staff
language plpgsql security definer set search_path = public as $$
declare
  v_old staff;
  v staff;
  v_name text := btrim(coalesce(p_name, ''));
begin
  if my_role() is distinct from 'manager' then raise exception 'Chỉ quản lý hoặc chủ quán được sửa nhân viên'; end if;
  if char_length(v_name) not between 1 and 40 then raise exception 'Nhập tên nhân viên (tối đa 40 ký tự)'; end if;
  if p_role is null or p_role not in ('waiter', 'kitchen', 'cashier', 'manager', 'owner') then raise exception 'Vai trò không hợp lệ'; end if;
  if exists (select 1 from staff where lower(name) = lower(v_name) and active and id is distinct from p_id) then
    raise exception 'Đã có nhân viên tên "%": thêm họ hoặc số để phân biệt', v_name;
  end if;
  if p_id is null then
    if not _may_manage(p_role, null) then raise exception 'Chỉ chủ quán được thêm quản lý hoặc chủ quán'; end if;
    if p_pin is null then raise exception 'Đặt mã PIN cho nhân viên mới'; end if;
    insert into staff (name, role) values (v_name, p_role::staff_role) returning * into v;
    perform _set_pin(v.id, p_pin);
    perform _audit('staff_add', jsonb_build_object('staff', v.id, 'name', v.name, 'role', p_role));
    return v;
  end if;
  select * into v_old from staff where id = p_id for update;
  if not found then raise exception 'Không tìm thấy nhân viên'; end if;
  if not _may_manage(v_old.role::text, v_old.id) or (p_role <> v_old.role::text and not _may_manage(p_role, null)) then
    raise exception 'Chỉ chủ quán được sửa quản lý hoặc chủ quán';
  end if;
  if v_old.id = my_staff_id() and p_role <> v_old.role::text then raise exception 'Không tự đổi vai trò của mình'; end if;
  update staff set name = v_name, role = p_role::staff_role, updated_at = now() where id = p_id returning * into v;
  if p_pin is not null then
    perform _set_pin(v.id, p_pin);
    update staff_sessions set ended_at = now(), end_reason = 'pin_reset' where staff_id = v.id and ended_at is null and token_hash is distinct from session_token_hash();
  end if;
  perform _audit('staff_edit', jsonb_build_object('staff', v.id, 'name', v.name, 'role', p_role,
                                                  'was', jsonb_build_object('name', v_old.name, 'role', v_old.role::text), 'pin_reset', p_pin is not null));
  return v;
end $$;

create function staff_reset_pin(p_staff uuid, p_pin text) returns void
language plpgsql security definer set search_path = public as $$
declare
  v staff;
begin
  if my_role() is distinct from 'manager' then raise exception 'Chỉ quản lý hoặc chủ quán được đặt lại PIN'; end if;
  select * into v from staff where id = p_staff;
  if not found then raise exception 'Không tìm thấy nhân viên'; end if;
  if not _may_manage(v.role::text, v.id) then raise exception 'Chỉ chủ quán được đặt lại PIN của quản lý hoặc chủ quán'; end if;
  perform _set_pin(v.id, p_pin);
  update staff_sessions set ended_at = now(), end_reason = 'pin_reset' where staff_id = v.id and ended_at is null and token_hash is distinct from session_token_hash();
  perform _audit('pin_reset', jsonb_build_object('staff', v.id, 'name', v.name));
end $$;

-- Ngừng làm / làm lại. Disabling signs the person out everywhere. Nobody disables themselves or the last owner.
create function staff_set_active(p_staff uuid, p_active boolean) returns staff
language plpgsql security definer set search_path = public as $$
declare
  v staff;
begin
  if my_role() is distinct from 'manager' then raise exception 'Chỉ quản lý hoặc chủ quán được khoá nhân viên'; end if;
  select * into v from staff where id = p_staff for update;
  if not found then raise exception 'Không tìm thấy nhân viên'; end if;
  if not _may_manage(v.role::text, v.id) then raise exception 'Chỉ chủ quán được khoá quản lý hoặc chủ quán'; end if;
  if v.id = my_staff_id() and not p_active then raise exception 'Không tự khoá tài khoản của mình'; end if;
  if not p_active and v.role::text = 'owner' and not exists (select 1 from staff where role::text = 'owner' and active and id <> v.id) then
    raise exception 'Phải còn ít nhất một chủ quán';
  end if;
  update staff set active = p_active, updated_at = now() where id = p_staff returning * into v;
  if not p_active then
    update staff_sessions set ended_at = now(), end_reason = 'disabled' where staff_id = p_staff and ended_at is null;
  end if;
  perform _audit(case when p_active then 'staff_on' else 'staff_off' end, jsonb_build_object('staff', v.id, 'name', v.name));
  return v;
end $$;

-- ---------------------------------------------------------------- row level security

-- Reads: every signed-in role, also through the device's current session (Realtime).
do $$
declare
  r record;
begin
  for r in select tablename from pg_policies where schemaname = 'public' and policyname = 'read_all' and qual = '(my_role() IS NOT NULL)' loop
    execute format('alter policy read_all on %I using (reader_role() is not null)', r.tablename);
  end loop;
end $$;

-- Money: bills, payments and shifts for cashiers and managers only (waiters and the kitchen see none).
drop policy read_all on bills;
drop policy read_all on payments;
drop policy read_all on shifts;
create policy read_money on bills for select using (reader_role() in ('cashier', 'manager'));
create policy read_money on payments for select using (reader_role() in ('cashier', 'manager'));
create policy read_money on shifts for select using (reader_role() in ('cashier', 'manager'));

-- Staff rows change only through staff_save / staff_set_active (owner rules); everyone signed in reads names.
drop policy manage on staff;
revoke insert, update, delete on staff from anon, authenticated;

-- Nothing deletes orders, lines, bills, payments or the audit trail through the API.
revoke delete on orders, order_items, bills, payments, audit_log, shifts from anon, authenticated;
revoke insert, update on audit_log, bills, payments from anon, authenticated;

alter table staff_secrets enable row level security;
alter table devices enable row level security;
alter table device_codes enable row level security;
alter table staff_sessions enable row level security;
alter table approvals enable row level security;
revoke all on staff_secrets, device_codes from anon, authenticated;
revoke all on devices, staff_sessions, approvals from anon, authenticated;
grant select on devices, staff_sessions, approvals to authenticated;
create policy read_mgr on devices for select using (my_role() = 'manager');
create policy read_mgr on staff_sessions for select using (my_role() = 'manager');
create policy read_mgr on approvals for select using (my_role() = 'manager');
-- staff_sessions.token_hash is a hash of a secret: managers see sessions, not hashes
revoke select on staff_sessions from authenticated;
grant select (id, device_id, staff_id, started_at, last_seen_at, expires_at, ended_at, end_reason) on staff_sessions to authenticated;
revoke select on approvals from authenticated;
grant select (id, action, order_id, detail, manager_id, requested_by, device_id, created_at, expires_at, used_at) on approvals to authenticated;

-- Functions: internal ones closed; SQL-editor-only ones closed to the API; the rest for signed-in users only.
revoke execute on function _token(), _hash(text), _audit(text, jsonb, uuid, uuid), _set_pin(uuid, text), _check_pin(uuid, text, text),
  _new_device_code(text, text, uuid), _approver(text, text, uuid, text, int, uuid), _may_manage(text, uuid),
  admin_create_device_code(text, text), admin_add_staff(text, text, text) from public, anon, authenticated;
revoke execute on function register_device(text), my_device(), signin_roster(), staff_sign_in(uuid, text), touch_session(), staff_sign_out(),
  verify_manager_pin(uuid, text, text, uuid, jsonb), create_device_code(text, text), device_set_active(uuid, boolean),
  staff_admin_list(), staff_save(uuid, text, text, text), staff_reset_pin(uuid, text), staff_set_active(uuid, boolean),
  pay_order(uuid, int, jsonb, text, text, text), void_item(uuid, int, text, text, text), void_order(uuid, text, text, text)
  from public, anon;
grant execute on function register_device(text), my_device(), signin_roster(), staff_sign_in(uuid, text), touch_session(), staff_sign_out(),
  verify_manager_pin(uuid, text, text, uuid, jsonb), create_device_code(text, text), device_set_active(uuid, boolean),
  staff_admin_list(), staff_save(uuid, text, text, text), staff_reset_pin(uuid, text), staff_set_active(uuid, boolean),
  pay_order(uuid, int, jsonb, text, text, text), void_item(uuid, int, text, text, text), void_order(uuid, text, text, text)
  to authenticated;

alter publication supabase_realtime add table staff, devices;

