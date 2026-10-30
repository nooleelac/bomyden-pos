import { describe, expect, it } from 'vitest'
import { DEFAULT_SHIP, shipEstimate, shipRulesProblem, shipTooFar } from '../lib/ship'
import { seedMenu } from '../menu/seed'
import * as E from './engine'
import { pendingOnline } from './logic'
import { floorEvents } from './notify'
import { createMemoryFloorRepo } from './repo'
import { seedFloor } from './seed'
import type { Actor, Bill, FloorState, SendLineInput } from './types'

const menu = seedMenu()
const T0 = new Date('2026-10-31T12:00:00Z')
const at = (role: Actor['role'], name = 'Hùng'): E.Ctx => {
  let n = 0
  return { now: T0, actor: { name, role }, menu, newId: () => `id-${++n}` }
}
const waiter = at('waiter')
const dish = menu.items.find(i => !i.hasSizes && i.groups.length === 0 && i.status === 'active')!
const line: SendLineInput = { menu_item_id: dish.id, qty: 2, options: [], removals: [] }
const order = (over: Partial<E.OnlinePlaceInput> = {}): E.OnlinePlaceInput => ({
  id: 'w-1', lines: [line], customerName: 'Khách A', phone: '0901 234 567', address: '12 Nguyễn Huệ, Quận 1', payMethod: 'transfer', ...over,
})
const placed = (over: Partial<E.OnlinePlaceInput> = {}) => E.placeOnlineOrder(seedFloor(), order(over), menu, T0)
const quoted = (s: FloorState = placed()) => E.quoteOnlineOrder(s, 'w-1', { fee: 25000, carrier: 'grab', foodTotal: 200000 }, waiter)

describe('phí ship tạm tính', () => {
  it('tính theo km đường đi, km lẻ làm tròn lên, giống _ship_estimate', () => {
    expect(shipEstimate(DEFAULT_SHIP, 1000)).toBe(15000)
    expect(shipEstimate(DEFAULT_SHIP, 3000)).toBe(25000)
    expect(shipTooFar(DEFAULT_SHIP, 7000)).toBe(false)
    expect(shipTooFar(DEFAULT_SHIP, 8000)).toBe(true)
  })
  it('từ chối bảng giá sai', () => {
    expect(shipRulesProblem(DEFAULT_SHIP)).toBeNull()
    expect(shipRulesProblem({ ...DEFAULT_SHIP, maxKm: 0 })).toContain('Phạm vi')
    expect(shipRulesProblem({ ...DEFAULT_SHIP, baseFee: 1.5 })).toContain('Phí ship')
  })
})

describe('đơn online', () => {
  it('khách gửi: chuẩn hoá số điện thoại, gửi lại không nhân đôi, báo chuông', () => {
    const s = placed()
    expect(s.onlineOrders).toEqual([expect.objectContaining({ id: 'w-1', phone: '0901234567', status: 'pending' })])
    expect(E.placeOnlineOrder(s, order(), menu, T0)).toBe(s)
    expect(pendingOnline(s)).toHaveLength(1)
    expect(floorEvents(s, T0)[0]).toMatchObject({ kind: 'guest', href: '#/ban/online' })
  })

  it('kiểm tra thông tin và giới hạn', () => {
    expect(() => placed({ phone: '123' })).toThrow('Số điện thoại')
    expect(() => placed({ address: 'ngắn' })).toThrow('địa chỉ')
    expect(() => placed({ customerName: ' ' })).toThrow('họ tên')
    expect(() => placed({ lines: [] })).toThrow('Chưa chọn món')
    let s = seedFloor()
    for (let i = 0; i < 3; i++) s = E.placeOnlineOrder(s, order({ id: `w-${i}` }), menu, T0)
    expect(() => E.placeOnlineOrder(s, order({ id: 'w-9' }), menu, T0)).toThrow('nhiều đơn chờ')
    const off = { ...seedFloor(), settings: { ...seedFloor().settings, onlineOrder: false } }
    expect(() => E.placeOnlineOrder(off, order(), menu, T0)).toThrow('chưa nhận đơn')
  })

  it('tạm tính theo vị trí, ngoài phạm vi thì không nhận', () => {
    const base = seedFloor()
    const s = { ...base, settings: { ...base.settings, guestGeo: { lat: 10.77, lng: 106.7, radius: null } } }
    const near = E.placeOnlineOrder(s, order({ fix: { lat: 10.78, lng: 106.7 } }), menu, T0)
    expect(near.onlineOrders![0].distanceM).toBeGreaterThan(1000)
    expect(near.onlineOrders![0].shipEstimate).toBe(15000)
    expect(() => E.placeOnlineOrder(s, order({ fix: { lat: 11, lng: 106.7 } }), menu, T0)).toThrow('phạm vi giao')
  })

  it('không vào bếp trước khi khách đồng ý', () => {
    expect(() => E.acceptOnlineOrder(placed(), 'w-1', waiter)).toThrow('chưa đồng ý')
    expect(() => E.acceptOnlineOrder(quoted(), 'w-1', waiter)).toThrow('chưa đồng ý')
  })

  it('phí đổi thì khách phải xem lại, bếp không báo được phí', () => {
    const s = quoted()
    expect(() => E.agreeOnlineOrder(s, 'w-1', 20000)).toThrow('đổi phí ship')
    expect(() => E.quoteOnlineOrder(placed(), 'w-1', { fee: 1, carrier: 'be', foodTotal: 0 }, at('kitchen'))).toThrow('Chưa có quyền')
    const again = E.quoteOnlineOrder(s, 'w-1', { fee: 30000, carrier: 'be', foodTotal: 200000 }, waiter)
    expect(E.agreeOnlineOrder(again, 'w-1', 30000).onlineOrders![0].status).toBe('agreed')
  })

  it('nhận đơn: thành đơn mang về, phí ship ở ghi chú không ở tiền món, nhận hai lần gửi một lần', () => {
    const s = E.agreeOnlineOrder(quoted(), 'w-1', 25000)
    const r = E.acceptOnlineOrder(s, 'w-1', waiter)
    const o = r.state.orders.find(x => x.id === r.orderId)!
    expect(o).toMatchObject({ kind: 'takeaway', customerName: 'Khách A 0901234567' })
    expect(o.note).toContain('ship 25,000đ')
    expect(r.state.lines.filter(l => l.orderId === o.id)).toHaveLength(1)
    expect(r.state.onlineOrders![0]).toMatchObject({ status: 'accepted', orderId: o.id, decidedBy: 'Hùng' })
    expect(pendingOnline(r.state)).toHaveLength(0)
    expect(E.acceptOnlineOrder(r.state, 'w-1', waiter)).toMatchObject({ state: r.state, orderId: o.id })
  })

  it('sau khi nhận và thu tiền vẫn xem lại được địa chỉ giao hàng', async () => {
    const accepted = E.acceptOnlineOrder(E.agreeOnlineOrder(quoted(), 'w-1', 25000), 'w-1', waiter)
    const bill = { id: 'b-1', orderId: accepted.orderId, paidAt: T0.toISOString() } as Bill
    const other = { id: 'b-2', orderId: 'khac', paidAt: T0.toISOString() } as Bill
    const repo = createMemoryFloorRepo({ menu: () => menu, actor: () => ({ name: 'Lan', role: 'cashier' }), initial: { ...accepted.state, bills: [bill, other] } })
    const h = await repo.billHistory('2000-01-01', '2100-01-01')
    expect(h.online).toEqual([expect.objectContaining({ orderId: accepted.orderId, address: '12 Nguyễn Huệ, Quận 1', phone: '0901234567' })])
  })

  it('khách huỷ trước khi quán nhận, sau đó thì không', () => {
    const s = E.agreeOnlineOrder(quoted(), 'w-1', 25000)
    expect(E.cancelOnlineOrder(s, 'w-1', T0).onlineOrders![0].status).toBe('cancelled')
    const done = E.acceptOnlineOrder(s, 'w-1', waiter).state
    expect(() => E.cancelOnlineOrder(done, 'w-1', T0)).toThrow('gọi quán để huỷ')
  })

  it('từ chối kèm lý do khách thấy', () => {
    const s = E.rejectOnlineOrder(placed(), 'w-1', 'Ngoài phạm vi giao', waiter)
    expect(s.onlineOrders![0]).toMatchObject({ status: 'rejected', reason: 'Ngoài phạm vi giao' })
    expect(() => E.rejectOnlineOrder(s, 'w-1', '', waiter)).toThrow('đã được xử lý')
  })
})
