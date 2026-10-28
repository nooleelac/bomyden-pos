// #/cai-dat/chi-nhanh (owner): every branch with its people, devices and dishes; add one (copying another branch's
// menu, or empty), rename, close / reopen, and work in another branch on this device.
// #/cai-dat/gio-lam (settings.edit): this branch's opening hours per weekday, whether ordering stops outside them,
// and where its business day starts (reports, takeaway numbers).

import { useCallback, useEffect, useState } from 'react'
import { hoursProblem, hoursSummary, WEEKDAYS } from '../auth/branch'
import { useAuth } from '../auth/context'
import type { Branch, OpeningHours } from '../auth/types'
import { errText } from '../floor/hooks'
import { Field, Section, Switch } from '../menu/ui'

interface Notify {
  onError: (m: string) => void
  onInfo: (m: string) => void
}

function useBranches(onError: (m: string) => void): [Branch[] | null, () => void] {
  const { repo } = useAuth()
  const [list, setList] = useState<Branch[] | null>(null)
  const load = useCallback(() => {
    repo.branches().then(setList, e => onError(errText(e)))
  }, [repo, onError])
  useEffect(() => {
    load()
    return repo.subscribe(load)
  }, [repo, load])
  return [list, load]
}

export function BranchesPage(props: Notify) {
  const { repo, branch, switchBranch } = useAuth()
  const [list, reload] = useBranches(props.onError)
  const [name, setName] = useState('')
  const [copyFrom, setCopyFrom] = useState<string>('')
  const [edit, setEdit] = useState<{ id: string; name: string } | null>(null)
  const [busy, setBusy] = useState(false)

  const run = (f: () => Promise<unknown>, done: string) => {
    setBusy(true)
    f()
      .then(() => {
        props.onInfo(done)
        reload()
      }, e => props.onError(errText(e)))
      .finally(() => setBusy(false))
  }
  const add = () =>
    run(async () => {
      await repo.saveBranch({ name, copyFrom: copyFrom || null })
      setName('')
    }, copyFrom ? 'Đã thêm chi nhánh và chép thực đơn' : 'Đã thêm chi nhánh')

  if (!list) return <p className="muted">Đang tải…</p>
  const open = list.filter(b => b.active)
  return (
    <section className="screen branch-settings">
      <h1>Chi nhánh</h1>
      <p className="muted small">
        Mỗi chi nhánh có thực đơn, bàn, đơn, hoá đơn, ca, nhân viên, máy, máy in và cài đặt riêng. Máy thuộc chi nhánh của mã đăng ký; nhân viên chỉ đăng
        nhập ở chi nhánh của mình. Chủ quán đăng nhập mọi nơi và đổi chi nhánh làm việc ở đây.
      </p>

      <ul className="branch-list">
        {list.map(b => {
          const here = b.id === branch?.id
          return (
            <li key={b.id} className={'branch-card' + (here ? ' is-here' : '') + (b.active ? '' : ' is-off')}>
              <div className="branch-head">
                {edit?.id === b.id ? (
                  <input className="branch-name-input" value={edit.name} maxLength={40} autoFocus onChange={e => setEdit({ ...edit, name: e.target.value })} aria-label="Tên chi nhánh" />
                ) : (
                  <b className="branch-name">
                    {b.name}
                    {here && <span className="tag-default">Đang làm việc</span>}
                    {!b.active && <span className="tag-off">Đã đóng</span>}
                  </b>
                )}
                <span className="branch-actions">
                  {edit?.id === b.id ? (
                    <>
                      <button type="button" className="btn btn-small btn-primary" disabled={busy || !edit.name.trim()} onClick={() => run(() => repo.saveBranch({ id: b.id, name: edit.name, active: b.active }).then(() => setEdit(null)), 'Đã đổi tên')}>
                        Lưu
                      </button>
                      <button type="button" className="btn btn-small" onClick={() => setEdit(null)}>
                        Huỷ
                      </button>
                    </>
                  ) : (
                    <>
                      {!here && b.active && (
                        <button type="button" className="btn btn-small btn-primary" disabled={busy} onClick={() => run(() => switchBranch(b.id), `Đang làm việc ở ${b.name}`)}>
                          Làm việc ở đây
                        </button>
                      )}
                      <button type="button" className="btn btn-small" disabled={busy} onClick={() => setEdit({ id: b.id, name: b.name })}>
                        Đổi tên
                      </button>
                      {b.active ? (
                        <button
                          type="button"
                          className="btn btn-small btn-danger"
                          disabled={busy || open.length < 2}
                          title={open.length < 2 ? 'Phải còn ít nhất một chi nhánh mở' : undefined}
                          onClick={() => window.confirm(`Đóng ${b.name}? Nhân viên ở đó không đăng nhập được nữa (dữ liệu vẫn giữ).`) && run(() => repo.saveBranch({ id: b.id, name: b.name, active: false }), 'Đã đóng chi nhánh')}
                        >
                          Đóng
                        </button>
                      ) : (
                        <button type="button" className="btn btn-small" disabled={busy} onClick={() => run(() => repo.saveBranch({ id: b.id, name: b.name, active: true }), 'Đã mở lại chi nhánh')}>
                          Mở lại
                        </button>
                      )}
                    </>
                  )}
                </span>
              </div>
              <p className="muted small">
                {b.staff} nhân viên · {b.devices} máy · {b.items} món · chốt ngày {b.businessDayStart}
              </p>
              <p className="small">
                ⏰ {hoursSummary(b.openingHours)}
                {b.enforceHours && <span className="muted"> · chặn gọi món ngoài giờ</span>}
              </p>
            </li>
          )
        })}
      </ul>

      <Section title="Thêm chi nhánh">
        <div className="form-grid">
          <Field label="Tên chi nhánh" hint="Ví dụ: Quận 7, Thủ Đức">
            <input value={name} maxLength={40} onChange={e => setName(e.target.value)} placeholder="Tên chi nhánh" />
          </Field>
          <Field label="Thực đơn" hint="Chép món, nhóm món, tuỳ chọn, khu bếp và giá; sửa riêng sau. Bàn và nhân viên thêm ở chi nhánh mới.">
            <select value={copyFrom} onChange={e => setCopyFrom(e.target.value)}>
              <option value="">Để trống (tự nhập thực đơn)</option>
              {list.map(b => (
                <option key={b.id} value={b.id}>
                  Chép từ {b.name} ({b.items} món)
                </option>
              ))}
            </select>
          </Field>
        </div>
        <p className="muted small">Cài đặt hoá đơn, thanh toán và đăng nhập chép từ chi nhánh đang làm việc. Thêm máy cho chi nhánh mới ở Nhân viên → Máy.</p>
        <div className="pay-settings-actions">
          <button type="button" className="btn btn-primary" disabled={busy || !name.trim()} onClick={add}>
            + Thêm chi nhánh
          </button>
        </div>
      </Section>
    </section>
  )
}

const DEFAULT_DAY = { open: '07:00', close: '22:00' }

export function OpeningHoursPage(props: Notify) {
  const { repo, branch, can } = useAuth()
  const [list] = useBranches(props.onError)
  const mine = list?.find(b => b.id === branch?.id) ?? null
  const [hours, setHours] = useState<OpeningHours>({})
  const [enforce, setEnforce] = useState(false)
  const [dayStart, setDayStart] = useState('06:00')
  const [busy, setBusy] = useState(false)
  const savedKey = mine ? JSON.stringify([mine.openingHours, mine.enforceHours, mine.businessDayStart]) : ''
  // another device saved: show what is stored now
  useEffect(() => {
    if (!savedKey) return
    const [h, e, d] = JSON.parse(savedKey) as [OpeningHours, boolean, string]
    setHours(h)
    setEnforce(e)
    setDayStart(d)
  }, [savedKey])

  if (!list) return <p className="muted">Đang tải…</p>
  if (!mine) return <p className="field-error block">Không tìm thấy chi nhánh đang làm việc.</p>
  const canEdit = can('settings.edit')
  const noHours = Object.keys(hours).length === 0
  const problem = hoursProblem(hours) || (/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(dayStart) ? '' : 'Giờ chốt ngày dạng 06:00')
  const dirty = JSON.stringify([hours, enforce, dayStart]) !== savedKey
  const setDay = (k: (typeof WEEKDAYS)[number]['key'], v: { open: string; close: string } | null) => {
    const next = { ...hours }
    if (v) next[k] = v
    else delete next[k]
    setHours(next)
  }
  const save = () => {
    setBusy(true)
    repo
      .saveOpeningHours(hours, enforce, dayStart)
      .then(() => props.onInfo('Đã lưu giờ làm việc'), e => props.onError(errText(e)))
      .finally(() => setBusy(false))
  }

  return (
    <section className="screen pay-settings hours-settings">
      <h1>Giờ làm việc · {mine.name}</h1>
      {!canEdit && <p className="field-error block">Chỉ người có quyền Sửa cài đặt mới lưu được.</p>}

      <Section title="Giờ mở cửa">
        <p className="muted small">Bỏ chọn ngày nghỉ. Giờ đóng trước giờ mở nghĩa là mở qua nửa đêm (ví dụ 17:00 – 02:00).</p>
        {noHours && <p className="small">Chưa đặt giờ: chi nhánh luôn mở.</p>}
        <ul className="hours-list">
          {WEEKDAYS.map(d => {
            const h = hours[d.key]
            return (
              <li key={d.key} className="hours-row">
                <label className="hours-day">
                  <input type="checkbox" checked={!!h} disabled={!canEdit} onChange={e => setDay(d.key, e.target.checked ? (hours['1'] ?? Object.values(hours)[0] ?? DEFAULT_DAY) : null)} />
                  <b>{d.label}</b>
                </label>
                {h ? (
                  <span className="hours-times">
                    <input type="time" value={h.open} disabled={!canEdit} aria-label={`${d.label} mở`} onChange={e => setDay(d.key, { ...h, open: e.target.value })} />
                    <span>–</span>
                    <input type="time" value={h.close} disabled={!canEdit} aria-label={`${d.label} đóng`} onChange={e => setDay(d.key, { ...h, close: e.target.value })} />
                  </span>
                ) : (
                  <span className="muted small">{noHours ? '—' : 'Nghỉ'}</span>
                )}
              </li>
            )
          })}
        </ul>
        {!noHours && (
          <button type="button" className="btn btn-small" disabled={!canEdit} onClick={() => setHours({})}>
            Bỏ giờ (luôn mở)
          </button>
        )}
      </Section>

      <Section title="Ngoài giờ">
        <Switch
          checked={enforce}
          disabled={!canEdit || noHours}
          onChange={setEnforce}
          label={
            <span>
              <b>Chặn mở bàn và gọi mang về ngoài giờ</b>
              <span className="muted small block">Bàn đang có khách vẫn gọi thêm món, thu tiền bình thường. Quản lý và chủ quán vẫn mở được bàn mới.</span>
            </span>
          }
        />
      </Section>

      <Section title="Chốt ngày">
        <div className="form-grid">
          <Field label="Ngày làm việc bắt đầu lúc" hint="Báo cáo doanh thu và số thứ tự mang về tính theo ngày này. Ví dụ 06:00: hoá đơn lúc 01:30 tính vào hôm trước.">
            <input type="time" value={dayStart} disabled={!canEdit} onChange={e => setDayStart(e.target.value)} />
          </Field>
        </div>
      </Section>

      {problem && dirty && <p className="field-error block">{problem}</p>}
      <div className="pay-settings-actions">
        <button
          type="button"
          className="btn"
          disabled={!dirty || busy}
          onClick={() => {
            setHours(mine.openingHours)
            setEnforce(mine.enforceHours)
            setDayStart(mine.businessDayStart)
          }}
        >
          Huỷ thay đổi
        </button>
        <button type="button" className="btn btn-primary" disabled={!canEdit || !dirty || busy || !!problem} onClick={save}>
          {busy ? 'Đang lưu…' : 'Lưu'}
        </button>
      </div>
    </section>
  )
}
