// Screens before anyone works: register this device (once), pick your name and enter your PIN, and the page
// shown when a role opens a screen it may not use.

import { useEffect, useState } from 'react'
import { errText, go } from '../floor/hooks'
import { SCREEN_LABEL, allowedRoles, homeRoute, isManager, screenOf } from './guards'
import { PinPad } from './PinPad'
import { isLocked } from './pin'
import type { AuthRepo } from './repo'
import { ROLE_LABEL, type Device, type Role, type RosterEntry, type Session } from './types'

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

const GROUPS: { label: string; roles: Role[] }[] = [
  { label: 'Phục vụ', roles: ['waiter'] },
  { label: 'Thu ngân', roles: ['cashier'] },
  { label: 'Bếp và bar', roles: ['kitchen'] },
  { label: 'Quản lý', roles: ['manager', 'owner'] },
]

export function SignInScreen(props: { repo: AuthRepo; device: Device; notice?: string; onSignedIn: (s: Session) => void }) {
  const { repo, device } = props
  const [roster, setRoster] = useState<RosterEntry[] | null>(null)
  const [pick, setPick] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [tries, setTries] = useState(0)
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const load = () => repo.roster().then(setRoster, e => setError(errText(e)))
    load()
    const off = repo.subscribe(load)
    const t = setInterval(() => setNow(new Date()), 15_000)
    return () => {
      off()
      clearInterval(t)
    }
  }, [repo])
  const person = roster?.find(r => r.id === pick) ?? null
  const pins = repo.samplePins?.()
  const submit = async (pin: string) => {
    if (!person) return
    setBusy(true)
    try {
      const r = await repo.signIn(person.id, pin)
      if (r.ok) return props.onSignedIn(r.session)
      setError(r.error)
      setTries(t => t + 1)
      if (r.lockedUntil) setRoster(rs => rs?.map(x => (x.id === person.id ? { ...x, lockedUntil: r.lockedUntil! } : x)) ?? null)
    } catch (e) {
      setError(errText(e))
    } finally {
      setBusy(false)
    }
  }
  const locked = person ? isLocked(person.lockedUntil, now) : false
  return (
    <div className="menu-app auth-app">
      <header className="topbar">
        <b className="brand">Bò Mỹ Đen</b>
        <span className="small">
          {device.kind === 'kitchen' ? 'Màn bếp' : 'Máy'}: {device.name}
        </span>
      </header>
      {repo.source === 'sample' && (
        <div className="sample-banner">Nhân viên mẫu, PIN mẫu ghi dưới mỗi tên. Quản lý đổi tên và PIN thật ở màn Nhân viên.</div>
      )}
      <main className="signin">
        <section className={'signin-names' + (person ? ' has-pick' : '')} aria-label="Chọn tên">
          <h1>Ai đang dùng máy?</h1>
          {props.notice && <p className="auth-notice">{props.notice}</p>}
          {!roster && !error && <p className="muted">Đang tải…</p>}
          {GROUPS.map(g => {
            const people = (roster ?? []).filter(r => g.roles.includes(r.role))
            if (!people.length) return null
            return (
              <div key={g.label} className="name-group">
                <h2>{g.label}</h2>
                <div className="name-grid">
                  {people.map(p => (
                    <button
                      key={p.id}
                      type="button"
                      className={'name-tile' + (pick === p.id ? ' is-on' : '') + (isLocked(p.lockedUntil, now) ? ' is-locked' : '')}
                      aria-pressed={pick === p.id}
                      onClick={() => {
                        setPick(p.id)
                        setError('')
                      }}
                    >
                      <span className="name-avatar" aria-hidden>
                        {p.name.split(' ').pop()!.slice(0, 1).toUpperCase()}
                      </span>
                      <b>{p.name}</b>
                      <span className="name-role">
                        {isManager(p.role) ? ROLE_LABEL[p.role] : isLocked(p.lockedUntil, now) ? `🔒 đến ${hhmm(p.lockedUntil!)}` : ROLE_LABEL[p.role]}
                        {pins?.[p.id] && <span className="sample-pin"> · PIN {pins[p.id]}</span>}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )
          })}
        </section>
        <section className="signin-pin" aria-label="Nhập mã PIN">
          {person ? (
            <>
              <div className="signin-who">
                <button type="button" className="link" onClick={() => setPick(null)}>
                  ← Chọn tên khác
                </button>
                <h2>{person.name}</h2>
                <span className="muted">{ROLE_LABEL[person.role]}</span>
              </div>
              {!person.hasPin ? (
                <p className="pin-msg is-error">Chưa có mã PIN: nhờ quản lý đặt PIN ở màn Nhân viên.</p>
              ) : (
                <PinPad
                  label={`Mã PIN của ${person.name}`}
                  onSubmit={submit}
                  busy={busy}
                  disabled={locked}
                  error={error || (locked ? `Nhập sai quá nhiều lần: khoá đến ${hhmm(person.lockedUntil!)}` : '')}
                  resetKey={`${pick}-${tries}`}
                />
              )}
            </>
          ) : (
            <p className="muted signin-hint">Chạm vào tên của bạn rồi nhập mã PIN.</p>
          )}
        </section>
      </main>
    </div>
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
            <b>{screen}</b> chỉ dành cho {allowedRoles(screenOf(props.route)).map(r => ROLE_LABEL[r].toLowerCase()).join(', ')}. Bạn đang đăng nhập là{' '}
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
          <p className="muted small">Cần làm việc này? Nhờ quản lý đăng nhập trên máy này hoặc duyệt bằng mã PIN.</p>
        </div>
      </main>
    </div>
  )
}
