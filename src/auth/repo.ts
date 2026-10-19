// Sign-in, staff management and manager approval talk to this interface only.
// createMemoryAuthRepo (memoryRepo.ts) runs on sample staff in this browser; createSupabaseAuthRepo
// (supabaseRepo.ts) runs the same screens on 0006 (PINs hashed with bcrypt on the server).

import type { Perm, PermMatrix, PermRole } from './permissions'
import type {
  ApprovalRequest, ApprovalResult, AuditEntry, AuthSettings, Device, DeviceCode, DeviceKind, RosterEntry, Session, SignInResult, StaffInput, StaffRecord,
} from './types'

export interface DeviceRow extends Device {
  lastSeenAt: string | null
}

export interface AuthRepo {
  readonly source: 'sample' | 'supabase'
  /** This device, or null until it is registered. */
  device(): Promise<Device | null>
  /** Register this device once, with a code from a manager (Nhân viên → Máy). */
  registerDevice(code: string): Promise<Device>
  settings(): Promise<AuthSettings>
  saveSettings(p: Partial<AuthSettings>): Promise<void>
  /** Names on the sign-in screen of this device. */
  roster(): Promise<RosterEntry[]>
  signIn(staffId: string, pin: string): Promise<SignInResult>
  /** The session this tab had before a reload, if still valid. */
  resume(): Promise<Session | null>
  /** Activity: push the idle sign-out back. Resolves with the new expiry; rejects when the session is over. */
  touch(): Promise<string | null>
  signOut(): Promise<void>
  /** A manager's PIN for one action on one order: a short-lived single-use token. Wrong PINs count to the lock. */
  verifyManagerPin(managerId: string, pin: string, req: ApprovalRequest): Promise<ApprovalResult>
  listStaff(): Promise<StaffRecord[]>
  /** Add (no id; PIN required) or edit. Resolves with the staff id. */
  saveStaff(inp: StaffInput): Promise<string>
  resetPin(staffId: string, pin: string): Promise<void>
  setStaffActive(staffId: string, active: boolean): Promise<void>
  devices(): Promise<DeviceRow[]>
  createDeviceCode(name: string, kind: DeviceKind): Promise<DeviceCode>
  setDeviceActive(id: string, active: boolean): Promise<void>
  /**
   * Xoá vĩnh viễn (admin.delete, admin_delete in 0010): a person with their PIN and sessions (not oneself, not the
   * last owner; managers and owners only by the owner), or a device with its sessions (not this one).
   */
  adminDelete(kind: 'staff' | 'device', id: string): Promise<void>
  audit(limit?: number): Promise<AuditEntry[]>
  /** What each role may do (0009). Everyone signed in reads it; the owner always has everything. */
  permissions(): Promise<PermMatrix>
  /** Owner only: replace one role's permissions. Resolves with what the role has now. */
  savePermissions(role: PermRole, perms: Perm[]): Promise<Perm[]>
  /** Staff, device or permission changes from any tab/device. Returns unsubscribe. */
  subscribe(onChange: () => void): () => void
  /** Sample only: the sample PINs shown on the sign-in screen. */
  samplePins?(): Record<string, string>
}
