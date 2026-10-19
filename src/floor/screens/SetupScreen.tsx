// Khu vực và bàn: tables.edit adds, renames, reorders (↑ ↓), closes areas and tables (Sửa on a table: tên, số ghế, khu); tables.temp adds a bàn tạm in two taps.
// Tables that were used are only "Ngừng sử dụng", unless someone with Xoá vĩnh viễn (admin.delete) deletes them for
// good (with the orders still open on them). Grid order now; drag-and-drop later.

import { roleCan } from '../../auth/permissions'
import { useState } from 'react'
import { newId } from '../../menu/repo'
import { areaTables, openOrdersAt } from '../logic'
import type { FloorRepo } from '../repo'
import type { Area, FloorState, Role, Table } from '../types'

export function SetupScreen(props: { floor: FloorState; repo: FloorRepo; role: Role; onError: (m: string) => void }) {
  const { floor, repo, role } = props
  const fail = (e: unknown) => props.onError(e instanceof Error ? e.message : String(e))
  const areas = [...floor.areas].sort((a, b) => a.sort - b.sort)
  const [areaName, setAreaName] = useState('')
  const [draft, setDraft] = useState<Record<string, { name: string; seats: number }>>({})
  const [editing, setEditing] = useState<{ id: string; name: string; seats: number; areaId: string } | null>(null)
  const [areaEdit, setAreaEdit] = useState<{ id: string; name: string } | null>(null)
  const manager = roleCan(role, 'tables.edit')
  const temp = roleCan(role, 'tables.temp')
  const purge = roleCan(role, 'admin.delete')
  const removeArea = (a: Area) => {
    const n = floor.tables.filter(t => t.areaId === a.id).length
    const open = floor.tables.filter(t => t.areaId === a.id).reduce((k, t) => k + openOrdersAt(floor, t.id).length, 0)
    const msg = `Xoá vĩnh viễn khu ${a.name} và ${n} bàn trong khu${open ? `, cùng ${open} đơn đang mở` : ''}? Hoá đơn đã thu vẫn giữ. Không khôi phục được.`
    if (confirm(msg)) repo.adminDelete('area', a.id).catch(fail)
  }
  const removeTable = (t: Table) => {
    const open = openOrdersAt(floor, t.id).length
    const msg = `Xoá vĩnh viễn bàn ${t.name}${open ? ` cùng ${open} đơn đang mở` : ''}? Hoá đơn đã thu vẫn giữ. Không khôi phục được.`
    if (confirm(msg)) repo.adminDelete('table', t.id).catch(fail)
  }

  const addTable = (a: Area, temporary: boolean) => {
    const d = draft[a.id] ?? { name: '', seats: 4 }
    const n = floor.tables.filter(t => t.temporary).length + 1
    const t: Table = {
      id: newId(), areaId: a.id, name: temporary && !d.name.trim() ? `Tạm ${n}` : d.name, seats: d.seats || 4,
      sort: Math.max(0, ...floor.tables.map(x => x.sort)) + 1, active: true, temporary,
    }
    repo.saveTable(t).then(() => setDraft(p => ({ ...p, [a.id]: { name: '', seats: d.seats } })), fail)
  }

  const saveEdit = (t: Table) => {
    if (!editing) return
    const moved = editing.areaId !== t.areaId
    const sort = moved ? Math.max(0, ...floor.tables.filter(x => x.areaId === editing.areaId).map(x => x.sort)) + 1 : t.sort
    repo.saveTable({ ...t, name: editing.name, seats: editing.seats, areaId: editing.areaId, sort }).then(() => setEditing(null), fail)
  }

  const saveAreaName = (a: Area) => {
    if (!areaEdit) return
    repo.saveArea({ ...a, name: areaEdit.name }).then(() => setAreaEdit(null), fail)
  }
  /** Lên / xuống: swap places with the neighbour (the floor map shows areas in this order). */
  const moveArea = (i: number, by: -1 | 1) => {
    const a = areas[i]
    const b = areas[i + by]
    if (!b) return
    const order = areas.map((x, k) => (k === i ? b : k === i + by ? a : x))
    Promise.all(order.map((x, k) => (x.sort === k + 1 ? null : repo.saveArea({ ...x, sort: k + 1 }))).filter(Boolean)).catch(fail)
  }

  return (
    <div className="screen">
      <h1>Khu vực và bàn</h1>
      {!manager && <p className="muted">Bạn chỉ tạo được bàn tạm (bàn kê thêm). Sửa khu vực và bàn cần quyền riêng.</p>}
      {areas.map((a, i) => (
        <section key={a.id} className="card">
          {areaEdit?.id === a.id ? (
            <header className="card-head area-edit">
              <label className="field">
                <span className="field-label">Tên khu</span>
                <input
                  autoFocus
                  maxLength={40}
                  value={areaEdit.name}
                  onChange={e => setAreaEdit({ ...areaEdit, name: e.target.value })}
                  onKeyDown={e => {
                    if (e.key === 'Enter') saveAreaName(a)
                    if (e.key === 'Escape') setAreaEdit(null)
                  }}
                />
              </label>
              <span className="row-actions">
                <button type="button" className="btn btn-small" onClick={() => setAreaEdit(null)}>
                  Huỷ
                </button>
                <button type="button" className="btn btn-small btn-primary" disabled={!areaEdit.name.trim()} onClick={() => saveAreaName(a)}>
                  Lưu
                </button>
              </span>
            </header>
          ) : (
          <header className="card-head">
            <h2>
              {a.name} {!a.active && <span className="badge">Tạm đóng</span>}
            </h2>
            <span className="row-actions">
              {manager && (
                <>
                  <button type="button" className="btn btn-small" aria-label={`Đưa khu ${a.name} lên`} disabled={i === 0} onClick={() => moveArea(i, -1)}>
                    ↑
                  </button>
                  <button type="button" className="btn btn-small" aria-label={`Đưa khu ${a.name} xuống`} disabled={i === areas.length - 1} onClick={() => moveArea(i, 1)}>
                    ↓
                  </button>
                  <button type="button" className="btn btn-small" onClick={() => setAreaEdit({ id: a.id, name: a.name })}>
                    Sửa
                  </button>
                </>
              )}
              {manager && (
                <button type="button" className="btn btn-small" onClick={() => repo.saveArea({ ...a, active: !a.active }).catch(fail)}>
                  {a.active ? 'Tạm đóng khu' : 'Mở lại khu'}
                </button>
              )}
              {purge && (
                <button type="button" className="btn btn-small btn-danger" onClick={() => removeArea(a)}>
                  Xoá khu
                </button>
              )}
            </span>
          </header>
          )}
          <ul className="rows">
            {areaTables(floor, a.id)
              .concat(floor.tables.filter(t => t.areaId === a.id && !t.active && !openOrdersAt(floor, t.id).length))
              .map(t =>
                editing?.id === t.id ? (
                  <li key={t.id} className="picked-line table-edit">
                    <label className="field">
                      <span className="field-label">Tên bàn</span>
                      <input autoFocus maxLength={20} value={editing.name} onChange={e => setEditing({ ...editing, name: e.target.value })} onKeyDown={e => e.key === 'Enter' && saveEdit(t)} />
                    </label>
                    <label className="field">
                      <span className="field-label">Số ghế</span>
                      <input type="number" min={1} max={99} className="w-qty" value={editing.seats} onChange={e => setEditing({ ...editing, seats: Number(e.target.value) })} />
                    </label>
                    {manager && (
                      <label className="field">
                        <span className="field-label">Khu</span>
                        <select value={editing.areaId} onChange={e => setEditing({ ...editing, areaId: e.target.value })}>
                          {areas.map(x => (
                            <option key={x.id} value={x.id}>
                              {x.name}
                            </option>
                          ))}
                        </select>
                      </label>
                    )}
                    <span className="row-actions">
                      <button type="button" className="btn btn-small" onClick={() => setEditing(null)}>
                        Huỷ
                      </button>
                      <button type="button" className="btn btn-small btn-primary" disabled={!editing.name.trim()} onClick={() => saveEdit(t)}>
                        Lưu
                      </button>
                    </span>
                  </li>
                ) : (
                  <li key={t.id} className="picked-line">
                    <span className={t.active ? '' : 'muted'}>
                      <b>Bàn {t.name}</b> · {t.seats} ghế {t.temporary && <span className="badge">bàn tạm</span>} {!t.active && '· ngừng sử dụng'}
                    </span>
                    <span className="row-actions">
                      {(manager || (temp && t.temporary)) && (
                        <button type="button" className="btn btn-small" onClick={() => setEditing({ id: t.id, name: t.name, seats: t.seats, areaId: t.areaId })}>
                          Sửa
                        </button>
                      )}
                      {manager && (
                        <button type="button" className="btn btn-small" onClick={() => repo.saveTable({ ...t, active: !t.active }).catch(fail)}>
                          {t.active ? 'Ngừng dùng' : 'Dùng lại'}
                        </button>
                      )}
                      {purge && (
                        <button type="button" className="btn btn-small btn-danger" onClick={() => removeTable(t)}>
                          Xoá
                        </button>
                      )}
                    </span>
                  </li>
                ),
              )}
          </ul>
          <div className="setup-add">
            <input
              aria-label={`Tên bàn mới ở ${a.name}`}
              placeholder="Tên bàn (VD: 13, VIP 1)"
              value={draft[a.id]?.name ?? ''}
              onChange={e => setDraft(p => ({ ...p, [a.id]: { seats: p[a.id]?.seats ?? 4, name: e.target.value } }))}
            />
            <input
              aria-label="Số ghế"
              type="number"
              min={1}
              max={99}
              className="w-qty"
              value={draft[a.id]?.seats ?? 4}
              onChange={e => setDraft(p => ({ ...p, [a.id]: { name: p[a.id]?.name ?? '', seats: Number(e.target.value) } }))}
            />
            {manager && (
              <button type="button" className="btn btn-small" onClick={() => addTable(a, false)}>
                + Bàn
              </button>
            )}
            {(manager || temp) && (
              <button type="button" className="btn btn-small" onClick={() => addTable(a, true)}>
                + Bàn tạm
              </button>
            )}
          </div>
        </section>
      ))}
      {manager && (
        <div className="setup-add">
          <input aria-label="Tên khu mới" placeholder="Khu mới (VD: Sân thượng)" value={areaName} onChange={e => setAreaName(e.target.value)} />
          <button
            type="button"
            className="btn"
            onClick={() => repo.saveArea({ id: newId(), name: areaName, sort: areas.length + 1, active: true }).then(() => setAreaName(''), fail)}
          >
            + Khu
          </button>
        </div>
      )}
    </div>
  )
}
