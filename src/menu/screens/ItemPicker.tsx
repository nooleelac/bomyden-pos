// Waiter: choose size, options, add-ons and left-out components for one dish, with the live line price.

import { useState } from 'react'
import { itemGroups, liveVariants, minusVnd, quoteLine, vnd, type PickerState } from '../picker'
import { isSoldOut, type Menu, type MenuItem } from '../types'
import { Stepper } from '../ui'

export function ItemPicker(props: {
  menu: Menu
  item: MenuItem
  initial: PickerState
  now: Date
  onAdd: (s: PickerState) => void
  onClose: () => void
  /** Button text instead of "Thêm vào đơn" (e.g. "Lưu sửa"). */
  addLabel?: string
  /** Quantity cannot change (SỬA món đã gửi). */
  lockQty?: boolean
}) {
  const { menu, item, now } = props
  const [s, setS] = useState<PickerState>(props.initial)
  const [tried, setTried] = useState(false)
  const q = quoteLine(menu, item, s, now)
  const groups = itemGroups(menu, item)
  const errorFor = (field: string) => (tried ? q.issues.find(i => i.level === 'error' && i.field === field)?.message : undefined)
  const warnings = q.issues.filter(i => i.level === 'warning')
  const firstError = q.issues.find(i => i.level === 'error')

  const toggleChoice = (groupId: string, optionId: string, max: number | null) => {
    setS(prev => {
      const opts = { ...prev.options }
      const g = groups.find(x => x.group.id === groupId)!
      if (opts[optionId]) delete opts[optionId]
      else {
        if (max === 1) for (const o of g.options) delete opts[o.id] // single choice: swap
        opts[optionId] = 1
      }
      return { ...prev, options: opts }
    })
  }
  const setAddon = (optionId: string, qty: number) =>
    setS(prev => {
      const opts = { ...prev.options }
      if (qty > 0) opts[optionId] = qty
      else delete opts[optionId]
      return { ...prev, options: opts }
    })
  const toggleRemoval = (id: string) =>
    setS(prev => ({ ...prev, removals: prev.removals.includes(id) ? prev.removals.filter(x => x !== id) : [...prev.removals, id] }))

  const add = () => {
    setTried(true)
    if (q.canAdd) props.onAdd(s)
  }

  return (
    <div className="sheet-backdrop" onClick={props.onClose}>
      <div className="sheet" role="dialog" aria-label={item.name} onClick={e => e.stopPropagation()}>
        <header className="sheet-head">
          <div>
            <h2>{item.name}</h2>
            {item.description && <p className="muted">{item.description}</p>}
          </div>
          <button type="button" className="icon-btn" onClick={props.onClose} aria-label="Đóng">
            ✕
          </button>
        </header>

        <div className="sheet-body">
          {item.hasSizes && (
            <fieldset className={'pick-group' + (errorFor('size') ? ' has-error' : '')}>
              <legend>
                Size <span className="badge badge-req">Bắt buộc</span>
              </legend>
              <div className="chip-row">
                {liveVariants(item).map(v => {
                  const out = isSoldOut(v.soldOutUntil, now)
                  return (
                    <button
                      key={v.id}
                      type="button"
                      className={'chip chip-size' + (s.variantId === v.id ? ' is-on' : '') + (out ? ' is-out' : '')}
                      disabled={out && s.variantId !== v.id}
                      aria-pressed={s.variantId === v.id}
                      onClick={() => setS(p => ({ ...p, variantId: v.id }))}
                    >
                      <b>{v.name}</b>
                      <span>{out ? 'Hết' : vnd(v.price)}</span>
                    </button>
                  )
                })}
              </div>
              {errorFor('size') && <p className="field-error">{errorFor('size')}</p>}
            </fieldset>
          )}

          {groups.map(g => {
            const err = errorFor(`group:${g.group.id}`)
            const picked = g.options.filter(o => s.options[o.id]).length
            const rule =
              g.group.kind === 'addon' ? 'Tính tiền theo mỗi phần'
              : g.min === 1 && g.max === 1 ? 'Chọn 1'
              : g.max != null ? `Chọn ${g.min ? `${g.min}–` : 'tối đa '}${g.max}`
              : `Chọn ít nhất ${g.min}`
            return (
              <fieldset key={g.group.id} className={'pick-group' + (err ? ' has-error' : '')}>
                <legend>
                  {g.group.name} {g.min > 0 && <span className="badge badge-req">Bắt buộc</span>}
                  <span className="muted small"> · {rule}{g.group.kind === 'choice' && g.max && g.max > 1 ? ` (${picked}/${g.max})` : ''}</span>
                </legend>
                {g.group.kind === 'choice' ? (
                  <div className="chip-row">
                    {g.options.map(o => {
                      const out = isSoldOut(o.soldOutUntil, now)
                      const on = !!s.options[o.id]
                      return (
                        <button
                          key={o.id}
                          type="button"
                          className={'chip' + (on ? ' is-on' : '') + (out ? ' is-out' : '')}
                          disabled={out && !on}
                          aria-pressed={on}
                          onClick={() => toggleChoice(g.group.id, o.id, g.max)}
                        >
                          {o.name}
                          {out ? <small> Hết</small> : o.priceDelta > 0 && <small> +{vnd(o.priceDelta)}</small>}
                        </button>
                      )
                    })}
                  </div>
                ) : (
                  <ul className="addon-list">
                    {g.options.map(o => {
                      const out = isSoldOut(o.soldOutUntil, now)
                      const n = s.options[o.id] ?? 0
                      return (
                        <li key={o.id} className={out ? 'is-out' : ''}>
                          <span>
                            {o.name} <span className="muted">+{vnd(o.priceDelta)}</span>
                            {n > 0 && s.qty > 1 && <span className="muted small"> (x{s.qty} = {n * s.qty})</span>}
                          </span>
                          {out && n === 0 ? <span className="badge badge-out">Hết</span> : <Stepper label={o.name} value={n} max={o.maxQty} onChange={v => setAddon(o.id, v)} />}
                        </li>
                      )
                    })}
                  </ul>
                )}
                {err && <p className="field-error">{err}</p>}
              </fieldset>
            )
          })}

          {item.components.length > 0 && (
            <fieldset className={'pick-group' + (errorFor('components') ? ' has-error' : '')}>
              <legend>
                Thành phần <span className="muted small">· bấm để bỏ</span>
              </legend>
              <div className="chip-row">
                {[...item.components].sort((a, b) => a.sort - b.sort).map(c => {
                  const off = s.removals.includes(c.id)
                  const out = isSoldOut(c.soldOutUntil, now)
                  if (!c.removable) {
                    return (
                      <span key={c.id} className="chip is-locked" title="Thành phần chính, không bỏ được">
                        🔒 {c.name}
                      </span>
                    )
                  }
                  return (
                    <button
                      key={c.id}
                      type="button"
                      className={'chip chip-removal' + (off ? ' is-removed' : '') + (out ? ' is-out' : '')}
                      aria-pressed={off}
                      onClick={() => toggleRemoval(c.id)}
                    >
                      {off ? `Không ${c.name.toLowerCase()}` : c.name}
                      <small> {c.removalDiscount ? minusVnd(c.removalDiscount) : '0đ'}</small>
                    </button>
                  )
                })}
              </div>
              {errorFor('components') && <p className="field-error">{errorFor('components')}</p>}
            </fieldset>
          )}
          {warnings.map(w => (
            <p key={w.message} className="warn">
              ⚠ {w.message}
            </p>
          ))}
          {tried && errorFor('item') && <p className="field-error block">{errorFor('item')}</p>}

          <label className="field">
            <span className="field-label">Ghi chú cho bếp</span>
            <input value={s.note} maxLength={60} placeholder="VD: ít muối" onChange={e => setS(p => ({ ...p, note: e.target.value }))} />
          </label>
        </div>

        <footer className="sheet-foot">
          {props.lockQty ? <b className="stepper-value">{s.qty} ×</b> : <Stepper label="số phần" min={1} value={s.qty} onChange={v => setS(p => ({ ...p, qty: v }))} />}
          <button type="button" className={'btn btn-primary btn-grow' + (q.canAdd ? '' : ' is-blocked')} onClick={add}>
            <span>{q.canAdd || !tried || !firstError ? (props.addLabel ?? 'Thêm vào đơn') : firstError.message}</span>
            <b>{q.total != null ? vnd(q.total) : '—'}</b>
          </button>
        </footer>
        {q.unit != null && s.qty > 1 && <p className="muted small center">{vnd(q.unit)} / phần</p>}
      </div>
    </div>
  )
}
