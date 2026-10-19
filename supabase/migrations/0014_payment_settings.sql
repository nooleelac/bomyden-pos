-- Bò Mỹ Đen POS 0014: Cài đặt → Thanh toán.
--
--   pay_cash / pay_bank / pay_card   payment methods the cashier may take; pay_order refuses a method turned off
--   vat_rate                         one VAT % for every dish sent from now on; null = by menu group (vat_rates)
--   show_vat_on_receipt              print the VAT lines on bills and pre-bills
--
-- Lines keep the rate they were sent with (as before): a new rate applies to dishes sent after the change.
-- Same rules as checkPaymentSettings / priceLine in src/floor/engine.ts.

alter table shop_settings
  add column pay_cash boolean not null default true,
  add column pay_bank boolean not null default true,
  add column pay_card boolean not null default true,
  add column vat_rate smallint check (vat_rate between 0 and 100),
  add column show_vat_on_receipt boolean not null default true,
  add constraint shop_settings_one_method check (pay_cash or pay_bank or pay_card);

-- the shop may set any whole percent, not only 0/5/8/10
alter table order_items drop constraint if exists order_items_vat_rate_check;
alter table order_items add constraint order_items_vat_rate_check check (vat_rate between 0 and 100);

-- _send_lines (0004) takes the rate of each line from here: the shop's one rate wins over the menu group
create or replace function vat_rate_on(p_group text, p_day date) returns smallint
language sql stable set search_path = public as $$
  select coalesce(
    (select vat_rate from shop_settings limit 1),
    (select rate from vat_rates where vat_group = p_group and valid_from <= p_day order by valid_from desc limit 1))
$$;

-- a method turned off cannot be paid with (the cashier screen hides it too)
create function payment_method_guard() returns trigger
language plpgsql set search_path = public as $$
declare
  s shop_settings;
begin
  select * into s from shop_settings limit 1;
  if (new.method = 'cash' and not s.pay_cash) or (new.method = 'bank' and not s.pay_bank) or (new.method = 'card' and not s.pay_card) then
    raise exception 'Quán đã tắt phương thức thanh toán này (Cài đặt → Thanh toán)';
  end if;
  return new;
end $$;

create trigger payments_method_guard before insert on payments
  for each row execute function payment_method_guard();

-- other devices see the change at once (methods on the cashier screen, VAT on the next bill)
alter publication supabase_realtime add table shop_settings;
