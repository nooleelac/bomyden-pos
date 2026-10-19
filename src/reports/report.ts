// Hoá đơn and Doanh thu: pure sums over the bills of a date range. Days are business days: a bill paid at 01:30
// before the shop's day start (06:00) counts for the day before, like the takeaway numbers and "Hết hôm nay".

import type { PayMethod } from '../lib/billing'
import type { Bill, BillHistory } from '../floor/types'

const pad = (n: number) => String(n).padStart(2, '0')
const minutesOf = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number)
  return (h || 0) * 60 + (m || 0)
}
const dayKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

/** Business day of a time, "YYYY-MM-DD" (device time zone). */
export function businessDay(at: string | Date, dayStart = '06:00'): string {
  const d = new Date(typeof at === 'string' ? at : at.getTime())
  d.setMinutes(d.getMinutes() - minutesOf(dayStart))
  return dayKey(d)
}

/** "YYYY-MM-DD" plus n days. */
export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number)
  return dayKey(new Date(y, m - 1, d + n))
}

/** Times covering business days `fromDay`…`toDay` (both included): [from, to). */
export function dayRange(fromDay: string, toDay: string, dayStart = '06:00'): { from: string; to: string } {
  const at = (day: string) => {
    const [y, m, d] = day.split('-').map(Number)
    return new Date(y, m - 1, d, 0, minutesOf(dayStart)).toISOString()
  }
  return { from: at(fromDay), to: at(addDays(toDay, 1)) }
}

export type Preset = 'today' | 'yesterday' | 'week' | 'month' | 'lastMonth'
export const PRESET_LABEL: Record<Preset, string> = {
  today: 'Hôm nay',
  yesterday: 'Hôm qua',
  week: '7 ngày',
  month: 'Tháng này',
  lastMonth: 'Tháng trước',
}

/** First and last business day of a preset. */
export function presetDays(p: Preset, now: Date, dayStart = '06:00'): { fromDay: string; toDay: string } {
  const today = businessDay(now, dayStart)
  const [y, m] = today.split('-').map(Number)
  switch (p) {
    case 'today':
      return { fromDay: today, toDay: today }
    case 'yesterday':
      return { fromDay: addDays(today, -1), toDay: addDays(today, -1) }
    case 'week':
      return { fromDay: addDays(today, -6), toDay: today }
    case 'month':
      return { fromDay: `${y}-${pad(m)}-01`, toDay: today }
    case 'lastMonth':
      return { fromDay: dayKey(new Date(y, m - 2, 1)), toDay: dayKey(new Date(y, m - 1, 0)) }
  }
}

/** "18/10" or "18/10/2026". */
export function dayLabel(day: string, withYear = false): string {
  const [y, m, d] = day.split('-')
  return withYear ? `${d}/${m}/${y}` : `${d}/${m}`
}

const WEEKDAY = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7']
export function weekday(day: string): string {
  const [y, m, d] = day.split('-').map(Number)
  return WEEKDAY[new Date(y, m - 1, d).getDay()]
}

export const methodsOf = (b: Bill): PayMethod[] => [...new Set(b.payments.map(p => p.method))]

export interface BillFilter {
  text: string
  method: PayMethod | ''
}

/** Search by bill number, table or cashier; filter by a payment method used on the bill. */
export function filterBills(bills: Bill[], f: BillFilter): Bill[] {
  const q = f.text.trim().toLowerCase()
  return bills.filter(
    b =>
      (!f.method || b.payments.some(p => p.method === f.method)) &&
      (!q || b.billNo.toLowerCase().includes(q) || b.tableLabel.toLowerCase().includes(q) || b.cashier.toLowerCase().includes(q)),
  )
}

export interface DayRow {
  day: string
  bills: number
  sales: number
}

export interface ItemRow {
  name: string
  qty: number
  amount: number
}

export interface Revenue {
  bills: number
  /** Sum of bill totals: what was collected. */
  sales: number
  subtotal: number
  discount: number
  serviceCharge: number
  vatTotal: number
  rounding: number
  average: number
  byMethod: Record<PayMethod, number>
  /** Every business day of the range, empty ones included. */
  byDay: DayRow[]
  /** Clock hour 0–23 of payment. */
  byHour: number[]
  byCashier: { name: string; bills: number; sales: number }[]
  /** Dishes by name and size, most money first. */
  items: ItemRow[]
}

export function revenue(h: BillHistory, fromDay: string, toDay: string, dayStart = '06:00'): Revenue {
  const byMethod: Record<PayMethod, number> = { cash: 0, bank: 0, card: 0 }
  const days = new Map<string, DayRow>()
  for (let d = fromDay; d <= toDay; d = addDays(d, 1)) days.set(d, { day: d, bills: 0, sales: 0 })
  const byHour = Array<number>(24).fill(0)
  const cashiers = new Map<string, { name: string; bills: number; sales: number }>()
  const sum = (f: (b: Bill) => number) => h.bills.reduce((t, b) => t + f(b), 0)

  for (const b of h.bills) {
    for (const p of b.payments) byMethod[p.method] += p.amount
    const day = businessDay(b.paidAt, dayStart)
    const row = days.get(day) ?? { day, bills: 0, sales: 0 }
    row.bills++
    row.sales += b.total
    days.set(day, row)
    byHour[new Date(b.paidAt).getHours()] += b.total
    const who = b.cashier || '—'
    const c = cashiers.get(who) ?? { name: who, bills: 0, sales: 0 }
    c.bills++
    c.sales += b.total
    cashiers.set(who, c)
  }

  const items = new Map<string, ItemRow>()
  for (const l of h.lines) {
    const name = l.variantName ? `${l.name} (${l.variantName})` : l.name
    const r = items.get(name) ?? { name, qty: 0, amount: 0 }
    r.qty += l.qty
    r.amount += l.amount
    items.set(name, r)
  }

  const sales = sum(b => b.total)
  return {
    bills: h.bills.length,
    sales,
    subtotal: sum(b => b.subtotal),
    discount: sum(b => b.discount),
    serviceCharge: sum(b => b.serviceCharge),
    vatTotal: sum(b => b.vatTotal),
    rounding: sum(b => b.rounding),
    average: h.bills.length ? Math.round(sales / h.bills.length) : 0,
    byMethod,
    byDay: [...days.values()].sort((a, b) => a.day.localeCompare(b.day)),
    byHour,
    byCashier: [...cashiers.values()].sort((a, b) => b.sales - a.sales),
    items: [...items.values()].sort((a, b) => b.amount - a.amount || b.qty - a.qty),
  }
}

/** "1,2 tr", "850 k": short money for chart labels. */
export function shortVnd(n: number): string {
  if (n >= 1_000_000_000) return (n / 1_000_000_000).toLocaleString('vi-VN', { maximumFractionDigits: 1 }) + ' tỷ'
  if (n >= 1_000_000) return (n / 1_000_000).toLocaleString('vi-VN', { maximumFractionDigits: 1 }) + ' tr'
  if (n >= 1000) return Math.round(n / 1000).toLocaleString('vi-VN') + ' k'
  return String(n)
}
