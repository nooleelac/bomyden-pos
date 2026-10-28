-- Bò Mỹ Đen POS 0019: Cài đặt → Thanh toán takes several bank accounts.
--
--   bank_accounts   [{ id, bin, bank_name, account, holder }], the default first; the cashier picks one for each VietQR
--
-- bank_bin / bank_name / bank_account / bank_account_name (0001, 0005) stay and hold the default account, so receipts
-- and devices on an older build keep working. Same rules as checkPaymentSettings in src/floor/engine.ts.

alter table shop_settings
  add column bank_accounts jsonb not null default '[]'::jsonb
    check (jsonb_typeof(bank_accounts) = 'array');

-- the one account saved so far becomes the first (default) of the list
update shop_settings
set bank_accounts = jsonb_build_array(jsonb_build_object(
  'id', 'tk-1', 'bin', bank_bin, 'bank_name', bank_name, 'account', bank_account, 'holder', bank_account_name))
where bank_accounts = '[]'::jsonb and (bank_bin <> '' or bank_account <> '');
