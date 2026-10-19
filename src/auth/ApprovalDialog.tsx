// "Quản lý duyệt": someone whose role may do this themselves (APPROVAL_PERM: pay.discount, order.void_sent; the owner
// always) picks their name and enters their PIN on this device. The server
// (verify_manager_pin) returns a short-lived single-use token for exactly this action; wrong PINs count to the lock.

import { useEffect, useState } from 'react'
import { errText } from '../floor/hooks'
import type { ApprovalPrompt, Approved } from './context'
import { APPROVAL_PERM, roleCan } from './permissions'
import { PinPad } from './PinPad'
import type { AuthRepo } from './repo'
import { ROLE_LABEL, type RosterEntry } from './types'

export function ApprovalDialog(props: { repo: AuthRepo; prompt: ApprovalPrompt; onDone: (a: Approved | null) => void }) {
  const { repo, prompt, onDone } = props
  const [managers, setManagers] = useState<RosterEntry[] | null>(null)
  const [pick, setPick] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [tries, setTries] = useState(0)
  useEffect(() => {
    repo.roster().then(
      r => {
        const m = r.filter(x => roleCan(x.role, APPROVAL_PERM[prompt.action]))
        setManagers(m)
        if (m.length === 1) setPick(m[0].id)
      },
      e => setError(errText(e)),
    )
  }, [repo, prompt.action])
  const manager = managers?.find(m => m.id === pick)
  const submit = async (pin: string) => {
    if (!pick) return
    setBusy(true)
    try {
      const r = await repo.verifyManagerPin(pick, pin, prompt)
      if (r.ok) return onDone({ token: r.token, managerName: r.managerName, expiresAt: r.expiresAt })
      setError(r.error)
      setTries(t => t + 1)
      if (r.lockedUntil) setManagers(ms => ms?.map(m => (m.id === pick ? { ...m, lockedUntil: r.lockedUntil! } : m)) ?? null)
    } catch (e) {
      setError(errText(e))
      setTries(t => t + 1)
    } finally {
      setBusy(false)
    }
  }
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
          <div className="approval-who">
            <span className="field-label">Người duyệt</span>
            <div className="chip-row">
              {(managers ?? []).map(m => (
                <button
                  key={m.id}
                  type="button"
                  className={'chip' + (pick === m.id ? ' is-on' : '')}
                  aria-pressed={pick === m.id}
                  onClick={() => {
                    setPick(m.id)
                    setError('')
                  }}
                >
                  {m.name} <span className="chip-sub">{ROLE_LABEL[m.role]}</span>
                  {m.lockedUntil && ' 🔒'}
                </button>
              ))}
              {managers && !managers.length && <span className="muted">Chưa có ai được quyền duyệt việc này: chủ quán cấp ở Nhân viên → Phân quyền.</span>}
            </div>
          </div>
          {manager ? (
            <PinPad label={`Mã PIN của ${manager.name}`} onSubmit={submit} busy={busy} error={error} resetKey={`${pick}-${tries}`} />
          ) : (
            <p className="muted pin-msg">{error || 'Chọn tên người duyệt'}</p>
          )}
          <p className="muted small center">Mã duyệt chỉ dùng một lần cho việc này và hết hạn sau vài phút.</p>
        </div>
      </div>
    </div>
  )
}
