// Khu vực và bàn: managers add, rename, close areas and tables; cashiers add a bàn tạm in two taps.
// Tables that were used are never deleted, only "Ngừng sử dụng". Grid order now; drag-and-drop later.

import { isManager } from '../../auth/guards'
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
  const manager = isManager(role)

  const addTable = (a: Area, temporary: boolean) => {
    const d = draft[a.id] ?? { name: '', seats: 4 }
    const n = floor.tables.filter(t => t.temporary).length + 1
    const t: Table = {
      id: newId(), areaId: a.id, name: temporary && !d.name.trim() ? `Tạm ${n}` : d.name, seats: d.seats || 4,
      sort: Math.max(0, ...floor.tables.map(x => x.sort)) + 1, active: true, temporary, needsCleaning: false,
    }
    repo.saveTable(t).then(() => setDraft(p => ({ ...p, [a.id]: { name: '', seats: d.seats } })), fail)
  }

  return (
    <div className="screen">
      <h1>Khu vực và bàn</h1>
      {!manager && <p className="muted">Thu ngân chỉ tạo được bàn tạm (bàn kê thêm). Quản lý sửa được mọi thứ.</p>}
      {areas.map(a => (
        <section key={a.id} className="card">
          <header className="card-head">
            <h2>
              {a.name} {!a.active && <span className="badge">Tạm đóng</span>}
            </h2>
            {manager && (
              <button type="button" className="btn btn-small" onClick={() => repo.saveArea({ ...a, active: !a.active }).catch(fail)}>
                {a.active ? 'Tạm đóng khu' : 'Mở lại khu'}
              </button>
            )}
          </header>
          <ul className="rows">
            {areaTables(floor, a.id)
              .concat(floor.tables.filter(t => t.areaId === a.id && !t.active && !openOrdersAt(floor, t.id).length))
              .map(t => (
                <li key={t.id} className="picked-line">
                  <span className={t.active ? '' : 'muted'}>
                    <b>Bàn {t.name}</b> · {t.seats} ghế {t.temporary && <span className="badge">bàn tạm</span>} {!t.active && '· ngừng sử dụng'}
                  </span>
                  {manager && (
                    <button type="button" className="btn btn-small" onClick={() => repo.saveTable({ ...t, active: !t.active }).catch(fail)}>
                      {t.active ? 'Ngừng dùng' : 'Dùng lại'}
                    </button>
                  )}
                </li>
              ))}
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
            {(manager || role === 'cashier') && (
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
