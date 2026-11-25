// "Quản lý duyệt": someone whose role may do this themselves (APPROVAL_PERM: pay.discount, order.void_sent; the owner
// always) types their account and PIN on this device (no list of names, 0033). The server
// (verify_manager_by_username) returns a short-lived single-use token for exactly this action; wrong PINs count to the lock.

import { useEffect, useRef, useState } from 'react'
import { errText } from '../floor/hooks'
import type { ApprovalPrompt, Approved } from './context'
import { APPROVAL_PERM, roleCan } from './permissions'
import { PinPad } from './PinPad'
import type { AuthRepo } from './repo'
import { AccountField } from './screens'
import { ROLE_LABEL } from './types'
import { normalizeUsername } from './username'

export function ApprovalDialog(props: { repo: AuthRepo; prompt: ApprovalPrompt; onDone: (a: Approved | null) => void }) {
  const { repo, prompt, onDone } = props
  const [username, setUsername] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [tries, setTries] = useState(0)
  const userRef = useRef<HTMLInputElement>(null)
  useEffect(() => userRef.current?.focus(), [])
  const user = normalizeUsername(username)
  const submit = async (pin: string) => {
    if (!user) {
      setError('Nhập tài khoản người duyệt trước')
      setTries(t => t + 1)
      userRef.current?.focus()
      return
    }
    setBusy(true)
    try {
      const r = await repo.verifyManagerPin(user, pin, prompt)
      if (r.ok) return onDone({ token: r.token, managerName: r.managerName, expiresAt: r.expiresAt })
      setError(r.error)
      setTries(t => t + 1)
    } catch (e) {
      setError(errText(e))
      setTries(t => t + 1)
    } finally {
      setBusy(false)
    }
  }
  const samples = repo.sampleAccounts?.().filter(a => roleCan(a.role, APPROVAL_PERM[prompt.action]))

  return (
    <div className="sheet-backdrop approval-backdrop" onClick={() => onDone(null)}>
      <div className="sheet approval" role="dialog" aria-modal="true" aria-label="Quản lý duyệt" onClick={e => e.stopPropagation()}>
        <header className="sheet-head">
          <div>
            <p className="approval-kicker">🔐 Cần quản lý duyệt</p>
            <h2>{prompt.title}</h2>
            {prompt.subtitle && <p className="muted">{prompt.subtitle}</p>}
          </div>
          <button type="button" className="icon-btn" onClick={() => onDone(null)} aria-label="Đóng">
            ✕
          </button>
        </header>
        <div className="sheet-body approval-body">
          <AccountField label="Tài khoản người duyệt" inputRef={userRef} value={username} onChange={v => {
            setUsername(v)
            setError('')
          }} />
          <PinPad label="Mã PIN người duyệt" onSubmit={submit} busy={busy} error={error} resetKey={`${user}-${tries}`} />
          {samples && samples.length > 0 && (
            <div className="chip-row">
              {samples.map(a => (
                <button key={a.username} type="button" className="chip" onClick={() => setUsername(a.username)}>
                  {a.username} <span className="chip-sub">{ROLE_LABEL[a.role]} · PIN {a.pin} (mẫu)</span>
                </button>
              ))}
            </div>
          )}
          <p className="muted small center">Mã duyệt chỉ dùng một lần cho việc này và hết hạn sau vài phút.</p>
        </div>
      </div>
    </div>
  )
}
