// Who is signed in on this screen, and the manager-approval prompt. Provided by AuthGate.

import { createContext, useContext } from 'react'
import type { Perm, PermMatrix } from './permissions'
import type { AuthRepo } from './repo'
import type { ApprovalRequest, AuthSettings, BranchInfo, Device, Session } from './types'

export interface ApprovalPrompt extends ApprovalRequest {
  /** What is being approved, e.g. "Huỷ 2 Steak bò nướng". */
  title: string
  subtitle?: string
}

export interface Approved {
  token: string
  managerName: string
  expiresAt: string
}

export interface AuthValue {
  repo: AuthRepo
  session: Session
  device: Device
  settings: AuthSettings
  /** The branch this session works in (0022); null until loaded. */
  branch: BranchInfo | null
  /** Owner: work in another branch (every screen reloads with that branch's data). */
  switchBranch: (id: string) => Promise<void>
  /** What each role may do (the owner: everything). */
  perms: PermMatrix
  /** May the signed-in person do this? */
  can: (p: Perm) => boolean
  /** Đổi người: back to the names on this device. */
  signOut: () => void
  /** Ask a manager to enter their PIN here. Resolves with the token, or null when cancelled. */
  requestApproval: (p: ApprovalPrompt) => Promise<Approved | null>
}

export const AuthContext = createContext<AuthValue | null>(null)

export function useAuth(): AuthValue {
  const v = useContext(AuthContext)
  if (!v) throw new Error('useAuth outside AuthGate')
  return v
}

/** For screens that also run outside the gate (tests, previews). */
export function useOptionalAuth(): AuthValue | null {
  return useContext(AuthContext)
}
