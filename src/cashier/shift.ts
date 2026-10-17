// Shift (ca thu ngân) totals. Pure; the same sums run in SQL (shift_summary in 0005_cashier.sql): keep both in step.

import type { PayMethod } from '../lib/billing'
import type { Bill, Shift } from '../floor/types'

/** Vietnamese notes a cashier counts at close (coins are not in use). */
export const DENOMINATIONS = [500000, 200000, 100000, 50000, 20000, 10000, 5000, 2000, 1000] as const

export interface ShiftSummary {
  bills: number
  /** Tiền hàng before bill discounts. */
  subtotal: number
  discount: number
  serviceCharge: number
  rounding: number
  /** Sum of bill totals (doanh thu thu được). */
  sales: number
  vatTotal: number
  byMethod: Record<PayMethod, number>
  /** Cash handed over by guests, and what went back as change (for information). */
  cashTendered: number
  changeGiven: number
  openingFloat: number
  /** Opening float + cash taken. */
  expectedCash: number
}

export function shiftBills(bills: Bill[], shiftId: string): Bill[] {
  return bills.filter(b => b.shiftId === shiftId)
}

export function shiftSummary(shift: Pick<Shift, 'id' | 'openingFloat'>, bills: Bill[]): ShiftSummary {
  const mine = shiftBills(bills, shift.id)
  const byMethod: Record<PayMethod, number> = { cash: 0, bank: 0, card: 0 }
  let cashTendered = 0
  let changeGiven = 0
  for (const b of mine) {
    for (const p of b.payments) {
      byMethod[p.method] += p.amount
      if (p.method === 'cash') {
        const t = p.tendered ?? p.amount
        cashTendered += t
        changeGiven += t - p.amount
      }
    }
  }
  const sum = (f: (b: Bill) => number) => mine.reduce((s, b) => s + f(b), 0)
  return {
    bills: mine.length,
    subtotal: sum(b => b.subtotal),
    discount: sum(b => b.discount),
    serviceCharge: sum(b => b.serviceCharge),
    rounding: sum(b => b.rounding),
    sales: sum(b => b.total),
    vatTotal: sum(b => b.vatTotal),
    byMethod,
    cashTendered,
    changeGiven,
    openingFloat: shift.openingFloat,
    expectedCash: shift.openingFloat + byMethod.cash,
  }
}

/** Total of a count by note: { "500000": 3, "10000": 2 } → 1.520.000. Unknown notes and bad counts are refused. */
export function countedTotal(detail: Record<string, number>): number {
  let total = 0
  for (const [note, count] of Object.entries(detail)) {
    const v = Number(note)
    if (!(DENOMINATIONS as readonly number[]).includes(v)) throw new RangeError(`Mệnh giá không hợp lệ: ${note}`)
    if (!Number.isInteger(count) || count < 0) throw new RangeError(`Số tờ không hợp lệ: ${count}`)
    total += v * count
  }
  return total
}

export function openShiftOf(shifts: Shift[], register: string): Shift | null {
  return shifts.find(s => s.register === register && !s.closedAt) ?? null
}
