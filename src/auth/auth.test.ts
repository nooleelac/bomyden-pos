import { describe, expect, it } from 'vitest'
import { seedMenu } from '../menu/seed'
import * as E from '../floor/engine'
import { createMemoryFloorRepo } from '../floor/repo'
import { seedFloor } from '../floor/seed'
import type { Actor, SendLineInput } from '../floor/types'
import { canOpen, homeRoute, menuTabsFor, navFor, screenOf, settingsFor } from './guards'
import { isIdle, shouldTouch } from './idle'
import { createMemoryAuthRepo, type MemoryAuthRepo } from './memoryRepo'
import { attemptPin, pinProblem } from './pin'
import type { Role } from './types'

// ---------------------------------------------------------------- role guards

describe('route guards by role', () => {
  const routes: Record<string, string[]> = {
    floor: ['ban'], setup: ['ban', 'caidat'], order: ['ban', 'don', 'o1'], kitchen: ['bep', 'grill'], cashier: ['thu-ngan'], pay: ['thu-ngan', 'o1'],
    shift: ['ca'], staff: ['nhan-vien'], devices: ['nhan-vien', 'may'], menuOrder: ['order'], soldout: ['soldout'], items: ['items', 'i-1'],
    categories: ['categories'], groups: ['groups'], root: [],
  }
  const allowed = (role: Role) => Object.entries(routes).filter(([, r]) => canOpen(role, r)).map(([k]) => k)

  it('waiter: floor, orders and the order menu; not the shift (#/ca), cashier, kitchen, staff or menu manager', () => {
    expect(allowed('waiter')).toEqual(['floor', 'order', 'menuOrder', 'soldout', 'root'])
    expect(canOpen('waiter', ['ca'])).toBe(false)
    expect(canOpen('waiter', ['items'])).toBe(false)
    expect(canOpen('waiter', ['categories'])).toBe(false)
  })
  it('kitchen sees only #/bep', () => {
    expect(allowed('kitchen')).toEqual(['kitchen'])
    expect(homeRoute('kitchen')).toBe('bep')
    expect(navFor('kitchen').map(l => l.href)).toEqual(['#/bep'])
    expect(menuTabsFor('kitchen')).toEqual([])
  })
  it('cashier: floor, temporary tables, cashier and shift; no menu manager or staff', () => {
    expect(allowed('cashier')).toEqual(['floor', 'setup', 'order', 'cashier', 'pay', 'shift', 'menuOrder', 'soldout', 'root'])
    expect(homeRoute('cashier')).toBe('thu-ngan')
  })
  it('manager and owner open everything', () => {
    for (const r of ['manager', 'owner'] as Role[]) expect(allowed(r)).toEqual(Object.keys(routes))
    expect(menuTabsFor('owner')).toContain('items')
    expect(navFor('manager').map(l => l.label)).toEqual(['Sơ đồ bàn', 'Bếp', 'Thu ngân', 'Cài đặt'])
    expect(settingsFor('manager').map(l => l.label)).toEqual(['Ca', 'Thực đơn', 'Bàn', 'Nhân viên'])
    expect(navFor('waiter').map(l => l.label)).toEqual(['Sơ đồ bàn', 'Cài đặt'])
    expect(settingsFor('waiter').map(l => l.label)).toEqual(['Hết món'])
    expect(settingsFor('cashier').map(l => l.label)).toEqual(['Ca', 'Hết món', 'Bàn'])
    expect(settingsFor('kitchen')).toEqual([])
    expect(screenOf(['cai-dat'])).toBe('settings')
  })
  it('nobody signed in opens nothing; unknown routes are the order menu', () => {
    expect(canOpen(null, ['ban'])).toBe(false)
    expect(screenOf(['whatever'])).toBe('menu-order')
  })
})

// ---------------------------------------------------------------- PIN rules and lockout

describe('PIN rules', () => {
  it('4–6 digits, not one digit repeated, not a straight run (same as pin_problem in 0006)', () => {
    for (const bad of ['', '123', '1234567', '12a4', '1111', '000000', '1234', '4321', '98765', '890123', '3456']) expect(pinProblem(bad)).not.toBeNull()
    for (const ok of ['2580', '1397', '2468', '102938', '1122']) expect(pinProblem(ok)).toBeNull()
  })
})

describe('failed-PIN lockout', () => {
  const cfg = { maxAttempts: 5, lockMinutes: 5 }
  const t0 = new Date('2026-10-17T12:00:00Z')
  it('counts misses, locks on the 5th for 5 minutes, refuses even the right PIN while locked, then resets', () => {
    let st = { failedCount: 0, lockedUntil: null as string | null }
    const lefts: (number | undefined)[] = []
    for (let i = 0; i < 4; i++) {
      const r = attemptPin(st, false, t0, cfg)
      st = r.state
      lefts.push(!r.result.ok ? r.result.attemptsLeft : -1)
    }
    expect(lefts).toEqual([4, 3, 2, 1])
    const lock = attemptPin(st, false, t0, cfg)
    expect(lock.locked).toBe(true)
    expect(lock.result).toMatchObject({ ok: false, error: 'Sai mã PIN 5 lần: khoá 5 phút' })
    st = lock.state
    expect(st.lockedUntil).toBe('2026-10-17T12:05:00.000Z')
    const stillLocked = attemptPin(st, true, new Date('2026-10-17T12:04:59Z'), cfg)
    expect(stillLocked.result).toMatchObject({ ok: false, error: 'Nhập sai quá nhiều lần: khoá đến 19:05' })
    const after = attemptPin(st, true, new Date('2026-10-17T12:05:01Z'), cfg)
    expect(after.result.ok).toBe(true)
    expect(after.state).toEqual({ failedCount: 0, lockedUntil: null })
  })
})

describe('idle sign-out', () => {
  it('signs out after the idle minutes, never a kitchen account; touches the server at most once a minute', () => {
    expect(isIdle('waiter', 0, 5 * 60_000 - 1, 5)).toBe(false)
    expect(isIdle('waiter', 0, 5 * 60_000, 5)).toBe(true)
    expect(isIdle('kitchen', 0, 24 * 3600_000, 5)).toBe(false)
    expect(shouldTouch(30_000, 0, 59_000)).toBe(false)
    expect(shouldTouch(30_000, 0, 60_000)).toBe(true)
    expect(shouldTouch(0, 10, 120_000)).toBe(false) // no activity since the last touch
  })
})

// ---------------------------------------------------------------- the sample auth engine

function clock(start = '2026-10-17T12:00:00Z') {
  let t = new Date(start).getTime()
  return { now: () => new Date(t), advance: (ms: number) => (t += ms) }
}
async function signedIn(repo: MemoryAuthRepo, id: string, pin: string) {
  const r = await repo.signIn(id, pin)
  if (!r.ok) throw new Error(r.error)
  return r.session
}

describe('sign-in on a shared device (memory engine)', () => {
  it('stores no PIN in plain text; wrong PINs count, lock, and are in the audit log', async () => {
    const c = clock()
    const repo = createMemoryAuthRepo({ now: c.now })
    const roster = await repo.roster()
    expect(roster.map(r => r.name)).toEqual(['Hùng', 'Mai', 'Lan', 'Bếp nướng', 'Quầy bar', 'Quản lý Hà', 'Chủ quán'])
    for (let i = 0; i < 4; i++) expect(await repo.signIn('s-hung', '0000')).toMatchObject({ ok: false, attemptsLeft: 4 - i })
    expect(await repo.signIn('s-hung', '9999')).toMatchObject({ ok: false, error: 'Sai mã PIN 5 lần: khoá 5 phút' })
    expect(await repo.signIn('s-hung', '2580')).toMatchObject({ ok: false, error: expect.stringContaining('khoá đến') })
    expect((await repo.roster()).find(r => r.id === 's-hung')?.lockedUntil).toBeTruthy()
    c.advance(5 * 60_000 + 1000)
    const s = await signedIn(repo, 's-hung', '2580')
    expect(s).toMatchObject({ name: 'Hùng', role: 'waiter' })
    expect(repo.current()?.staffId).toBe('s-hung')
    // the audit log is for managers
    await expect(repo.audit()).rejects.toThrow('Chỉ quản lý')
    await signedIn(repo, 's-ha', '1397')
    const log = await repo.audit()
    expect(log.filter(a => a.action === 'pin_failed' && a.staff === 'Hùng')).toHaveLength(4)
    expect(log.filter(a => a.action === 'pin_locked' && a.staff === 'Hùng')).toHaveLength(1)
    expect(JSON.stringify(log)).not.toContain('2580')
  })

  it('idle sign-out after the configured minutes; kitchen accounts stay signed in', async () => {
    const c = clock()
    const repo = createMemoryAuthRepo({ now: c.now })
    const w = await signedIn(repo, 's-hung', '2580')
    expect(w.expiresAt).toBe('2026-10-17T12:05:00.000Z')
    c.advance(4 * 60_000)
    await repo.touch()
    c.advance(4 * 60_000)
    expect(await repo.resume()).not.toBeNull() // touched at 4', so still on at 8'
    c.advance(5 * 60_000)
    expect(await repo.resume()).toBeNull()
    await expect(repo.touch()).rejects.toThrow('Phiên đăng nhập đã hết')
    const k = await signedIn(repo, 's-bep', '4826')
    expect(k.expiresAt).toBeNull()
    c.advance(10 * 3600_000)
    expect((await repo.resume())?.name).toBe('Bếp nướng')
  })

  it('a kitchen display lists kitchen accounts and managers, and refuses others', async () => {
    const repo = createMemoryAuthRepo({ device: { name: 'Màn bếp', kind: 'kitchen' } })
    expect((await repo.roster()).map(r => r.name)).toEqual(['Bếp nướng', 'Quầy bar', 'Quản lý Hà', 'Chủ quán'])
    expect(await repo.signIn('s-lan', '3690')).toMatchObject({ ok: false, error: 'Máy bếp chỉ đăng nhập tài khoản bếp hoặc quản lý' })
  })

  it('an unregistered device registers once with a manager code', async () => {
    const admin = createMemoryAuthRepo({})
    await signedIn(admin, 's-owner', '2468')
    await expect(admin.registerDevice('AAAA-BBBB')).rejects.toThrow('đã được đăng ký')
    const code = await admin.createDeviceCode('Máy tầng 2', 'pos')
    expect(code.code).toMatch(/^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/)
    const fresh = createMemoryAuthRepo({ device: null })
    expect(await fresh.device()).toBeNull()
    await expect(fresh.roster()).rejects.toThrow('chưa được đăng ký')
  })
})

describe('staff management rules (manager vs owner)', () => {
  it('managers manage waiters, kitchen and cashiers; only owners manage managers; nobody disables themselves', async () => {
    const repo = createMemoryAuthRepo({})
    await signedIn(repo, 's-hung', '2580')
    await expect(repo.listStaff()).rejects.toThrow('Chỉ quản lý')
    await expect(repo.saveStaff({ name: 'Tý', role: 'waiter', pin: '7531' })).rejects.toThrow('Chỉ quản lý')
    await signedIn(repo, 's-ha', '1397')
    await expect(repo.saveStaff({ name: 'Tý', role: 'waiter', pin: '1234' })).rejects.toThrow('dãy liên tiếp')
    await expect(repo.saveStaff({ name: 'Tý', role: 'waiter' })).rejects.toThrow('Đặt mã PIN')
    const ty = await repo.saveStaff({ name: 'Tý', role: 'waiter', pin: '7531' })
    await expect(repo.saveStaff({ name: 'tý', role: 'cashier', pin: '7532' })).rejects.toThrow('Đã có nhân viên tên')
    await expect(repo.saveStaff({ name: 'Minh', role: 'manager', pin: '8642' })).rejects.toThrow('Chỉ chủ quán')
    await expect(repo.saveStaff({ id: 's-lan', name: 'Lan', role: 'manager' })).rejects.toThrow('Chỉ chủ quán')
    await expect(repo.setStaffActive('s-owner', false)).rejects.toThrow('Chỉ chủ quán')
    await expect(repo.resetPin('s-owner', '9753')).rejects.toThrow('Chỉ chủ quán')
    await expect(repo.setStaffActive('s-ha', false)).rejects.toThrow('Không tự khoá')
    await repo.setStaffActive(ty, false)
    expect((await repo.roster()).some(r => r.id === ty)).toBe(false)
    await signedIn(repo, 's-owner', '2468')
    await repo.saveStaff({ name: 'Minh', role: 'manager', pin: '8642' })
    await expect(repo.setStaffActive('s-owner', false)).rejects.toThrow('Không tự khoá')
    const list = await repo.listStaff()
    expect(list[0]).toMatchObject({ name: 'Chủ quán', role: 'owner', signedInOn: 'Máy mẫu' })
    expect(list.find(r => r.name === 'Tý')?.active).toBe(false)
  })

  it('a PIN reset replaces the old PIN and lifts a lock; a disabled person cannot sign in', async () => {
    const repo = createMemoryAuthRepo({})
    for (let i = 0; i < 5; i++) await repo.signIn('s-lan', '0000')
    expect((await repo.roster()).find(r => r.id === 's-lan')?.lockedUntil).toBeTruthy()
    await signedIn(repo, 's-ha', '1397')
    await repo.resetPin('s-lan', '3691')
    expect((await repo.listStaff()).find(r => r.id === 's-lan')?.lockedUntil).toBeNull()
    expect(await repo.signIn('s-lan', '3690')).toMatchObject({ ok: false })
    expect((await repo.signIn('s-lan', '3691')).ok).toBe(true)
    await signedIn(repo, 's-ha', '1397')
    await repo.setStaffActive('s-lan', false)
    expect(await repo.signIn('s-lan', '3691')).toMatchObject({ ok: false, error: 'Không tìm thấy nhân viên hoặc đã ngừng làm' })
  })
})

// ---------------------------------------------------------------- manager approval through the floor engine

const steak: SendLineInput = { menu_item_id: 'i-steak', variant_id: 'v-300', qty: 2, options: [{ option_id: 'o-m' }], removals: [] }

const menu = seedMenu()
async function floorWithAuth() {
  const auth = createMemoryAuthRepo({})
  const actor: { a: Actor } = { a: { name: '', role: 'waiter' } }
  const floor = createMemoryFloorRepo({ menu: () => menu, actor: () => actor.a, approve: (t, need) => auth.consumeApproval(t, need), initial: seedFloor() })
  const as = async (id: string, pin: string) => {
    const s = await signedIn(auth, id, pin)
    actor.a = { name: s.name, role: s.role }
    return s
  }
  return { auth, floor, as }
}

describe('manager approval flow', () => {
  it('void after Gửi bếp: PIN → single-use token for that line, by the person who asked', async () => {
    const { auth, floor, as } = await floorWithAuth()
    await as('s-hung', '2580')
    const orderId = await floor.openTable({ tableId: 't-5', guestCount: 2 })
    await floor.sendLines(orderId, [steak], 'b1', {})
    const line = (await floor.load()).lines.find(l => l.orderId === orderId)!
    await expect(floor.voidLine(line.id, { qty: 1, reason: 'Khách đổi ý' })).rejects.toThrow('Huỷ món đã gửi bếp: cần quản lý nhập mã PIN')
    // a waiter cannot approve; a wrong manager PIN counts toward the lock
    expect(await auth.verifyManagerPin('s-mai', '3691', { action: 'void_item', orderId, lineId: line.id })).toMatchObject({ ok: false, error: 'Chỉ quản lý hoặc chủ quán duyệt được' })
    expect(await auth.verifyManagerPin('s-ha', '0000', { action: 'void_item', orderId, lineId: line.id })).toMatchObject({ ok: false, attemptsLeft: 4 })
    const ok = await auth.verifyManagerPin('s-ha', '1397', { action: 'void_item', orderId, lineId: line.id })
    if (!ok.ok) throw new Error(ok.error)
    expect(ok.managerName).toBe('Quản lý Hà')
    expect(Date.parse(ok.expiresAt) - Date.now()).toBeLessThanOrEqual(120_000)
    await expect(floor.voidLine(line.id, { qty: 1, reason: 'Khách đổi ý', approval: 'forged' })).rejects.toThrow('Mã duyệt của quản lý không hợp lệ')
    await floor.voidLine(line.id, { qty: 1, reason: 'Khách đổi ý', approval: ok.token })
    await expect(floor.voidLine(line.id, { qty: 1, reason: 'Khách đổi ý', approval: ok.token })).rejects.toThrow('đã dùng')
    const st = await floor.load()
    expect(st.lines.filter(l => l.orderId === orderId).map(l => [l.qty, l.status])).toEqual([[1, 'new'], [1, 'void']])
    // another person cannot use a token asked by Hùng
    const ok2 = await auth.verifyManagerPin('s-ha', '1397', { action: 'void_item', orderId, lineId: line.id })
    await as('s-mai', '3691')
    await expect(floor.voidLine(line.id, { qty: 1, reason: 'Khách đổi ý', approval: ok2.ok ? ok2.token : '' })).rejects.toThrow('Mã duyệt')
    // audit: who, what, approved by
    await as('s-ha', '1397')
    const log = await auth.audit()
    expect(log.find(a => a.action === 'void_item')).toMatchObject({ staff: 'Hùng', approvedBy: 'Quản lý Hà', device: 'Máy mẫu' })
    expect(log.filter(a => a.action === 'approval')).toHaveLength(2)
  })

  it('huỷ cả đơn: one approval for the whole order, then the table is free', async () => {
    const { auth, floor, as } = await floorWithAuth()
    await as('s-hung', '2580')
    const orderId = await floor.openTable({ tableId: 't-6', guestCount: 2 })
    await floor.sendLines(orderId, [steak, { ...steak, qty: 1 }], 'b1', {})
    await expect(floor.voidOrder(orderId, { reason: 'Khách đổi ý' })).rejects.toThrow('Huỷ đơn đã gửi bếp: cần quản lý')
    const other = await auth.verifyManagerPin('s-owner', '2468', { action: 'void_order', orderId: 'o-other' })
    await expect(floor.voidOrder(orderId, { reason: 'Khách đổi ý', approval: other.ok ? other.token : '' })).rejects.toThrow('Mã duyệt')
    const ok = await auth.verifyManagerPin('s-owner', '2468', { action: 'void_order', orderId })
    await floor.voidOrder(orderId, { reason: 'Khách đổi ý', approval: ok.ok ? ok.token : '' })
    const st = await floor.load()
    expect(st.orders.find(o => o.id === orderId)?.status).toBe('void')
    expect(st.lines.filter(l => l.orderId === orderId).every(l => l.status === 'void')).toBe(true)
    expect(st.notices.filter(n => n.orderId === orderId && n.kind === 'void')).toHaveLength(2)
  })

  it('discount: the token covers at most the approved amount; a manager needs none', async () => {
    const { auth, floor, as } = await floorWithAuth()
    await as('s-hung', '2580')
    const orderId = await floor.openTable({ tableId: 't-7', guestCount: 2 })
    await floor.sendLines(orderId, [steak], 'b1', {})
    await as('s-lan', '3690')
    await floor.openShift({ openingFloat: 0 })
    const d = { kind: 'percent' as const, value: 10 }
    const q = E.quoteBill(await floor.load(), orderId, d)
    const pay = { discount: d, discountReason: 'Khách quen', payments: [{ method: 'cash' as const, amount: q.total }] }
    await expect(floor.payOrder(orderId, pay)).rejects.toThrow('Giảm giá hoá đơn cần quản lý nhập mã PIN')
    const small = await auth.verifyManagerPin('s-ha', '1397', { action: 'discount', orderId, amount: q.discount - 1000 })
    await expect(floor.payOrder(orderId, { ...pay, approval: small.ok ? small.token : '' })).rejects.toThrow('Mã duyệt')
    const ok = await auth.verifyManagerPin('s-ha', '1397', { action: 'discount', orderId, amount: q.discount })
    const billId = await floor.payOrder(orderId, { ...pay, approval: ok.ok ? ok.token : '' })
    expect((await floor.load()).bills.find(b => b.id === billId)).toMatchObject({ discount: q.discount, cashier: 'Lan' })
    await as('s-ha', '1397')
    expect((await auth.audit()).find(a => a.action === 'discount')).toMatchObject({ staff: 'Lan', approvedBy: 'Quản lý Hà' })
  })

  it('approval tokens expire', async () => {
    const c = clock()
    const auth = createMemoryAuthRepo({ now: c.now })
    await signedIn(auth, 's-hung', '2580')
    const ok = await auth.verifyManagerPin('s-ha', '1397', { action: 'void_order', orderId: 'o1' })
    c.advance(121_000)
    expect(auth.consumeApproval(ok.ok ? ok.token : '', { action: 'void_order', orderId: 'o1' })).toBeNull()
  })
})
