// Chống phá (0026) on the guest's phone: with a geofence, the QR page asks for GPS as soon as it opens and keeps
// following it; the menu shows only while the server says the phone is close enough. The fix rides along with every
// request (the server checks it again).

import { useCallback, useEffect, useRef, useState } from 'react'
import { distanceM, type GeoFix } from '../lib/geo'
import { errText } from '../floor/hooks'
import type { GuestRepo } from './repo'

export type GeoPhase = 'off' | 'asking' | 'denied' | 'unavailable' | 'error' | 'far' | 'ok'

export interface GeoGate {
  phase: GeoPhase
  /** Why it is not ok (far: the distance; error: what went wrong). */
  message: string
  /** Latest fix, for the requests. */
  fix: GeoFix | null
  retry: () => void
}

/** A new fix is checked with the server when it moved this far, or after CHECK_MS. */
const MOVE_M = 15
const CHECK_MS = 20_000

export function useGeoGate(repo: GuestRepo, token: string, radius: number | null): GeoGate {
  const [phase, setPhase] = useState<GeoPhase>(radius == null ? 'off' : 'asking')
  const [message, setMessage] = useState('')
  const [fix, setFix] = useState<GeoFix | null>(null)
  const [round, setRound] = useState(0)
  const last = useRef<{ fix: GeoFix; at: number } | null>(null)

  useEffect(() => {
    if (radius == null) {
      setPhase('off')
      return
    }
    if (typeof navigator === 'undefined' || !navigator.geolocation || (typeof isSecureContext !== 'undefined' && !isSecureContext)) {
      setPhase('unavailable')
      return
    }
    setPhase(p => (p === 'ok' || p === 'far' ? p : 'asking'))
    let stop = false
    const check = (f: GeoFix) => {
      const prev = last.current
      if (prev && Date.now() - prev.at < CHECK_MS && distanceM(prev.fix, f) < MOVE_M) return
      last.current = { fix: f, at: Date.now() }
      repo.checkGeo(token, f).then(
        problem => {
          if (stop) return
          setPhase(problem ? 'far' : 'ok')
          setMessage(problem ?? '')
        },
        e => {
          if (stop) return
          last.current = null
          setPhase(p => (p === 'ok' ? p : 'error'))
          setMessage(errText(e))
        },
      )
    }
    const id = navigator.geolocation.watchPosition(
      p => {
        if (stop) return
        const f = { lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy }
        setFix(f)
        check(f)
      },
      e => {
        if (stop) return
        if (e.code === e.PERMISSION_DENIED) setPhase('denied')
        else {
          setPhase(p => (p === 'ok' || p === 'far' ? p : 'error'))
          setMessage(e.code === e.TIMEOUT ? 'Chưa lấy được vị trí: ra gần cửa sổ hoặc bật Wi-Fi rồi thử lại' : 'Không lấy được vị trí của điện thoại')
        }
      },
      { enableHighAccuracy: true, maximumAge: 10_000, timeout: 20_000 },
    )
    return () => {
      stop = true
      navigator.geolocation.clearWatch(id)
    }
  }, [repo, token, radius, round])

  const retry = useCallback(() => {
    last.current = null
    setPhase('asking')
    setRound(r => r + 1)
  }, [])
  return { phase, message, fix, retry }
}
