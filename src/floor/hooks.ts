// Data hooks shared by the floor and kitchen screens: live state from the repos, a ticking clock, the hash route.

import { createContext, useEffect, useState } from 'react'
import type { MenuRepo } from '../menu/repo'
import type { Menu } from '../menu/types'
import type { FloorRepo } from './repo'
import type { Actor, FloorState } from './types'

export function useLive(floorRepo: FloorRepo, menuRepo: MenuRepo, onError: (m: string) => void) {
  const floor = useSource<FloorState>(floorRepo, onError)
  const menu = useSource<Menu>(menuRepo, onError)
  return { floor, menu }
}

// One live copy per repo, shared by every component that reads it (the screen and the notification bell), so a
// change on another device is loaded once, not once per reader.
interface Source<T> {
  load(): Promise<T>
  subscribe(onChange: () => void): () => void
}
interface Store {
  value: unknown
  seq: number
  readers: Set<() => void>
  errors: Set<(e: unknown) => void>
  unsubscribe: (() => void) | null
  reload: () => void
}
const stores = new WeakMap<object, Store>()
function storeOf(src: Source<unknown>): Store {
  let st = stores.get(src)
  if (!st) {
    const s: Store = {
      value: null,
      seq: 0,
      readers: new Set(),
      errors: new Set(),
      unsubscribe: null,
      reload: () => {
        const n = ++s.seq
        src.load().then(
          v => {
            if (n !== s.seq) return // a newer load is on its way
            s.value = v
            s.readers.forEach(f => f())
          },
          e => s.errors.forEach(f => f(e)),
        )
      },
    }
    stores.set(src, s)
    st = s
  }
  return st
}

/** Live value of a repo (reloaded on every change it reports). */
export function useSource<T>(src: Source<T>, onError?: (m: string) => void): T | null {
  const st = storeOf(src as Source<unknown>)
  const [value, setValue] = useState(() => st.value as T | null)
  useEffect(() => {
    const read = () => setValue(st.value as T)
    const err = (e: unknown) => onError?.(errText(e))
    st.readers.add(read)
    st.errors.add(err)
    if (!st.unsubscribe) st.unsubscribe = src.subscribe(st.reload)
    st.reload()
    return () => {
      st.readers.delete(read)
      st.errors.delete(err)
      if (!st.readers.size) {
        st.unsubscribe?.()
        st.unsubscribe = null
      }
    }
  }, [st, src, onError])
  return value
}

/** The app's repos, for parts of the frame (the bell) that sit outside a screen. */
export const ReposContext = createContext<{ floor: FloorRepo; menu: MenuRepo } | null>(null)

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

// Orders this device just opened from the map. Leaving one before anything was sent hands the table back (an
// accidental tap must not leave a table "Đang ngồi"); see OrderView.
const quickKey = (id: string) => `bmd-quick-${id}`
export function markQuickOpened(id: string) {
  try {
    sessionStorage.setItem(quickKey(id), '1')
  } catch {
    /* ignore */
  }
}
export function takeQuickOpened(id: string): boolean {
  try {
    const on = sessionStorage.getItem(quickKey(id)) === '1'
    sessionStorage.removeItem(quickKey(id))
    return on
  } catch {
    return false
  }
}
