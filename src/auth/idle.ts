// Idle sign-out on shared devices. Kitchen accounts stay signed in (the display runs all evening).

import type { Role } from './types'

export const TOUCH_EVERY_MS = 60_000

export function idleLimitMs(role: Role, idleMinutes: number): number | null {
  return role === 'kitchen' ? null : Math.max(1, idleMinutes) * 60_000
}

/** True once nobody touched the screen for the idle limit. */
export function isIdle(role: Role, lastActivity: number, now: number, idleMinutes: number): boolean {
  const limit = idleLimitMs(role, idleMinutes)
  return limit !== null && now - lastActivity >= limit
}

/** Tell the server about activity at most once a minute (it pushes its own idle expiry back). */
export function shouldTouch(lastActivity: number, lastTouch: number, now: number): boolean {
  return lastActivity > lastTouch && now - lastTouch >= TOUCH_EVERY_MS
}
