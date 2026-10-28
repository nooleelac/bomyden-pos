import { describe, expect, it } from 'vitest'
import { createMemoryGuestRepo } from '../guest/repo'
import { createMemoryMenuRepo } from '../menu/repo'
import { seedMenu } from '../menu/seed'
import * as E from './engine'
import { floorEvents } from './notify'
import { createMemoryFloorRepo } from './repo'
import { seedFloor } from './seed'
import type { Actor, FloorState, SendLineInput } from './types'

const menu = seedMenu()
const T0 = new Date('2026-10-29T12:00:00Z')
let n = 0
const at = (role: Actor['role'] = 'waiter'): E.Ctx => ({ now: T0, actor: { name: role === 'manager' ? 'Chủ quán' : 'Hùng', role }, menu, newId: () => `id-${++n}` })
const waiter = at()
const manager = at('manager')
const steak: SendLineInput = { menu_item_id: 'i-steak', variant_id: 'v-300', qty: 2, options: [{ option_id: 'o-m' }], removals: [] }
const beer: SendLineInput = { menu_item_id: 'i-tiger', qty: 4, options: [], removals: [] }

/** The floor with QR tokens on every table; the token of table `id`. */
function withQr(): { s: FloorState; token: (id: string) => string } {
  const s = E.tableQrTokens(seedFloor(), null, manager)
  return { s, token: id => s.tables.find(t => t.id === id)!.qrToken! }
}

describe('khách gọi món qua QR', () => {
  it('gives every table a distinct token; Đổi mã replaces one and the old token stops working', () => {
    const { s, token } = withQr()
    expect(new Set(s.tables.map(t => t.qrToken)).size).toBe(s.tables.length)
    expect(token('t-5')).toMatch(/^[0-9a-f]{32}$/)
    const renewed = E.tableQrTokens(s, 't-5', manager)
    expect(() => E.guestTable(renewed, token('t-5'))).toThrow('không còn dùng được')
    expect(E.guestTable(renewed, renewed.tables.find(t => t.id === 't-5')!.qrToken!).id).toBe('t-5')
    expect(() => E.tableQrTokens(s, null, waiter)).toThrow('Chưa có quyền')
  })

  it('a request waits for a waiter: nothing reaches the kitchen, the bell shows it', () => {
    const { s, token } = withQr()
    const next = E.placeGuestOrder(s, token('t-5'), { id: 'g-1', lines: [steak, beer], note: 'ít cay', guestCount: 3 }, menu, T0)
    expect(next.guestRequests).toEqual([expect.objectContaining({ id: 'g-1', tableId: 't-5', status: 'pending', guestCount: 3, note: 'ít cay' })])
    expect(next.lines).toHaveLength(0)
    expect(next.orders).toHaveLength(0)
    expect(floorEvents(next, T0)[0]).toMatchObject({ kind: 'guest', href: '#/ban/khach' })
    // the same tap sent twice changes nothing
    expect(E.placeGuestOrder(next, token('t-5'), { id: 'g-1', lines: [beer] }, menu, T0)).toBe(next)
  })

  it('Nhận opens the free table and sends the lines once, as one round', () => {
    const { s, token } = withQr()
    const placed = E.placeGuestOrder(s, token('t-5'), { id: 'g-1', lines: [steak, beer], note: 'ít cay', guestCount: 3 }, menu, T0)
    const r = E.acceptGuestRequest(placed, 'g-1', waiter)
    const o = r.state.orders.find(x => x.id === r.orderId)!
    expect(o).toMatchObject({ tableId: 't-5', guestCount: 3, note: 'ít cay', rounds: 1 })
    expect(r.state.lines.map(l => [l.menuItemId, l.qty, l.sendBatch])).toEqual([['i-steak', 2, 'g-1'], ['i-tiger', 4, 'g-1']])
    expect(r.state.guestRequests![0]).toMatchObject({ status: 'accepted', decidedBy: 'Hùng', orderId: r.orderId })
    // a second device tapping Nhận too: same order, no second ticket
    const again = E.acceptGuestRequest(r.state, 'g-1', waiter)
    expect(again.orderId).toBe(r.orderId)
    expect(again.state.lines).toHaveLength(2)
    expect(floorEvents(r.state, T0).some(e => e.kind === 'guest')).toBe(false)
  })

  it('Nhận on a seated table adds a round to its order', () => {
    const { s, token } = withQr()
    const seated = E.openTable(s, { tableId: 't-5', guestCount: 2 }, waiter)
    const sent = E.sendLines(seated.state, seated.orderId, [beer], 'b-1', {}, waiter).state
    const placed = E.placeGuestOrder(sent, token('t-5'), { id: 'g-2', lines: [steak] }, menu, T0)
    const r = E.acceptGuestRequest(placed, 'g-2', waiter)
    expect(r.orderId).toBe(seated.orderId)
    expect(r.state.orders.find(o => o.id === r.orderId)!.rounds).toBe(2)
  })

  it('Từ chối keeps the kitchen out and gives the guest the reason', () => {
    const { s, token } = withQr()
    const placed = E.placeGuestOrder(s, token('t-5'), { id: 'g-1', lines: [beer] }, menu, T0)
    const no = E.rejectGuestRequest(placed, 'g-1', 'Bàn chưa có khách', waiter)
    expect(no.guestRequests![0]).toMatchObject({ status: 'rejected', reason: 'Bàn chưa có khách' })
    expect(() => E.acceptGuestRequest(no, 'g-1', waiter)).toThrow('đã bị từ chối')
    expect(() => E.rejectGuestRequest(placed, 'g-1', '', at('kitchen'))).toThrow('Chưa có quyền')
  })

  it('refuses bad links, guest ordering turned off, too many waiting requests and silly quantities', () => {
    const { s, token } = withQr()
    expect(() => E.placeGuestOrder(s, 'abc', { id: 'x', lines: [beer] }, menu, T0)).toThrow('không còn dùng được')
    const off = E.setGuestOrder(s, false, manager)
    expect(() => E.placeGuestOrder(off, token('t-5'), { id: 'x', lines: [beer] }, menu, T0)).toThrow('tắt gọi món')
    expect(() => E.placeGuestOrder(s, token('t-5'), { id: 'x', lines: [] }, menu, T0)).toThrow('Chưa chọn món')
    expect(() => E.placeGuestOrder(s, token('t-5'), { id: 'x', lines: [{ ...beer, qty: 50 }] }, menu, T0)).toThrow('từ 1 đến 20')
    let many = s
    for (let i = 0; i < 5; i++) many = E.placeGuestOrder(many, token('t-5'), { id: `g-${i}`, lines: [beer] }, menu, T0)
    expect(() => E.placeGuestOrder(many, token('t-5'), { id: 'g-9', lines: [beer] }, menu, T0)).toThrow('nhiều yêu cầu chờ')
  })

  it('Gọi phục vụ waits once per table; Đã xử lý sends nothing to the kitchen', () => {
    const { s, token } = withQr()
    const a = E.placeGuestCall(s, token('t-5'), { id: 'c-1', kind: 'service', note: 'Thêm nước đá' }, T0)
    expect(a.state.guestRequests![0]).toMatchObject({ id: 'c-1', kind: 'service', status: 'pending', lines: [], note: 'Thêm nước đá' })
    expect(floorEvents(a.state, T0)[0].text).toBe('khách Bàn 5 gọi phục vụ: Thêm nước đá')
    // calling again while the first is waiting follows the first
    const b = E.placeGuestCall(a.state, token('t-5'), { id: 'c-2', kind: 'service' }, T0)
    expect(b.id).toBe('c-1')
    expect(b.state.guestRequests).toHaveLength(1)
    const done = E.acceptGuestRequest(b.state, 'c-1', waiter)
    expect(done.orderId).toBe('')
    expect(done.state.guestRequests![0]).toMatchObject({ status: 'accepted', decidedBy: 'Hùng' })
    expect(done.state.orders).toHaveLength(0)
    expect(done.state.lines).toHaveLength(0)
    // done: the next call is a new one
    expect(E.placeGuestCall(done.state, token('t-5'), { id: 'c-3', kind: 'service' }, T0).id).toBe('c-3')
  })

  it('Gọi thanh toán needs dishes on the table and links the table order', () => {
    const { s, token } = withQr()
    expect(() => E.placeGuestCall(s, token('t-5'), { id: 'c-1', kind: 'bill' }, T0)).toThrow('chưa có món')
    const seated = E.openTable(s, { tableId: 't-5', guestCount: 2 }, waiter)
    const sent = E.sendLines(seated.state, seated.orderId, [beer], 'b-1', {}, waiter).state
    const call = E.placeGuestCall(sent, token('t-5'), { id: 'c-1', kind: 'bill', note: 'Thanh toán chuyển khoản' }, T0)
    expect(floorEvents(call.state, T0).find(e => e.kind === 'guest')?.text).toBe('khách Bàn 5 gọi thanh toán: Thanh toán chuyển khoản')
    const done = E.acceptGuestRequest(call.state, 'c-1', waiter)
    expect(done.orderId).toBe(seated.orderId)
    expect(done.state.lines).toHaveLength(1)
  })

  it('the guest page on sample data: menu, send, status with the table dishes after Nhận', async () => {
    const menuRepo = createMemoryMenuRepo()
    let actor: Actor = { name: 'Chủ quán', role: 'manager' }
    const floor = createMemoryFloorRepo({ menu: () => menuRepo.load(), actor: () => actor, now: () => T0 })
    await floor.tableQrTokens(null)
    const token = (await floor.load()).tables.find(t => t.id === 't-7')!.qrToken!
    const guest = createMemoryGuestRepo(floor, menuRepo)
    const view = await guest.load(token)
    expect(view).toMatchObject({ tableId: 't-7', tableName: '7' })
    await guest.place(token, { id: 'g-1', lines: [beer] })
    expect((await guest.status(token, ['g-1'])).requests).toEqual([expect.objectContaining({ id: 'g-1', status: 'pending' })])
    actor = { name: 'Hùng', role: 'waiter' }
    await floor.acceptGuest('g-1')
    const st = await guest.status(token, ['g-1'])
    expect(st.requests[0].status).toBe('accepted')
    expect(st.lines).toEqual([expect.objectContaining({ name: 'Bia Tiger lon', qty: 4, price: 25000 })])
    const billId = await guest.call(token, { id: 'c-1', kind: 'bill' })
    expect((await guest.status(token, [billId])).requests).toEqual([expect.objectContaining({ id: 'c-1', kind: 'bill', status: 'pending' })])
  })
})
