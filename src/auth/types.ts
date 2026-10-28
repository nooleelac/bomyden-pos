// Staff, devices, sessions and manager approvals (0006). Same shapes for the sample engine (memoryRepo.ts)
// and the database (supabaseRepo.ts).

import type { Role } from '../floor/types'

export type { Role }

export const ROLES: Role[] = ['waiter', 'cashier', 'kitchen', 'manager', 'owner']

export const ROLE_LABEL: Record<Role, string> = {
  waiter: 'Phục vụ',
  cashier: 'Thu ngân',
  kitchen: 'Bếp',
  manager: 'Quản lý',
  owner: 'Chủ quán',
}

export type DeviceKind = 'pos' | 'kitchen'

export interface Device {
  id: string
  name: string
  kind: DeviceKind
  active: boolean
  /** The branch this device was registered for (0022). */
  branchName?: string
}

/** Opening hours by ISO weekday ('1' = Thứ Hai … '7' = Chủ nhật), HH:MM; a missing day is closed, {} = no hours set. */
export type Weekday = '1' | '2' | '3' | '4' | '5' | '6' | '7'
export type OpeningHours = Partial<Record<Weekday, { open: string; close: string }>>

/** A row on Cài đặt → Chi nhánh (0022). */
export interface Branch {
  id: string
  name: string
  active: boolean
  address: string
  phone: string
  openingHours: OpeningHours
  /** Outside the hours only quản lý / chủ quán open tables or takeaway orders. */
  enforceHours: boolean
  /** HH:MM where the business day (reports, takeaway numbers) starts. */
  businessDayStart: string
  staff: number
  devices: number
  items: number
}

/** The branch this session works in: the device's, or the one the owner switched to. */
export interface BranchInfo {
  id: string
  name: string
  deviceBranchId: string | null
  /** Owners may work in any branch. */
  canSwitch: boolean
  /** Inside the opening hours now (or no hours set). */
  isOpen: boolean
}

export interface BranchInput {
  id?: string
  name: string
  active?: boolean
  /** New branch: copy this branch's menu (dishes, groups, options, stations). */
  copyFrom?: string | null
}

/** A name on the sign-in screen. */
export interface RosterEntry {
  id: string
  name: string
  role: Role
  hasPin: boolean
  /** Locked after too many wrong PINs until then (ISO). */
  lockedUntil: string | null
}

/** A row on the staff screen (managers). */
export interface StaffRecord extends RosterEntry {
  active: boolean
  pinSetAt: string | null
  /** Device name where this person is signed in now. */
  signedInOn: string | null
  lastSeenAt: string | null
}

export interface Session {
  staffId: string
  name: string
  role: Role
  /** Opaque token (sent as x-staff-session in Supabase mode). */
  token: string
  /** Idle sign-out time (ISO); null = stays signed in (kitchen accounts). */
  expiresAt: string | null
}

export type PinResult =
  | { ok: true }
  | { ok: false; error: string; attemptsLeft?: number; lockedUntil?: string }

export type SignInResult = { ok: true; session: Session } | Extract<PinResult, { ok: false }>

export type ApprovalAction = 'discount' | 'void_item' | 'void_order'

export interface ApprovalRequest {
  action: ApprovalAction
  orderId: string
  /** discount: the most that may be taken off (đồng). */
  amount?: number
  /** void_item: the line. */
  lineId?: string
}

export type ApprovalResult =
  | { ok: true; token: string; managerId: string; managerName: string; expiresAt: string }
  | Extract<PinResult, { ok: false }>

export interface AuthSettings {
  /** Auto sign-out after this many idle minutes (not for kitchen accounts). */
  idleMinutes: number
  /** Wrong PINs before a lock, and how long the lock lasts. */
  maxAttempts: number
  lockMinutes: number
  /** Seconds an approval token stays valid. */
  approvalSeconds: number
  /** 'sent': voiding any sent line needs a manager; 'started': only lines the kitchen started, finished or served. */
  voidApproval: 'sent' | 'started'
}

export const DEFAULT_AUTH_SETTINGS: AuthSettings = { idleMinutes: 5, maxAttempts: 5, lockMinutes: 5, approvalSeconds: 120, voidApproval: 'sent' }

export interface AuditEntry {
  id: string
  at: string
  action: string
  staff: string
  approvedBy: string
  device: string
  detail: Record<string, unknown>
}

export interface DeviceCode {
  code: string
  name: string
  kind: DeviceKind
  expiresAt: string
}

export interface StaffInput {
  id?: string
  name: string
  role: Role
  /** Required for a new person; on edit it replaces the PIN. */
  pin?: string
}
