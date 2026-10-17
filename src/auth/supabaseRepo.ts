// AuthRepo on Supabase (0006). The device is a Supabase auth user (anonymous sign-in, then register_device with a
// manager's code); staff sign in with a PIN (staff_sign_in, bcrypt on the server) and the session token rides on
// every request as x-staff-session (see token.ts). Approvals come from verify_manager_pin and are checked again
// inside pay_order / void_item / void_order. Not exercised against a live project yet: the SQL is tested on a
// local Postgres 16 (supabase/tests/0006_staff_auth_test.sql).

import type { SupabaseClient } from '@supabase/supabase-js'
import type { AuthRepo, DeviceRow } from './repo'
import { staffToken } from './token'
import {
  DEFAULT_AUTH_SETTINGS,
  type ApprovalResult, type AuditEntry, type AuthSettings, type Device, type Role, type RosterEntry, type Session, type SignInResult, type StaffRecord,
} from './types'

type Row = Record<string, unknown>
const SESSION_KEY = 'bmd-staff-session'

async function rpc<T = Row>(db: SupabaseClient, fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await db.rpc(fn, args)
  if (error) throw new Error(error.message)
  return data as T
}
async function rows(q: PromiseLike<{ data: Row[] | null; error: { message: string } | null }>): Promise<Row[]> {
  const { data, error } = await q
  if (error) throw new Error(error.message)
  return data ?? []
}
const s = (v: unknown) => (v == null ? '' : String(v))
const sn = (v: unknown) => (v == null ? null : String(v))

function pinFail(r: Row): { ok: false; error: string; attemptsLeft?: number; lockedUntil?: string } {
  return { ok: false, error: s(r.error) || 'Không đăng nhập được', ...(r.attempts_left != null ? { attemptsLeft: Number(r.attempts_left) } : {}), ...(r.locked_until ? { lockedUntil: s(r.locked_until) } : {}) }
}

function keep(sess: Session | null) {
  staffToken.current = sess?.token ?? null
  try {
    if (sess) sessionStorage.setItem(SESSION_KEY, JSON.stringify(sess))
    else sessionStorage.removeItem(SESSION_KEY)
    if (sess && sess.role === 'kitchen') localStorage.setItem(SESSION_KEY, JSON.stringify(sess))
    else localStorage.removeItem(SESSION_KEY)
  } catch {
    /* in memory only */
  }
}
function stored(): Session | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY) ?? localStorage.getItem(SESSION_KEY)
    return raw ? (JSON.parse(raw) as Session) : null
  } catch {
    return null
  }
}

export function createSupabaseAuthRepo(db: SupabaseClient): AuthRepo {
  const toDevice = (d: Row): Device => ({ id: s(d.id), name: s(d.name), kind: d.kind === 'kitchen' ? 'kitchen' : 'pos', active: d.active !== false })
  return {
    source: 'supabase',
    async device() {
      const { data } = await db.auth.getSession()
      if (!data.session) return null
      const d = await rpc<Row | null>(db, 'my_device')
      return d ? toDevice(d) : null
    },
    async registerDevice(code) {
      const { data } = await db.auth.getSession()
      if (!data.session) {
        const { error } = await db.auth.signInAnonymously()
        if (error) throw new Error(`Không kết nối được máy chủ: ${error.message}`)
      }
      return toDevice(await rpc<Row>(db, 'register_device', { p_code: code }))
    },
    async settings(): Promise<AuthSettings> {
      const r = (await rows(db.from('shop_settings').select('idle_signout_min, pin_max_attempts, pin_lock_min, approval_ttl_sec, void_approval').limit(1)).catch(() => []))[0]
      if (!r) {
        const d = await rpc<Row | null>(db, 'my_device').catch(() => null)
        return { ...DEFAULT_AUTH_SETTINGS, idleMinutes: Number(d?.idle_min ?? DEFAULT_AUTH_SETTINGS.idleMinutes) }
      }
      return {
        idleMinutes: Number(r.idle_signout_min), maxAttempts: Number(r.pin_max_attempts), lockMinutes: Number(r.pin_lock_min),
        approvalSeconds: Number(r.approval_ttl_sec), voidApproval: r.void_approval === 'started' ? 'started' : 'sent',
      }
    },
    async saveSettings(p) {
      const row: Row = {}
      if (p.idleMinutes !== undefined) row.idle_signout_min = p.idleMinutes
      if (p.maxAttempts !== undefined) row.pin_max_attempts = p.maxAttempts
      if (p.lockMinutes !== undefined) row.pin_lock_min = p.lockMinutes
      if (p.approvalSeconds !== undefined) row.approval_ttl_sec = p.approvalSeconds
      if (p.voidApproval !== undefined) row.void_approval = p.voidApproval
      const { error } = await db.from('shop_settings').update(row).eq('id', 1)
      if (error) throw new Error(error.message)
    },
    async roster() {
      return (await rpc<Row[]>(db, 'signin_roster')).map((r): RosterEntry => ({
        id: s(r.id), name: s(r.name), role: r.role as Role, hasPin: r.has_pin === true, lockedUntil: sn(r.locked_until),
      }))
    },
    async signIn(staffId, pin): Promise<SignInResult> {
      const r = await rpc<Row>(db, 'staff_sign_in', { p_staff: staffId, p_pin: pin })
      if (r.ok !== true) return pinFail(r)
      const st = r.staff as Row
      const sess: Session = { staffId: s(st.id), name: s(st.name), role: st.role as Role, token: s(r.token), expiresAt: sn(r.expires_at) }
      keep(sess)
      return { ok: true, session: sess }
    },
    async resume() {
      const sess = stored()
      if (!sess) return null
      staffToken.current = sess.token
      try {
        const exp = await rpc<string | null>(db, 'touch_session')
        const next = { ...sess, expiresAt: exp }
        keep(next)
        return next
      } catch {
        keep(null)
        return null
      }
    },
    async touch() {
      return rpc<string | null>(db, 'touch_session')
    },
    async signOut() {
      try {
        if (staffToken.current) await rpc(db, 'staff_sign_out')
      } finally {
        keep(null)
      }
    },
    async verifyManagerPin(managerId, pin, req): Promise<ApprovalResult> {
      const detail = req.action === 'discount' ? { amount: req.amount } : req.action === 'void_item' ? { line: req.lineId } : {}
      const r = await rpc<Row>(db, 'verify_manager_pin', { p_manager: managerId, p_pin: pin, p_action: req.action, p_order: req.orderId, p_detail: detail })
      if (r.ok !== true) return pinFail(r)
      const m = r.manager as Row
      return { ok: true, token: s(r.token), managerId: s(m.id), managerName: s(m.name), expiresAt: s(r.expires_at) }
    },
    async listStaff() {
      return (await rpc<Row[]>(db, 'staff_admin_list')).map((r): StaffRecord => ({
        id: s(r.id), name: s(r.name), role: r.role as Role, active: r.active === true, hasPin: r.has_pin === true, pinSetAt: sn(r.pin_set_at),
        lockedUntil: sn(r.locked_until), signedInOn: sn(r.signed_in_on), lastSeenAt: sn(r.last_seen_at),
      }))
    },
    async saveStaff(inp) {
      const r = await rpc<Row>(db, 'staff_save', { p_id: inp.id ?? null, p_name: inp.name, p_role: inp.role, p_pin: inp.pin || null })
      return s(r.id)
    },
    resetPin: async (id, pin) => void (await rpc(db, 'staff_reset_pin', { p_staff: id, p_pin: pin })),
    setStaffActive: async (id, active) => void (await rpc(db, 'staff_set_active', { p_staff: id, p_active: active })),
    async devices() {
      return (await rows(db.from('devices').select('id, name, kind, active, last_seen_at').order('registered_at'))).map((d): DeviceRow => ({ ...toDevice(d), lastSeenAt: sn(d.last_seen_at) }))
    },
    async createDeviceCode(name, kind) {
      const r = await rpc<Row>(db, 'create_device_code', { p_name: name, p_kind: kind })
      return { code: s(r.code), name: s(r.name), kind, expiresAt: s(r.expires_at) }
    },
    setDeviceActive: async (id, active) => void (await rpc(db, 'device_set_active', { p_device: id, p_active: active })),
    async audit(limit = 100) {
      const [log, staff, devices] = await Promise.all([
        rows(db.from('audit_log').select('id, at, action, staff_id, approved_by, device_id, detail').order('at', { ascending: false }).limit(limit)),
        rows(db.from('staff').select('id, name')),
        rows(db.from('devices').select('id, name')),
      ])
      const nm = (list: Row[], id: unknown) => s(list.find(x => x.id === id)?.name)
      return log.map((a): AuditEntry => ({
        id: s(a.id), at: s(a.at), action: s(a.action), staff: nm(staff, a.staff_id), approvedBy: nm(staff, a.approved_by), device: nm(devices, a.device_id),
        detail: (a.detail as Record<string, unknown>) ?? {},
      }))
    },
    subscribe(onChange) {
      const ch = db.channel('staff-changes')
      for (const table of ['staff', 'devices']) ch.on('postgres_changes', { event: '*', schema: 'public', table }, onChange)
      ch.subscribe()
      return () => void db.removeChannel(ch)
    },
  }
}
