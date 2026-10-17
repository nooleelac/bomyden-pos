// Nothing opens until this device is registered and someone signed in with their PIN. Then: route guards by role,
// idle sign-out (not for kitchen accounts), and the manager-approval prompt for the screens below.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { errText, go, session as floorSession, useRoute } from '../floor/hooks'
import '../menu/menu.css'
import './auth.css'
import { ApprovalDialog } from './ApprovalDialog'
import { AuthContext, type ApprovalPrompt, type Approved, type AuthValue } from './context'
import { canOpen, homeRoute } from './guards'
import { isIdle, shouldTouch } from './idle'
import type { AuthRepo } from './repo'
import { BlockedScreen, DeviceSetup, SignInScreen } from './screens'
import { DEFAULT_AUTH_SETTINGS, type AuthSettings, type Device, type Session } from './types'

type Phase = { kind: 'loading' } | { kind: 'device'; off: Device | null } | { kind: 'signin' } | { kind: 'in'; session: Session }

export function AuthGate(props: { repo: AuthRepo; children: ReactNode }) {
  const { repo } = props
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' })
  const [device, setDevice] = useState<Device | null>(null)
  const [settings, setSettings] = useState<AuthSettings>(DEFAULT_AUTH_SETTINGS)
  const [notice, setNotice] = useState('')
  const [prompt, setPrompt] = useState<{ p: ApprovalPrompt; resolve: (a: Approved | null) => void } | null>(null)
  const route = useRoute()
  const lastActivity = useRef(Date.now())
  const lastTouch = useRef(Date.now())

  const enter = useCallback((s: Session, fresh: boolean) => {
    floorSession.actor = { name: s.name, role: s.role }
    lastActivity.current = Date.now()
    lastTouch.current = Date.now()
    setNotice('')
    setPhase({ kind: 'in', session: s })
    if (fresh) go(homeRouteFor(s))
  }, [])
  const leave = useCallback((why = '') => {
    setNotice(why)
    setPrompt(p => {
      p?.resolve(null)
      return null
    })
    setPhase({ kind: 'signin' })
  }, [])
  const signOut = useCallback(() => {
    repo.signOut().catch(() => undefined)
    leave()
  }, [repo, leave])

  useEffect(() => {
    let live = true
    ;(async () => {
      try {
        const d = await repo.device()
        if (!live) return
        if (!d || !d.active) return setPhase({ kind: 'device', off: d && !d.active ? d : null })
        setDevice(d)
        setSettings(await repo.settings())
        const s = await repo.resume()
        if (!live) return
        if (s) enter(s, false)
        else setPhase({ kind: 'signin' })
      } catch (e) {
        if (live) {
          setNotice(errText(e))
          setPhase({ kind: 'device', off: null })
        }
      }
    })()
    return () => {
      live = false
    }
  }, [repo, enter])

  // someone else disabled this person, reset their PIN or locked the device: back to the names
  const signedIn = phase.kind === 'in'
  useEffect(() => {
    if (!signedIn) return
    return repo.subscribe(() => {
      repo.resume().then(s => {
        if (!s) leave('Phiên đăng nhập đã kết thúc (quản lý đổi PIN, khoá tài khoản hoặc khoá máy).')
      }, () => undefined)
      repo.settings().then(setSettings, () => undefined)
    })
  }, [repo, signedIn, leave])

  // idle sign-out and server keep-alive
  const role = phase.kind === 'in' ? phase.session.role : null
  useEffect(() => {
    if (!role) return
    const mark = () => {
      lastActivity.current = Date.now()
    }
    const events = ['pointerdown', 'keydown', 'touchstart', 'wheel'] as const
    events.forEach(e => window.addEventListener(e, mark, { passive: true }))
    const t = setInterval(() => {
      const now = Date.now()
      if (isIdle(role, lastActivity.current, now, settings.idleMinutes)) {
        repo.signOut().catch(() => undefined)
        leave(`Đã tự đăng xuất sau ${settings.idleMinutes} phút không dùng.`)
      } else if (shouldTouch(lastActivity.current, lastTouch.current, now)) {
        lastTouch.current = now
        repo.touch().catch(() => leave('Phiên đăng nhập đã hết: đăng nhập lại.'))
      }
    }, 5000)
    return () => {
      events.forEach(e => window.removeEventListener(e, mark))
      clearInterval(t)
    }
  }, [role, settings.idleMinutes, repo, leave])

  const requestApproval = useCallback((p: ApprovalPrompt) => new Promise<Approved | null>(resolve => setPrompt({ p, resolve })), [])
  const value = useMemo<AuthValue | null>(
    () => (phase.kind === 'in' && device ? { repo, session: phase.session, device, settings, signOut, requestApproval } : null),
    [phase, device, repo, settings, signOut, requestApproval],
  )

  if (phase.kind === 'loading') return <p className="auth-loading">Đang kết nối…</p>
  if (phase.kind === 'device') {
    return (
      <DeviceSetup
        repo={repo}
        disabled={phase.off}
        onDone={d => {
          setDevice(d)
          repo.settings().then(setSettings, () => undefined)
          setPhase({ kind: 'signin' })
        }}
      />
    )
  }
  if (phase.kind === 'signin' || !value) return <SignInScreen repo={repo} device={device!} notice={notice} onSignedIn={s => enter(s, true)} />
  return (
    <AuthContext.Provider value={value}>
      {canOpen(value.session.role, route) ? props.children : <BlockedScreen session={value.session} route={route} onSwitch={signOut} />}
      {prompt && (
        <div className="approval-layer">
          <ApprovalDialog
            repo={repo}
            prompt={prompt.p}
            onDone={a => {
              prompt.resolve(a)
              setPrompt(null)
            }}
          />
        </div>
      )}
    </AuthContext.Provider>
  )
}

/** After a fresh sign-in: stay on the screen this device showed when the person may use it, else go home. */
function homeRouteFor(s: Session): string {
  const here = location.hash.replace(/^#\/?/, '')
  return here && canOpen(s.role, here.split('/').filter(Boolean)) ? here : homeRoute(s.role)
}
