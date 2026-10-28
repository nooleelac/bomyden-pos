-- Bò Mỹ Đen POS 0017: Cài đặt → Mẫu in.
--
--   receipt_template   words and sizes on bills, pre-bills and shift reports, one template for the shop
--                      ({} = the defaults; shape and defaults in src/cashier/template.ts)
--
-- The shop header (shop_name, address, phone, tax_code) and receipt_footer are edited on the same screen. Updating
-- shop_settings already needs settings.edit (0009), and other devices see the change through realtime (0014).

alter table shop_settings add column receipt_template jsonb not null default '{}'::jsonb;
