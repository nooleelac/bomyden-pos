// From floor state to what the cashier screen and the receipts show: grouped items, VietQR memo and payload,
// receipt data for a pre-bill, a closed bill or a shift report. Pure.

import { formatMoney, type Discount } from '../lib/billing'
import type { BillTotals } from '../lib/pricing'
import { asciiNote, vietQrPayload } from '../lib/vietqr'
import { billTableLabel } from '../floor/engine'
import { orderLabel, tableName, tableTitle } from '../floor/logic'
import type { Bill, FloorState, Line, Order, ShopProfile } from '../floor/types'
import type { ReceiptData, ReceiptGroup, ReceiptItem, ReceiptPayment } from './receipt'
import { enabledMethods } from './config'

/** 'Bàn 5-B', 'Bàn 3 + 4 (gộp)', 'MV-02' from a stored label ('5-B', 'nhóm gộp 3+4', 'MV-02'). */
export function receiptTableTitle(label: string): string {
  const m = /^nhóm gộp (.+)$/.exec(label)
  if (m) return `Bàn ${m[1].split('+').join(' + ')} (gộp)`
  return tableTitle(label)
}

const itemKey = (l: Line) => JSON.stringify([l.menuItemId, l.variantId, l.price, l.note, l.mods.map(m => [m.kind, m.name, m.qty, m.unitDelta])])

/** Live lines of an order, identical lines merged, grouped by the table they went to when the order spans tables. */
export function receiptGroups(s: FloorState, order: Order): ReceiptGroup[] {
  const lines = s.lines.filter(l => l.orderId === order.id && l.status !== 'void').sort((a, b) => a.sentAt.localeCompare(b.sentAt))
  const tables = [...new Set(lines.map(l => l.deliveryTableId ?? ''))]
  const grouped = order.kind === 'dine_in' && tables.length > 1
  const groups: ReceiptGroup[] = []
  for (const t of grouped ? tables : ['']) {
    const items: ReceiptItem[] = []
    const byKey = new Map<string, ReceiptItem>()
    for (const l of lines.filter(x => !grouped || (x.deliveryTableId ?? '') === t)) {
      const k = itemKey(l)
      const hit = byKey.get(k)
      if (hit) {
        hit.qty += l.qty
        continue
      }
      const it: ReceiptItem = {
        name: l.name, variant: l.variantName, qty: l.qty, unitPrice: l.price, note: l.note || undefined,
        mods: l.mods.map(m => ({ kind: m.kind, name: m.name, qty: m.qty, unitDelta: m.unitDelta })),
      }
      byKey.set(k, it)
      items.push(it)
    }
    groups.push({ label: grouped ? `Bàn ${tableName(s, t || null)}` : '', items })
  }
  return groups
}

/** Short code of an order for the transfer note: 6 letters/digits, stable across devices. */
export function orderCode(orderId: string): string {
  const hex = orderId.replace(/-/g, '')
  if (/^[0-9a-f]{12,}$/i.test(hex)) return hex.slice(0, 6).toUpperCase()
  let h = 2166136261
  for (const ch of orderId) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0
  return h.toString(36).toUpperCase().padStart(6, '0').slice(-6)
}

/**
 * Nội dung chuyển khoản: ASCII letters and digits only, short (banks cut special characters).
 * 'BMD3F9A2C BAN5B'; each share of a split bill adds its letter: 'BMD3F9A2CA BAN5B'.
 */
export function payMemo(s: FloorState, order: Order, part = ''): string {
  const where = asciiNote(tableTitle(orderLabel(s, order))).replace(/ /g, '').toUpperCase()
  return asciiNote(`BMD${orderCode(order.id)}${part} ${where}`)
}

/** VietQR payload with the exact amount and memo, or null when the shop has no bank account set or takes no transfers. */
export function vietQr(shop: ShopProfile, amount: number, memo: string): string | null {
  if (!enabledMethods(shop).includes('bank') || !shop.bankBin || !shop.bankAccount || amount <= 0) return null
  return vietQrPayload({ bankBin: shop.bankBin, account: shop.bankAccount, amount, note: memo })
}

export function discountLabel(d: Discount | null, reason: string): string {
  const pct = d?.kind === 'percent' ? ` ${d.value}%` : ''
  return `Giảm giá${pct}${reason ? ` (${reason})` : ''}`
}

function orderHead(s: FloorState, order: Order) {
  return {
    tableLabel: receiptTableTitle(billTableLabel(s, order)),
    positionLabel: order.kind === 'takeaway' ? order.customerName : order.positionLabel,
    guestCount: order.guestCount,
    openedAt: order.openedAt,
    waiter: order.openedBy,
  }
}

/** Phiếu tạm tính: what the table owes now, with a VietQR for the amount still due. */
export function prebillData(
  s: FloorState,
  order: Order,
  totals: BillTotals,
  opts: { at: string; cashier?: string; discount?: Discount | null; discountReason?: string; printNo?: number; paidBefore?: ReceiptPayment[]; qrAmount?: number; qrPart?: string },
): ReceiptData {
  const paid = (opts.paidBefore ?? []).reduce((n, p) => n + p.amount, 0)
  const qrAmount = opts.qrAmount ?? totals.total - paid
  const memo = payMemo(s, order, opts.qrPart)
  const payload = vietQr(s.shop, qrAmount, memo)
  return {
    kind: 'prebill',
    shop: s.shop,
    ...orderHead(s, order),
    at: opts.at,
    cashier: opts.cashier,
    groups: receiptGroups(s, order),
    subtotal: totals.subtotal,
    discount: totals.discount,
    discountLabel: discountLabel(opts.discount ?? null, opts.discountReason ?? ''),
    serviceCharge: totals.serviceCharge,
    serviceChargePct: s.shop.serviceChargePct,
    rounding: totals.rounding,
    total: totals.total,
    vat: totals.vat,
    payments: opts.paidBefore,
    printNo: opts.printNo,
    qr: payload ? { payload, amount: qrAmount, memo } : undefined,
  }
}

/** Hoá đơn of a closed bill; `print` is this print's number (2+ prints IN LẠI). */
export function billData(s: FloorState, bill: Bill, print?: { count: number; at: string; by: string }): ReceiptData {
  const order = s.orders.find(o => o.id === bill.orderId)
  return {
    kind: 'bill',
    shop: s.shop,
    billNo: bill.billNo,
    tableLabel: receiptTableTitle(bill.tableLabel),
    positionLabel: order ? (order.kind === 'takeaway' ? order.customerName : order.positionLabel) : '',
    guestCount: order?.guestCount ?? null,
    openedAt: order?.openedAt ?? bill.paidAt,
    at: bill.paidAt,
    cashier: bill.cashier,
    waiter: order?.openedBy,
    groups: order ? receiptGroups(s, order) : [],
    subtotal: bill.subtotal,
    discount: bill.discount,
    discountLabel: discountLabel(null, bill.discountReason),
    serviceCharge: bill.serviceCharge,
    serviceChargePct: s.shop.serviceChargePct,
    rounding: bill.rounding,
    total: bill.total,
    vat: bill.vatLines,
    payments: bill.payments.map(p => ({ method: p.method, amount: p.amount, tendered: p.tendered, ref: p.ref })),
    reprint: print,
  }
}

/** One-line summary for lists: "HD000012 · Bàn 9 · 1.274.000đ". */
export function billSummary(b: Bill): string {
  return `${b.billNo} · ${receiptTableTitle(b.tableLabel)} · ${formatMoney(b.total)}đ`
}
