// One live feed for the Supabase repos (floor, menu, staff). Realtime alone misses changes: a phone or tablet that
// goes to the background, locks or drops Wi-Fi loses its socket, and the rows changed meanwhile never arrive, so a
// new order only showed after the app was closed and opened again. This feed reloads whenever it may have missed
// something — the channel (re)joins, the screen comes back, the network returns — resubscribes a channel that
// errors or closes, and loads every `pollMs` while the screen is shown in case the socket died without telling.

import type { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js'

let channelNo = 0 // a fresh name per listener: a second .on() on a subscribed channel throws

export function liveTables(db: SupabaseClient, name: string, tables: readonly string[], onChange: () => void, pollMs = 15000): () => void {
  let stopped = false
  let ch: RealtimeChannel | null = null
  let burst: ReturnType<typeof setTimeout> | null = null
  let retry: ReturnType<typeof setTimeout> | null = null
  let joined = false // the first join needs no reload (the reader loads on its own)
  let lastFire = Date.now()

  const fire = (wait = 80) => {
    if (stopped) return
    if (burst) clearTimeout(burst)
    burst = setTimeout(() => {
      lastFire = Date.now()
      onChange()
    }, wait) // one reload for a burst of row changes
  }

  const join = () => {
    if (stopped) return
    const c = db.channel(`${name}-${++channelNo}`)
    for (const table of tables) c.on('postgres_changes', { event: '*', schema: 'public', table }, () => fire())
    c.subscribe(status => {
      if (stopped || c !== ch) return
      if (status === 'SUBSCRIBED') {
        if (joined) fire() // back after a drop: load what was missed
        joined = true
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
        // a fresh channel (fresh token) in a moment; the screen keeps the last copy meanwhile
        if (retry) return
        retry = setTimeout(() => {
          retry = null
          if (stopped || c !== ch) return
          ch = null
          void db.removeChannel(c)
          join()
        }, 2000)
      }
    })
    ch = c
  }
  join()

  // back on screen after a while, network back, page restored: whatever came meanwhile may be missing
  let hiddenAt = 0
  const wake = (e?: Event) => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
      hiddenAt = Date.now()
      return
    }
    if (e?.type === 'visibilitychange' && Date.now() - hiddenAt < 2000) return // a quick app switch: realtime kept up
    if (e?.type === 'pageshow' && !(e as PageTransitionEvent).persisted) return // the first load, not a restore
    fire(0)
    // a socket that died in the background may still look joined: start over
    if (ch && ch.state !== 'joined') {
      const old = ch
      ch = null
      void db.removeChannel(old)
      join()
    }
  }
  const poll = setInterval(() => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
    if (Date.now() - lastFire >= pollMs - 500) fire(0)
  }, pollMs)
  if (typeof window !== 'undefined') {
    document.addEventListener('visibilitychange', wake)
    window.addEventListener('online', wake)
    window.addEventListener('pageshow', wake)
  }

  return () => {
    stopped = true
    if (burst) clearTimeout(burst)
    if (retry) clearTimeout(retry)
    clearInterval(poll)
    if (typeof window !== 'undefined') {
      document.removeEventListener('visibilitychange', wake)
      window.removeEventListener('online', wake)
      window.removeEventListener('pageshow', wake)
    }
    if (ch) void db.removeChannel(ch)
    ch = null
  }
}
