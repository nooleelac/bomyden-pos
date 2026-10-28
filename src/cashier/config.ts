// Shop profile used until shop_settings is filled in (Supabase mode reads shop_settings instead).
// ĐIỀN THÔNG TIN THẬT: name, address, phone, tax code and the bank account below are placeholders.

import type { PayMethod } from '../lib/billing'
import type { BankAccount, PaymentSettings, ShopProfile } from '../floor/types'

export const SAMPLE_SHOP: ShopProfile = {
  sample: true,
  name: 'BÒ MỸ ĐEN',
  address: '[Địa chỉ quán – cập nhật trong cài đặt]',
  phone: '[Số điện thoại]',
  taxCode: '',
  // Vietcombank BIN with a dummy account: the QR scans, but do not transfer to it.
  bankBin: '970436',
  bankName: 'Vietcombank',
  bankAccount: '0000000000',
  bankAccountName: 'TAI KHOAN MAU',
  footer: 'Cảm ơn quý khách. Hẹn gặp lại!',
  serviceChargePct: 0,
  roundingMode: 'down',
  roundingUnit: 1000,
}

/** The register this device works at. One open shift per register. */
export const REGISTER = 'Quầy 1'

/** Bill discount reasons (spec: bắt buộc chọn lý do). */
export const DISCOUNT_REASONS = ['Khách quen', 'Món ra chậm', 'Món lỗi', 'Nhân viên ăn', 'Chủ quán mời', 'Khác'] as const

/** Payment methods in the order the cashier sees them. */
export const PAY_METHODS: PayMethod[] = ['cash', 'bank', 'card']

/** Methods the shop takes (Cài đặt → Thanh toán); all three until the shop turns one off. */
export const enabledMethods = (shop: ShopProfile): PayMethod[] => PAY_METHODS.filter(m => shop.payMethods?.[m] ?? true)

/** VAT lines on printed bills: yes until the shop turns them off. */
export const showVat = (shop: ShopProfile): boolean => shop.showVat ?? true

/** What Cài đặt → Thanh toán edits, with the defaults filled in. */
export function paymentSettings(shop: ShopProfile): PaymentSettings {
  return {
    payMethods: { cash: true, bank: true, card: true, ...shop.payMethods },
    vatRate: shop.vatRate ?? null,
    showVat: showVat(shop),
    bankAccounts: bankAccounts(shop),
  }
}

/** The shop's transfer accounts, the default first; a shop saved before 0019 has its one account. */
export function bankAccounts(shop: ShopProfile): BankAccount[] {
  if (shop.bankAccounts?.length) return shop.bankAccounts
  if (!shop.bankBin && !shop.bankAccount) return []
  return [{ id: 'tk-1', bin: shop.bankBin, bankName: shop.bankName, account: shop.bankAccount, holder: shop.bankAccountName }]
}

/** The account to show a VietQR for: the one picked, else the default. */
export function bankAccountFor(shop: ShopProfile, id?: string): BankAccount | undefined {
  const all = bankAccounts(shop)
  return all.find(a => a.id === id) ?? all[0]
}
