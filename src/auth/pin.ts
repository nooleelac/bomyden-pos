// PIN rules and the failed-PIN lockout, as pin_problem / _check_pin in 0006. Pure functions: the sample engine
// keeps the state, the database keeps its own (staff_secrets) and only ever stores bcrypt hashes.

import type { AuthSettings, PinResult } from './types'

/** Why a new PIN is refused, or null when it is fine. 4–6 digits; not one digit repeated; not a straight run. */
export function pinProblem(pin: string): string | null {
  if (!/^[0-9]{4,6}$/.test(pin)) return 'Mã PIN gồm 4 đến 6 chữ số'
  if (/^(.)\1*$/.test(pin)) return 'Mã PIN không được toàn một chữ số'
  const d = [...pin].map(Number)
  const up = d.every((x, i) => i === 0 || x === (d[i - 1] + 1) % 10)
  const down = d.every((x, i) => i === 0 || x === (d[i - 1] + 9) % 10)
  if (up || down) return 'Mã PIN không được là dãy liên tiếp (1234, 4321…)'
  return null
}

export interface PinState {
  failedCount: number
  lockedUntil: string | null
}

const hhmm = (iso: string) =>
  new Date(new Date(iso).getTime() + 7 * 3600_000).toISOString().slice(11, 16) // shop time (UTC+7)

/**
 * One PIN attempt against the lockout. `matches` says whether the PIN was right (checked against the hash by
 * the caller). Returns the result and the new counter state; a lock wins over a right PIN.
 */
export function attemptPin(st: PinState, matches: boolean, now: Date, cfg: Pick<AuthSettings, 'maxAttempts' | 'lockMinutes'>): { result: PinResult; state: PinState; locked?: boolean } {
  if (st.lockedUntil && new Date(st.lockedUntil).getTime() > now.getTime()) {
    return { result: { ok: false, error: `Nhập sai quá nhiều lần: khoá đến ${hhmm(st.lockedUntil)}`, lockedUntil: st.lockedUntil }, state: st }
  }
  if (matches) return { result: { ok: true }, state: { failedCount: 0, lockedUntil: null } }
  const left = cfg.maxAttempts - st.failedCount - 1
  if (left <= 0) {
    const until = new Date(now.getTime() + cfg.lockMinutes * 60_000).toISOString()
    return {
      result: { ok: false, error: `Sai mã PIN ${cfg.maxAttempts} lần: khoá ${cfg.lockMinutes} phút`, lockedUntil: until },
      state: { failedCount: 0, lockedUntil: until },
      locked: true,
    }
  }
  return { result: { ok: false, error: `Mã PIN không đúng (còn ${left} lần thử)`, attemptsLeft: left }, state: { failedCount: st.failedCount + 1, lockedUntil: null } }
}

/** True while `lockedUntil` is in the future. */
export const isLocked = (lockedUntil: string | null, now: Date) => !!lockedUntil && new Date(lockedUntil).getTime() > now.getTime()
