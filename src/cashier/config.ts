// Shop profile used until shop_settings is filled in (Supabase mode reads shop_settings instead).
// ĐIỀN THÔNG TIN THẬT: name, address, phone, tax code and the bank account below are placeholders.

import type { ShopProfile } from '../floor/types'

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
