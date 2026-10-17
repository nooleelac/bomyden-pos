-- Bò Mỹ Đen POS: initial schema.
-- One order = one seating at a table. A bill can be settled by several payment rows (split payment).

create type staff_role as enum ('waiter', 'kitchen', 'cashier', 'manager');
create type order_status as enum ('open', 'paid', 'void');
create type item_status as enum ('new', 'cooking', 'ready', 'served', 'void');
create type pay_method as enum ('cash', 'bank', 'card');
create type station as enum ('grill', 'hotpot', 'bar', 'none');

create table staff (
  id uuid primary key default gen_random_uuid(),
  user_id uuid unique references auth.users on delete set null,
  name text not null,
  role staff_role not null,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table areas (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  sort int not null default 0
);

create table tables (
  id uuid primary key default gen_random_uuid(),
  area_id uuid references areas on delete set null,
  name text not null unique,
  sort int not null default 0,
  is_takeaway boolean not null default false
);

create table menu_categories (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  sort int not null default 0
);

create table menu_items (
  id uuid primary key default gen_random_uuid(),
  category_id uuid not null references menu_categories on delete restrict,
  name text not null,
  price int not null check (price >= 0),          -- VND
  station station not null default 'grill',       -- 'none' = drinks served straight from the bar
  available boolean not null default true,
  sort int not null default 0
);

create table orders (
  id uuid primary key default gen_random_uuid(),
  table_id uuid not null references tables,
  status order_status not null default 'open',
  opened_by uuid references staff,
  opened_at timestamptz not null default now(),
  closed_at timestamptz
);
-- At most one open order per table.
create unique index orders_one_open_per_table on orders (table_id) where status = 'open';

create table order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references orders on delete cascade,
  menu_item_id uuid not null references menu_items,
  name text not null,                              -- copied at order time so later menu edits don't change old bills
  price int not null check (price >= 0),
  qty int not null check (qty > 0),
  note text not null default '',
  status item_status not null default 'new',
  station station not null,
  batch_at timestamptz not null default now(),     -- one "Gửi bếp" = one kitchen ticket
  created_by uuid references staff,
  void_reason text
);
create index order_items_kitchen on order_items (status, batch_at) where status in ('new', 'cooking', 'ready');

create sequence bill_no_seq;

create table bills (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null unique references orders,
  bill_no text not null unique default ('HD' || lpad(nextval('bill_no_seq')::text, 6, '0')),
  subtotal int not null,
  discount int not null default 0 check (discount >= 0),
  total int not null check (total >= 0),
  cashier_id uuid references staff,
  paid_at timestamptz not null default now(),
  check (total = subtotal - discount)
);

create table payments (
  id uuid primary key default gen_random_uuid(),
  bill_id uuid not null references bills on delete cascade,
  method pay_method not null,
  amount int not null check (amount > 0),
  tendered int,                                    -- cash handed over, for change on the receipt
  check (tendered is null or (method = 'cash' and tendered >= amount))
);

create table shop_settings (
  id int primary key default 1 check (id = 1),
  shop_name text not null default 'BÒ MỸ ĐEN',
  address text not null default '',
  phone text not null default '',
  tax_code text not null default '',
  bank_bin text not null default '',               -- NAPAS BIN of the receiving bank
  bank_account text not null default '',
  bank_account_name text not null default '',
  receipt_footer text not null default 'Cảm ơn quý khách. Hẹn gặp lại!'
);
insert into shop_settings default values;

create table audit_log (
  id bigserial primary key,
  at timestamptz not null default now(),
  staff_id uuid references staff,
  action text not null,                            -- 'void_item', 'discount', 'reprint', ...
  detail jsonb not null default '{}'
);

-- Settle an order in one transaction: payments must add up exactly to the total.
create or replace function pay_order(p_order uuid, p_discount int, p_payments jsonb)
returns bills language plpgsql security definer set search_path = public as $$
declare
  v_sub int;
  v_paid int;
  v_bill bills;
  v_staff uuid := (select id from staff where user_id = auth.uid());
begin
  if not exists (select 1 from staff where id = v_staff and role in ('cashier', 'manager') and active) then
    raise exception 'Chỉ thu ngân hoặc quản lý được thanh toán';
  end if;
  perform 1 from orders where id = p_order and status = 'open' for update;
  if not found then raise exception 'Order không còn mở'; end if;

  select coalesce(sum(price * qty), 0) into v_sub from order_items where order_id = p_order and status <> 'void';
  if p_discount < 0 or p_discount > v_sub then raise exception 'Giảm giá không hợp lệ'; end if;
  select coalesce(sum((p->>'amount')::int), 0) into v_paid from jsonb_array_elements(p_payments) p;
  if v_paid <> v_sub - p_discount then
    raise exception 'Tổng thanh toán % khác số phải trả %', v_paid, v_sub - p_discount;
  end if;

  insert into bills (order_id, subtotal, discount, total, cashier_id)
  values (p_order, v_sub, p_discount, v_sub - p_discount, v_staff) returning * into v_bill;
  insert into payments (bill_id, method, amount, tendered)
  select v_bill.id, (p->>'method')::pay_method, (p->>'amount')::int, nullif(p->>'tendered', '')::int
  from jsonb_array_elements(p_payments) p;

  update order_items set status = 'served' where order_id = p_order and status in ('new', 'cooking', 'ready');
  update orders set status = 'paid', closed_at = now() where id = p_order;
  if p_discount > 0 then
    insert into audit_log (staff_id, action, detail) values (v_staff, 'discount', jsonb_build_object('bill', v_bill.bill_no, 'amount', p_discount));
  end if;
  return v_bill;
end $$;

-- Row level security: every signed-in active staff member can read; writes are limited by role.
create or replace function my_role() returns staff_role language sql stable security definer set search_path = public as
$$ select role from staff where user_id = auth.uid() and active $$;

alter table staff enable row level security;
alter table areas enable row level security;
alter table tables enable row level security;
alter table menu_categories enable row level security;
alter table menu_items enable row level security;
alter table orders enable row level security;
alter table order_items enable row level security;
alter table bills enable row level security;
alter table payments enable row level security;
alter table shop_settings enable row level security;
alter table audit_log enable row level security;

create policy read_all on staff for select using (my_role() is not null);
create policy read_all on areas for select using (my_role() is not null);
create policy read_all on tables for select using (my_role() is not null);
create policy read_all on menu_categories for select using (my_role() is not null);
create policy read_all on menu_items for select using (my_role() is not null);
create policy read_all on orders for select using (my_role() is not null);
create policy read_all on order_items for select using (my_role() is not null);
create policy read_all on bills for select using (my_role() is not null);
create policy read_all on payments for select using (my_role() is not null);
create policy read_all on shop_settings for select using (my_role() is not null);
create policy read_mgr on audit_log for select using (my_role() = 'manager');

create policy manage on staff for all using (my_role() = 'manager') with check (my_role() = 'manager');
create policy manage on areas for all using (my_role() = 'manager') with check (my_role() = 'manager');
create policy manage on tables for all using (my_role() = 'manager') with check (my_role() = 'manager');
create policy manage on menu_categories for all using (my_role() = 'manager') with check (my_role() = 'manager');
create policy manage on menu_items for all using (my_role() = 'manager') with check (my_role() = 'manager');
create policy manage on shop_settings for update using (my_role() = 'manager') with check (my_role() = 'manager');

create policy open_order on orders for insert with check (my_role() in ('waiter', 'cashier', 'manager'));
create policy add_items on order_items for insert with check (my_role() in ('waiter', 'cashier', 'manager'));
-- Kitchen moves items new -> cooking -> ready; floor staff mark ready -> served.
create policy update_items on order_items for update using (my_role() is not null) with check (my_role() is not null);
create policy move_order on orders for update using (my_role() in ('waiter', 'cashier', 'manager'));
-- bills/payments are only written through pay_order().

alter publication supabase_realtime add table orders, order_items, menu_items;
