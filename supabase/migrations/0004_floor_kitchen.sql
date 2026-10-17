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
