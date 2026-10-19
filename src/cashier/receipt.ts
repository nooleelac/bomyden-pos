// 80mm receipt layout as plain text lines: 48 characters per line (Font A on an 80mm thermal printer),
// 24 for double-size lines. Pure, so the layout is tested; print.ts turns the blocks into HTML for window.print.
// Text is NFC-normalised so every Vietnamese letter is one character (no combining marks in a monospace grid).

import { METHOD_LABEL, formatMoney, type PayMethod } from '../lib/billing'
import type { VatGroup } from '../lib/pricing'
import type { ShopProfile } from '../floor/types'
import { showVat } from './config'
import { DENOMINATIONS, type ShiftSummary } from './shift'

export const WIDTH = 48
export const BIG_WIDTH = 24

export type Block =
  | { kind: 'text'; text: string; bold?: boolean; big?: boolean }
  | { kind: 'qr'; payload: string }

// ---------------------------------------------------------------- line helpers

const nfc = (s: string) => s.normalize('NFC')
/** Characters as printed (code points after NFC). */
export const textWidth = (s: string) => [...nfc(s)].length

function chars(s: string): string[] {
  return [...nfc(s)]
}

/** Word wrap to `width`; continuation lines start with `indent`. Words longer than a line are cut. */
export function wrap(text: string, width = WIDTH, indent = ''): string[] {
  const t = nfc(text)
  const lead = /^ */.exec(t)![0]
  const words = t.split(/\s+/).filter(Boolean)
  const out: string[] = []
  let cur = lead
  const room = () => width - textWidth(out.length ? indent : '')
  for (let w of words) {
    while (textWidth(w) > width - textWidth(indent)) {
      if (cur.trim()) {
        out.push((out.length ? indent : '') + cur)
        cur = ''
      }
      const cut = chars(w)
      const n = room()
      out.push((out.length ? indent : '') + cut.slice(0, n).join(''))
      w = cut.slice(n).join('')
    }
    if (!w) continue
    const next = cur.trim() ? `${cur} ${w}` : cur + w
    if (textWidth(next) <= room()) cur = next
    else {
      out.push((out.length ? indent : '') + cur)
      cur = w
    }
  }
  if (cur.trim() || !out.length) out.push((out.length ? indent : '') + cur)
  return out
}

/** Left text and a right-aligned amount on one line; long left text wraps and the amount ends the last line. */
export function row(left: string, right = '', width = WIDTH, indent = '  '): string[] {
  if (!right) return wrap(left, width, indent)
  const r = nfc(right)
  const lines = wrap(left, width, indent)
  const last = lines[lines.length - 1]
  if (textWidth(last) + 1 + textWidth(r) <= width) {
    lines[lines.length - 1] = last + ' '.repeat(width - textWidth(last) - textWidth(r)) + r
  } else {
    lines.push(' '.repeat(Math.max(0, width - textWidth(r))) + r)
  }
  return lines
}

export function center(text: string, width = WIDTH): string[] {
  return wrap(text, width).map(l => {
    const pad = Math.max(0, Math.floor((width - textWidth(l)) / 2))
    return ' '.repeat(pad) + l
  })
}

const rule = (ch = '-') => ch.repeat(WIDTH)
const signed = (n: number) => (n > 0 ? '+' : '') + formatMoney(n)

// ---------------------------------------------------------------- dates (shop time, UTC+7)

function vn(iso: string): Date {
  return new Date(new Date(iso).getTime() + 7 * 3600_000)
}
const two = (n: number) => String(n).padStart(2, '0')
export function fmtDate(iso: string): string {
  const d = vn(iso)
  return `${two(d.getUTCDate())}/${two(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`
}
export function fmtTime(iso: string): string {
  const d = vn(iso)
  return `${two(d.getUTCHours())}:${two(d.getUTCMinutes())}`
}

// ---------------------------------------------------------------- bill and pre-bill

export interface ReceiptMod {
  kind: 'option' | 'addon' | 'removal'
  name: string
  qty: number
  /** Per unit, signed (removals negative). */
  unitDelta: number
}

export interface ReceiptItem {
  name: string
  variant: string
  qty: number
  /** Locked unit price (size + options/add-ons − removed components). */
  unitPrice: number
  mods: ReceiptMod[]
  note?: string
}

export interface ReceiptGroup {
  /** 'Bàn 3' for a merged group; '' when the bill has one table. */
  label: string
  items: ReceiptItem[]
}

export interface ReceiptPayment {
  method: PayMethod
  amount: number
  tendered?: number | null
  ref?: string
}

export interface ReceiptData {
  kind: 'bill' | 'prebill'
  shop: ShopProfile
  billNo?: string
  /** 'Bàn 5-B', 'Bàn 3 + 4 (gộp)', 'MV-02'. */
  tableLabel: string
  positionLabel?: string
  guestCount?: number | null
  openedAt: string
  /** Paid at (bill) or printed at (pre-bill). */
  at: string
  cashier?: string
  waiter?: string
  groups: ReceiptGroup[]
  subtotal: number
  discount: number
  /** 'Giảm giá 10% (Khách quen)'. */
  discountLabel?: string
  serviceCharge: number
  serviceChargePct?: number
  rounding: number
  total: number
  vat: VatGroup[]
  payments?: ReceiptPayment[]
  /** VietQR for an amount still to transfer (pre-bill, or a transfer not received yet). */
  qr?: { payload: string; amount: number; memo: string }
  /** Pre-bill print number (Lần in). */
  printNo?: number
  /** Second and later print of a bill. */
  reprint?: { count: number; at: string; by: string }
}

function header(shop: ShopProfile): Block[] {
  const out: Block[] = []
  for (const l of center(shop.name, BIG_WIDTH)) out.push({ kind: 'text', text: l, big: true })
  const small = [shop.address, shop.phone && `ĐT: ${shop.phone}`, shop.taxCode && `MST: ${shop.taxCode}`].filter(Boolean) as string[]
  for (const s of small) for (const l of center(s)) out.push({ kind: 'text', text: l })
  return out
}

/** Item name with its size, the modifiers under it with their price per portion, then qty × unit = amount. */
export function itemLines(it: ReceiptItem): string[] {
  const title = it.name + (it.variant ? ` (${it.variant})` : '')
  const amount = it.unitPrice * it.qty
  if (!it.mods.length && !it.note && it.qty === 1) return row(title, formatMoney(amount))
  const delta = it.mods.reduce((s, m) => s + m.unitDelta * m.qty, 0)
  const out = delta !== 0 ? row(title, formatMoney(it.unitPrice - delta)) : wrap(title, WIDTH, '  ')
  for (const m of it.mods) {
    const label =
      m.kind === 'removal' ? `Không ${m.name.charAt(0).toLowerCase()}${m.name.slice(1)}` : m.kind === 'addon' ? `+ ${m.name}${m.qty > 1 ? ` x${m.qty}` : ''}` : m.name
    out.push(...row('  ' + label, m.unitDelta ? signed(m.unitDelta * m.qty) : '', WIDTH, '    '))
  }
  if (it.note) out.push(...wrap(`  Ghi chú: ${it.note}`, WIDTH, '    '))
  out.push(...row(`  ${it.qty} x ${formatMoney(it.unitPrice)}`, formatMoney(amount)))
  return out
}

export function receiptBlocks(d: ReceiptData): Block[] {
  const out: Block[] = header(d.shop)
  const vatShown = showVat(d.shop)
  const t = (text: string, bold = false) => out.push({ kind: 'text', text, bold })
  const lines = (ls: string[], bold = false) => ls.forEach(l => t(l, bold))
  t(rule('='))
  if (d.kind === 'prebill') {
    for (const l of center('PHIẾU TẠM TÍNH', BIG_WIDTH)) out.push({ kind: 'text', text: l, big: true })
    lines(center('CHƯA THANH TOÁN'), true)
    if (d.printNo) lines(center(`Lần in: ${d.printNo}`))
  } else {
    lines(center('HOÁ ĐƠN THANH TOÁN'), true)
    if (d.reprint && d.reprint.count > 1) {
      lines(center(`*** IN LẠI – lần ${d.reprint.count} ***`), true)
      lines(center(`${fmtTime(d.reprint.at)} ${fmtDate(d.reprint.at)} · ${d.reprint.by}`))
    }
  }
  t('')
  if (d.billNo) lines(row(`Số HĐ: ${d.billNo}`, `Ngày: ${fmtDate(d.at)}`))
  else lines(row(`Ngày: ${fmtDate(d.at)}`, `In lúc: ${fmtTime(d.at)}`))
  lines(row(`${d.tableLabel}${d.positionLabel ? ` · ${d.positionLabel}` : ''}`, d.guestCount ? `Khách: ${d.guestCount}` : ''))
  lines(row(`Giờ vào: ${fmtTime(d.openedAt)}`, d.kind === 'bill' ? `Giờ ra: ${fmtTime(d.at)}` : ''))
  const staff = [d.cashier && `Thu ngân: ${d.cashier}`, d.waiter && `Phục vụ: ${d.waiter}`].filter(Boolean) as string[]
  if (staff.length === 2 && textWidth(staff[0]) + textWidth(staff[1]) + 1 <= WIDTH) lines(row(staff[0], staff[1]))
  else staff.forEach(s => lines(wrap(s)))
  t(rule())

  for (const g of d.groups) {
    if (g.label) t(`[${g.label}]`, true)
    for (const it of g.items) lines(itemLines(it))
    if (g.label && d.groups.length > 1) lines(row(`  Cộng ${g.label}`, formatMoney(g.items.reduce((s, i) => s + i.unitPrice * i.qty, 0))))
  }
  t(rule())
  lines(row('Tạm tính', formatMoney(d.subtotal)))
  if (d.discount) lines(row(d.discountLabel || 'Giảm giá', formatMoney(-d.discount)))
  if (d.serviceCharge) lines(row(`Phí phục vụ${d.serviceChargePct ? ` ${d.serviceChargePct}%` : ''}`, formatMoney(d.serviceCharge)))
  // VAT added on top stays even when the shop hides VAT (Cài đặt → Thanh toán): without it the total would not add up
  for (const g of d.vat.filter(v => !v.priceIncludesVat)) lines(row(vatShown ? `Thuế GTGT ${g.vatRate}% (trên ${formatMoney(g.base)})` : 'Thuế', formatMoney(g.vat)))
  if (d.rounding) lines(row('Làm tròn', signed(d.rounding)))
  t(rule('='))
  const paidBefore = d.kind === 'prebill' ? (d.payments ?? []).reduce((s, p) => s + p.amount, 0) : 0
  const due = d.total - paidBefore
  const bigLabel = d.kind === 'prebill' ? (paidBefore ? 'CÒN PHẢI TRẢ' : 'TỔNG CỘNG') : 'TỔNG CỘNG'
  if (paidBefore) lines(row('TỔNG THANH TOÁN', formatMoney(d.total)), true)
  for (const l of row(bigLabel, formatMoney(due) + 'đ', BIG_WIDTH, '')) out.push({ kind: 'text', text: l, big: true })
  const incl = vatShown ? d.vat.filter(v => v.priceIncludesVat && v.vat > 0) : []
  if (incl.length) {
    t(d.vat.every(v => v.priceIncludesVat) ? 'Giá đã gồm thuế GTGT. Trong đó:' : 'Trong đó thuế GTGT đã gồm trong giá:')
    for (const g of incl) lines(row(`  Thuế GTGT ${g.vatRate}% (trên ${formatMoney(g.base)})`, formatMoney(g.vat)))
  }

  if (d.payments?.length) {
    t(rule())
    if (d.kind === 'prebill') t('Đã thu trước:')
    for (const p of d.payments) {
      lines(row(METHOD_LABEL[p.method] + (p.ref ? ` (${p.ref})` : ''), formatMoney(p.amount)))
      if (p.method === 'cash' && p.tendered != null && p.tendered > p.amount) {
        lines(row('  Khách đưa', formatMoney(p.tendered)))
        lines(row('  Tiền thối', formatMoney(p.tendered - p.amount)), true)
      }
    }
  }

  if (d.qr) {
    t(rule())
    lines(center('QUÉT MÃ ĐỂ CHUYỂN KHOẢN'), true)
    out.push({ kind: 'qr', payload: d.qr.payload })
    lines(center(`${d.shop.bankName} · ${d.shop.bankAccount}`))
    if (d.shop.bankAccountName) lines(center(d.shop.bankAccountName))
    lines(center(`Số tiền: ${formatMoney(d.qr.amount)}đ`), true)
    lines(center(`Nội dung: ${d.qr.memo}`))
  }

  t(rule())
  if (d.kind === 'prebill') lines(center('Quý khách vui lòng kiểm tra món trước khi thanh toán.'))
  if (d.shop.footer) lines(center(d.shop.footer))
  if (d.shop.sample) lines(center('(Thông tin quán và tài khoản là mẫu)'))
  return out
}

// ---------------------------------------------------------------- shift report

export interface ShiftReportData {
  shop: ShopProfile
  register: string
  openedBy: string
  openedAt: string
  closedBy?: string | null
  closedAt?: string | null
  summary: ShiftSummary
  countedDetail?: Record<string, number>
  countedCash?: number | null
  note?: string
  openOrders?: number
  /** Printed before the shift is closed. */
  draft?: boolean
}

export function shiftReportBlocks(d: ShiftReportData): Block[] {
  const out: Block[] = header(d.shop)
  const t = (text: string, bold = false) => out.push({ kind: 'text', text, bold })
  const lines = (ls: string[], bold = false) => ls.forEach(l => t(l, bold))
  const s = d.summary
  t(rule('='))
  lines(center(d.draft ? 'BÁO CÁO CA (TẠM)' : 'BÁO CÁO CHỐT CA'), true)
  t('')
  lines(row(d.register, `Mở: ${d.openedBy}`))
  lines(row('Mở ca', `${fmtTime(d.openedAt)} ${fmtDate(d.openedAt)}`))
  if (d.closedAt) lines(row(`Chốt ca${d.closedBy ? ` (${d.closedBy})` : ''}`, `${fmtTime(d.closedAt)} ${fmtDate(d.closedAt)}`))
  t(rule())
  lines(row('Số hoá đơn', String(s.bills)))
  lines(row('Tiền hàng', formatMoney(s.subtotal)))
  if (s.discount) lines(row('Giảm giá hoá đơn', formatMoney(-s.discount)))
  if (s.serviceCharge) lines(row('Phí phục vụ', formatMoney(s.serviceCharge)))
  if (s.rounding) lines(row('Làm tròn', signed(s.rounding)))
  lines(row('DOANH THU', formatMoney(s.sales)), true)
  lines(row('  Trong đó thuế GTGT', formatMoney(s.vatTotal)))
  t(rule())
  t('THU THEO CÁCH TRẢ', true)
  for (const m of ['cash', 'bank', 'card'] as PayMethod[]) lines(row(`  ${METHOD_LABEL[m]}`, formatMoney(s.byMethod[m])))
  lines(row('  Cộng', formatMoney(s.byMethod.cash + s.byMethod.bank + s.byMethod.card)), true)
  t(rule())
  t('TIỀN MẶT TRONG KÉT', true)
  lines(row('  Tiền đầu ca', formatMoney(s.openingFloat)))
  lines(row('  + Thu tiền mặt', formatMoney(s.byMethod.cash)))
  if (s.changeGiven) lines(row('    (khách đưa / đã thối)', `${formatMoney(s.cashTendered)} / ${formatMoney(s.changeGiven)}`))
  lines(row('  = Dự kiến trong két', formatMoney(s.expectedCash)), true)
  if (d.countedCash != null) {
    const detail = DENOMINATIONS.map(v => [v, d.countedDetail?.[String(v)] ?? 0] as const).filter(([, n]) => n > 0)
    if (detail.length) {
      t('  Đếm thực tế:')
      for (const [v, n] of detail) lines(row(`    ${formatMoney(v)} x ${n}`, formatMoney(v * n)))
    }
    lines(row('  Tiền đếm được', formatMoney(d.countedCash)), true)
    const diff = d.countedCash - s.expectedCash
    lines(row(`  Chênh lệch${diff > 0 ? ' (thừa)' : diff < 0 ? ' (thiếu)' : ''}`, signed(diff)), true)
  }
  if (d.note) lines(wrap(`Ghi chú: ${d.note}`, WIDTH, '  '))
  if (d.openOrders) lines(wrap(`Còn ${d.openOrders} đơn chưa thanh toán lúc in báo cáo.`))
  t(rule())
  t('')
  lines(row('Thu ngân ký', 'Quản lý ký'))
  t('')
  t('')
  t('')
  return out
}

/** Plain text of the blocks (tests, and a fallback when no printer is set up). */
export function blocksText(blocks: Block[]): string {
  return blocks.map(b => (b.kind === 'qr' ? '[QR]' : b.text)).join('\n')
}
