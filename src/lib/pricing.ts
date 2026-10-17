// Line and bill pricing. Pure functions, whole VND only.
// The same rules run on the server (send_order_lines / calc_bill in 0002_menu_and_tables.sql);
// keep both in step so the pre-bill on screen always equals the printed bill.

import { discountAmount, subtotal, type BillLine, type Discount } from './billing'

// ---------------------------------------------------------------- one line

export type ModifierKind = 'option' | 'addon' | 'removal'

export interface LineModifier {
  kind: ModifierKind
  /** Option / add-on surcharge, or the removal discount. Always >= 0; removals are subtracted. */
  amount: number
  /** Units per portion (e.g. 2 extra eggs on each steak). Default 1. */
  qty?: number
}

export interface LineInput {
  /** Size price, or the item price when the item has no sizes. */
  basePrice: number
  /** Portions on this line. */
  qty: number
  modifiers?: LineModifier[]
}

function assertVnd(n: number, what: string): void {
  if (!Number.isSafeInteger(n) || n < 0) throw new RangeError(`${what} phải là số đồng nguyên không âm: ${n}`)
}

/** Signed price change per portion for one modifier. */
export function modifierDelta(m: LineModifier): number {
  assertVnd(m.amount, 'Giá tuỳ chọn')
  const q = m.qty ?? 1
  if (!Number.isInteger(q) || q < 1) throw new RangeError(`Số lượng tuỳ chọn không hợp lệ: ${q}`)
  return (m.kind === 'removal' ? -m.amount : m.amount) * q
}

/** Price of one portion: base + options + add-ons − removed components, never below 0. */
export function unitPrice(line: Omit<LineInput, 'qty'>): number {
  assertVnd(line.basePrice, 'Giá món')
  const delta = (line.modifiers ?? []).reduce((s, m) => s + modifierDelta(m), 0)
  return Math.max(0, line.basePrice + delta)
}

/** Line amount = unit price × portions. */
export function linePrice(line: LineInput): number {
  if (!Number.isInteger(line.qty) || line.qty < 1) throw new RangeError(`Số phần không hợp lệ: ${line.qty}`)
  return unitPrice(line) * line.qty
}

// ---------------------------------------------------------------- whole bill

export type RoundingMode = 'down' | 'nearest'

/** A sent line as stored on order_items: locked unit price plus the tax flags snapshotted at send. */
export interface TaxedLine extends BillLine {
  /** VAT percent: 0, 5, 8 or 10. */
  vatRate: number
  /** Default true: menu prices already include VAT. */
  priceIncludesVat?: boolean
  /** Default true: a bill-level discount may reduce this line. */
  discountable?: boolean
  /** Default true: counts toward the service charge (only when the shop sets one). */
  serviceCharge?: boolean
}

export interface BillOptions {
  discount?: Discount | null
  /** Whole percent, default 0 (no service charge). */
  serviceChargePct?: number
  roundingMode?: RoundingMode
  roundingUnit?: number
}

export interface VatGroup {
  vatRate: number
  priceIncludesVat: boolean
  /** Amount before VAT ("thành tiền chưa thuế"). */
  base: number
  vat: number
}

export interface BillTotals {
  subtotal: number
  /** Sum of discountable lines: the cap and the base for a % discount. */
  discountBase: number
  discount: number
  serviceCharge: number
  /** VAT added on top for lines priced without VAT (0 when every price includes VAT). */
  vatAdded: number
  /** All VAT on the bill: included + added. */
  vatTotal: number
  /** Signed: total − amount before rounding. */
  rounding: number
  total: number
  vat: VatGroup[]
}

/** Integer a / b rounded half up, for a >= 0 and b > 0. */
export function roundDiv(a: number, b: number): number {
  return Math.floor((2 * a + b) / (2 * b))
}

export function roundTotal(amount: number, mode: RoundingMode = 'down', unit = 1000): number {
  if (!Number.isInteger(unit) || unit < 1) throw new RangeError(`Đơn vị làm tròn không hợp lệ: ${unit}`)
  return (mode === 'down' ? Math.floor(amount / unit) : roundDiv(amount, unit)) * unit
}

/**
 * Split `amount` across `weights` in proportion, largest remainder first, so the parts add up exactly.
 * Ties go to the earlier weight, so callers pass weights in a fixed order.
 */
export function allocate(amount: number, weights: number[]): number[] {
  const total = weights.reduce((s, w) => s + w, 0)
  if (amount === 0 || total <= 0) return weights.map(() => 0)
  const sign = amount < 0 ? -1 : 1
  const a = BigInt(Math.abs(amount))
  const W = BigInt(total)
  const parts = weights.map((w, i) => ({ i, floor: (a * BigInt(w)) / W, rem: (a * BigInt(w)) % W }))
  let left = a - parts.reduce((s, p) => s + p.floor, 0n)
  const byRem = [...parts].sort((x, y) => (x.rem === y.rem ? x.i - y.i : x.rem > y.rem ? -1 : 1))
  for (const p of byRem) {
    if (left <= 0n) break
    p.floor += 1n
    left -= 1n
  }
  return parts.map(p => sign * Number(p.floor))
}

interface Bucket {
  vatRate: number
  incl: boolean
  sc: boolean
  disc: boolean
  amount: number
}

// rate ascending, VAT-included first, service-charge lines first: the server uses the same order to break ties.
const bucketOrder = (a: Bucket, b: Bucket) =>
  a.vatRate - b.vatRate || Number(b.incl) - Number(a.incl) || Number(b.sc) - Number(a.sc) || Number(b.disc) - Number(a.disc)

/**
 * Bill totals in the fixed order: line amounts → subtotal → bill discount (spread over discountable lines)
 * → service charge → VAT per rate → round the grand total once.
 * VAT-included prices (the shop default): VAT is taken out of what the guest finally pays, so the rounding
 * is spread over the rates first ("trong đó thuế GTGT 8%: 32.296đ" on 436.000đ).
 * Any VAT-excluded line on the bill: VAT is added on top and the rounding stays a separate line.
 */
export function billTotals(lines: TaxedLine[], opts: BillOptions = {}): BillTotals {
  const pct = opts.serviceChargePct ?? 0
  if (!Number.isInteger(pct) || pct < 0 || pct > 100) throw new RangeError(`Phí phục vụ không hợp lệ: ${pct}`)
  const live = lines.filter(l => !l.void)
  for (const l of live) {
    assertVnd(l.price, 'Đơn giá')
    if (!Number.isInteger(l.vatRate) || l.vatRate < 0 || l.vatRate > 100) throw new RangeError(`Thuế suất không hợp lệ: ${l.vatRate}`)
  }

  // 1. Buckets of lines that are taxed and discounted the same way.
  const buckets: Bucket[] = []
  for (const l of live) {
    const key = { vatRate: l.vatRate, incl: l.priceIncludesVat ?? true, sc: l.serviceCharge ?? true, disc: l.discountable ?? true }
    const b = buckets.find(x => x.vatRate === key.vatRate && x.incl === key.incl && x.sc === key.sc && x.disc === key.disc)
    if (b) b.amount += l.price * l.qty
    else buckets.push({ ...key, amount: l.price * l.qty })
  }
  buckets.sort(bucketOrder)

  // 2. Bill discount, capped at the discountable lines and spread over them.
  const sub = subtotal(live)
  const discBuckets = buckets.filter(b => b.disc)
  const discountBase = discBuckets.reduce((s, b) => s + b.amount, 0)
  const discount = discountAmount(discountBase, opts.discount ?? null)
  const discAlloc = allocate(discount, discBuckets.map(b => b.amount))
  const net = new Map<Bucket, number>(buckets.map(b => [b, b.amount]))
  discBuckets.forEach((b, i) => net.set(b, b.amount - discAlloc[i]))

  // 3. Per VAT rate: service charge, then VAT added on top for VAT-excluded prices.
  type Group = { vatRate: number; incl: boolean; gross: number; sc: number; vat: number }
  const groups: Group[] = []
  for (const b of buckets) {
    let g = groups.find(x => x.vatRate === b.vatRate && x.incl === b.incl)
    if (!g) groups.push((g = { vatRate: b.vatRate, incl: b.incl, gross: 0, sc: 0, vat: 0 }))
    g.gross += net.get(b)!
    if (b.sc) g.sc += net.get(b)!
  }
  let serviceCharge = 0
  for (const g of groups) {
    const charge = roundDiv(g.sc * pct, 100)
    g.gross += charge
    serviceCharge += charge
    if (!g.incl) g.vat = roundDiv(g.gross * g.vatRate, 100)
  }
  const vatAdded = groups.reduce((s, g) => s + g.vat, 0)

  // 4. Round the grand total once. On an all-VAT-included bill the rates absorb the rounding before VAT is
  //    taken out; with any VAT-excluded line the rounding stays apart (it could exceed a small included rate).
  const before = groups.reduce((s, g) => s + g.gross + g.vat, 0)
  const total = roundTotal(before, opts.roundingMode, opts.roundingUnit)
  const rounding = total - before
  const absorb = groups.every(g => g.incl)
  const roundAlloc = absorb ? allocate(rounding, groups.map(g => g.gross)) : groups.map(() => 0)
  groups.forEach((g, i) => {
    if (!g.incl) return
    g.gross += roundAlloc[i]
    g.vat = roundDiv(g.gross * g.vatRate, 100 + g.vatRate)
  })

  const vat: VatGroup[] = groups.map(g => ({
    vatRate: g.vatRate,
    priceIncludesVat: g.incl,
    base: g.incl ? g.gross - g.vat : g.gross,
    vat: g.vat,
  }))
  return {
    subtotal: sub,
    discountBase,
    discount,
    serviceCharge,
    vatAdded,
    vatTotal: vat.reduce((s, g) => s + g.vat, 0),
    rounding,
    total,
    vat,
  }
}

// ---------------------------------------------------------------- VAT rate by date (mirror of vat_rates in 0002)

/**
 * Food and drinks 8% until 31/12/2026 (NQ 204/2025/QH15), 10% from 1/1/2027 unless extended; beer and alcohol 10%.
 * Same rows as `insert into vat_rates` in 0002_menu_and_tables.sql. The shop's accountant confirms the rates.
 */
export const VAT_RATES: { group: string; from: string; rate: number }[] = [
  { group: 'food', from: '2025-01-01', rate: 8 },
  { group: 'food', from: '2027-01-01', rate: 10 },
  { group: 'alcohol', from: '2025-01-01', rate: 10 },
]

/** Vietnam calendar day (UTC+7) of an instant, as YYYY-MM-DD. */
export function vnDay(at: Date): string {
  return new Date(at.getTime() + 7 * 3600_000).toISOString().slice(0, 10)
}

/** Rate in force for a VAT group on the Vietnam day of `at` (vat_rate_on in SQL); null for an unknown group. */
export function vatRateOn(group: string, at: Date): number | null {
  const day = vnDay(at)
  const rows = VAT_RATES.filter(r => r.group === group && r.from <= day).sort((a, b) => a.from.localeCompare(b.from))
  return rows.length ? rows[rows.length - 1].rate : null
}
