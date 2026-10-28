// Cài đặt → Mẫu in: the words printed on bills, pre-bills and shift reports and the size of each part. One template for
// the whole shop (shop_settings.receipt_template, 0017); missing or unknown fields fall back to the defaults below.

/** Size of a part as a multiple of the base text (Cài đặt → Máy in sets the base per device). */
export type LineSize = 1 | 1.5 | 2
export const LINE_SIZES: { v: LineSize; label: string }[] = [
  { v: 1, label: 'Thường' },
  { v: 1.5, label: 'Vừa' },
  { v: 2, label: 'To' },
]

export interface StylePart {
  size: LineSize
  bold: boolean
}

/** Text the shop writes itself; several lines allowed, each centred. Empty = not printed. */
export interface TextPart extends StylePart {
  text: string
}

export interface ReceiptTemplate {
  /** Shop name (the text is Cài đặt → Mẫu in → Tên quán). */
  shopName: StylePart
  /** Address, phone, tax code. */
  shopInfo: StylePart
  /** Extra lines under the shop info, e.g. opening hours. */
  headerNote: TextPart
  billTitle: TextPart
  prebillTitle: TextPart
  prebillNote: TextPart
  /** Bill number, table, times, staff. */
  details: StylePart
  showStaff: boolean
  /** Dishes and their amounts. */
  items: StylePart
  totalLabel: TextPart
  qrTitle: TextPart
  prebillFooter: TextPart
  /** Thank-you line (the text is the shop's footer). */
  footer: StylePart
  /** Extra lines at the very end, e.g. Wi-Fi password. */
  footerNote: TextPart
}

export const TEXT_MAX = 200

export const DEFAULT_TEMPLATE: ReceiptTemplate = {
  shopName: { size: 2, bold: true },
  shopInfo: { size: 1, bold: false },
  headerNote: { text: '', size: 1, bold: false },
  billTitle: { text: 'HOÁ ĐƠN THANH TOÁN', size: 1, bold: true },
  prebillTitle: { text: 'PHIẾU TẠM TÍNH', size: 2, bold: true },
  prebillNote: { text: 'CHƯA THANH TOÁN', size: 1, bold: true },
  details: { size: 1, bold: false },
  showStaff: true,
  items: { size: 1, bold: false },
  totalLabel: { text: 'TỔNG CỘNG', size: 2, bold: true },
  qrTitle: { text: 'QUÉT MÃ ĐỂ CHUYỂN KHOẢN', size: 1, bold: true },
  prebillFooter: { text: 'Quý khách vui lòng kiểm tra món trước khi thanh toán.', size: 1, bold: false },
  footer: { size: 1, bold: false },
  footerNote: { text: '', size: 1, bold: false },
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const size = (v: unknown, d: LineSize): LineSize => (v === 1 || v === 1.5 || v === 2 ? v : d)

function style(v: unknown, d: StylePart): StylePart {
  const o = isObj(v) ? v : {}
  return { size: size(o.size, d.size), bold: typeof o.bold === 'boolean' ? o.bold : d.bold }
}

function text(v: unknown, d: TextPart): TextPart {
  const o = isObj(v) ? v : {}
  const t = typeof o.text === 'string' ? o.text.replace(/\r/g, '').slice(0, TEXT_MAX) : d.text
  return { text: t, ...style(o, d) }
}

/** The stored template (any shape) with every field present and valid. */
export function receiptTemplate(v: unknown): ReceiptTemplate {
  const o = isObj(v) ? v : {}
  const d = DEFAULT_TEMPLATE
  return {
    shopName: style(o.shopName, d.shopName),
    shopInfo: style(o.shopInfo, d.shopInfo),
    headerNote: text(o.headerNote, d.headerNote),
    billTitle: text(o.billTitle, d.billTitle),
    prebillTitle: text(o.prebillTitle, d.prebillTitle),
    prebillNote: text(o.prebillNote, d.prebillNote),
    details: style(o.details, d.details),
    showStaff: typeof o.showStaff === 'boolean' ? o.showStaff : d.showStaff,
    items: style(o.items, d.items),
    totalLabel: text(o.totalLabel, d.totalLabel),
    qrTitle: text(o.qrTitle, d.qrTitle),
    prebillFooter: text(o.prebillFooter, d.prebillFooter),
    footer: style(o.footer, d.footer),
    footerNote: text(o.footerNote, d.footerNote),
  }
}
