// Manager: shared option groups (Độ chín, Nước sốt) and paid add-on groups (Món thêm).

import { useState } from 'react'
import { vnd } from '../picker'
import { newId, type MenuRepo } from '../repo'
import type { Menu, ModifierGroup, ModifierOption, ReceiptPrint } from '../types'
import { validateGroup } from '../validate'
import { Field, MoneyInput, Section, Switch } from '../ui'

const PRINT_LABEL: Record<ReceiptPrint, string> = { always: 'Luôn in', if_priced: 'Chỉ in khi có tiền', never: 'Không in' }

export function GroupsScreen(props: { menu: Menu; repo: MenuRepo; onError: (m: string) => void }) {
  const { menu } = props
  const [edit, setEdit] = useState<ModifierGroup | null>(null)
  if (edit) {
    return (
      <GroupEditor
        menu={menu}
        value={edit}
        onClose={() => setEdit(null)}
        onSave={g => props.repo.saveGroup(g).then(() => setEdit(null))}
      />
    )
  }
  const usedBy = (id: string) => menu.items.filter(i => i.groups.some(l => l.groupId === id)).length
  return (
    <div className="screen">
      <div className="screen-head">
        <h1>Tuỳ chọn và món thêm</h1>
      </div>
      <div className="btn-row">
        <button type="button" className="btn" onClick={() => setEdit({ id: newId(), name: '', kind: 'choice', minSelect: 0, maxSelect: 1, printReceipt: 'if_priced', sort: menu.groups.length + 1, options: [] })}>
          + Nhóm tuỳ chọn
        </button>
        <button type="button" className="btn" onClick={() => setEdit({ id: newId(), name: '', kind: 'addon', minSelect: 0, maxSelect: null, printReceipt: 'always', sort: menu.groups.length + 1, options: [] })}>
          + Nhóm món thêm
        </button>
      </div>
      <ul className="manage-list">
        {[...menu.groups].sort((a, b) => a.sort - b.sort).map(g => (
          <li key={g.id}>
            <button type="button" className="manage-main" onClick={() => setEdit(structuredClone(g))}>
              <span>
                <b>{g.name}</b>{' '}
                {g.minSelect > 0 && <span className="badge badge-req">Bắt buộc</span>}
                <span className="muted small block">
                  {g.kind === 'addon' ? 'Món thêm tính tiền' : `Chọn ${g.minSelect}–${g.maxSelect ?? '∞'}`} · dùng cho {usedBy(g.id)} món
                </span>
                <span className="muted small block">{g.options.map(o => (o.priceDelta ? `${o.name} +${vnd(o.priceDelta)}` : o.name)).join(', ')}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

function GroupEditor(props: { menu: Menu; value: ModifierGroup; onSave: (g: ModifierGroup) => Promise<void>; onClose: () => void }) {
  const [g, setG] = useState(props.value)
  const [tried, setTried] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const e = tried ? validateGroup(props.menu, g) : {}
  const addon = g.kind === 'addon'
  const setOpt = (id: string, patch: Partial<ModifierOption>) => setG({ ...g, options: g.options.map(o => (o.id === id ? { ...o, ...patch } : o)) })
  const save = () => {
    setTried(true)
    if (Object.keys(validateGroup(props.menu, g)).length) return
    props.onSave(g).catch(err => setMsg(err instanceof Error ? err.message : String(err)))
  }
  return (
    <div className="screen editor">
      <div className="screen-head">
        <button type="button" className="link" onClick={props.onClose}>
          ← Nhóm tuỳ chọn
        </button>
      </div>
      <h1>{g.name || (addon ? 'Nhóm món thêm mới' : 'Nhóm tuỳ chọn mới')}</h1>
      <Section title="Nhóm">
        <div className="form-grid">
          <Field label="Tên nhóm" error={e.name} wide>
            <input value={g.name} onChange={x => setG({ ...g, name: x.target.value })} placeholder={addon ? 'Món thêm' : 'Độ chín'} />
          </Field>
          {!addon && (
            <>
              <Switch
                label="Bắt buộc chọn (chưa chọn thì không gửi bếp được)"
                checked={g.minSelect > 0}
                onChange={v => setG({ ...g, minSelect: v ? 1 : 0, maxSelect: v ? Math.max(g.maxSelect ?? 1, 1) : g.maxSelect, options: v ? g.options.map(o => ({ ...o, isDefault: false })) : g.options })}
              />
              <Field label="Chọn ít nhất" error={e.minSelect}>
                <input type="number" inputMode="numeric" min={0} value={g.minSelect} onChange={x => setG({ ...g, minSelect: Number(x.target.value) })} />
              </Field>
              <Field label="Chọn nhiều nhất (trống = không giới hạn)" error={e.maxSelect}>
                <input type="number" inputMode="numeric" min={1} value={g.maxSelect ?? ''} onChange={x => setG({ ...g, maxSelect: x.target.value === '' ? null : Number(x.target.value) })} />
              </Field>
            </>
          )}
          <Field label="In trên hoá đơn" hint="Phiếu bếp luôn in tuỳ chọn">
            <select value={g.printReceipt} onChange={x => setG({ ...g, printReceipt: x.target.value as ReceiptPrint })}>
              {Object.entries(PRINT_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </Field>
        </div>
      </Section>
      <Section title={addon ? 'Món thêm' : 'Lựa chọn'} error={e.options}>
        <ul className="rows">
          {[...g.options].sort((a, b) => a.sort - b.sort).map(o => (
            <li key={o.id} className={'edit-row opt-row' + (e[`option:${o.id}`] ? ' has-error' : '')}>
              <input aria-label="Tên lựa chọn" className="w-name" value={o.name} placeholder={addon ? 'Thêm trứng ốp la' : 'Medium rare'} onChange={x => setOpt(o.id, { name: x.target.value })} />
              <input aria-label="Tên in bếp" className="w-code upper" value={o.kitchenName} placeholder="IN BẾP" onChange={x => setOpt(o.id, { kitchenName: x.target.value.toUpperCase() })} />
              <MoneyInput ariaLabel={`Giá cộng thêm ${o.name}`} value={o.priceDelta} onChange={v => setOpt(o.id, { priceDelta: v })} />
              {addon ? (
                <label className="small">
                  tối đa/phần{' '}
                  <input type="number" inputMode="numeric" min={1} max={10} className="w-qty" value={o.maxQty} onChange={x => setOpt(o.id, { maxQty: Number(x.target.value) })} />
                </label>
              ) : (
                g.minSelect === 0 && (
                  <label className="small inline-check">
                    <input type="checkbox" checked={o.isDefault} onChange={x => setOpt(o.id, { isDefault: x.target.checked })} /> chọn sẵn
                  </label>
                )
              )}
              <button type="button" className="icon-btn" aria-label={`Bỏ ${o.name}`} onClick={() => setG({ ...g, options: g.options.filter(x => x.id !== o.id) })}>
                ✕
              </button>
              {e[`option:${o.id}`] && <span className="field-error row-error">{e[`option:${o.id}`]}</span>}
            </li>
          ))}
        </ul>
        <button
          type="button"
          className="btn"
          onClick={() => setG({ ...g, options: [...g.options, { id: newId(), groupId: g.id, name: '', kitchenName: '', priceDelta: 0, maxQty: addon ? 3 : 1, isDefault: false, sort: g.options.length + 1, soldOutUntil: null }] })}
        >
          + Thêm lựa chọn
        </button>
      </Section>
      {msg && <p className="field-error block">{msg}</p>}
      <div className="save-bar">
        <button type="button" className="btn btn-primary btn-grow" onClick={save}>
          Lưu nhóm
        </button>
      </div>
    </div>
  )
}
