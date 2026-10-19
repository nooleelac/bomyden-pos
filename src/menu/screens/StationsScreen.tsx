// Manager: khu chế biến (bếp nướng, bếp lẩu, bar…): add, rename, kind, kitchen-screen timing, order, delete.
// Each kitchen/bar station gets its own kitchen screen at #/bep/<code>; 'Không qua bếp' dishes are ready at once.

import { useState } from 'react'
import { newId, type MenuRepo } from '../repo'
import { STATION_KIND_LABEL, type Menu, type Station, type StationKind } from '../types'
import { stationCode, stationDeleteBlock, validateStation } from '../validate'
import { Field } from '../ui'

export function StationsScreen(props: { menu: Menu; repo: MenuRepo; onError: (m: string) => void }) {
  const { menu, repo } = props
  const [edit, setEdit] = useState<Station | null>(null)
  const list = [...menu.stations].sort((a, b) => a.sort - b.sort)
  const used = (id: string) =>
    menu.categories.filter(c => c.defaultStationId === id).length + menu.items.filter(i => i.stationId === id).length

  const run = (p: Promise<unknown>) => p.catch(e => props.onError(e instanceof Error ? e.message : String(e)))
  const move = (st: Station, dir: -1 | 1) => {
    const ids = list.map(x => x.id)
    const i = ids.indexOf(st.id)
    const j = i + dir
    if (j < 0 || j >= ids.length) return
    ;[ids[i], ids[j]] = [ids[j], ids[i]]
    run(repo.reorderStations(ids))
  }
  const blank = (): Station => ({ id: newId(), code: '', name: '', kind: 'kitchen', sort: list.length + 1, warnMin: 10, lateMin: 15 })

  return (
    <div className="screen">
      <div className="screen-head">
        <h1>Khu bếp</h1>
        <button type="button" className="btn btn-primary" onClick={() => setEdit(blank())}>
          + Khu
        </button>
      </div>
      <p className="muted small">
        Món gửi bếp sẽ hiện ở màn hình của khu chế biến món đó. Khu loại Không qua bếp thì món xong ngay, không lên màn bếp.
      </p>
      <ul className="cat-list">
        {list.map((st, i) => (
          <li key={st.id} className="cat-row">
            <button type="button" className="cat-name" onClick={() => setEdit({ ...st })}>
              <b>{st.name}</b>
              <span className="muted small">
                {STATION_KIND_LABEL[st.kind]} · mã {st.code}
                {st.kind !== 'none' && ` · vàng ${st.warnMin}′, đỏ ${st.lateMin}′`} · {used(st.id)} nhóm/món dùng
              </span>
            </button>
            <span className="row-actions">
              <button type="button" className="icon-btn" aria-label={`Đưa ${st.name} lên`} disabled={i === 0} onClick={() => move(st, -1)}>
                ↑
              </button>
              <button type="button" className="icon-btn" aria-label={`Đưa ${st.name} xuống`} disabled={i === list.length - 1} onClick={() => move(st, 1)}>
                ↓
              </button>
            </span>
          </li>
        ))}
      </ul>
      {edit && (
        <StationForm
          menu={menu}
          value={edit}
          onCancel={() => setEdit(null)}
          onSave={st => run(repo.saveStation(st).then(() => setEdit(null)))}
          onDelete={id => run(repo.deleteStation(id).then(() => setEdit(null)))}
        />
      )}
    </div>
  )
}

function StationForm(props: { menu: Menu; value: Station; onSave: (st: Station) => void; onCancel: () => void; onDelete: (id: string) => void }) {
  const { menu } = props
  const [st, setSt] = useState(props.value)
  const [tried, setTried] = useState(false)
  const isNew = !menu.stations.some(x => x.id === st.id)
  // a new station's code follows its name until the manager types one
  const [autoCode, setAutoCode] = useState(isNew && !st.code)
  const errors = tried ? validateStation(menu, st) : {}
  const delBlock = isNew ? null : stationDeleteBlock(menu, st.id)
  const save = () => {
    setTried(true)
    if (Object.keys(validateStation(menu, st)).length === 0) props.onSave({ ...st, name: st.name.trim(), code: st.code.trim() })
  }
  const del = () => {
    if (confirm(`Xoá khu ${props.value.name}? Phiếu đang chờ ở khu này sẽ không còn hiện trên màn bếp.`)) props.onDelete(st.id)
  }
  const num = (v: string) => (v === '' ? NaN : Number(v))
  return (
    <div className="sheet-backdrop" onClick={props.onCancel}>
      <div className="sheet" role="dialog" aria-label="Sửa khu bếp" onClick={e => e.stopPropagation()}>
        <header className="sheet-head">
          <h2>{isNew ? 'Khu mới' : `Sửa khu ${props.value.name}`}</h2>
          <button type="button" className="icon-btn" onClick={props.onCancel} aria-label="Đóng">
            ✕
          </button>
        </header>
        <div className="sheet-body form-grid">
          <Field label="Tên khu" error={errors.name} hint="Ví dụ: Bếp nướng, Bếp lẩu, Bar" wide>
            <input
              value={st.name}
              maxLength={30}
              autoFocus
              onChange={e => setSt({ ...st, name: e.target.value, code: autoCode ? stationCode(e.target.value) : st.code })}
            />
          </Field>
          <Field label="Mã khu" error={errors.code} hint={st.code ? `Màn bếp: #/bep/${st.code}` : 'Chữ thường không dấu, dùng cho link màn bếp'}>
            <input
              value={st.code}
              maxLength={20}
              onChange={e => {
                setAutoCode(false)
                setSt({ ...st, code: e.target.value.toLowerCase() })
              }}
            />
          </Field>
          <Field label="Loại">
            <select value={st.kind} onChange={e => setSt({ ...st, kind: e.target.value as StationKind })}>
              {(Object.keys(STATION_KIND_LABEL) as StationKind[]).map(k => (
                <option key={k} value={k}>
                  {STATION_KIND_LABEL[k]}
                </option>
              ))}
            </select>
          </Field>
          {st.kind !== 'none' && (
            <>
              <Field label="Phiếu vàng sau (phút)" error={errors.warnMin}>
                <input type="number" inputMode="numeric" min={1} max={240} value={Number.isFinite(st.warnMin) ? st.warnMin : ''} onChange={e => setSt({ ...st, warnMin: num(e.target.value) })} />
              </Field>
              <Field label="Phiếu đỏ sau (phút)" error={errors.lateMin}>
                <input type="number" inputMode="numeric" min={1} max={240} value={Number.isFinite(st.lateMin) ? st.lateMin : ''} onChange={e => setSt({ ...st, lateMin: num(e.target.value) })} />
              </Field>
            </>
          )}
        </div>
        <footer className="sheet-foot">
          {!isNew && (
            <button type="button" className="btn btn-danger" disabled={!!delBlock} title={delBlock ?? ''} onClick={del}>
              Xoá
            </button>
          )}
          <button type="button" className="btn btn-primary btn-grow" onClick={save}>
            Lưu khu
          </button>
        </footer>
        {delBlock && <p className="muted small center">{delBlock}</p>}
      </div>
    </div>
  )
}
