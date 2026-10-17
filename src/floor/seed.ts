// Sample floor so the screens run before Supabase is connected: 3 areas, 24 tables, a few open orders.
// Table counts, seats and timings are examples; the shop sets its own.

import { SAMPLE_SHOP } from '../cashier/config'
import type { Menu } from '../menu/types'
import { addSharedOrder, markClean, openShift, openTable, payOrder, printBill, quoteBill, requestBill, sendLines, setLineStatus, type Ctx } from './engine'
import type { Area, FloorState, Table } from './types'

export function seedFloor(): FloorState {
  const areas: Area[] = [
    { id: 'a-1', name: 'Tầng 1', sort: 1, active: true },
    { id: 'a-2', name: 'Tầng 2', sort: 2, active: true },
    { id: 'a-out', name: 'Ngoài trời', sort: 3, active: true },
  ]
  const t = (n: number, areaId: string, seats = 4): Table => ({
    id: `t-${n}`, areaId, name: String(n), seats, sort: n, active: true, temporary: false, needsCleaning: false,
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
      requireCleaning: true,
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
  send(r5.orderId, 13, [
    { menu_item_id: 'i-steak', variant_id: 'v-300', qty: 1, options: [{ option_id: 'o-m' }, { option_id: 'o-pepper' }], removals: ['k-egg'] },
    { menu_item_id: 'i-coca', qty: 2, options: [], removals: [] },
  ])

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
  s = setLineStatus(s, l11, 'ready', ctx(110, 'kitchen'))
  s = setLineStatus(s, l11, 'served', ctx(109))
  const total11 = quoteBill(s, o11).total
  const paid = payOrder(s, o11, { payments: [{ method: 'bank', amount: 300000 }, { method: 'cash', amount: total11 - 300000, tendered: 500000 }] }, ctx(62, 'cashier'))
  s = printBill(paid.state, paid.billId, ctx(62, 'cashier')).state
  s = markClean(s, 't-11', ctx(55))
  return s
}
