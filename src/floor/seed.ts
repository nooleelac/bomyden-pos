// Sample floor so the screens run before Supabase is connected: 3 areas, 24 tables, a few open orders.
// Table counts, seats and timings are examples; the shop sets its own.

import { SAMPLE_SHOP } from '../cashier/config'
import type { Menu } from '../menu/types'
import { addSharedOrder, openShift, openTable, payOrder, printBill, quoteBill, requestBill, sendLines, setLineStatus, setPartStatus, type Ctx } from './engine'
import type { Area, Bill, BillHistory, FloorState, SoldLine, Table } from './types'

export function seedFloor(): FloorState {
  const areas: Area[] = [
    { id: 'a-1', name: 'Tầng 1', sort: 1, active: true },
    { id: 'a-2', name: 'Tầng 2', sort: 2, active: true },
    { id: 'a-out', name: 'Ngoài trời', sort: 3, active: true },
  ]
  const t = (n: number, areaId: string, seats = 4): Table => ({
    id: `t-${n}`, areaId, name: String(n), seats, sort: n, active: true, temporary: false,
  })
  const tables = [
    ...Array.from({ length: 12 }, (_, i) => t(i + 1, 'a-1', i % 4 === 3 ? 6 : 4)),
    ...Array.from({ length: 8 }, (_, i) => t(i + 13, 'a-2', 6)),
    ...Array.from({ length: 4 }, (_, i) => t(i + 21, 'a-out', 4)),
  ]
  return {
    sample: true,
    settings: {
      maxOrdersPerTable: 4,
      maxMergeTables: 30,
      waiterSeesAmounts: false,
      businessDayStart: '06:00',
      voidApproval: 'sent',
      // Example thresholds (minutes): Bar 5/10, Bếp lẩu 7/12, Bếp nướng 12/20.
      timing: { 'st-grill': { warn: 12, late: 20 }, 'st-hotpot': { warn: 7, late: 12 }, 'st-bar': { warn: 5, late: 10 } },
    },
    areas,
    tables,
    orders: [],
    lines: [],
    notices: [],
    tickets: [],
    bills: [],
    shifts: [],
    shop: structuredClone(SAMPLE_SHOP),
  }
}

/** A busy evening: Bàn 3 eating, Bàn 5 shared by two parties (5-A, 5-B), Bàn 9 waiting for the bill. */
export function sampleEvening(menu: Menu, now = new Date()): FloorState {
  let n = 0
  const ctx = (minutesAgo: number, role: Ctx['actor']['role'] = 'waiter'): Ctx => ({
    now: new Date(now.getTime() - minutesAgo * 60_000),
    actor: { name: role === 'kitchen' ? 'Bếp' : role === 'cashier' ? 'Lan' : 'Hùng', role },
    menu,
    newId: () => `s-${++n}`,
  })
  let s = seedFloor()
  // Lan opened the register at the start of the evening with 2.000.000đ in small notes (example amount).
  s = openShift(s, { openingFloat: 2000000 }, ctx(240, 'cashier')).state
  const open = (tableId: string, guests: number, ago: number) => {
    const r = openTable(s, { tableId, guestCount: guests }, ctx(ago))
    s = r.state
    return r.orderId
  }
  const send = (orderId: string, ago: number, lines: Parameters<typeof sendLines>[2]) => {
    const r = sendLines(s, orderId, lines, `batch-${++n}`, {}, ctx(ago))
    s = r.state
    return r.lineIds
  }
  /** Side parts (salad, bánh mì at Quầy rau) of these lines. */
  const parts = (ids: string[]) => s.lines.filter(l => ids.includes(l.id)).flatMap(l => l.sideParts.map(p => ({ lineId: l.id, stationId: p.stationId })))
  const o3 = open('t-3', 6, 52)
  send(o3, 48, [
    { menu_item_id: 'i-hotpot', qty: 1, options: [], removals: [] },
    { menu_item_id: 'i-tiger', qty: 6, options: [], removals: [] },
  ])
  const ba = send(o3, 9, [{ menu_item_id: 'i-ba-chi', qty: 2, options: [], removals: [] }])
  s = setLineStatus(s, ba, 'cooking', ctx(6, 'kitchen'))

  const o5 = open('t-5', 2, 35)
  send(o5, 30, [{ menu_item_id: 'i-lalot', qty: 1, options: [], removals: [] }])
  const r5 = addSharedOrder(s, { tableId: 't-5', guestCount: 2, positionLabel: '2 khách áo xanh', existingLabels: { [o5]: 'đầu bàn' } }, ctx(14))
  s = r5.state
  const l5 = send(r5.orderId, 13, [
    { menu_item_id: 'i-steak', variant_id: 'v-300', qty: 1, options: [{ option_id: 'o-m' }, { option_id: 'o-pepper' }], removals: ['k-egg'] },
    { menu_item_id: 'i-coca', qty: 2, options: [], removals: [] },
  ])
  // the cold counter has the salad, bánh mì and sốt ready; the steak is still on the grill
  s = setPartStatus(s, parts(l5), 'ready', ctx(9, 'kitchen'))

  const o9 = open('t-9', 4, 75)
  const l9 = send(o9, 70, [
    { menu_item_id: 'i-ribeye', variant_id: 'v-rb-250', qty: 2, options: [{ option_id: 'o-mr' }], removals: [] },
    { menu_item_id: 'i-tiger', qty: 4, options: [], removals: [] },
  ])
  s = setLineStatus(s, l9, 'ready', ctx(55, 'kitchen'))
  s = setLineStatus(s, l9, 'served', ctx(54))
  s = requestBill(s, o9, ctx(4))

  // Bàn 11 already paid: transfer 300.000đ + the rest in cash (guest handed over 500.000đ).
  const o11 = open('t-11', 2, 130)
  const l11 = send(o11, 125, [
    { menu_item_id: 'i-steak', variant_id: 'v-200', qty: 1, options: [{ option_id: 'o-mr' }, { option_id: 'o-pepper' }], removals: ['k-egg'] },
    { menu_item_id: 'i-lalot', qty: 1, options: [], removals: [] },
    { menu_item_id: 'i-tiger', qty: 3, options: [], removals: [] },
  ])
  s = setPartStatus(s, parts(l11), 'ready', ctx(118, 'kitchen'))
  s = setPartStatus(s, parts(l11), 'served', ctx(117))
  s = setLineStatus(s, l11, 'ready', ctx(110, 'kitchen'))
  s = setLineStatus(s, l11, 'served', ctx(109))
  const total11 = quoteBill(s, o11).total
  const paid = payOrder(s, o11, { payments: [{ method: 'bank', amount: 300000 }, { method: 'cash', amount: total11 - 300000, tendered: 500000 }] }, ctx(62, 'cashier'))
  s = printBill(paid.state, paid.billId, ctx(62, 'cashier')).state
  return s
}

/**
 * Bills of the 45 days before today for Hoá đơn and Doanh thu on sample data (the sample evening holds today's).
 * Same every time for the same day; dishes and prices come from the sample menu, so amounts are examples only.
 */
export function sampleBillHistory(menu: Menu, now = new Date(), days = 45): BillHistory {
  let seed = Math.floor(now.getTime() / 86_400_000)
  const rnd = () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const pick = <T,>(xs: T[]) => xs[Math.floor(rnd() * xs.length)]
  const dishes = menu.items
    .filter(i => i.status === 'active')
    .flatMap(i => (i.hasSizes ? i.variants.filter(v => !v.archivedAt).map(v => ({ name: i.name, variantName: v.name, price: v.price })) : [{ name: i.name, variantName: '', price: i.price }]))
    .filter(d => d.price > 0)
  const bills: Bill[] = []
  const lines: SoldLine[] = []
  let no = 0
  for (let back = days; back >= 1; back--) {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() - back)
    const weekend = day.getDay() === 0 || day.getDay() === 5 || day.getDay() === 6
    const count = Math.floor((weekend ? 18 : 10) + rnd() * 10)
    for (let k = 0; k < count; k++) {
      const orderId = `h-${++no}`
      // lunch 11:00–13:30 for a third of the bills, the rest in the evening 17:30–23:00
      const minute = rnd() < 0.33 ? 660 + rnd() * 150 : 1050 + rnd() * 330
      const paidAt = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, Math.floor(minute)).toISOString()
      let subtotal = 0
      const n = 2 + Math.floor(rnd() * 4)
      for (let j = 0; j < n; j++) {
        const d = pick(dishes)
        const qty = 1 + Math.floor(rnd() * 3)
        subtotal += d.price * qty
        lines.push({ orderId, name: d.name, variantName: d.variantName, qty, amount: d.price * qty })
      }
      const discount = rnd() < 0.08 ? Math.round(subtotal / 10 / 1000) * 1000 : 0
      const raw = subtotal - discount
      const total = Math.floor(raw / 1000) * 1000
      const vat = Math.round((raw * 8) / 108)
      const r = rnd()
      const method = r < 0.5 ? 'cash' : r < 0.9 ? 'bank' : 'card'
      const cashier = rnd() < 0.6 ? 'Lan' : 'Minh'
      bills.push({
        id: orderId, orderId, billNo: 'HDM' + String(no).padStart(5, '0'),
        tableLabel: rnd() < 0.12 ? `MV-${String(1 + Math.floor(rnd() * 20)).padStart(2, '0')}` : String(1 + Math.floor(rnd() * 24)),
        subtotal, discount, discountReason: discount ? 'Khách quen' : '', serviceCharge: 0, vatAdded: 0, vatTotal: vat, rounding: total - raw, total,
        vatLines: [{ vatRate: 8, priceIncludesVat: true, base: raw - vat, vat }],
        payments: [{ id: `${orderId}-p`, method, amount: total, tendered: null, ref: '', receivedBy: cashier, receivedAt: paidAt }],
        cashier, paidAt, shiftId: null, printCount: 1, lastPrintAt: paidAt, lastPrintBy: cashier,
      })
    }
  }
  return { bills, lines }
}
