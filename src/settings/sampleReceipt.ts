// Sample receipts for Cài đặt → Máy in (test print) and Cài đặt → Mẫu in (preview): two dishes, cash with change,
// and a QR so its print quality shows too.

import { receiptBlocks, type Block } from '../cashier/receipt'
import type { ShopProfile } from '../floor/types'

export function sampleReceipt(shop: ShopProfile, kind: 'bill' | 'prebill', at: string): Block[] {
  return receiptBlocks({
    kind, shop, billNo: kind === 'bill' ? 'HD-0001' : undefined, printNo: kind === 'prebill' ? 1 : undefined,
    tableLabel: 'Bàn 1', guestCount: 2, openedAt: at, at, cashier: 'Lan', waiter: 'Hùng',
    groups: [{ label: '', items: [
      { name: 'Ba chỉ bò Mỹ nướng', variant: 'Lớn', qty: 2, unitPrice: 189000, mods: [] },
      { name: 'Trà đá', variant: '', qty: 2, unitPrice: 5000, mods: [] },
    ] }],
    subtotal: 388000, discount: 0, serviceCharge: 0, rounding: 0, total: 388000, vat: [],
    payments: kind === 'bill' ? [{ method: 'cash', amount: 388000, tendered: 500000 }] : [],
    qr: { payload: 'IN THU MAY IN', amount: 388000, memo: 'HD0001' },
  })
}
