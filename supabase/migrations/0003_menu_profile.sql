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
