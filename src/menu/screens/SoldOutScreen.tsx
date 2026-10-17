// Kitchen / cashier / manager: mark a dish, a size, an option or a component sold out; every device updates.
// Waiters see the list but cannot change it.

import { useState } from 'react'
import { fold } from '../../lib/text'
import type { MenuRepo } from '../repo'
import { isSoldOut, type Menu, type SoldOutKind, type SoldOutMode } from '../types'

function untilLabel(until: string | null): string {
  if (until === 'infinity') return 'Tạm ngưng'
  if (!until) return ''
  const d = new Date(until)
  const local = new Date(d.getTime() + 7 * 3600_000)
  return `Hết hôm nay (mở lại ${String(local.getUTCHours()).padStart(2, '0')}:${String(local.getUTCMinutes()).padStart(2, '0')})`
}

export function SoldOutScreen(props: { menu: Menu; repo: MenuRepo; now: Date; canEdit: boolean; onError: (m: string) => void }) {
  const { menu, now, canEdit } = props
  const [q, setQ] = useState('')
  const [onlyOut, setOnlyOut] = useState(false)

  const Toggle = (p: { kind: SoldOutKind; id: string; name: string; until: string | null }) => {
    const out = isSoldOut(p.until, now)
    const go = (mode: SoldOutMode) => props.repo.setSoldOut(p.kind, p.id, mode).catch(e => props.onError(e instanceof Error ? e.message : String(e)))
    return (
      <li className={'so-row' + (out ? ' is-out' : '')}>
        <span>
          {p.name}
          {out && <span className="small so-until"> · {untilLabel(p.until)}</span>}
        </span>
        {canEdit ? (
          out ? (
            <button type="button" className="btn btn-small" onClick={() => go('reopen')}>
              Mở bán lại
            </button>
          ) : (
            <span className="btn-pair">
              <button type="button" className="btn btn-small btn-warn" onClick={() => go('today')}>
                Hết hôm nay
              </button>
              <button type="button" className="btn btn-small" onClick={() => go('hold')}>
                Tạm ngưng
              </button>
            </span>
          )
        ) : (
          <span className={'badge' + (out ? ' badge-out' : '')}>{out ? 'Hết' : 'Còn'}</span>
        )}
      </li>
    )
  }

  const items = menu.items
    .filter(i => i.status === 'active' && (!q || fold(`${i.name} ${i.code}`).includes(fold(q))))
    .sort((a, b) => a.name.localeCompare(b.name, 'vi'))
  const anyOut = (i: (typeof items)[number]) =>
    isSoldOut(i.soldOutUntil, now) || i.variants.some(v => isSoldOut(v.soldOutUntil, now)) || i.components.some(c => isSoldOut(c.soldOutUntil, now))

  return (
    <div className="screen">
      <div className="screen-head">
        <h1>Báo hết món</h1>
      </div>
      {!canEdit && <p className="muted small">Phục vụ chỉ xem. Bếp, Thu ngân hoặc Quản lý báo hết.</p>}
      <div className="search-bar">
        <input type="search" value={q} placeholder="Tìm món" aria-label="Tìm món để báo hết" onChange={e => setQ(e.target.value)} />
      </div>
      <label className="muted small inline-check">
        <input type="checkbox" checked={onlyOut} onChange={e => setOnlyOut(e.target.checked)} /> Chỉ hiện mục đang hết
      </label>
      {items.filter(i => !onlyOut || anyOut(i)).map(i => (
        <section key={i.id} className="card so-card">
          <h2>{i.name}</h2>
          <ul>
            <Toggle kind="item" id={i.id} name="Cả món" until={i.soldOutUntil} />
            {i.variants.filter(v => !v.archivedAt && (!onlyOut || isSoldOut(v.soldOutUntil, now))).map(v => (
              <Toggle key={v.id} kind="variant" id={v.id} name={`Size ${v.name}`} until={v.soldOutUntil} />
            ))}
            {i.components.filter(c => !onlyOut || isSoldOut(c.soldOutUntil, now)).map(c => (
              <Toggle key={c.id} kind="component" id={c.id} name={`${c.name}${c.removable ? '' : ' (chính: hết là hết món)'}`} until={c.soldOutUntil} />
            ))}
          </ul>
        </section>
      ))}
      <section className="card so-card">
        <h2>Tuỳ chọn và món thêm</h2>
        <ul>
          {menu.groups.flatMap(g =>
            g.options.filter(o => (!onlyOut || isSoldOut(o.soldOutUntil, now)) && (!q || fold(o.name).includes(fold(q)))).map(o => (
              <Toggle key={o.id} kind="option" id={o.id} name={`${g.name}: ${o.name}`} until={o.soldOutUntil} />
            )),
          )}
        </ul>
      </section>
    </div>
  )
}
