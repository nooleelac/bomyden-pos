import { describe, expect, it } from 'vitest'
import { seedMenu } from '../menu/seed'
import * as E from './engine'
import { activeTickets, allergyText, buildTickets, doneTickets, groupLabel, orderLabel, readyToServe, tableState, tableTile, ticketKey } from './logic'
import { createMemoryFloorRepo } from './repo'
import { sampleEvening, seedFloor } from './seed'
import type { Actor, FloorState, Line, SendLineInput } from './types'

const menu = seedMenu()
const T0 = new Date('2026-10-17T12:00:00Z') // 19:00 in Vietnam
let n = 0
const at = (minutes: number, role: Actor['role'] = 'waiter'): E.Ctx => ({
  now: new Date(T0.getTime() + minutes * 60_000),
  actor: { name: role === 'kitchen' ? 'Bếp' : role === 'manager' ? 'Chủ quán' : role === 'cashier' ? 'Lan' : 'Hùng', role },
  menu,
  newId: () => `id-${++n}`,
})
const waiter = at(0)
const kitchen = at(0, 'kitchen')
const cashier = at(0, 'cashier')
const manager = at(0, 'manager')

const steak300: SendLineInput = { menu_item_id: 'i-steak', variant_id: 'v-300', qty: 2, options: [{ option_id: 'o-m' }], removals: [] }
const beer = (qty = 6): SendLineInput => ({ menu_item_id: 'i-tiger', qty, options: [], removals: [] })
const lau: SendLineInput = { menu_item_id: 'i-hotpot', qty: 1, options: [], removals: [] }

function open(s: FloorState, table: string, guests = 2, c = waiter) {
  return E.openTable(s, { tableId: table, guestCount: guests }, c)
}
function send(s: FloorState, orderId: string, lines: SendLineInput[], c = waiter, batch = `b-${++n}`) {
  return E.sendLines(s, orderId, lines, batch, {}, c)
}
const order = (s: FloorState, id: string) => s.orders.find(o => o.id === id)!
const linesOf = (s: FloorState, id: string) => s.lines.filter(l => l.orderId === id)
const table = (s: FloorState, id: string) => s.tables.find(t => t.id === id)!
/** Cash for the exact total, opening the register's shift first when none is open. */
function payCash(s: FloorState, orderId: string, c = cashier): FloorState {
  if (!s.shifts.some(x => !x.closedAt)) s = E.openShift(s, { openingFloat: 0 }, c).state
  return E.payOrder(s, orderId, { payments: [{ method: 'cash', amount: E.quoteBill(s, orderId).total }] }, c).state
}

describe('mở bàn', () => {
  it('opens a free table with guests; a second device opening the same table enters the same order', () => {
    const r = open(seedFloor(), 't-6', 6)
    expect(order(r.state, r.orderId)).toMatchObject({ guestCount: 6, tableId: 't-6', status: 'open', openedBy: 'Hùng' })
    expect(tableState(r.state, table(r.state, 't-6'))).toBe('occupied')
    expect(tableTile(r.state, table(r.state, 't-6'), T0).overSeats).toBe(true) // 6 guests at a 4-seat table: warning only
    const again = open(r.state, 't-6', 3)
    expect(again.orderId).toBe(r.orderId)
    expect(again.state.orders.filter(o => o.status === 'open')).toHaveLength(1)
  })
  it('needs 1–99 guests, an open area, and refuses the kitchen account', () => {
    expect(() => open(seedFloor(), 't-1', 0)).toThrow('Số khách phải từ 1 đến 99')
    expect(() => open(seedFloor(), 't-1', 2, kitchen)).toThrow('Chưa có quyền: Mở bàn')
    const closed = E.saveArea(seedFloor(), { id: 'a-2', name: 'Tầng 2', sort: 2, active: false }, manager)
    expect(tableState(closed, table(closed, 't-13'))).toBe('closed')
    expect(() => open(closed, 't-13')).toThrow('Khu này đang tạm đóng')
  })
  it('merges at opening: one order on 3+4+5', () => {
    const r = E.openTable(seedFloor(), { tableId: 't-3', guestCount: 14, extraTableIds: ['t-4', 't-5'] }, waiter)
    const o = order(r.state, r.orderId)
    expect(groupLabel(r.state, o)).toBe('nhóm gộp 3+4+5')
    expect(['t-3', 't-4', 't-5'].map(t => tableState(r.state, table(r.state, t)))).toEqual(['occupied', 'occupied', 'occupied'])
    expect(tableTile(r.state, table(r.state, 't-4'), T0).groupLabel).toBe('Gộp 3+4+5')
  })
})

describe('ghép bàn (đơn riêng trên một bàn)', () => {
  it('5 becomes 5-A and 5-B with position labels; each order keeps its own lines and bill', () => {
    let s = open(seedFloor(), 't-5').state
    const a = s.orders[0].id
    expect(orderLabel(s, order(s, a))).toBe('5')
    expect(() => E.addSharedOrder(s, { tableId: 't-5', guestCount: 2, positionLabel: '' }, waiter)).toThrow('Ghi vị trí ngồi')
    expect(() => E.addSharedOrder(s, { tableId: 't-5', guestCount: 2, positionLabel: 'áo xanh' }, waiter)).toThrow('mỗi đơn phải ghi vị trí ngồi')
    const r = E.addSharedOrder(s, { tableId: 't-5', guestCount: 2, positionLabel: '2 khách áo xanh', existingLabels: { [a]: 'đầu bàn' } }, waiter)
    s = r.state
    expect(orderLabel(s, order(s, a))).toBe('5-A')
    expect(orderLabel(s, order(s, r.orderId))).toBe('5-B')
    s = send(s, r.orderId, [steak300]).state
    const t = buildTickets(s, T0)
    expect(t).toHaveLength(2) // the steak at the grill, its salad, bánh mì and sốt at the cold counter
    expect(t.every(x => x.label === '5-B' && x.positionLabel === '2 khách áo xanh')).toBe(true)
    // 5-B pays; the table stays occupied until 5-A closes too
    s = payCash(s, r.orderId)
    expect(tableState(s, table(s, 't-5'))).toBe('occupied')
    expect(orderLabel(s, order(s, a))).toBe('5') // alone again: the suffix shows only while the table is shared
  })
  it('caps orders per table', () => {
    let s = open(seedFloor(), 't-5').state
    s = E.updateOrder(s, s.orders[0].id, { positionLabel: 'A' }, waiter)
    for (const l of ['B', 'C', 'D']) s = E.addSharedOrder(s, { tableId: 't-5', guestCount: 1, positionLabel: l }, waiter).state
    expect(() => E.addSharedOrder(s, { tableId: 't-5', guestCount: 1, positionLabel: 'E' }, waiter)).toThrow('đã có đủ 4 đơn')
  })
})

describe('gửi bếp', () => {
  it('prices from the menu, splits by station, locks the round, and is idempotent per batch', () => {
    const o = open(seedFloor(), 't-3', 6)
    const first = E.sendLines(o.state, o.orderId, [steak300, lau, beer()], 'tap-1', {}, waiter)
    const again = E.sendLines(first.state, o.orderId, [steak300, lau, beer()], 'tap-1', {}, waiter)
    expect(again.state.lines).toHaveLength(3)
    const ls = linesOf(first.state, o.orderId)
    expect(ls.map(l => [l.stationId, l.price, l.round, l.status])).toEqual([
      ['st-grill', 279000, 1, 'new'],
      ['st-hotpot', 399000, 1, 'new'],
      ['st-bar', 25000, 1, 'new'], // drinks go to the bar
    ])
    expect(new Set(buildTickets(first.state, T0).map(t => t.stationId))).toEqual(new Set(['st-grill', 'st-cold', 'st-hotpot', 'st-bar']))
    const second = send(first.state, o.orderId, [beer(2)])
    expect(linesOf(second.state, o.orderId).slice(-1)[0].round).toBe(2)
  })
  it('keeps the price after a menu price change', () => {
    const o = open(seedFloor(), 't-3')
    const s = send(o.state, o.orderId, [steak300]).state
    const dearer = structuredClone(menu)
    dearer.items.find(i => i.id === 'i-steak')!.variants[1].price = 299000
    const s2 = E.sendLines(s, o.orderId, [steak300], 'later', {}, { ...waiter, menu: dearer }).state
    expect(linesOf(s2, o.orderId).map(l => l.price)).toEqual([279000, 299000])
  })
  it('refuses lines the picker refuses (no doneness, note too long) and rush without a reason', () => {
    const o = open(seedFloor(), 't-3')
    expect(() => send(o.state, o.orderId, [{ ...steak300, options: [] }])).toThrow('Chọn Độ chín')
    expect(() => send(o.state, o.orderId, [{ ...beer(), note: 'x'.repeat(61) }])).toThrow('tối đa 60')
    expect(() => E.sendLines(o.state, o.orderId, [beer()], 'r', { rush: true }, waiter)).toThrow('Chọn lý do GẤP')
  })
  it('order note and allergy flag go on top of every ticket of the order', () => {
    let s = open(seedFloor(), 't-3').state
    const id = s.orders[0].id
    s = E.updateOrder(s, id, { note: 'Khách dị ứng đậu phộng', allergy: true }, waiter)
    s = send(s, id, [steak300, beer()]).state
    expect(buildTickets(s, T0).every(t => t.order.allergy && t.order.note === 'Khách dị ứng đậu phộng')).toBe(true)
    expect(() => E.updateOrder(s, id, { note: 'x'.repeat(61) }, waiter)).toThrow('Ghi chú đơn tối đa 60')
  })
})

describe('trạng thái món, xong phiếu, gọi lại', () => {
  function cooking() {
    const o = open(seedFloor(), 't-3')
    const r = send(o.state, o.orderId, [steak300, { ...steak300, qty: 1, options: [{ option_id: 'o-wd' }] }])
    return { s: r.state, ids: r.lineIds, orderId: o.orderId }
  }
  it('Chờ làm → Đang làm → Xong → Đã bưng, with role checks and the 2-minute undo', () => {
    const { s, ids } = cooking()
    expect(() => E.setLineStatus(s, [ids[0]], 'cooking', waiter)).toThrow('Chưa có quyền: Màn hình bếp')
    let x = E.setLineStatus(s, [ids[0]], 'cooking', kitchen)
    x = E.setLineStatus(x, [ids[0]], 'ready', at(1, 'kitchen'))
    expect(readyToServe(x, at(2).now).map(r => r.label)).toEqual(['3'])
    expect(E.setLineStatus(x, [ids[0]], 'cooking', at(2, 'kitchen')).lines[0].status).toBe('cooking')
    expect(() => E.setLineStatus(x, [ids[0]], 'cooking', at(4, 'kitchen'))).toThrow('Quá 2 phút')
    x = E.setLineStatus(x, [ids[0]], 'served', at(3))
    expect(x.lines[0]).toMatchObject({ status: 'served', servedAt: at(3).now.toISOString() })
    // straight to Xong is allowed
    expect(E.setLineStatus(x, [ids[1]], 'ready', kitchen).lines[1].status).toBe('ready')
  })
  it('bump moves the rest to Xong, recall brings unserved dishes back with GỌI LẠI and the original timer', () => {
    const { s } = cooking()
    const key = ticketKey(s.lines[0])
    let x = E.bumpTicket(s, key, at(10, 'kitchen'))
    expect(x.lines.map(l => l.status)).toEqual(['ready', 'ready'])
    expect(activeTickets(x, menu, 'st-grill', at(10).now)).toHaveLength(0)
    expect(doneTickets(x, 'st-grill', at(11).now)).toHaveLength(1)
    x = E.setLineStatus(x, [x.lines[0].id], 'served', at(11))
    x = E.recallTicket(x, key, at(12, 'kitchen'))
    expect(x.lines.map(l => l.status)).toEqual(['served', 'cooking'])
    const t = activeTickets(x, menu, 'st-grill', at(12).now)[0]
    expect(t).toMatchObject({ recalled: true, sentAt: T0.toISOString() })
    expect(t.elapsedMs).toBe(12 * 60_000)
    expect(() => E.recallTicket(E.bumpTicket(x, key, at(13, 'kitchen')), key, at(50, 'kitchen'))).toThrow('quá 30 phút')
  })
  it('timer colours follow the station thresholds (grill: yellow 12, red 20)', () => {
    const { s } = cooking()
    expect(activeTickets(s, menu, 'all', at(11).now)[0].heat).toBe('ok')
    expect(activeTickets(s, menu, 'all', at(12).now)[0].heat).toBe('warn')
    expect(activeTickets(s, menu, 'all', at(20).now)[0].heat).toBe('late')
  })
})

describe('huỷ món', () => {
  it('before send is just removing from the cart; after send needs a reason and tells the kitchen', () => {
    const o = open(seedFloor(), 't-5')
    const sent = send(o.state, o.orderId, [beer(3)])
    // default (0006): every sent line needs a manager; the shop can allow lines the kitchen has not started
    expect(() => E.voidLine(sent.state, sent.lineIds[0], { qty: 1, reason: 'Khách đổi ý' }, waiter)).toThrow('Huỷ món đã gửi bếp: cần quản lý nhập mã PIN')
    const r = { ...sent, state: { ...sent.state, settings: { ...sent.state.settings, voidApproval: 'started' as const } } }
    expect(() => E.voidLine(r.state, r.lineIds[0], { qty: 1, reason: '' }, waiter)).toThrow('Chọn lý do huỷ')
    expect(() => E.voidLine(r.state, r.lineIds[0], { qty: 1, reason: 'Khác' }, waiter)).toThrow('ghi rõ lý do')
    const s = E.voidLine(r.state, r.lineIds[0], { qty: 1, reason: 'Khách đổi ý' }, waiter)
    const ls = linesOf(s, o.orderId)
    expect(ls.map(l => [l.qty, l.status])).toEqual([[2, 'new'], [1, 'void']])
    expect(s.notices[0]).toMatchObject({ kind: 'void', text: 'HUỶ 1 TIGER (bớt 1, còn 2) – Khách đổi ý', ackAt: null })
    // the void line stays struck on the ticket until Đã biết, and the ticket cannot be bumped before that
    const t = buildTickets(s, T0)[0]
    expect(t.lines.map(l => l.status)).toEqual(['new', 'void'])
    expect(() => E.bumpTicket(s, t.key, kitchen)).toThrow('Đã biết')
    const acked = E.ackNotice(s, s.notices[0].id, kitchen)
    expect(buildTickets(acked, T0)[0].lines).toHaveLength(1)
  })
  it('a dish already started needs a manager approval token and the amount leaves the bill', () => {
    const o = open(seedFloor(), 't-5')
    const r = send(o.state, o.orderId, [steak300])
    const s = E.setLineStatus(r.state, r.lineIds, 'cooking', kitchen)
    expect(() => E.voidLine(s, r.lineIds[0], { qty: 2, reason: 'Món lỗi' }, waiter)).toThrow('cần quản lý nhập mã PIN')
    const approve: E.Ctx['approve'] = (t, need) => (t === 'tok' && need.action === 'void_item' && need.lineId === r.lineIds[0] ? 'Quản lý Hà' : null)
    const w = { ...waiter, approve }
    expect(() => E.voidLine(s, r.lineIds[0], { qty: 2, reason: 'Món lỗi', approval: 'forged' }, w)).toThrow('Mã duyệt của quản lý không hợp lệ')
    const v = E.voidLine(s, r.lineIds[0], { qty: 2, reason: 'Món lỗi', approval: 'tok' }, w)
    expect(tableTile(v, table(v, 't-5'), T0).amount).toBe(0)
    expect(v.notices[0].kind).toBe('void')
    // served dishes: voided by the manager, the kitchen is not told
    const served = E.setLineStatus(E.setLineStatus(s, r.lineIds, 'ready', kitchen), r.lineIds, 'served', waiter)
    expect(E.voidLine(served, r.lineIds[0], { qty: 1, reason: 'Món lỗi' }, manager).notices).toHaveLength(0)
  })
})

describe('sửa món đã gửi', () => {
  it('Chờ làm: applied at once with the new price and a SỬA notice; Đang làm: waits for the kitchen', () => {
    const o = open(seedFloor(), 't-5')
    const r = send(o.state, o.orderId, [{ ...steak300, qty: 1 }])
    let s = E.modifyLine(r.state, r.lineIds[0], { ...steak300, qty: 1, removals: ['k-egg'] }, waiter)
    const live = linesOf(s, o.orderId).filter(l => l.status !== 'void')
    expect(live.map(l => l.price)).toEqual([276000]) // trứng −3.000đ
    const n = s.notices.find(x => x.kind === 'modify')!
    expect(n).toMatchObject({ status: 'done', before: 'Steak bò nướng – 300g · MEDIUM', text: 'Steak bò nướng – 300g · MEDIUM · KHÔNG TRỨNG' })
    expect(buildTickets(s, T0)[0].lines).toHaveLength(1)
    expect(() => E.modifyLine(s, live[0].id, { ...steak300, qty: 2 }, waiter)).toThrow('Đổi số lượng')

    s = E.ackNotice(s, n.id, kitchen)
    s = E.setLineStatus(s, [live[0].id], 'cooking', kitchen)
    s = E.modifyLine(s, live[0].id, { ...steak300, qty: 1, variant_id: 'v-400', removals: ['k-egg'] }, waiter)
    const pending = s.notices.find(x => x.status === 'pending')!
    expect(linesOf(s, o.orderId).find(l => l.status === 'cooking')!.price).toBe(276000) // unchanged until accepted
    expect(() => E.ackNotice(s, pending.id, kitchen)).toThrow('Nhận sửa')
    const accepted = E.decideModify(s, pending.id, true, kitchen)
    expect(linesOf(accepted, o.orderId).filter(l => l.status !== 'void').map(l => [l.variantName, l.price, l.status])).toEqual([['400g', 356000, 'cooking']])
    const rejected = E.decideModify(s, pending.id, false, kitchen)
    expect(rejected.notices.slice(-1)[0]).toMatchObject({ kind: 'modify_rejected' })
    expect(() => E.modifyLine(E.setLineStatus(s, [live[0].id], 'ready', kitchen), live[0].id, steak300, waiter)).toThrow()
  })
})

describe('gộp bàn', () => {
  it('folds orders into the target, keeps every line’s delivery table and kitchen state, prints no notice', () => {
    let s = seedFloor()
    const ids = ['t-3', 't-4', 't-5'].map((t, i) => {
      const r = open(s, t, 4 + i, at(-10 + i))
      s = r.state
      return r.orderId
    })
    s = send(s, ids[2], [{ menu_item_id: 'i-ba-chi', qty: 2, options: [], removals: [] }]).state
    s = E.setLineStatus(s, [s.lines[0].id], 'cooking', kitchen)
    s = send(s, ids[1], [beer()]).state
    const noticesBefore = s.notices.length
    s = E.mergeOrders(s, ids[0], [ids[1], ids[2]], waiter)
    const target = order(s, ids[0])
    expect(target).toMatchObject({ guestCount: 15, openedAt: at(-10).now.toISOString() })
    expect(order(s, ids[1])).toMatchObject({ status: 'merged', mergedInto: ids[0] })
    expect(s.lines.map(l => [l.orderId, l.deliveryTableId, l.status, l.originOrderId])).toEqual([
      [ids[0], 't-5', 'cooking', ids[2]],
      [ids[0], 't-4', 'new', ids[1]],
    ])
    expect(s.notices.length).toBe(noticesBefore)
    const t = buildTickets(s, T0).find(x => x.stationId === 'st-grill')!
    expect([t.label, t.groupLabel]).toEqual(['5', 'nhóm gộp 3+4+5'])
    // new lines after merging go to the primary table unless another table of the group is chosen
    s = send(s, ids[0], [beer(1), { ...beer(1), delivery_table_id: 't-4' }]).state
    expect(s.lines.slice(-2).map(l => l.deliveryTableId)).toEqual(['t-3', 't-4'])
    expect(() => send(s, ids[0], [{ ...beer(1), delivery_table_id: 't-9' }])).toThrow('Bàn ra món phải là một bàn của đơn')
  })
  it('refuses takeaway and orders being paid by someone else', () => {
    let s = open(seedFloor(), 't-1').state
    const a = s.orders[0].id
    const tw = E.openTakeaway(s, { customerName: 'chị Lan' }, waiter)
    expect(() => E.mergeOrders(tw.state, a, [tw.orderId], waiter)).toThrow('mang về')
    s = open(s, 't-2').state
    const b = s.orders[1].id
    s = E.beginPayment(s, b, cashier)
    expect(() => E.mergeOrders(s, a, [b], waiter)).toThrow('Đơn đang thanh toán')
  })
  it('release a table once nothing is headed there; split one table back to its own order', () => {
    let s = E.openTable(seedFloor(), { tableId: 't-3', guestCount: 8, extraTableIds: ['t-4'] }, waiter).state
    const id = s.orders[0].id
    s = send(s, id, [{ ...beer(2), delivery_table_id: 't-4' }]).state
    expect(() => E.releaseTable(s, id, 't-4', waiter)).toThrow('Còn 1 món sẽ ra bàn 4')
    const split = E.splitTableFromGroup(s, { orderId: id, tableId: 't-4', guestCount: 3 }, cashier)
    expect(order(split.state, id).tables.map(t => t.tableId)).toEqual(['t-3'])
    expect(linesOf(split.state, split.orderId)).toHaveLength(1)
    expect(order(split.state, split.orderId)).toMatchObject({ guestCount: 3, tableId: 't-4' })
    const served = E.setLineStatus(E.setLineStatus(s, [s.lines[0].id], 'ready', kitchen), [s.lines[0].id], 'served', waiter)
    const released = E.releaseTable(served, id, 't-4', waiter)
    expect(tableState(released, table(released, 't-4'))).toBe('free')
  })
})

describe('chuyển bàn, chuyển món, tách đơn', () => {
  it('moves a whole order to a free table; unfinished dishes follow with CHUYỂN TỪ, served ones stay', () => {
    let s = open(seedFloor(), 't-2', 4).state
    const id = s.orders[0].id
    const r = send(s, id, [steak300, beer(4)])
    s = E.setLineStatus(E.setLineStatus(r.state, [r.lineIds[1]], 'ready', kitchen), [r.lineIds[1]], 'served', waiter)
    s = E.moveOrder(s, { orderId: id, toTableId: 't-15' }, at(5))
    expect(tableState(s, table(s, 't-2'))).toBe('free')
    expect(s.lines.map(l => [l.deliveryTableId, l.movedFromLabel])).toEqual([['t-15', '2'], ['t-2', '']])
    expect(activeTickets(s, menu, 'st-grill', at(6).now)[0]).toMatchObject({ label: '15', movedFrom: '2' })
    expect(activeTickets(s, menu, 'st-grill', at(21).now)[0].movedFrom).toBe('') // label shows 15 minutes
    expect(order(s, id).openedAt).toBe(T0.toISOString())
    s = open(s, 't-7').state
    expect(() => E.moveOrder(s, { orderId: id, toTableId: 't-7' }, waiter)).toThrow('Gộp vào đơn hoặc Thành đơn ghép')
    const shared = E.moveOrder(s, { orderId: id, toTableId: 't-7', mode: 'shared', positionLabel: 'cuối bàn', existingLabels: { [s.orders[1].id]: 'đầu bàn' } }, waiter)
    expect(orderLabel(shared, order(shared, id))).toBe('7-B')
  })
  it('moves part of a line between orders; finished dishes need a cashier', () => {
    let s = open(seedFloor(), 't-2').state
    const a = s.orders[0].id
    s = open(s, 't-12').state
    const b = s.orders[1].id
    const r = send(s, a, [beer(6)])
    s = E.moveItems(r.state, [{ id: r.lineIds[0], qty: 2 }], b, waiter)
    expect(linesOf(s, a).map(l => l.qty)).toEqual([4])
    expect(linesOf(s, b)).toMatchObject([{ qty: 2, price: 25000, deliveryTableId: 't-12', movedFromLabel: '2', originOrderId: a }])
    const ready = E.setLineStatus(s, [r.lineIds[0]], 'ready', kitchen)
    expect(() => E.moveItems(ready, [{ id: r.lineIds[0] }], b, waiter)).toThrow('Chưa có quyền: Chuyển món đã xong')
    expect(linesOf(E.moveItems(ready, [{ id: r.lineIds[0] }], b, cashier), b)).toHaveLength(2)
  })
  it('splits chosen lines into 5-B on the same table (cashier), kitchen keeps cooking', () => {
    let s = open(seedFloor(), 't-8', 5).state
    const id = s.orders[0].id
    const r = send(s, id, [steak300, beer(3), lau])
    s = E.setLineStatus(r.state, [r.lineIds[0]], 'cooking', kitchen)
    const split = { orderId: id, items: [{ id: r.lineIds[0], qty: 1 }, { id: r.lineIds[1] }], positionLabel: 'nhóm B', guestCount: 2, sourceLabel: 'nhóm A' }
    expect(() => E.splitOrder(s, split, waiter)).toThrow('Chưa có quyền: Tách đơn')
    const x = E.splitOrder(s, split, cashier)
    expect(orderLabel(x.state, order(x.state, x.orderId))).toBe('8-B')
    expect(orderLabel(x.state, order(x.state, id))).toBe('8-A')
    expect(linesOf(x.state, x.orderId).map(l => [l.name, l.qty, l.status]).sort()).toEqual([['Bia Tiger lon', 3, 'new'], ['Steak bò nướng', 1, 'cooking']])
    expect(linesOf(x.state, id).map(l => l.qty)).toEqual([1, 1])
    const labels = buildTickets(x.state, T0).map(t => t.label).sort()
    expect(labels).toEqual(['8-A', '8-A', '8-A', '8-B', '8-B', '8-B']) // each steak half keeps its cold-counter part
    expect(linesOf(x.state, x.orderId).find(l => l.name === 'Steak bò nướng')!.sideParts).toMatchObject([{ stationId: 'st-cold', status: 'new' }])
  })
})

describe('tạm tính, thanh toán, dọn bàn', () => {
  it('Đang ngồi → Chờ thanh toán → (gọi thêm: Đang ngồi) → Đang thanh toán → Trống ngay khi thu xong', () => {
    let s = open(seedFloor(), 't-7').state
    const id = s.orders[0].id
    expect(() => E.requestBill(s, id, waiter)).toThrow('chưa có món')
    s = send(s, id, [beer(2)]).state
    s = E.requestBill(s, id, waiter)
    expect(tableState(s, table(s, 't-7'))).toBe('bill')
    s = send(s, id, [beer(1)]).state
    expect(tableState(s, table(s, 't-7'))).toBe('occupied')
    s = E.requestBill(s, id, waiter)
    expect(order(s, id).billPrintCount).toBe(2)
    expect(() => E.beginPayment(s, id, waiter)).toThrow('Chưa có quyền: Thu tiền')
    s = E.beginPayment(s, id, cashier)
    expect(tableState(s, table(s, 't-7'))).toBe('paying')
    expect(() => send(s, id, [beer(1)], { ...waiter, actor: { name: 'Minh', role: 'waiter' } })).toThrow('Đơn đang thanh toán')
    s = payCash(s, id)
    expect(tableState(s, table(s, 't-7'))).toBe('free')
  })
  it('an order with nothing on it closes without permission', () => {
    const r = open(seedFloor(), 't-1')
    expect(tableState(E.closeEmptyOrder(r.state, r.orderId, waiter), table(r.state, 't-1'))).toBe('free')
    const sent = send(r.state, r.orderId, [beer(1)]).state
    expect(() => E.closeEmptyOrder(sent, r.orderId, waiter)).toThrow('Đơn còn món')
  })
})

describe('mang về, giục món', () => {
  it('numbers takeaway orders MV-01, MV-02 per business day', () => {
    let s = seedFloor()
    const a = E.openTakeaway(s, { customerName: 'anh Tuấn' }, waiter)
    s = a.state
    const b = E.openTakeaway(s, {}, waiter)
    expect([orderLabel(b.state, order(b.state, a.orderId)), orderLabel(b.state, order(b.state, b.orderId))]).toEqual(['MV-01', 'MV-02'])
    const tomorrow = E.openTakeaway(b.state, {}, { ...waiter, now: new Date(T0.getTime() + 20 * 3600_000) })
    expect(order(tomorrow.state, tomorrow.orderId).takeawayNo).toBe(1)
    const sent = send(b.state, a.orderId, [lau]).state
    expect(buildTickets(sent, T0)[0]).toMatchObject({ label: 'MV-01', takeaway: true })
  })
  it('chase puts the ticket first, at most every 3 minutes, and the kitchen acknowledges', () => {
    let s = open(seedFloor(), 't-1').state
    const a = s.orders[0].id
    s = open(s, 't-2').state
    const b = s.orders[1].id
    s = send(s, a, [steak300]).state
    s = send(s, b, [{ ...steak300, qty: 1 }], at(1)).state
    expect(activeTickets(s, menu, 'st-grill', at(2).now).map(t => t.label)).toEqual(['1', '2'])
    s = E.chaseOrder(s, b, at(5))
    expect(activeTickets(s, menu, 'st-grill', at(6).now).map(t => t.label)).toEqual(['2', '1'])
    expect(() => E.chaseOrder(s, b, at(7))).toThrow('chờ 3 phút')
    const chase = s.notices.find(n => n.kind === 'chase')!
    expect(chase.text).toBe('GIỤC lần 1')
    s = E.ackNotice(s, chase.id, at(6, 'kitchen'))
    expect(activeTickets(s, menu, 'st-grill', at(6).now).map(t => t.label)).toEqual(['1', '2'])
  })
})

describe('một món, hai quầy (phần đi kèm)', () => {
  // Steak at Bếp nướng; salad, bánh mì and the sốt at Quầy rau – sốt (seed menu): one line on the bill, two tickets
  const full: SendLineInput = { ...steak300, options: [{ option_id: 'o-m' }, { option_id: 'o-pepper' }, { option_id: 'o-bread' }], removals: ['k-egg'] }
  function sent(line = full) {
    const o = open(seedFloor(), 't-3')
    const r = send(o.state, o.orderId, [line])
    return { s: r.state, id: r.lineIds[0], orderId: o.orderId }
  }
  const ticketAt = (s: FloorState, station: string, now = T0) => activeTickets(s, menu, station, now)[0]

  it('sends one line with a side part; each station sees only what it makes', () => {
    const { s, orderId } = sent()
    const l = linesOf(s, orderId)[0]
    expect(linesOf(s, orderId)).toHaveLength(1)
    expect(l).toMatchObject({ stationId: 'st-grill', price: 279000 - 3000 + 5000, sideParts: [{ stationId: 'st-cold', parts: ['SALAD', 'BÁNH MÌ'], status: 'new' }] })
    expect(l.mods.map(m => [m.kitchenName, m.stationId ?? null])).toEqual([['MEDIUM', null], ['TIÊU ĐEN', 'st-cold'], ['+ BÁNH MÌ', 'st-cold'], ['TRỨNG', null]])
    const grill = ticketAt(s, 'st-grill')
    expect(grill.lines.map(x => [x.qty, x.shortName, x.mods.map(m => m.kitchenName), x.parts])).toEqual([[2, 'STEAK BÒ', ['MEDIUM', 'TRỨNG'], []]])
    expect(grill.lines[0].others).toEqual([{ stationId: 'st-cold', status: 'new' }])
    const cold = ticketAt(s, 'st-cold')
    expect(cold).toMatchObject({ label: '3', stationId: 'st-cold' })
    expect(cold.lines.map(x => [x.qty, x.parts, x.mods.map(m => m.kitchenName)])).toEqual([[2, ['SALAD', 'BÁNH MÌ'], ['TIÊU ĐEN', '+ BÁNH MÌ']]])
    expect(E.taxedLines(s, orderId)).toHaveLength(1) // the bill reads the one line, at its price
  })
  it('no side part when everything made elsewhere is left out', () => {
    const { s, orderId } = sent({ ...steak300, removals: ['k-salad', 'k-bread'] })
    expect(linesOf(s, orderId)[0].sideParts).toEqual([])
    expect(activeTickets(s, menu, 'st-cold', T0)).toHaveLength(0)
    expect(ticketAt(s, 'st-grill').lines[0].mods.map(m => m.kitchenName)).toEqual(['MEDIUM', 'SALAD', 'BÁNH MÌ']) // KHÔNG SALAD stays with the steak
  })
  it('the cold counter finishes its part first and the waiter carries it out; the steak keeps cooking', () => {
    const { s, id } = sent()
    const part = { lineId: id, stationId: 'st-cold' }
    expect(() => E.setPartStatus(s, [part], 'cooking', waiter)).toThrow('Chưa có quyền: Màn hình bếp')
    let x = E.setPartStatus(s, [part], 'ready', at(3, 'kitchen'))
    expect(x.lines[0]).toMatchObject({ status: 'new', sideParts: [{ status: 'ready', readyAt: at(3).now.toISOString() }] })
    expect(activeTickets(x, menu, 'st-cold', at(3).now)).toHaveLength(0)
    expect(ticketAt(x, 'st-grill', at(3).now).lines[0].others).toEqual([{ stationId: 'st-cold', status: 'ready' }])
    const ready = readyToServe(x, at(4).now)
    expect(ready.map(r => [r.label, r.line.sideStationId, r.line.parts])).toEqual([['3', 'st-cold', ['SALAD', 'BÁNH MÌ']]])
    expect(() => E.setPartStatus(s, [part], 'served', waiter)).toThrow('Chỉ bưng món đã xong')
    x = E.setPartStatus(x, [part], 'served', at(4))
    expect(readyToServe(x, at(4).now)).toHaveLength(0)
    expect(tableTile(x, table(x, 't-3'), at(15).now).kitchenHeat).toBe('warn') // the steak is still at the grill
    x = E.setLineStatus(x, [id], 'ready', at(9, 'kitchen'))
    expect(readyToServe(x, at(9).now).map(r => r.line.sideStationId)).toEqual([null])
  })
  it('bump and recall work on the side ticket alone', () => {
    const { s } = sent()
    const cold = ticketAt(s, 'st-cold')
    let x = E.bumpTicket(s, cold.key, at(2, 'kitchen'))
    expect(x.lines[0]).toMatchObject({ status: 'new', sideParts: [{ status: 'ready' }] })
    expect(doneTickets(x, 'st-cold', at(3).now)).toHaveLength(1)
    x = E.recallTicket(x, cold.key, at(3, 'kitchen'))
    expect(x.lines[0].sideParts[0].status).toBe('cooking')
    expect(ticketAt(x, 'st-cold', at(3).now).recalled).toBe(true)
  })
  it('huỷ shows on both tickets; giục reaches the station still working', () => {
    const { s, id, orderId } = sent()
    const v = E.voidLine(s, id, { qty: 2, reason: 'Khách đổi ý' }, manager)
    expect([ticketAt(v, 'st-grill'), ticketAt(v, 'st-cold')].map(t => t.notices.map(n => n.kind))).toEqual([['void'], ['void']])
    expect(ticketAt(v, 'st-cold').lines[0].status).toBe('void')
    const grillDone = E.setLineStatus(s, [id], 'ready', kitchen)
    const chased = E.chaseOrder(grillDone, orderId, at(5))
    expect(chased.notices.map(n => n.stationId)).toEqual(['st-cold'])
  })
  it('tách món: each half keeps its own side part state', () => {
    const { s, id, orderId } = sent()
    const x = E.setPartStatus(s, [{ lineId: id, stationId: 'st-cold' }], 'cooking', kitchen)
    const y = E.splitOrder(x, { orderId, items: [{ id, qty: 1 }], positionLabel: 'B', guestCount: 1, sourceLabel: 'A' }, cashier)
    expect(y.state.lines.map(l => [l.qty, l.sideParts[0].status])).toEqual([[1, 'cooking'], [1, 'cooking']])
  })
})

describe('memory repo', () => {
  it('runs the sample evening and keeps the state when a transition fails', async () => {
    const repo = createMemoryFloorRepo({ initial: sampleEvening(menu, T0), menu: () => menu, actor: () => ({ name: 'Hùng', role: 'waiter' }), now: () => T0 })
    const s = await repo.load()
    expect(s.orders.filter(o => o.status === 'open').map(o => orderLabel(s, o))).toEqual(['3', '5-A', '5-B', '9'])
    expect(tableState(s, table(s, 't-9'))).toBe('bill')
    await expect(repo.openTable({ tableId: 't-1', guestCount: 0 })).rejects.toThrow('Số khách')
    expect((await repo.load()).orders).toHaveLength(s.orders.length)
    let calls = 0
    repo.subscribe(() => calls++)
    const id = await repo.openTable({ tableId: 't-1', guestCount: 2 })
    await repo.sendLines(id, [beer(2)], 'x', {})
    await Promise.resolve()
    expect(calls).toBeGreaterThan(0)
    const after = await repo.load()
    expect(after.lines.filter((l: Line) => l.orderId === id)).toHaveLength(1)
  })
})

describe('ô dị ứng trên phiếu bếp', () => {
  it('gọn một dòng', () => {
    expect(allergyText('Khách dị ứng đậu phộng')).toBe('⚠ DỊ ỨNG: đậu phộng')
    expect(allergyText('dị ứng: tôm')).toBe('⚠ DỊ ỨNG: tôm')
    expect(allergyText('hải sản')).toBe('⚠ DỊ ỨNG: hải sản')
    expect(allergyText('')).toBe('⚠ CÓ KHÁCH DỊ ỨNG')
  })
})

describe('xoá vĩnh viễn (admin.delete)', () => {
  const owner = at(0, 'owner')
  it('only with the permission: the owner has it, a manager not by default', () => {
    const r = open(seedFloor(), 't-6')
    expect(() => E.adminDelete(r.state, 'order', r.orderId, manager)).toThrow('Chưa có quyền: Xoá vĩnh viễn')
    expect(E.adminDelete(r.state, 'order', r.orderId, owner).orders.some(o => o.id === r.orderId)).toBe(false)
  })

  it('an order goes with its dishes and bill; a table with the orders open on it, paid ones keep their bill', () => {
    const a = open(seedFloor(), 't-6')
    let s = send(a.state, a.orderId, [beer(2)]).state
    s = payCash(s, a.orderId)
    const b = open(s, 't-6')
    s = send(b.state, b.orderId, [lau]).state
    const bill = s.bills.find(x => x.orderId === a.orderId)!
    s = E.adminDelete(s, 'table', 't-6', owner)
    expect(s.tables.some(t => t.id === 't-6')).toBe(false)
    expect(s.orders.some(o => o.id === b.orderId) || linesOf(s, b.orderId).length).toBeFalsy()
    expect(order(s, a.orderId)).toMatchObject({ status: 'paid', tableId: null, tables: [] })
    expect(s.bills.some(x => x.id === bill.id)).toBe(true)
    s = E.adminDelete(s, 'order', a.orderId, owner)
    expect(s.bills.some(x => x.id === bill.id) || linesOf(s, a.orderId).length).toBeFalsy()
  })

  it('an area goes with its tables; a shift leaves its bills without a shift', () => {
    const a = open(seedFloor(), 't-6')
    let s = payCash(send(a.state, a.orderId, [beer(1)]).state, a.orderId)
    const area = table(s, 't-6').areaId
    s = E.adminDelete(s, 'area', area, owner)
    expect(s.areas.some(x => x.id === area) || s.tables.some(t => t.areaId === area)).toBe(false)
    const shift = s.shifts[0].id
    s = E.adminDelete(s, 'shift', shift, owner)
    expect(s.shifts.some(x => x.id === shift)).toBe(false)
    expect(s.bills.find(x => x.orderId === a.orderId)?.shiftId).toBeNull()
  })
})

describe('cài đặt thanh toán', () => {
  const base = { payMethods: { cash: true, bank: true, card: true }, vatRate: null, showVat: true, bankBin: '970436', bankName: 'Vietcombank', bankAccount: '0123 456 789', bankAccountName: 'nguyen van a' }
  it('needs one method, a bank account for transfers, a whole VAT % from 0 to 100, and settings.edit', () => {
    expect(() => E.checkPaymentSettings({ ...base, payMethods: { cash: false, bank: false, card: false } })).toThrow('Bật ít nhất một phương thức thanh toán')
    expect(() => E.checkPaymentSettings({ ...base, bankBin: '97' })).toThrow('BIN')
    expect(() => E.checkPaymentSettings({ ...base, vatRate: 7.5 })).toThrow('Thuế suất')
    expect(E.checkPaymentSettings({ ...base, bankBin: '', payMethods: { cash: true, bank: false, card: true } }).payMethods.bank).toBe(false)
    expect(E.checkPaymentSettings(base)).toMatchObject({ bankAccount: '0123456789', bankAccountName: 'NGUYEN VAN A' })
    expect(() => E.saveShop(seedFloor(), base, waiter)).toThrow('Chưa có quyền')
  })
  it("the shop's VAT % applies to dishes sent after saving; dishes already sent keep their rate", () => {
    const r = open(seedFloor(), 't-1')
    const s1 = send(r.state, r.orderId, [beer(1)]).state
    const s2 = E.saveShop(s1, { ...base, vatRate: 5 }, manager)
    const s3 = send(s2, r.orderId, [lau]).state
    expect(linesOf(s3, r.orderId).map(l => l.vatRate)).toEqual([10, 5])
  })
})
