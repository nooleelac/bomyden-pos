import { describe, expect, it } from 'vitest'
import { canOpen, manageFor } from '../auth/guards'
import { seedMenu } from '../menu/seed'
import { sampleBillHistory } from '../floor/seed'
import type { Bill } from '../floor/types'
import { addDays, businessDay, dayRange, filterBills, presetDays, revenue } from './report'

const at = (y: number, m: number, d: number, h: number, min = 0) => new Date(y, m - 1, d, h, min).toISOString()
const bill = (id: string, paidAt: string, total: number, method: 'cash' | 'bank' | 'card' = 'cash'): Bill => ({
  id, orderId: 'o-' + id, billNo: 'HD' + id, tableLabel: 'Bàn 3', subtotal: total, discount: 0, discountReason: '', serviceCharge: 0, vatAdded: 0,
  vatTotal: 0, rounding: 0, total, vatLines: [], payments: [{ id: 'p' + id, method, amount: total, tendered: null, ref: '', receivedBy: 'Lan', receivedAt: paidAt }],
  cashier: 'Lan', paidAt, shiftId: null, printCount: 1, lastPrintAt: paidAt, lastPrintBy: 'Lan',
})

describe('business days', () => {
  it('a bill paid before the day start counts for the day before', () => {
    expect(businessDay(at(2026, 10, 18, 1, 30), '06:00')).toBe('2026-10-17')
    expect(businessDay(at(2026, 10, 18, 6, 0), '06:00')).toBe('2026-10-18')
  })
  it('ranges run from day start to the next day start', () => {
    const r = dayRange('2026-10-17', '2026-10-18', '06:00')
    expect(r.from).toBe(at(2026, 10, 17, 6))
    expect(r.to).toBe(at(2026, 10, 19, 6))
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01')
  })
  it('presets', () => {
    const now = new Date(2026, 9, 18, 12)
    expect(presetDays('week', now)).toEqual({ fromDay: '2026-10-12', toDay: '2026-10-18' })
    expect(presetDays('month', now)).toEqual({ fromDay: '2026-10-01', toDay: '2026-10-18' })
    expect(presetDays('lastMonth', now)).toEqual({ fromDay: '2026-09-01', toDay: '2026-09-30' })
  })
})

describe('revenue', () => {
  const bills = [bill('1', at(2026, 10, 17, 19), 500000, 'cash'), bill('2', at(2026, 10, 18, 1), 300000, 'bank'), bill('3', at(2026, 10, 18, 12), 200000, 'card')]
  const lines = [
    { orderId: 'o-1', name: 'Bia Tiger', variantName: '', qty: 6, amount: 120000 },
    { orderId: 'o-3', name: 'Bia Tiger', variantName: '', qty: 2, amount: 40000 },
    { orderId: 'o-2', name: 'Bò bít tết', variantName: '300g', qty: 1, amount: 300000 },
  ]
  it('sums by business day, method, hour and dish', () => {
    const r = revenue({ bills, lines }, '2026-10-17', '2026-10-18')
    expect(r.sales).toBe(1000000)
    expect(r.average).toBe(333333)
    expect(r.byDay).toEqual([
      { day: '2026-10-17', bills: 2, sales: 800000 },
      { day: '2026-10-18', bills: 1, sales: 200000 },
    ])
    expect(r.byMethod).toEqual({ cash: 500000, bank: 300000, card: 200000 })
    expect(r.byHour[19]).toBe(500000)
    expect(r.items[0]).toEqual({ name: 'Bò bít tết (300g)', qty: 1, amount: 300000 })
    expect(r.items[1]).toEqual({ name: 'Bia Tiger', qty: 8, amount: 160000 })
  })
  it('filters bills by text and method', () => {
    expect(filterBills(bills, { text: 'hd2', method: '' }).map(b => b.id)).toEqual(['2'])
    expect(filterBills(bills, { text: '', method: 'card' }).map(b => b.id)).toEqual(['3'])
  })
  it('sample history adds up', () => {
    const h = sampleBillHistory(seedMenu(), new Date(2026, 9, 18, 12), 10)
    expect(h.bills.length).toBeGreaterThan(50)
    for (const b of h.bills) expect(b.payments.reduce((t, p) => t + p.amount, 0)).toBe(b.total)
  })
})

describe('Quản lý in the menu', () => {
  it('owner and manager see both; cashier sees bills only; waiter and kitchen see none', () => {
    expect(manageFor('owner').map(i => i.href)).toEqual(['#/hoa-don', '#/doanh-thu'])
    expect(manageFor('manager').map(i => i.href)).toEqual(['#/hoa-don', '#/doanh-thu'])
    expect(manageFor('cashier').map(i => i.href)).toEqual(['#/hoa-don'])
    expect(manageFor('waiter')).toEqual([])
    expect(manageFor('kitchen')).toEqual([])
    expect(canOpen('cashier', ['doanh-thu'])).toBe(false)
  })
})
