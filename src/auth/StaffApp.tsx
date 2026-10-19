// #/nhan-vien: staff with role and PIN status (add, edit, ngừng làm, đặt lại PIN), Phân quyền (chủ quán: what each
// role may do), devices (thêm máy with a one-time code, khoá máy), sign-in settings, and the audit log. Each tab
// shows only with its permission (staffTabsFor). With Xoá vĩnh viễn (admin.delete) people and devices can also be
// deleted for good.
// Routes: #/nhan-vien  #/nhan-vien/quyen  #/nhan-vien/may  #/nhan-vien/caidat  #/nhan-vien/nhatky

import { useCallback, useEffect, useState } from 'react'
import { Sheet } from '../floor/screens/Sheet'
import { errText, useRoute } from '../floor/hooks'
import '../floor/floor.css'
import { SettingsBack, TopBar } from './chrome'
import { useAuth } from './context'
import { isManager, staffTabsFor } from './guards'
import { roleCan } from './permissions'
import { PermissionsScreen } from './PermissionsScreen'
import { pinProblem } from './pin'
import type { DeviceRow } from './repo'
import { ROLE_LABEL, ROLES, type AuditEntry, type AuthSettings, type DeviceCode, type DeviceKind, type Role, type StaffRecord } from './types'

const TABS = [
  { id: '', label: 'Nhân viên' },
  { id: 'quyen', label: 'Phân quyền' },
  { id: 'may', label: 'Máy' },
  { id: 'caidat', label: 'Cài đặt' },
  { id: 'nhatky', label: 'Nhật ký' },
] as const

const when = (iso: string | null) => {
  if (!iso) return ''
  const d = new Date(new Date(iso).getTime() + 7 * 3600_000).toISOString()
  return `${d.slice(11, 16)} ${d.slice(8, 10)}/${d.slice(5, 7)}`
}

export function StaffApp() {
  const auth = useAuth()
  const route = useRoute()
  const allowed = staffTabsFor(auth.session.role)
  const tabs = TABS.filter(t => allowed.includes(t.id))
  const tab = tabs.find(t => t.id === (route[1] ?? ''))?.id ?? tabs[0]?.id
  const [toast, setToast] = useState<{ text: string; ok?: boolean } | null>(null)
  const onError = useCallback((e: unknown) => setToast({ text: errText(e) }), [])
  const onInfo = useCallback((m: string) => setToast({ text: m, ok: true }), [])
  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), toast.ok ? 2500 : 5000)
    return () => clearTimeout(t)
  }, [toast])
  return (
    <div className="menu-app floor-app staff-app">
      <TopBar />
      <SettingsBack />
      {auth.repo.source === 'sample' && <div className="sample-banner">Nhân viên mẫu trên trình duyệt này. Đổi tên và đặt PIN thật trước khi dùng ở quán.</div>}
      <nav className="tabs" aria-label="Nhân viên">
        {tabs.map(t => (
          <a key={t.id} href={`#/nhan-vien${t.id ? '/' + t.id : ''}`} className={'tab' + (t.id === tab ? ' is-on' : '')} aria-current={t.id === tab ? 'page' : undefined}>
            {t.label}
          </a>
        ))}
      </nav>
      <main className="staff-main">
        {tab === '' && <StaffList onError={onError} onInfo={onInfo} />}
        {tab === 'quyen' && <PermissionsScreen onError={onError} onInfo={onInfo} />}
        {tab === 'may' && <Devices onError={onError} onInfo={onInfo} />}
        {tab === 'caidat' && <Settings onError={onError} onInfo={onInfo} />}
        {tab === 'nhatky' && <Audit onError={onError} />}
      </main>
      {toast && (
        <div className={'toast' + (toast.ok ? ' toast-ok' : '')} role={toast.ok ? 'status' : 'alert'} onClick={() => setToast(null)}>
          {toast.text}
        </div>
      )}
    </div>
  )
}

type Notify = { onError: (e: unknown) => void; onInfo: (m: string) => void }

/** Roles the signed-in person may give: owners any, others (with staff.manage) waiter / kitchen / cashier. */
function assignable(me: Role): Role[] {
  return me === 'owner' ? ROLES : ROLES.filter(r => !isManager(r))
}

function StaffList(props: Notify) {
  const { repo, session } = useAuth()
  const [list, setList] = useState<StaffRecord[] | null>(null)
  const [edit, setEdit] = useState<StaffRecord | 'new' | null>(null)
  const [pinFor, setPinFor] = useState<StaffRecord | null>(null)
  const [showOff, setShowOff] = useState(false)
  const { onError } = props
  const load = useCallback(() => repo.listStaff().then(setList, onError), [repo, onError])
  useEffect(() => {
    load()
    return repo.subscribe(load)
  }, [repo, load])
  const may = (r: StaffRecord) => session.role === 'owner' || !isManager(r.role) || r.id === session.staffId
  const toggle = async (r: StaffRecord) => {
    if (r.active && !confirm(`${r.name} ngừng làm? Người này bị đăng xuất khỏi mọi máy và không đăng nhập được nữa.`)) return
    try {
      await repo.setStaffActive(r.id, !r.active)
      props.onInfo(r.active ? `${r.name} đã ngừng làm` : `${r.name} làm lại`)
      load()
    } catch (e) {
      onError(e)
    }
  }
  const purge = roleCan(session.role, 'admin.delete')
  const remove = async (r: StaffRecord) => {
    if (!confirm(`Xoá vĩnh viễn ${r.name}? Mã PIN và phiên đăng nhập bị xoá; hoá đơn, ca cũ vẫn giữ nhưng không còn tên người này. Không khôi phục được.`)) return
    try {
      await repo.adminDelete('staff', r.id)
      props.onInfo(`Đã xoá ${r.name}`)
      load()
    } catch (e) {
      onError(e)
    }
  }
  const shown = (list ?? []).filter(r => showOff || r.active)
  const off = (list ?? []).filter(r => !r.active).length
  return (
    <section className="screen">
      <div className="screen-head">
        <h1>Nhân viên</h1>
        <button type="button" className="btn btn-primary" onClick={() => setEdit('new')}>
          + Thêm nhân viên
        </button>
      </div>
      <p className="muted small">Mỗi người một mã PIN 4–6 số để đăng nhập trên máy chung. Máy chủ chỉ lưu PIN đã mã hoá; quên PIN thì đặt lại.</p>
      {!list && <p className="muted">Đang tải…</p>}
      <ul className="staff-list">
        {shown.map(r => (
          <li key={r.id} className={'card staff-row' + (r.active ? '' : ' is-off')}>
            <div className="staff-main-col">
              <div className="staff-name">
                <b>{r.name}</b>
                <span className={`badge role-${r.role}`}>{ROLE_LABEL[r.role]}</span>
                {!r.active && <span className="badge badge-archived">Ngừng làm</span>}
                {r.lockedUntil && <span className="badge badge-req">🔒 Khoá PIN đến {when(r.lockedUntil).slice(0, 5)}</span>}
                {!r.hasPin && r.active && <span className="badge badge-draft">Chưa có PIN</span>}
              </div>
              <span className="muted small">
                {r.signedInOn ? `Đang đăng nhập: ${r.signedInOn}` : r.lastSeenAt ? `Lần cuối: ${when(r.lastSeenAt)}` : 'Chưa đăng nhập'}
                {r.pinSetAt && ` · PIN đặt ${when(r.pinSetAt)}`}
              </span>
            </div>
            {may(r) && (
              <div className="staff-actions">
                <button type="button" className="btn btn-small" onClick={() => setEdit(r)}>
                  Sửa
                </button>
                <button type="button" className="btn btn-small" onClick={() => setPinFor(r)}>
                  Đặt lại PIN
                </button>
                {r.id !== session.staffId && (
                  <button type="button" className={'btn btn-small' + (r.active ? ' btn-danger' : '')} onClick={() => toggle(r)}>
                    {r.active ? 'Ngừng làm' : 'Làm lại'}
                  </button>
                )}
                {purge && r.id !== session.staffId && (
                  <button type="button" className="btn btn-small btn-danger" onClick={() => remove(r)}>
                    Xoá
                  </button>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
      {off > 0 && (
        <button type="button" className="link" onClick={() => setShowOff(v => !v)}>
          {showOff ? 'Ẩn người đã nghỉ' : `Xem ${off} người đã ngừng làm`}
        </button>
      )}
      {edit && (
        <StaffSheet
          value={edit === 'new' ? null : edit}
          roles={assignable(session.role)}
          self={edit !== 'new' && edit.id === session.staffId}
          onClose={() => setEdit(null)}
          onSave={async inp => {
            await repo.saveStaff(inp)
            props.onInfo(inp.id ? 'Đã lưu' : `Đã thêm ${inp.name.trim()}`)
            setEdit(null)
            load()
          }}
        />
      )}
      {pinFor && (
        <PinSheet
          who={pinFor}
          onClose={() => setPinFor(null)}
          onSave={async pin => {
            await repo.resetPin(pinFor.id, pin)
            props.onInfo(`Đã đặt PIN mới cho ${pinFor.name}`)
            setPinFor(null)
            load()
          }}
        />
      )}
    </section>
  )
}

function PinFields(props: { pin: string; again: string; onPin: (v: string) => void; onAgain: (v: string) => void; label: string }) {
  const digits = (v: string) => v.replace(/\D/g, '').slice(0, 6)
  return (
    <div className="form-grid">
      <label className="field">
        <span className="field-label">{props.label}</span>
        <input type="password" inputMode="numeric" autoComplete="new-password" maxLength={6} value={props.pin} onChange={e => props.onPin(digits(e.target.value))} />
      </label>
      <label className="field">
        <span className="field-label">Nhập lại PIN</span>
        <input type="password" inputMode="numeric" autoComplete="new-password" maxLength={6} value={props.again} onChange={e => props.onAgain(digits(e.target.value))} />
      </label>
    </div>
  )
}

function pinError(pin: string, again: string): string | null {
  return pinProblem(pin) ?? (pin !== again ? 'Hai lần nhập PIN không giống nhau' : null)
}

function StaffSheet(props: { value: StaffRecord | null; roles: Role[]; self: boolean; onClose: () => void; onSave: (inp: { id?: string; name: string; role: Role; pin?: string }) => Promise<void> }) {
  const v = props.value
  const [name, setName] = useState(v?.name ?? '')
  const [role, setRole] = useState<Role>(v?.role ?? 'waiter')
  const [pin, setPin] = useState('')
  const [again, setAgain] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const roles = v && !props.roles.includes(v.role) ? [v.role, ...props.roles] : props.roles
  const save = async () => {
    if (!name.trim()) return setErr('Nhập tên nhân viên')
    if (!v || pin) {
      const e = pinError(pin, again)
      if (e) return setErr(e)
    }
    setBusy(true)
    setErr('')
    try {
      await props.onSave({ id: v?.id, name, role, pin: pin || undefined })
    } catch (e) {
      setErr(errText(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Sheet
      title={v ? `Sửa ${v.name}` : 'Thêm nhân viên'}
      subtitle={v ? 'Đổi tên, vai trò; để trống PIN nếu không đổi' : 'Tên hiện trên màn đăng nhập của mọi máy'}
      onClose={props.onClose}
      foot={
        <button type="button" className="btn btn-primary btn-grow" disabled={busy} onClick={save}>
          <span>{ROLE_LABEL[role]}</span>
          <b>{v ? 'Lưu' : 'Thêm'}</b>
        </button>
      }
    >
      <label className="field">
        <span className="field-label">Tên</span>
        <input maxLength={40} value={name} onChange={e => setName(e.target.value)} placeholder="VD: Hùng" />
      </label>
      <fieldset className="pick-group">
        <legend>Vai trò</legend>
        <div className="chip-row">
          {roles.map(r => (
            <button key={r} type="button" className={'chip' + (role === r ? ' is-on' : '')} aria-pressed={role === r} disabled={props.self && r !== v?.role} onClick={() => setRole(r)}>
              {ROLE_LABEL[r]}
            </button>
          ))}
        </div>
        <p className="muted small role-help">{ROLE_HELP[role]}</p>
      </fieldset>
      <PinFields pin={pin} again={again} onPin={setPin} onAgain={setAgain} label={v ? 'PIN mới (không bắt buộc)' : 'Mã PIN (4–6 số)'} />
      {err && <p className="field-error block">{err}</p>}
    </Sheet>
  )
}

const ROLE_HELP: Record<Role, string> = {
  waiter: 'Mặc định: mở bàn, gọi món, gửi bếp, bưng món. Chủ quán đổi được ở Phân quyền.',
  cashier: 'Mặc định: thu tiền, in hoá đơn, mở và chốt ca, bàn tạm. Chủ quán đổi được ở Phân quyền.',
  kitchen: 'Mặc định: màn hình bếp, báo hết món. Không tự đăng xuất khi để yên.',
  manager: 'Mặc định: mọi việc trừ phân quyền và quản lý quản lý / chủ quán. Chủ quán đổi được ở Phân quyền.',
  owner: 'Mọi quyền, phân quyền cho các vai trò, quản lý cả quản lý và chủ quán.',
}

function PinSheet(props: { who: StaffRecord; onClose: () => void; onSave: (pin: string) => Promise<void> }) {
  const [pin, setPin] = useState('')
  const [again, setAgain] = useState('')
  const [err, setErr] = useState('')
  const save = async () => {
    const e = pinError(pin, again)
    if (e) return setErr(e)
    try {
      await props.onSave(pin)
    } catch (x) {
      setErr(errText(x))
    }
  }
  return (
    <Sheet
      title={`Đặt lại PIN cho ${props.who.name}`}
      subtitle="Người này bị đăng xuất khỏi các máy khác; mở khoá PIN nếu đang bị khoá."
      onClose={props.onClose}
      foot={
        <button type="button" className="btn btn-primary btn-grow" onClick={save}>
          <span />
          <b>Đặt PIN</b>
        </button>
      }
    >
      <PinFields pin={pin} again={again} onPin={setPin} onAgain={setAgain} label="PIN mới (4–6 số)" />
      {err && <p className="field-error block">{err}</p>}
    </Sheet>
  )
}

function Devices(props: Notify) {
  const { repo, device, session } = useAuth()
  const [list, setList] = useState<DeviceRow[] | null>(null)
  const purge = roleCan(session.role, 'admin.delete')
  const [name, setName] = useState('')
  const [kind, setKind] = useState<DeviceKind>('pos')
  const [code, setCode] = useState<DeviceCode | null>(null)
  const { onError } = props
  const load = useCallback(() => repo.devices().then(setList, onError), [repo, onError])
  useEffect(() => {
    load()
    return repo.subscribe(load)
  }, [repo, load])
  return (
    <section className="screen">
      <h1>Máy</h1>
      <p className="muted small">Mỗi máy tính bảng, máy POS, màn bếp đăng ký một lần bằng mã. Mất máy thì khoá máy: mọi người trên máy đó bị đăng xuất.</p>
      <ul className="staff-list">
        {(list ?? []).map(d => (
          <li key={d.id} className={'card staff-row' + (d.active ? '' : ' is-off')}>
            <div className="staff-main-col">
              <div className="staff-name">
                <b>{d.name}</b>
                <span className="badge">{d.kind === 'kitchen' ? 'Màn bếp' : 'Máy bán hàng'}</span>
                {d.id === device.id && <span className="badge badge-active">Máy này</span>}
                {!d.active && <span className="badge badge-archived">Đã khoá</span>}
              </div>
              <span className="muted small">{d.lastSeenAt ? `Đăng nhập lần cuối ${when(d.lastSeenAt)}` : 'Chưa ai đăng nhập'}</span>
            </div>
            {d.id !== device.id && (
              <div className="staff-actions">
                <button
                  type="button"
                  className={'btn btn-small' + (d.active ? ' btn-danger' : '')}
                  onClick={() => (!d.active || confirm(`Khoá máy ${d.name}?`)) && repo.setDeviceActive(d.id, !d.active).then(load, onError)}
                >
                  {d.active ? 'Khoá máy' : 'Mở lại'}
                </button>
                {purge && (
                  <button
                    type="button"
                    className="btn btn-small btn-danger"
                    onClick={() =>
                      confirm(`Xoá vĩnh viễn máy ${d.name}? Mọi người trên máy đó bị đăng xuất; muốn dùng lại phải đăng ký mã mới.`) &&
                      repo.adminDelete('device', d.id).then(() => (props.onInfo(`Đã xoá máy ${d.name}`), load()), onError)
                    }
                  >
                    Xoá
                  </button>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
      <div className="card">
        <h2>Thêm máy</h2>
        <div className="form-grid">
          <label className="field">
            <span className="field-label">Tên máy</span>
            <input maxLength={40} value={name} placeholder="VD: Máy tầng 2" onChange={e => setName(e.target.value)} />
          </label>
          <div className="field">
            <span className="field-label">Loại</span>
            <div className="chip-row">
              <button type="button" className={'chip' + (kind === 'pos' ? ' is-on' : '')} onClick={() => setKind('pos')}>
                Máy bán hàng
              </button>
              <button type="button" className={'chip' + (kind === 'kitchen' ? ' is-on' : '')} onClick={() => setKind('kitchen')}>
                Màn bếp
              </button>
            </div>
          </div>
        </div>
        <div className="btn-row">
          <button type="button" className="btn btn-primary" disabled={!name.trim()} onClick={() => repo.createDeviceCode(name, kind).then(setCode, onError)}>
            Tạo mã đăng ký
          </button>
        </div>
        {code && (
          <div className="device-code" role="status">
            <span className="muted small">Trên máy mới, mở app và nhập mã (dùng một lần, hết hạn {when(code.expiresAt).slice(0, 5)}):</span>
            <b>{code.code}</b>
            <span className="small">
              {code.name} · {code.kind === 'kitchen' ? 'Màn bếp' : 'Máy bán hàng'}
            </span>
          </div>
        )}
      </div>
    </section>
  )
}

function Settings(props: Notify) {
  const { repo } = useAuth()
  const [s, setS] = useState<AuthSettings | null>(null)
  useEffect(() => {
    repo.settings().then(setS, props.onError)
  }, [repo, props.onError])
  if (!s) return <p className="muted">Đang tải…</p>
  const num = (k: keyof AuthSettings, label: string, min: number, max: number, unit: string, hint?: string) => (
    <label className="field">
      <span className="field-label">{label}</span>
      <span className="input-unit">
        <input type="number" inputMode="numeric" min={min} max={max} value={s[k] as number} onChange={e => setS({ ...s, [k]: Number(e.target.value) || 0 })} />
        <span>{unit}</span>
      </span>
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  )
  return (
    <section className="screen">
      <h1>Cài đặt đăng nhập</h1>
      <div className="card form-grid">
        {num('idleMinutes', 'Tự đăng xuất khi để yên', 1, 240, 'phút', 'Không áp dụng tài khoản bếp')}
        {num('maxAttempts', 'Nhập sai PIN tối đa', 3, 10, 'lần')}
        {num('lockMinutes', 'Khoá PIN sau khi sai', 1, 120, 'phút')}
        {num('approvalSeconds', 'Mã duyệt có hiệu lực', 30, 600, 'giây')}
        <fieldset className="pick-group field-wide">
          <legend>Huỷ món cần quản lý duyệt</legend>
          <div className="chip-row">
            <button type="button" className={'chip' + (s.voidApproval === 'sent' ? ' is-on' : '')} onClick={() => setS({ ...s, voidApproval: 'sent' })}>
              Mọi món đã gửi bếp
            </button>
            <button type="button" className={'chip' + (s.voidApproval === 'started' ? ' is-on' : '')} onClick={() => setS({ ...s, voidApproval: 'started' })}>
              Chỉ món bếp đã làm
            </button>
          </div>
        </fieldset>
      </div>
      <button type="button" className="btn btn-primary" onClick={() => repo.saveSettings(s).then(() => props.onInfo('Đã lưu cài đặt'), props.onError)}>
        Lưu cài đặt
      </button>
    </section>
  )
}

const ACTION_LABEL: Record<string, string> = {
  sign_in: 'Đăng nhập', sign_out: 'Đăng xuất', pin_failed: 'Nhập sai PIN', pin_locked: 'Khoá PIN', approval: 'Quản lý duyệt',
  discount: 'Giảm giá', void_item: 'Huỷ món', void_order: 'Huỷ đơn', staff_add: 'Thêm nhân viên', staff_edit: 'Sửa nhân viên',
  staff_off: 'Ngừng làm', staff_on: 'Làm lại', pin_reset: 'Đặt lại PIN', device_code: 'Tạo mã máy', device_registered: 'Đăng ký máy',
  device_on: 'Mở lại máy', device_off: 'Khoá máy', settings: 'Đổi cài đặt', open_shift: 'Mở ca', close_shift: 'Chốt ca', reprint: 'In lại hoá đơn',
  modify_item: 'Sửa món', sold_out: 'Báo hết', restock: 'Có lại', delete: 'Xoá vĩnh viễn',
}
const DELETE_KIND: Record<string, string> = {
  category: 'nhóm món', item: 'món', group: 'nhóm tuỳ chọn', area: 'khu', table: 'bàn', order: 'đơn / hoá đơn', shift: 'ca', staff: 'nhân viên', device: 'máy',
}
const FOR_LABEL: Record<string, string> = { discount: 'giảm giá', void_item: 'huỷ món', void_order: 'huỷ đơn' }

function auditText(a: AuditEntry): string {
  const d = a.detail
  const parts: string[] = []
  if (a.action === 'approval' && d.for) parts.push(FOR_LABEL[String(d.for)] ?? String(d.for))
  if (a.action === 'delete' && d.kind) parts.push(DELETE_KIND[String(d.kind)] ?? String(d.kind))
  if (d.name && a.action !== 'sign_in') parts.push(String(d.name))
  if (d.qty) parts.push(`× ${d.qty}`)
  if (typeof d.amount === 'number') parts.push(`${d.amount.toLocaleString('vi-VN')}đ`)
  if (d.reason) parts.push(`“${d.reason}”`)
  if (d.role) parts.push(ROLE_LABEL[d.role as Role] ?? String(d.role))
  if (typeof d.left === 'number') parts.push(`còn ${d.left} lần`)
  if (d.device && a.action !== 'sign_in') parts.push(String(d.device))
  return parts.join(' · ')
}

function Audit(props: { onError: (e: unknown) => void }) {
  const { repo } = useAuth()
  const [list, setList] = useState<AuditEntry[] | null>(null)
  const { onError } = props
  const load = useCallback(() => repo.audit(200).then(setList, onError), [repo, onError])
  useEffect(() => {
    load()
    return repo.subscribe(load)
  }, [repo, load])
  return (
    <section className="screen">
      <div className="screen-head">
        <h1>Nhật ký</h1>
        <button type="button" className="btn btn-small" onClick={load}>
          Tải lại
        </button>
      </div>
      <p className="muted small">Ai làm gì, lúc nào, ai duyệt, trên máy nào (cả những lần xoá vĩnh viễn). Không sửa hay xoá được.</p>
      <div className="audit-wrap">
        <table className="audit">
          <thead>
            <tr>
              <th>Lúc</th>
              <th>Việc</th>
              <th>Người</th>
              <th>Duyệt</th>
              <th>Máy</th>
              <th>Chi tiết</th>
            </tr>
          </thead>
          <tbody>
            {(list ?? []).map(a => (
              <tr key={a.id} className={a.action === 'pin_failed' || a.action === 'pin_locked' ? 'is-warn' : ''}>
                <td>{when(a.at)}</td>
                <td>{ACTION_LABEL[a.action] ?? a.action}</td>
                <td>{a.staff}</td>
                <td>{a.approvedBy}</td>
                <td>{a.device}</td>
                <td>{auditText(a)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {list && !list.length && <p className="muted">Chưa có gì.</p>}
      </div>
    </section>
  )
}
