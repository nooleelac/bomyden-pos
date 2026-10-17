// Pure money logic shared by the cashier screen and the receipt. All amounts are whole VND.

export type PayMethod = 'cash' | 'bank' | 'card'

export interface BillLine {
  price: number
  qty: number
  void?: boolean
}

export interface PaymentInput {
  method: PayMethod
  amount: number
  /** Cash handed over by the guest; only meaningful for cash. */
  tendered?: number
}

export type Discount = { kind: 'percent'; value: number } | { kind: 'amount'; value: number }

export const METHOD_LABEL: Record<PayMethod, string> = {
  cash: 'Tiền mặt',
  bank: 'Chuyển khoản',
  card: 'Thẻ',
}

export function subtotal(lines: BillLine[]): number {
  return lines.reduce((s, l) => (l.void ? s : s + l.price * l.qty), 0)
}

export function discountAmount(sub: number, d: Discount | null): number {
  if (!d || d.value <= 0) return 0
  const raw = d.kind === 'percent' ? Math.round((sub * Math.min(d.value, 100)) / 100) : d.value
  return Math.min(Math.max(0, Math.round(raw)), sub)
}

export interface BillSummary {
  subtotal: number
  discount: number
  total: number
  paid: number
  /** Positive = still owed, negative = overpaid (not allowed on payment rows). */
  remaining: number
  change: number
  canSettle: boolean
}

export function summarize(lines: BillLine[], d: Discount | null, payments: PaymentInput[]): BillSummary {
  const sub = subtotal(lines)
  const disc = discountAmount(sub, d)
  const total = sub - disc
  const valid = payments.every(p => Number.isInteger(p.amount) && p.amount > 0)
  const paid = payments.reduce((s, p) => s + (p.amount > 0 ? p.amount : 0), 0)
  const change = payments.reduce(
    (s, p) => s + (p.method === 'cash' && p.tendered && p.tendered > p.amount ? p.tendered - p.amount : 0),
    0,
  )
  const remaining = total - paid
  return { subtotal: sub, discount: disc, total, paid, remaining, change, canSettle: valid && payments.length > 0 && remaining === 0 }
}

/** Amount to pre-fill when the cashier adds another payment row. */
export function suggestNext(total: number, payments: PaymentInput[]): number {
  return Math.max(0, total - payments.reduce((s, p) => s + Math.max(0, p.amount), 0))
}

export function formatVnd(n: number): string {
  return Math.round(n).toLocaleString('vi-VN') + 'đ'
}

// ---------------------------------------------------------------- cashier: split payment, change, split evenly

/** One payment row on the cashier screen. For cash, `tendered` is what the guest hands over (blank = exact). */
export interface PayRow {
  method: PayMethod
  /** Amount this row settles. */
  amount: number
  tendered?: number | null
  /** Bank transfer seen on the shop's account, card slip approved. Cash needs no confirmation. */
  confirmed?: boolean
}

export interface Settlement {
  total: number
  /** Settled so far (cash counted only up to its amount). */
  paid: number
  /** Still to collect, never negative. */
  remaining: number
  /** All money handed over, including cash that comes back as change. */
  received: number
  change: number
  /** Rows to send to pay_order: amounts add up to the total, cash carries what the guest handed over. */
  payments: PaymentInput[]
  /** For each entry of `payments`, the index of the row it came from. */
  from: number[]
  /** Why it cannot close yet (Vietnamese, for the screen). */
  problems: string[]
  canSettle: boolean
}

/**
 * The bill closes only when the settled amounts equal the total exactly (as pay_order checks). Only cash may be
 * handed over above its amount (the excess is change); transfer and card are capped at what is still owed.
 */
export function settle(total: number, rows: PayRow[]): Settlement {
  const problems: string[] = []
  let paid = 0
  let received = 0
  let change = 0
  let nonCash = 0
  const payments: PaymentInput[] = []
  const from: number[] = []
  rows.forEach((r, i) => {
    if (!Number.isInteger(r.amount) || r.amount <= 0) {
      problems.push(`${METHOD_LABEL[r.method]}: nhập số tiền`)
      return
    }
    if (r.method === 'cash') {
      const tendered = r.tendered ?? r.amount
      if (!Number.isInteger(tendered) || tendered < 0) {
        problems.push('Tiền khách đưa không hợp lệ')
        return
      }
      const applied = Math.min(tendered, r.amount)
      if (applied <= 0) return
      paid += applied
      received += tendered
      change += tendered - applied
      payments.push(tendered > applied ? { method: 'cash', amount: applied, tendered } : { method: 'cash', amount: applied })
      from.push(i)
    } else {
      if (!r.confirmed) {
        problems.push(r.method === 'bank' ? 'Chờ xác nhận tiền chuyển khoản' : 'Chờ xác nhận cà thẻ')
        return
      }
      paid += r.amount
      received += r.amount
      nonCash += r.amount
      payments.push({ method: r.method, amount: r.amount })
      from.push(i)
    }
  })
  if (nonCash > total) problems.push('Chuyển khoản và thẻ không được vượt số phải thu')
  else if (paid > total) problems.push(`Thu thừa ${formatVnd(paid - total)}: giảm số tiền một dòng`)
  const remaining = Math.max(0, total - paid)
  if (remaining > 0) problems.push(`Còn phải thu ${formatVnd(remaining)}`)
  return { total, paid, remaining, received, change, payments, from, problems, canSettle: total >= 0 && problems.length === 0 && paid === total && (payments.length > 0 || total === 0) }
}

/** Tiền thối: what goes back to the guest for one cash payment (0 when short). */
export function changeDue(due: number, tendered: number): number {
  return Math.max(0, tendered - due)
}

/** Quick cash buttons after "Đủ tiền": the nearest round amounts above, e.g. 436.000đ → 440.000, 450.000, 500.000. */
export function quickCash(due: number, count = 3): number[] {
  if (due <= 0) return []
  const out = new Set<number>()
  for (const unit of [10000, 50000, 100000, 200000, 500000, 1000000]) {
    const v = Math.ceil(due / unit) * unit
    if (v > due) out.add(v)
  }
  return [...out].sort((a, b) => a - b).slice(0, count)
}

/**
 * Chia đều: total ÷ n, each share rounded up to `unit`, the last one takes what is left
 * (1.274.000đ / 3 → 425.000 + 425.000 + 424.000). Falls back to exact shares when rounding would leave nothing.
 */
export function splitEven(total: number, n: number, unit = 1000): number[] {
  if (!Number.isInteger(n) || n < 1) throw new RangeError(`Số người không hợp lệ: ${n}`)
  if (n === 1) return [total]
  const share = Math.ceil(total / n / unit) * unit
  const last = total - share * (n - 1)
  if (last > 0) return [...Array.from({ length: n - 1 }, () => share), last]
  const base = Math.floor(total / n)
  return Array.from({ length: n }, (_, i) => base + (i < total - base * n ? 1 : 0))
}

/** Money without the đ, for receipt columns: 1274000 → "1.274.000", −3000 → "-3.000". */
export function formatMoney(n: number): string {
  const v = Math.round(n)
  const s = String(Math.abs(v)).replace(/\B(?=(\d{3})+(?!\d))/g, '.')
  return (v < 0 ? '-' : '') + s
}
