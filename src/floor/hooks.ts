// Data hooks shared by the floor and kitchen screens: live state from the repos, a ticking clock, the hash route.

import { useCallback, useEffect, useState } from 'react'
import type { MenuRepo } from '../menu/repo'
import type { Menu } from '../menu/types'
import type { FloorRepo } from './repo'
import type { Actor, FloorState } from './types'

export function useLive(floorRepo: FloorRepo, menuRepo: MenuRepo, onError: (m: string) => void) {
  const [floor, setFloor] = useState<FloorState | null>(null)
  const [menu, setMenu] = useState<Menu | null>(null)
  const reloadFloor = useCallback(() => {
    floorRepo.load().then(setFloor, e => onError(errText(e)))
  }, [floorRepo, onError])
  const reloadMenu = useCallback(() => {
    menuRepo.load().then(setMenu, e => onError(errText(e)))
  }, [menuRepo, onError])
  useEffect(() => {
    reloadFloor()
    return floorRepo.subscribe(reloadFloor)
  }, [floorRepo, reloadFloor])
  useEffect(() => {
    reloadMenu()
    return menuRepo.subscribe(reloadMenu)
  }, [menuRepo, reloadMenu])
  return { floor, menu }
}

/** Shop time, refreshed every `ms` (timers on tiles and tickets). */
export function useNow(ms = 1000, offset = 0): Date {
  const [now, setNow] = useState(() => new Date(Date.now() + offset))
  useEffect(() => {
    const t = setInterval(() => setNow(new Date(Date.now() + offset)), ms)
    return () => clearInterval(t)
  }, [ms, offset])
  return now
}

export function readRoute(): string[] {
  return location.hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent)
}

export function useRoute(): string[] {
  const [r, setR] = useState(readRoute)
  useEffect(() => {
    const f = () => setR(readRoute())
    window.addEventListener('hashchange', f)
    return () => window.removeEventListener('hashchange', f)
  }, [])
  return r
}

export const go = (path: string) => {
  location.hash = '#/' + path
}

export function useOnline(): boolean {
  const [on, setOn] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine))
  useEffect(() => {
    const up = () => setOn(true)
    const down = () => setOn(false)
    window.addEventListener('online', up)
    window.addEventListener('offline', down)
    return () => {
      window.removeEventListener('online', up)
      window.removeEventListener('offline', down)
    }
  }, [])
  return on
}

export function errText(e: unknown): string {
  if (e instanceof Error) return e.message
  if (e && typeof e === 'object' && 'message' in e) return String((e as { message: unknown }).message)
  return String(e)
}

// ---------------------------------------------------------------- who is using this screen

/**
 * The person signed in on this tab (set by AuthGate on sign-in). The sample floor repo stamps orders, tickets and
 * payments with it; in Supabase mode the server knows from the PIN session instead.
 */
export const session: { actor: Actor } = { actor: { name: '', role: 'waiter' } }
