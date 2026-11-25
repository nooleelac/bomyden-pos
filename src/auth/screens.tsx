// Screens before anyone works: register this device (once), type your account and PIN (no list of names), and the page
// shown when a role opens a screen it may not use.

import { useEffect, useRef, useState, type RefObject } from 'react'
import { errText, go } from '../floor/hooks'
import { SCREEN_LABEL, homeRoute, screenOf, screenPerms } from './guards'
import { PERM_LABEL } from './permissions'
import { PinPad } from './PinPad'
import { isLocked } from './pin'
import type { AuthRepo } from './repo'
import { ROLE_LABEL, type Device, type Session } from './types'
import { lastUsername, normalizeUsername, rememberUsername } from './username'

const hhmm = (iso: string) => new Date(new Date(iso).getTime() + 7 * 3600_000).toISOString().slice(11, 16)

export function DeviceSetup(props: { repo: AuthRepo; onDone: (d: Device) => void; disabled?: Device | null }) {
  const [code, setCode] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = async () => {
    setBusy(true)
    setErr('')
    try {
      props.onDone(await props.repo.registerDevice(code))
    } catch (e) {
      setErr(errText(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="menu-app auth-app">
      <main className="auth-main">
        <div className="auth-card">
          <b className="auth-brand">Bò Mỹ Đen</b>
          {props.disabled ? (
            <>
              <h1>Máy “{props.disabled.name}” đã bị khoá</h1>
              <p className="muted">Quản lý mở lại máy này ở Cài đặt → Nhân viên → Máy trên một máy khác.</p>
            </>
          ) : (
            <>
              <h1>Đăng ký máy này</h1>
              <p className="muted">
                Làm một lần cho mỗi máy tính bảng, máy POS hoặc màn bếp. Quản lý tạo mã ở <b>Cài đặt → Nhân viên → Máy → Thêm máy</b>, rồi nhập mã ở đây.
              </p>
              <label className="field">
                <span className="field-label">Mã đăng ký máy</span>
                <input
                  className="device-code-input"
                  value={code}
                  autoCapitalize="characters"
                  autoComplete="off"
                  placeholder="VD: K7Q2-M9XD"
                  maxLength={9}
                  onChange={e => setCode(e.target.value.toUpperCase())}
                  onKeyDown={e => e.key === 'Enter' && code.length >= 8 && submit()}
                />
              </label>
              {err && <p className="field-error block">{err}</p>}
              <button type="button" className="btn btn-primary auth-wide" disabled={busy || code.replace('-', '').length < 8} onClick={submit}>
                {busy ? 'Đang đăng ký…' : 'Đăng ký máy'}
              </button>
            </>
          )}
        </div>
      </main>
    </div>
  )
}

export function SignInScreen(props: { repo: AuthRepo; device: Device; notice?: string; onSignedIn: (s: Session) => void }) {
  const { repo, device } = props
  const [username, setUsername] = useState(lastUsername)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [tries, setTries] = useState(0)
  const [lock, setLock] = useState<{ user: string; until: string } | null>(null)
  const [now, setNow] = useState(() => new Date())
  const userRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 15_000)
    if (!lastUsername()) userRef.current?.focus()
    return () => clearInterval(t)
  }, [])
  const user = normalizeUsername(username)
  const locked = !!lock && lock.user === user && isLocked(lock.until, now)
  const submit = async (pin: string) => {
    if (!user) {
      setError('Nhập tài khoản trước')
      setTries(t => t + 1)
      userRef.current?.focus()
      return
    }
    setBusy(true)
    try {
      const r = await repo.signIn(user, pin)
      if (r.ok) {
        rememberUsername(user)
        return props.onSignedIn(r.session)
      }
      setError(r.error)
      setTries(t => t + 1)
      if (r.lockedUntil) setLock({ user, until: r.lockedUntil })
    } catch (e) {
      setError(errText(e))
      setTries(t => t + 1)
    } finally {
      setBusy(false)
    }
  }
  const samples = repo.sampleAccounts?.()
  return (
    <div className="menu-app auth-app">
      <header className="topbar">
        <b className="brand">Bò Mỹ Đen</b>
        <span className="small">
          {device.kind === 'kitchen' ? 'Màn bếp' : 'Máy'}: {device.name}
        </span>
      </header>
      {repo.source === 'sample' && (
        <div className="sample-banner">Bản mẫu: tài khoản và PIN mẫu ở cuối trang. Quản lý đặt tên đăng nhập và PIN thật ở màn Nhân viên.</div>
      )}
      <main className="auth-main">
        <form className="auth-card signin-card" aria-label="Đăng nhập" onSubmit={e => e.preventDefault()}>
          <h1>Đăng nhập</h1>
          {props.notice && <p className="auth-notice">{props.notice}</p>}
          <AccountField
            inputRef={userRef}
            value={username}
            onChange={v => {
              setUsername(v)
              setError('')
            }}
          />
          <PinPad
            label="Mã PIN"
            onSubmit={submit}
            busy={busy}
            disabled={locked}
            error={error || (locked ? `Nhập sai quá nhiều lần: khoá đến ${hhmm(lock!.until)}` : '')}
            resetKey={`${user}-${tries}`}
          />
          <p className="muted small center">Quên tài khoản hoặc PIN? Nhờ quản lý xem ở Cài đặt → Nhân viên.</p>
        </form>
      </main>
      {samples && samples.length > 0 && (
        <details className="sample-accounts">
          <summary>Tài khoản mẫu (chỉ có ở bản mẫu)</summary>
          <div className="chip-row">
            {samples.map(a => (
              <button key={a.username} type="button" className="chip" onClick={() => setUsername(a.username)}>
                {a.username} <span className="chip-sub">{ROLE_LABEL[a.role]} · PIN {a.pin}</span>
              </button>
            ))}
          </div>
        </details>
      )}
    </div>
  )
}

/** The account box of the sign-in and approval forms: typed, never picked from a list of names. */
export function AccountField(props: { value: string; onChange: (v: string) => void; inputRef?: RefObject<HTMLInputElement | null>; label?: string }) {
  return (
    <label className="field account-field">
      <span className="field-label">{props.label ?? 'Tài khoản'}</span>
      <span className="account-input">
        <input
          ref={props.inputRef}
          value={props.value}
          autoCapitalize="none"
          autoCorrect="off"
          autoComplete="off"
          spellCheck={false}
          inputMode="text"
          maxLength={30}
          placeholder="Tên đăng nhập"
          onChange={e => props.onChange(e.target.value)}
          onKeyDown={e => {
            // Enter moves on to the PIN pad (digits typed outside the box go to the pad)
            if (e.key === 'Enter') {
              e.preventDefault()
              e.currentTarget.blur()
            }
          }}
        />
        {props.value && (
          <button type="button" className="icon-btn" aria-label="Xoá tài khoản" onClick={() => props.onChange('')}>
            ✕
          </button>
        )}
      </span>
    </label>
  )
}

export function BlockedScreen(props: { session: Session; route: string[]; onSwitch: () => void }) {
  const { session } = props
  const screen = SCREEN_LABEL[screenOf(props.route)]
  const home = homeRoute(session.role)
  const homeLabel = SCREEN_LABEL[screenOf([home])]
  return (
    <div className="menu-app auth-app">
      <header className="topbar">
        <b className="brand">Bò Mỹ Đen</b>
        <span className="small">
          {session.name} · {ROLE_LABEL[session.role]}
        </span>
      </header>
      <main className="auth-main">
        <div className="auth-card blocked" role="alert">
          <span className="blocked-icon" aria-hidden>
            🔒
          </span>
          <h1>Không có quyền mở màn hình này</h1>
          <p>
            <b>{screen}</b> cần quyền {screenPerms(screenOf(props.route)).map(p => `“${PERM_LABEL[p]}”`).join(' hoặc ')}. Bạn đang đăng nhập là{' '}
            <b>
              {session.name} ({ROLE_LABEL[session.role]})
            </b>
            .
          </p>
          <div className="btn-row blocked-actions">
            <button type="button" className="btn btn-primary" onClick={() => go(home)}>
              Về {homeLabel}
            </button>
            <button type="button" className="btn" onClick={props.onSwitch}>
              Đổi người
            </button>
          </div>
          <p className="muted small">Cần làm việc này? Nhờ chủ quán cấp quyền ở Nhân viên → Phân quyền, hoặc nhờ người có quyền đăng nhập trên máy này.</p>
        </div>
      </main>
    </div>
  )
}
