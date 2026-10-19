// #/nhan-vien/quyen (chủ quán): what each role may do. Pick a role, switch permissions on or off, Lưu. Every signed-in
// device picks the change up at once (AuthGate reloads the table); the server checks the same table (0009).

import { useEffect, useMemo, useState } from 'react'
import { errText } from '../floor/hooks'
import { Switch } from '../menu/ui'
import { useAuth } from './context'
import { canOpen, SCREEN_LABEL, type Screen } from './guards'
import { DEFAULT_PERMS, PERM_GROUPS, PERM_ROLES, PERMS, type Perm, type PermMatrix, type PermRole } from './permissions'
import { ROLE_LABEL, type StaffRecord } from './types'

const same = (a: readonly Perm[], b: readonly Perm[]) => a.length === b.length && a.every(p => b.includes(p))
const WORK_SCREENS: Screen[] = ['floor', 'cashier', 'kitchen', 'shift', 'bills', 'revenue', 'menu-admin', 'menu-soldout', 'floor-setup', 'staff']

export function PermissionsScreen(props: { onError: (e: unknown) => void; onInfo: (m: string) => void }) {
  const { repo, perms } = useAuth()
  const [role, setRole] = useState<PermRole>('waiter')
  const [base, setBase] = useState<PermMatrix>(perms)
  const [draft, setDraft] = useState<PermMatrix>(perms)
  const [staff, setStaff] = useState<StaffRecord[]>([])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const { onError } = props

  // a change saved on another device: take it for every role not being edited here
  useEffect(() => {
    setDraft(d => Object.fromEntries(PERM_ROLES.map(r => [r, same(d[r], base[r]) ? perms[r] : d[r]])) as PermMatrix)
    setBase(perms)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when the shop's table changes
  }, [perms])
  useEffect(() => {
    repo.listStaff().then(setStaff, onError)
  }, [repo, onError])

  const dirty = (r: PermRole) => !same(draft[r], base[r])
  const on = draft[role]
  const toggle = (p: Perm, v: boolean) => {
    setErr('')
    setDraft(d => ({ ...d, [role]: PERMS.filter(x => (x === p ? v : d[role].includes(x))) }))
  }
  const people = staff.filter(s => s.active && s.role === role).map(s => s.name)
  const screens = useMemo(() => WORK_SCREENS.filter(s => canOpen(role, s, draft)), [role, draft])

  const saveRole = async () => {
    setBusy(true)
    setErr('')
    try {
      const saved = await repo.savePermissions(role, draft[role])
      setBase(b => ({ ...b, [role]: saved }))
      setDraft(d => ({ ...d, [role]: saved }))
      props.onInfo(`Đã lưu quyền ${ROLE_LABEL[role]}`)
    } catch (e) {
      setErr(errText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="screen perms">
      <h1>Phân quyền</h1>
      <p className="muted small">
        Chọn vai trò rồi bật những việc vai trò đó được làm. Chủ quán luôn có mọi quyền. Lưu xong, các máy đang dùng áp dụng ngay; máy chủ cũng kiểm tra lại từng việc.
      </p>

      <div className="chip-row perms-roles" role="tablist" aria-label="Vai trò">
        {PERM_ROLES.map(r => (
          <button key={r} type="button" role="tab" className={'chip' + (r === role ? ' is-on' : '')} aria-selected={r === role} onClick={() => (setRole(r), setErr(''))}>
            {ROLE_LABEL[r]} <span className="chip-sub">{draft[r].length}</span>
            {dirty(r) && <span className="perms-dot" title="Chưa lưu" aria-label="chưa lưu" />}
          </button>
        ))}
        <span className="chip perms-owner" aria-disabled>
          {ROLE_LABEL.owner} <span className="chip-sub">mọi quyền</span>
        </span>
      </div>

      <div className="card perms-summary">
        <span className="muted small">
          {people.length ? `Áp dụng cho ${people.length} người: ${people.join(', ')}` : `Chưa có ai là ${ROLE_LABEL[role].toLowerCase()}.`}
        </span>
        {screens.length ? (
          <span className="small">Mở được: {screens.map(s => SCREEN_LABEL[s]).join(' · ')}</span>
        ) : (
          <span className="perms-warn small">⚠ Không mở được màn hình nào: người {ROLE_LABEL[role].toLowerCase()} đăng nhập xong chỉ thấy “Không có quyền”.</span>
        )}
      </div>

      {PERM_GROUPS.map(g => (
        <div key={g.title} className="card perms-group">
          <h2>{g.title}</h2>
          <ul className="perms-list">
            {g.perms.map(p => (
              <li key={p.id} className={'perms-row' + (on.includes(p.id) !== base[role].includes(p.id) ? ' is-changed' : '')}>
                <Switch
                  checked={on.includes(p.id)}
                  onChange={v => toggle(p.id, v)}
                  label={
                    <span>
                      <b className="perms-label">{p.label}</b>
                      {p.hint && <span className="muted small block">{p.hint}</span>}
                    </span>
                  }
                />
              </li>
            ))}
          </ul>
        </div>
      ))}

      {err && <p className="field-error block">{err}</p>}
      <div className="perms-bar">
        <button type="button" className="btn" disabled={busy || same(draft[role], DEFAULT_PERMS[role])} onClick={() => setDraft(d => ({ ...d, [role]: [...DEFAULT_PERMS[role]] }))}>
          Về mặc định
        </button>
        <button type="button" className="btn" disabled={busy || !dirty(role)} onClick={() => setDraft(d => ({ ...d, [role]: base[role] }))}>
          Bỏ thay đổi
        </button>
        <button type="button" className="btn btn-primary btn-grow" disabled={busy || !dirty(role)} onClick={saveRole}>
          {busy ? 'Đang lưu…' : `Lưu quyền ${ROLE_LABEL[role]}`}
        </button>
      </div>

      <details className="card perms-overview">
        <summary>Xem tất cả vai trò</summary>
        <div className="audit-wrap">
          <table className="audit">
            <thead>
              <tr>
                <th>Quyền</th>
                {PERM_ROLES.map(r => (
                  <th key={r}>{ROLE_LABEL[r]}</th>
                ))}
                <th>{ROLE_LABEL.owner}</th>
              </tr>
            </thead>
            <tbody>
              {PERM_GROUPS.flatMap(g => g.perms).map(p => (
                <tr key={p.id}>
                  <td>{p.label}</td>
                  {PERM_ROLES.map(r => (
                    <td key={r} className="perms-cell">
                      {draft[r].includes(p.id) ? '✓' : '–'}
                    </td>
                  ))}
                  <td className="perms-cell">✓</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </section>
  )
}
