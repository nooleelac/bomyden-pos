// Manager: every dish by category, including drafts and archived ones.

import { useState } from 'react'
import { fold } from '../../lib/text'
import { priceLabel } from '../picker'
import { blankItem, type MenuRepo } from '../repo'
import { ITEM_STATUS_LABEL, type Menu, type MenuItem } from '../types'

export function ItemsScreen(props: { menu: Menu; repo: MenuRepo; onOpen: (item: MenuItem) => void; onError: (m: string) => void }) {
  const { menu } = props
  const [q, setQ] = useState('')
  const [showArchived, setShowArchived] = useState(false)
  const cats = menu.categories
    .filter(c => !c.parentId)
    .sort((a, b) => a.sort - b.sort)
    .flatMap(c => [c, ...menu.categories.filter(k => k.parentId === c.id).sort((a, b) => a.sort - b.sort)])
  const match = (i: MenuItem) => (!q || fold(`${i.name} ${i.code} ${i.shortName}`).includes(fold(q))) && (showArchived || i.status !== 'archived')

  const move = (list: MenuItem[], i: number, dir: -1 | 1) => {
    const ids = list.map(x => x.id)
    const j = i + dir
    ;[ids[i], ids[j]] = [ids[j], ids[i]]
    props.repo.reorderItems(ids).catch(e => props.onError(String(e)))
  }

  return (
    <div className="screen">
      <div className="screen-head">
        <h1>Món</h1>
        <button type="button" className="btn btn-primary" onClick={() => props.onOpen(blankItem(menu, cats[0]?.id ?? ''))}>
          + Món
        </button>
      </div>
      <div className="search-bar">
        <input type="search" value={q} placeholder="Lọc theo tên hoặc mã" aria-label="Lọc món" onChange={e => setQ(e.target.value)} />
      </div>
      <label className="muted small inline-check">
        <input type="checkbox" checked={showArchived} onChange={e => setShowArchived(e.target.checked)} /> Hiện món ngừng kinh doanh
      </label>
      {cats.map(c => {
        const list = menu.items.filter(i => i.categoryId === c.id).sort((a, b) => a.sort - b.sort)
        const shown = list.filter(match)
        if (!shown.length) return null
        return (
          <section key={c.id} className="item-group">
            <h2 className="group-title" style={{ ['--cat' as string]: c.color }}>
              {c.parentId ? `${menu.categories.find(p => p.id === c.parentId)?.name} › ` : ''}
              {c.name}
              {!c.visible && <span className="badge">Nhóm đang ẩn</span>}
            </h2>
            <ul className="manage-list">
              {shown.map(i => {
                const idx = list.indexOf(i)
                return (
                  <li key={i.id}>
                    <button type="button" className="manage-main" onClick={() => props.onOpen(structuredClone(i))}>
                      <span>
                        <b>{i.name}</b> <span className="muted small">{i.code} · {i.shortName}</span>
                        <span className="muted small block">
                          {priceLabel(i)}
                          {i.hasSizes ? ` · ${i.variants.filter(v => !v.archivedAt).map(v => v.name).join(' / ')}` : ''}
                          {i.components.length ? ` · ${i.components.length} thành phần` : ''}
                        </span>
                      </span>
                      <span className={`badge badge-${i.status}`}>{ITEM_STATUS_LABEL[i.status]}</span>
                    </button>
                    {!q && (
                      <span className="row-actions">
                        <button type="button" className="icon-btn" aria-label={`Đưa ${i.name} lên`} disabled={idx === 0} onClick={() => move(list, idx, -1)}>
                          ↑
                        </button>
                        <button type="button" className="icon-btn" aria-label={`Đưa ${i.name} xuống`} disabled={idx === list.length - 1} onClick={() => move(list, idx, 1)}>
                          ↓
                        </button>
                      </span>
                    )}
                  </li>
                )
              })}
            </ul>
          </section>
        )
      })}
    </div>
  )
}
