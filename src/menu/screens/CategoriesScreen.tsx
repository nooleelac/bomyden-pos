// Manager: categories in 2 levels, with order, colour, hide, default station and VAT group. Xoá vĩnh viễn
// (admin.delete) deletes a category with its sub-groups and their dishes.

import { useState } from 'react'
import { newId, type MenuRepo } from '../repo'
import { CATEGORY_COLORS, type Category, type Menu } from '../types'
import { categoryDeleteBlock, validateCategory } from '../validate'
import { Field, Switch } from '../ui'

export function CategoriesScreen(props: { menu: Menu; repo: MenuRepo; purge?: boolean; onError: (m: string) => void }) {
  const { menu, repo } = props
  const [edit, setEdit] = useState<Category | null>(null)
  const sorted = (parentId: string | null) => menu.categories.filter(c => c.parentId === parentId).sort((a, b) => a.sort - b.sort)
  const count = (id: string) => menu.items.filter(i => i.categoryId === id).length

  const run = (p: Promise<unknown>) => p.catch(e => props.onError(e instanceof Error ? e.message : String(e)))
  const move = (c: Category, dir: -1 | 1) => {
    const ids = sorted(c.parentId).map(x => x.id)
    const i = ids.indexOf(c.id)
    const j = i + dir
    if (j < 0 || j >= ids.length) return
    ;[ids[i], ids[j]] = [ids[j], ids[i]]
    run(repo.reorderCategories(ids))
  }
  const blank = (parentId: string | null): Category => {
    const parent = menu.categories.find(c => c.id === parentId)
    return {
      id: newId(), parentId, name: '', sort: sorted(parentId).length + 1, color: parent?.color ?? CATEGORY_COLORS[0], visible: true,
      defaultStationId: parent?.defaultStationId ?? null, vatGroup: parent?.vatGroup ?? 'food',
    }
  }

  const row = (c: Category, level: number, siblings: number, index: number) => (
    <li key={c.id} className={'cat-row' + (level ? ' is-child' : '') + (c.visible ? '' : ' is-hidden')}>
      <span className="swatch" style={{ background: c.color }} aria-hidden />
      <button type="button" className="cat-name" onClick={() => setEdit({ ...c })}>
        <b>{c.name}</b>
        <span className="muted small">
          {count(c.id)} món · {menu.stations.find(s => s.id === c.defaultStationId)?.name ?? 'chưa chọn khu'}
          {c.visible ? '' : ' · Đang ẩn'}
        </span>
      </button>
      <span className="row-actions">
        <button type="button" className="icon-btn" aria-label={`Đưa ${c.name} lên`} disabled={index === 0} onClick={() => move(c, -1)}>
          ↑
        </button>
        <button type="button" className="icon-btn" aria-label={`Đưa ${c.name} xuống`} disabled={index === siblings - 1} onClick={() => move(c, 1)}>
          ↓
        </button>
        <Switch label={<span className="sr-only">Hiện {c.name}</span>} checked={c.visible} onChange={v => run(repo.saveCategory({ ...c, visible: v }))} />
      </span>
    </li>
  )

  return (
    <div className="screen">
      <div className="screen-head">
        <h1>Nhóm món</h1>
        <button type="button" className="btn btn-primary" onClick={() => setEdit(blank(null))}>
          + Nhóm
        </button>
      </div>
      <p className="muted small">Tối đa 2 cấp. Thứ tự ở đây là thứ tự thẻ trên máy order. Ẩn nhóm thì món trong nhóm không hiện khi gọi món.</p>
      <ul className="cat-list">
        {sorted(null).map((c, i, all) => [
          row(c, 0, all.length, i),
          ...sorted(c.id).map((k, j, ks) => row(k, 1, ks.length, j)),
          <li key={c.id + '-add'} className="cat-add">
            <button type="button" className="link" onClick={() => setEdit(blank(c.id))}>
              + Nhóm con trong {c.name}
            </button>
          </li>,
        ])}
      </ul>
      {edit && (
        <CategoryForm
          menu={menu}
          value={edit}
          onCancel={() => setEdit(null)}
          onSave={c => run(repo.saveCategory(c).then(() => setEdit(null)))}
          onDelete={id => run(repo.deleteCategory(id).then(() => setEdit(null)))}
          onPurge={props.purge ? id => run(repo.adminDelete('category', id).then(() => setEdit(null))) : undefined}
        />
      )}
    </div>
  )
}

function CategoryForm(props: {
  menu: Menu
  value: Category
  onSave: (c: Category) => void
  onCancel: () => void
  onDelete: (id: string) => void
  onPurge?: (id: string) => void
}) {
  const { menu } = props
  const [c, setC] = useState(props.value)
  const [tried, setTried] = useState(false)
  const errors = tried ? validateCategory(menu, c) : {}
  const isNew = !menu.categories.some(x => x.id === c.id)
  const hasChildren = menu.categories.some(x => x.parentId === c.id)
  const delBlock = isNew ? null : categoryDeleteBlock(menu, c.id)
  const save = () => {
    setTried(true)
    if (Object.keys(validateCategory(menu, c)).length === 0) props.onSave({ ...c, name: c.name.trim() })
  }
  const purge = () => {
    const kids = menu.categories.filter(x => x.parentId === c.id)
    const ids = new Set([c.id, ...kids.map(x => x.id)])
    const dishes = menu.items.filter(i => ids.has(i.categoryId)).length
    const what = [kids.length && `${kids.length} nhóm con`, dishes && `${dishes} món`].filter(Boolean).join(' và ')
    if (confirm(`Xoá vĩnh viễn nhóm ${props.value.name}${what ? ` cùng ${what} trong nhóm` : ''}? Hoá đơn cũ vẫn giữ tên món. Không khôi phục được.`)) props.onPurge?.(c.id)
  }
  return (
    <div className="sheet-backdrop" onClick={props.onCancel}>
      <div className="sheet" role="dialog" aria-label="Sửa nhóm món" onClick={e => e.stopPropagation()}>
        <header className="sheet-head">
          <h2>{isNew ? 'Nhóm mới' : `Sửa nhóm ${props.value.name}`}</h2>
          <button type="button" className="icon-btn" onClick={props.onCancel} aria-label="Đóng">
            ✕
          </button>
        </header>
        <div className="sheet-body form-grid">
          <Field label="Tên nhóm" error={errors.name} wide>
            <input value={c.name} maxLength={30} autoFocus onChange={e => setC({ ...c, name: e.target.value })} />
          </Field>
          <Field label="Thuộc nhóm" error={errors.parentId} hint={hasChildren ? 'Nhóm đang có nhóm con nên phải là nhóm lớn' : undefined}>
            <select value={c.parentId ?? ''} disabled={hasChildren} onChange={e => setC({ ...c, parentId: e.target.value || null })}>
              <option value="">— Nhóm lớn —</option>
              {menu.categories.filter(x => !x.parentId && x.id !== c.id).map(x => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Khu chế biến mặc định">
            <select value={c.defaultStationId ?? ''} onChange={e => setC({ ...c, defaultStationId: e.target.value || null })}>
              <option value="">— Chưa chọn —</option>
              {menu.stations.map(s => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Thuế VAT mặc định">
            <select value={c.vatGroup} onChange={e => setC({ ...c, vatGroup: e.target.value })}>
              {menu.vatGroups.map(g => (
                <option key={g.code} value={g.code}>
                  {g.name} ({g.rate}%)
                </option>
              ))}
            </select>
          </Field>
          <Field label="Màu" error={errors.color} wide>
            <div className="swatches">
              {CATEGORY_COLORS.map(col => (
                <button
                  key={col}
                  type="button"
                  className={'swatch-btn' + (c.color === col ? ' is-on' : '')}
                  style={{ background: col }}
                  aria-label={`Màu ${col}`}
                  aria-pressed={c.color === col}
                  onClick={() => setC({ ...c, color: col })}
                />
              ))}
            </div>
          </Field>
          <Switch label="Hiện trên máy order" checked={c.visible} onChange={v => setC({ ...c, visible: v })} />
        </div>
        <footer className="sheet-foot">
          {!isNew && delBlock && props.onPurge ? (
            <button type="button" className="btn btn-danger" onClick={purge}>
              Xoá vĩnh viễn
            </button>
          ) : (
            !isNew && (
              <button type="button" className="btn btn-danger" disabled={!!delBlock} title={delBlock ?? ''} onClick={() => props.onDelete(c.id)}>
                Xoá
              </button>
            )
          )}
          <button type="button" className="btn btn-primary btn-grow" onClick={save}>
            Lưu nhóm
          </button>
        </footer>
        {delBlock && !props.onPurge && <p className="muted small center">{delBlock}</p>}
      </div>
    </div>
  )
}
