// AuthRepo on sample staff, kept in this browser (localStorage, shared by its tabs; the signed-in person is per
// tab). Same rules as 0006: PINs are salted SHA-256 here (bcrypt on the server), wrong PINs lock after
// maxAttempts, approval tokens are single-use, bound to the action, order, line/amount and the person who asked.
// The floor engine checks approvals through consumeApproval (sample stand-in for the p_approval check in SQL).

import { newId } from '../menu/repo'
import { isManager } from './guards'
import { attemptPin, isLocked, pinProblem, type PinState } from './pin'
import type { AuthRepo, DeviceRow } from './repo'
import {
  DEFAULT_AUTH_SETTINGS, ROLE_LABEL,
  type ApprovalRequest, type ApprovalResult, type AuditEntry, type AuthSettings, type DeviceCode, type DeviceKind, type Role,
  type RosterEntry, type Session, type SignInResult, type StaffRecord,
} from './types'

interface StaffRow extends PinState {
  id: string
  name: string
  role: Role
  active: boolean
  salt: string
  pinHash: string | null
  pinSetAt: string | null
}
interface SessionRow {
  token: string
  staffId: string
  deviceId: string
  startedAt: string
  lastSeenAt: string
  expiresAt: string | null
  endedAt: string | null
}
interface AuditRow {
  id: string
  at: string
  action: string
  staffId: string | null
  approvedBy: string | null
  deviceId: string | null
  detail: Record<string, unknown>
}
interface Store {
  v: number
  staff: StaffRow[]
  devices: DeviceRow[]
  codes: (DeviceCode & { used: boolean })[]
  sessions: SessionRow[]
  settings: AuthSettings
  audit: AuditRow[]
}
interface Approval extends ApprovalRequest {
  token: string
  managerId: string
  requestedBy: string
  expiresAt: number
  used: boolean
}

const VERSION = 1
const AUDIT_KEEP = 300

/** Sample staff and their PINs (examples only; the shop sets real ones on Nhân viên). */
export const SAMPLE_STAFF: { id: string; name: string; role: Role; pin: string }[] = [
  { id: 's-hung', name: 'Hùng', role: 'waiter', pin: '2580' },
  { id: 's-mai', name: 'Mai', role: 'waiter', pin: '3691' },
  { id: 's-lan', name: 'Lan', role: 'cashier', pin: '3690' },
  { id: 's-bep', name: 'Bếp nướng', role: 'kitchen', pin: '4826' },
  { id: 's-bar', name: 'Quầy bar', role: 'kitchen', pin: '5937' },
  { id: 's-ha', name: 'Quản lý Hà', role: 'manager', pin: '1397' },
  { id: 's-owner', name: 'Chủ quán', role: 'owner', pin: '2468' },
]

export async function sha256Pin(salt: string, pin: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${salt}:${pin}`))
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('')
}

function fail(msg: string): never {
  throw new Error(msg)
}
const randomHex = (n: number) => [...crypto.getRandomValues(new Uint8Array(n))].map(b => b.toString(16).padStart(2, '0')).join('')
const ROSTER_ORDER: Role[] = ['waiter', 'cashier', 'kitchen', 'manager', 'owner']
const ADMIN_ORDER: Role[] = ['owner', 'manager', 'cashier', 'waiter', 'kitchen']

export interface MemoryAuthOptions {
  now?: () => Date
  /** Share staff and devices with the other tabs (off in tests). */
  sync?: { storageKey: string; sessionKey: string; channel: string }
  /** Start with this device registered (sample mode); otherwise the device registration screen shows first. */
  device?: { name: string; kind: DeviceKind } | null
  staff?: typeof SAMPLE_STAFF
}

export type MemoryAuthRepo = AuthRepo & {
  /** Sample stand-in for the server's approval check: the approving manager's name, or null. Uses the token up. */
  consumeApproval(token: string | undefined, need: ApprovalRequest): string | null
  /** The person signed in on this tab right now. */
  current(): Session | null
}

export function createMemoryAuthRepo(opts: MemoryAuthOptions = {}): MemoryAuthRepo {
  const now = opts.now ?? (() => new Date())
  const iso = () => now().toISOString()
  const sync = opts.sync
  const listeners = new Set<() => void>()
  const approvals = new Map<string, Approval>()
  let store: Store | null = null
  let myToken: string | null = null
  let myDeviceId: string | null = null
  let channel: BroadcastChannel | null = null

  const changed = () => queueMicrotask(() => listeners.forEach(l => l()))
  const save = () => {
    if (!sync || !store) return changed()
    try {
      localStorage.setItem(sync.storageKey, JSON.stringify(store))
    } catch {
      /* storage blocked: this tab keeps working on its copy */
    }
    channel?.postMessage('changed')
    changed()
  }
  const keepToken = (t: string | null, kitchen: boolean) => {
    myToken = t
    if (!sync) return
    try {
      if (t) sessionStorage.setItem(sync.sessionKey, t)
      else sessionStorage.removeItem(sync.sessionKey)
      // the kitchen display stays signed in across restarts of the browser
      if (t && kitchen) localStorage.setItem(sync.sessionKey + '-kitchen', t)
      else localStorage.removeItem(sync.sessionKey + '-kitchen')
    } catch {
      /* per-tab only */
    }
  }

  async function seed(): Promise<Store> {
    const staff: StaffRow[] = []
    for (const s of opts.staff ?? SAMPLE_STAFF) {
      const salt = randomHex(8)
      staff.push({ id: s.id, name: s.name, role: s.role, active: true, salt, pinHash: await sha256Pin(salt, s.pin), pinSetAt: iso(), failedCount: 0, lockedUntil: null })
    }
    const devices: DeviceRow[] = opts.device === null ? [] : [{ id: 'dev-sample', name: opts.device?.name ?? 'Máy mẫu', kind: opts.device?.kind ?? 'pos', active: true, lastSeenAt: null }]
    return { v: VERSION, staff, devices, codes: [], sessions: [], settings: { ...DEFAULT_AUTH_SETTINGS }, audit: [] }
  }

  let ready: Promise<void> | null = null
  const init = () =>
    (ready ??= (async () => {
      if (sync) {
        try {
          const raw = localStorage.getItem(sync.storageKey)
          const parsed = raw ? (JSON.parse(raw) as Store) : null
          if (parsed?.v === VERSION) store = parsed
        } catch {
          /* bad data: start from the sample */
        }
        try {
          myDeviceId = localStorage.getItem(sync.storageKey + '-device')
          myToken = sessionStorage.getItem(sync.sessionKey) ?? localStorage.getItem(sync.sessionKey + '-kitchen')
        } catch {
          /* no storage */
        }
        if (typeof BroadcastChannel !== 'undefined') {
          channel = new BroadcastChannel(sync.channel)
          channel.onmessage = () => {
            try {
              const raw = localStorage.getItem(sync.storageKey)
              if (raw) store = JSON.parse(raw) as Store
            } catch {
              /* keep ours */
            }
            changed()
          }
        }
      }
      if (!store) {
        store = await seed()
        save()
      }
      if (!myDeviceId && store.devices[0] && opts.device !== null) myDeviceId = store.devices[0].id
    })())
  const db = async () => {
    await init()
    return store!
  }

  const device = (s: Store) => s.devices.find(d => d.id === myDeviceId && d.active) ?? null
  const staffOf = (s: Store, id: string | null) => s.staff.find(x => x.id === id)
  const liveSession = (s: Store, token: string | null): SessionRow | null => {
    const r = token ? s.sessions.find(x => x.token === token) : null
    if (!r || r.endedAt || r.deviceId !== myDeviceId || !device(s)) return null
    if (r.expiresAt && new Date(r.expiresAt).getTime() <= now().getTime()) return null
    if (!staffOf(s, r.staffId)?.active) return null
    return r
  }
  const me = (s: Store) => {
    const r = liveSession(s, myToken)
    return r ? staffOf(s, r.staffId)! : null
  }
  const audit = (s: Store, action: string, detail: Record<string, unknown> = {}, staffId?: string | null, approvedBy?: string | null) => {
    s.audit.unshift({ id: newId(), at: iso(), action, staffId: staffId === undefined ? (me(s)?.id ?? null) : staffId, approvedBy: approvedBy ?? null, deviceId: myDeviceId, detail })
    s.audit.length = Math.min(s.audit.length, AUDIT_KEEP)
  }
  const requireManager = (s: Store) => {
    const m = me(s)
    if (!m || !isManager(m.role)) fail('Chỉ quản lý hoặc chủ quán được làm việc này')
    return m
  }
  const mayManage = (s: Store, targetRole: Role, targetId: string | null) => {
    const m = me(s)
    if (m?.role === 'owner') return true
    if (m?.role === 'manager') return targetRole === 'waiter' || targetRole === 'kitchen' || targetRole === 'cashier' || (targetId !== null && targetId === m.id)
    return false
  }
  const endSessions = (s: Store, staffId: string, keep?: string | null) => {
    for (const r of s.sessions) if (r.staffId === staffId && !r.endedAt && r.token !== keep) r.endedAt = iso()
  }
  const checkPin = async (s: Store, row: StaffRow, pin: string, purpose: string) => {
    if (!row.pinHash) return { ok: false as const, error: 'Chưa có mã PIN: nhờ quản lý đặt PIN' }
    const matches = /^[0-9]{4,6}$/.test(pin) && (await sha256Pin(row.salt, pin)) === row.pinHash
    const r = attemptPin(row, matches, now(), s.settings)
    row.failedCount = r.state.failedCount
    row.lockedUntil = r.state.lockedUntil
    if (r.locked) audit(s, 'pin_locked', { purpose, until: row.lockedUntil }, row.id)
    else if (!r.result.ok && r.result.attemptsLeft !== undefined) audit(s, 'pin_failed', { purpose, left: r.result.attemptsLeft }, row.id)
    save()
    return r.result
  }
  const setPin = async (row: StaffRow, pin: string) => {
    const bad = pinProblem(pin)
    if (bad) fail(bad)
    row.salt = randomHex(8)
    row.pinHash = await sha256Pin(row.salt, pin)
    row.pinSetAt = iso()
    row.failedCount = 0
    row.lockedUntil = null
  }
  const toSession = (r: SessionRow, st: StaffRow): Session => ({ staffId: st.id, name: st.name, role: st.role, token: r.token, expiresAt: r.expiresAt })

  const repo: MemoryAuthRepo = {
    source: 'sample',
    async device() {
      const s = await db()
      const d = device(s)
      return d ? { id: d.id, name: d.name, kind: d.kind, active: d.active } : null
    },
    async registerDevice(code) {
      const s = await db()
      if (device(s)) fail('Máy này đã được đăng ký')
      const c = s.codes.find(x => x.code === code.trim().toUpperCase())
      if (!c || c.used || new Date(c.expiresAt).getTime() < now().getTime()) fail('Mã đăng ký máy không đúng hoặc đã hết hạn')
      c.used = true
      const d: DeviceRow = { id: newId(), name: c.name, kind: c.kind, active: true, lastSeenAt: null }
      s.devices.push(d)
      myDeviceId = d.id
      try {
        if (sync) localStorage.setItem(sync.storageKey + '-device', d.id)
      } catch {
        /* this tab only */
      }
      audit(s, 'device_registered', { name: d.name, kind: d.kind }, null)
      save()
      return { id: d.id, name: d.name, kind: d.kind, active: true }
    },
    async settings() {
      return { ...(await db()).settings }
    },
    async saveSettings(p) {
      const s = await db()
      requireManager(s)
      const n = { ...s.settings, ...p }
      if (!Number.isInteger(n.idleMinutes) || n.idleMinutes < 1 || n.idleMinutes > 240) fail('Tự đăng xuất sau 1 đến 240 phút')
      if (!Number.isInteger(n.maxAttempts) || n.maxAttempts < 3 || n.maxAttempts > 10) fail('Số lần nhập sai từ 3 đến 10')
      if (!Number.isInteger(n.lockMinutes) || n.lockMinutes < 1 || n.lockMinutes > 120) fail('Thời gian khoá từ 1 đến 120 phút')
      s.settings = n
      audit(s, 'settings', p)
      save()
    },
    async roster() {
      const s = await db()
      const d = device(s) ?? fail('Máy này chưa được đăng ký hoặc đã bị khoá')
      return s.staff
        .filter(x => x.active && (d.kind === 'pos' || x.role === 'kitchen' || isManager(x.role)))
        .sort((a, b) => ROSTER_ORDER.indexOf(a.role) - ROSTER_ORDER.indexOf(b.role) || a.name.localeCompare(b.name, 'vi'))
        .map((x): RosterEntry => ({ id: x.id, name: x.name, role: x.role, hasPin: !!x.pinHash, lockedUntil: isLocked(x.lockedUntil, now()) ? x.lockedUntil : null }))
    },
    async signIn(staffId, pin): Promise<SignInResult> {
      const s = await db()
      const d = device(s) ?? fail('Máy này chưa được đăng ký hoặc đã bị khoá')
      const row = s.staff.find(x => x.id === staffId && x.active)
      if (!row) return { ok: false, error: 'Không tìm thấy nhân viên hoặc đã ngừng làm' }
      if (d.kind === 'kitchen' && row.role !== 'kitchen' && !isManager(row.role)) return { ok: false, error: 'Máy bếp chỉ đăng nhập tài khoản bếp hoặc quản lý' }
      const r = await checkPin(s, row, pin, 'sign_in')
      if (!r.ok) return r
      // this tab's previous person is signed out (the device has one person at a time per screen)
      if (myToken) for (const x of s.sessions) if (x.token === myToken && !x.endedAt) x.endedAt = iso()
      const expiresAt = row.role === 'kitchen' ? null : new Date(now().getTime() + s.settings.idleMinutes * 60_000).toISOString()
      const sess: SessionRow = { token: randomHex(24), staffId: row.id, deviceId: d.id, startedAt: iso(), lastSeenAt: iso(), expiresAt, endedAt: null }
      s.sessions = [...s.sessions.filter(x => !x.endedAt).slice(-50), sess]
      d.lastSeenAt = iso()
      keepToken(sess.token, row.role === 'kitchen')
      audit(s, 'sign_in', { device: d.name }, row.id)
      save()
      return { ok: true, session: toSession(sess, row) }
    },
    async resume() {
      const s = await db()
      const r = liveSession(s, myToken)
      if (!r) {
        if (myToken) keepToken(null, false)
        return null
      }
      return toSession(r, staffOf(s, r.staffId)!)
    },
    async touch() {
      const s = await db()
      const r = liveSession(s, myToken) ?? fail('Phiên đăng nhập đã hết: đăng nhập lại')
      r.lastSeenAt = iso()
      if (r.expiresAt) r.expiresAt = new Date(now().getTime() + s.settings.idleMinutes * 60_000).toISOString()
      save()
      return r.expiresAt
    },
    async signOut() {
      const s = await db()
      const r = liveSession(s, myToken)
      if (r) {
        r.endedAt = iso()
        audit(s, 'sign_out', {}, r.staffId)
        save()
      }
      keepToken(null, false)
    },
    async verifyManagerPin(managerId, pin, req): Promise<ApprovalResult> {
      const s = await db()
      const asker = me(s) ?? fail('Đăng nhập trước khi xin quản lý duyệt')
      if (req.action === 'discount' && !(typeof req.amount === 'number' && req.amount > 0)) fail('Ghi số tiền giảm cần duyệt')
      if (req.action === 'void_item' && !req.lineId) fail('Chọn món cần duyệt')
      const m = s.staff.find(x => x.id === managerId && x.active && isManager(x.role))
      if (!m) return { ok: false, error: 'Chỉ quản lý hoặc chủ quán duyệt được' }
      const r = await checkPin(s, m, pin, `approve_${req.action}`)
      if (!r.ok) return r
      const a: Approval = { ...req, token: randomHex(24), managerId: m.id, requestedBy: asker.id, expiresAt: now().getTime() + s.settings.approvalSeconds * 1000, used: false }
      approvals.set(a.token, a)
      audit(s, 'approval', { for: req.action, order: req.orderId, ...(req.amount ? { amount: req.amount } : {}), ...(req.lineId ? { line: req.lineId } : {}) }, asker.id, m.id)
      save()
      return { ok: true, token: a.token, managerId: m.id, managerName: m.name, expiresAt: new Date(a.expiresAt).toISOString() }
    },
    consumeApproval(token, need) {
      if (!token || !store) return null
      const a = approvals.get(token)
      const asker = me(store)
      if (!a || a.used || !asker || a.requestedBy !== asker.id || a.action !== need.action || a.orderId !== need.orderId) return null
      if (a.expiresAt <= now().getTime()) return null
      if (need.lineId && a.lineId !== need.lineId) return null
      if (need.amount != null && (a.amount ?? 0) < need.amount) return null
      const m = store.staff.find(x => x.id === a.managerId && x.active && isManager(x.role))
      if (!m) return null
      a.used = true
      audit(store, need.action, { order: need.orderId, ...(need.amount ? { amount: need.amount } : {}), ...(need.lineId ? { line: need.lineId } : {}) }, asker.id, m.id)
      save()
      return m.name
    },
    current() {
      if (!store) return null
      const r = liveSession(store, myToken)
      return r ? toSession(r, staffOf(store, r.staffId)!) : null
    },
    async listStaff() {
      const s = await db()
      requireManager(s)
      const t = now()
      return [...s.staff]
        .sort((a, b) => Number(b.active) - Number(a.active) || ADMIN_ORDER.indexOf(a.role) - ADMIN_ORDER.indexOf(b.role) || a.name.localeCompare(b.name, 'vi'))
        .map((x): StaffRecord => {
          const live = s.sessions.filter(r => r.staffId === x.id && !r.endedAt && (!r.expiresAt || new Date(r.expiresAt) > t))
          const seen = s.sessions.filter(r => r.staffId === x.id).map(r => r.lastSeenAt).sort().pop() ?? null
          return {
            id: x.id, name: x.name, role: x.role, active: x.active, hasPin: !!x.pinHash, pinSetAt: x.pinSetAt,
            lockedUntil: isLocked(x.lockedUntil, t) ? x.lockedUntil : null,
            signedInOn: live.length ? (s.devices.find(d => d.id === live[live.length - 1].deviceId)?.name ?? '') : null, lastSeenAt: seen,
          }
        })
    },
    async saveStaff(inp) {
      const s = await db()
      const m = requireManager(s)
      const name = inp.name.trim()
      if (name.length < 1 || name.length > 40) fail('Nhập tên nhân viên (tối đa 40 ký tự)')
      if (!(inp.role in ROLE_LABEL)) fail('Vai trò không hợp lệ')
      if (s.staff.some(x => x.active && x.id !== inp.id && x.name.toLowerCase() === name.toLowerCase())) fail(`Đã có nhân viên tên "${name}": thêm họ hoặc số để phân biệt`)
      if (!inp.id) {
        if (!mayManage(s, inp.role, null)) fail('Chỉ chủ quán được thêm quản lý hoặc chủ quán')
        if (!inp.pin) fail('Đặt mã PIN cho nhân viên mới')
        const row: StaffRow = { id: newId(), name, role: inp.role, active: true, salt: '', pinHash: null, pinSetAt: null, failedCount: 0, lockedUntil: null }
        await setPin(row, inp.pin)
        s.staff.push(row)
        audit(s, 'staff_add', { name, role: inp.role })
        save()
        return row.id
      }
      const row = s.staff.find(x => x.id === inp.id) ?? fail('Không tìm thấy nhân viên')
      if (!mayManage(s, row.role, row.id) || (inp.role !== row.role && !mayManage(s, inp.role, null))) fail('Chỉ chủ quán được sửa quản lý hoặc chủ quán')
      if (row.id === m.id && inp.role !== row.role) fail('Không tự đổi vai trò của mình')
      if (inp.pin) await setPin(row, inp.pin)
      const was = { name: row.name, role: row.role }
      row.name = name
      row.role = inp.role
      if (inp.pin) endSessions(s, row.id, myToken)
      audit(s, 'staff_edit', { name, role: inp.role, was, pin_reset: !!inp.pin })
      save()
      return row.id
    },
    async resetPin(staffId, pin) {
      const s = await db()
      requireManager(s)
      const row = s.staff.find(x => x.id === staffId) ?? fail('Không tìm thấy nhân viên')
      if (!mayManage(s, row.role, row.id)) fail('Chỉ chủ quán được đặt lại PIN của quản lý hoặc chủ quán')
      await setPin(row, pin)
      endSessions(s, row.id, myToken)
      audit(s, 'pin_reset', { name: row.name })
      save()
    },
    async setStaffActive(staffId, active) {
      const s = await db()
      const m = requireManager(s)
      const row = s.staff.find(x => x.id === staffId) ?? fail('Không tìm thấy nhân viên')
      if (!mayManage(s, row.role, row.id)) fail('Chỉ chủ quán được khoá quản lý hoặc chủ quán')
      if (row.id === m.id && !active) fail('Không tự khoá tài khoản của mình')
      if (!active && row.role === 'owner' && !s.staff.some(x => x.role === 'owner' && x.active && x.id !== row.id)) fail('Phải còn ít nhất một chủ quán')
      row.active = active
      if (!active) endSessions(s, row.id)
      audit(s, active ? 'staff_on' : 'staff_off', { name: row.name })
      save()
    },
    async devices() {
      const s = await db()
      requireManager(s)
      return s.devices.map(d => ({ ...d }))
    },
    async createDeviceCode(name, kind) {
      const s = await db()
      requireManager(s)
      if (name.trim().length < 1 || name.trim().length > 40) fail('Đặt tên máy (1–40 ký tự)')
      const A = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'
      const b = crypto.getRandomValues(new Uint8Array(8))
      const raw = [...b].map(x => A[x % 32]).join('')
      const c = { code: `${raw.slice(0, 4)}-${raw.slice(4)}`, name: name.trim(), kind, expiresAt: new Date(now().getTime() + 30 * 60_000).toISOString(), used: false }
      s.codes = [...s.codes.filter(x => !x.used && new Date(x.expiresAt) > now()), c]
      audit(s, 'device_code', { name: c.name, kind })
      save()
      return { code: c.code, name: c.name, kind, expiresAt: c.expiresAt }
    },
    async setDeviceActive(id, active) {
      const s = await db()
      requireManager(s)
      const d = s.devices.find(x => x.id === id) ?? fail('Không tìm thấy máy')
      if (!active && d.id === myDeviceId) fail('Đang dùng máy này: khoá từ máy khác')
      d.active = active
      if (!active) for (const r of s.sessions) if (r.deviceId === id && !r.endedAt) r.endedAt = iso()
      audit(s, active ? 'device_on' : 'device_off', { device: d.name })
      save()
    },
    async audit(limit = 100) {
      const s = await db()
      requireManager(s)
      const nm = (id: string | null) => (id ? (staffOf(s, id)?.name ?? '') : '')
      return s.audit.slice(0, limit).map((a): AuditEntry => ({
        id: a.id, at: a.at, action: a.action, staff: nm(a.staffId), approvedBy: nm(a.approvedBy),
        device: s.devices.find(d => d.id === a.deviceId)?.name ?? '', detail: a.detail,
      }))
    },
    subscribe(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    samplePins() {
      return Object.fromEntries((opts.staff ?? SAMPLE_STAFF).map(x => [x.id, x.pin]))
    },
  }
  return repo
}
