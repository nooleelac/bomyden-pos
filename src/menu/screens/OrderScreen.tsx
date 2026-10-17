// Waiter: search the menu, tap a size, fill the picker, collect lines. Lines are re-checked on every menu
// change, so a dish sold out on another device turns red here before it can be sent.
// With `onSend` (order on a table) Gửi bếp sends the cart as one round; without it, it only previews the data.
// With `storageKey` the unsent cart is kept on this device (per order) until it is sent or removed.

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { describeLine, initialState, itemBlock, liveVariants, priceLabel, quoteLine, searchItems, toSendLine, vnd, type PickerState } from '../picker'
import { isSoldOut, type Menu, type MenuItem } from '../types'
import { ItemPicker } from './ItemPicker'

interface Draft {
  key: number
  state: PickerState
}

function loadCart(key: string | undefined): Draft[] {
  if (!key) return []
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? '[]')
    return Array.isArray(v) ? (v as Draft[]) : []
  } catch {
    return []
  }
}

export function OrderScreen(props: {
  menu: Menu
  now: Date
  /** Gửi bếp: resolves when the round is sent (the cart then empties), rejects to keep it. */
  onSend?: (lines: PickerState[]) => Promise<void>
  /** Keep the unsent cart on this device under this key. */
  storageKey?: string
  /** Extra controls next to Gửi bếp (GẤP, bàn ra món). */
  footExtra?: ReactNode
  /** Cart size changes (to warn before leaving with unsent lines). */
  onCartChange?: (n: number) => void
}) {
  const { menu, now, onSend, storageKey, onCartChange } = props
  const [query, setQuery] = useState('')
  const [cat, setCat] = useState<string | null>(null)
  const [open, setOpen] = useState<{ item: MenuItem; state: PickerState; key?: number } | null>(null)
  const [lines, setLines] = useState<Draft[]>(() => loadCart(storageKey))
  const [sent, setSent] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  useEffect(() => {
    if (!storageKey) return
    try {
      if (lines.length) localStorage.setItem(storageKey, JSON.stringify(lines))
      else localStorage.removeItem(storageKey)
    } catch {
      /* storage blocked: the cart still lives in memory */
    }
  }, [lines, storageKey])
  useEffect(() => onCartChange?.(lines.length), [lines.length, onCartChange])

  const tops = menu.categories.filter(c => !c.parentId && c.visible).sort((a, b) => a.sort - b.sort)
  const results = useMemo(() => searchItems(menu, query, query ? null : cat), [menu, query, cat])

  const openItem = (item: MenuItem, variantId: string | null = null) => {
    const state = initialState(menu, item, variantId, now)
    // A dish with nothing to choose goes straight onto the order.
    const q = quoteLine(menu, item, state, now)
    const nothingToAsk = !item.hasSizes && item.groups.length === 0 && item.components.every(c => !c.removable)
    if (nothingToAsk && q.canAdd) addLine(state)
    else setOpen({ item, state })
  }
  const addLine = (state: PickerState, key?: number) => {
    setSent(null)
    setLines(prev => (key != null ? prev.map(l => (l.key === key ? { key, state } : l)) : [...prev, { key: Date.now() + Math.random(), state }]))
    setOpen(null)
  }

  const quoted = lines.map(l => {
    const item = menu.items.find(i => i.id === l.state.itemId)
    return { l, item, q: item ? quoteLine(menu, item, l.state, now) : null }
  })
  const total = quoted.reduce((s, x) => s + (x.q?.total ?? 0), 0)
  const blocked = quoted.filter(x => !x.q?.canAdd).length

  return (
    <div className="order">
      <div className="search-bar">
        <input
          type="search"
          value={query}
          placeholder="Tìm món: gõ không dấu, chữ đầu (sbn) hoặc mã (101)"
          aria-label="Tìm món"
          onChange={e => setQuery(e.target.value)}
        />
      </div>
      {!query && (
        <nav className="cat-tabs" aria-label="Nhóm món">
          <button type="button" className={'cat-tab' + (cat == null ? ' is-on' : '')} onClick={() => setCat(null)}>
            Tất cả
          </button>
          {tops.map(c => (
            <button
              key={c.id}
              type="button"
              className={'cat-tab' + (cat === c.id ? ' is-on' : '')}
              style={{ ['--cat' as string]: c.color }}
              onClick={() => setCat(c.id)}
            >
              {c.name}
            </button>
          ))}
        </nav>
      )}

      <ul className="item-list">
        {results.length === 0 && <li className="empty">Không tìm thấy món “{query}”</li>}
        {results.map(item => {
          const block = itemBlock(menu, item, now)
          const color = menu.categories.find(c => c.id === item.categoryId)?.color
          return (
            <li key={item.id} className={'item-row' + (block ? ' is-out' : '')} style={{ ['--cat' as string]: color }}>
              <button type="button" className="item-main" disabled={!!block} onClick={() => openItem(item)}>
                <span className="item-name">
                  {item.name} <span className="muted small">{item.code}</span>
                </span>
                <span className="item-price">{block ?? priceLabel(item)}</span>
              </button>
              {item.hasSizes && !block && (
                <div className="size-row">
                  {liveVariants(item).map(v => {
                    const out = isSoldOut(v.soldOutUntil, now)
                    return (
                      <button key={v.id} type="button" className={'size-btn' + (out ? ' is-out' : '')} disabled={out} onClick={() => openItem(item, v.id)}>
                        <b>{v.name}</b>
                        <span>{out ? 'Hết' : vnd(v.price)}</span>
                      </button>
                    )
                  })}
                </div>
              )}
            </li>
          )
        })}
      </ul>

      {lines.length > 0 && (
        <section className="cart" aria-label="Món đang chọn">
          <h2>Món đang chọn</h2>
          <ul>
            {quoted.map(({ l, item, q }) => (
              <li key={l.key} className={q?.canAdd ? '' : 'is-bad'}>
                <button type="button" className="cart-line" onClick={() => item && setOpen({ item, state: l.state, key: l.key })}>
                  <span>
                    <b>{l.state.qty} × {item?.name ?? 'Món đã xoá'}</b>
                    <span className="muted small">{item ? describeLine(menu, item, l.state) : ''}</span>
                    {q && !q.canAdd && <span className="field-error">{q.issues.find(i => i.level === 'error')?.message}</span>}
                  </span>
                  <b>{q?.total != null ? vnd(q.total) : '—'}</b>
                </button>
                <button type="button" className="icon-btn" aria-label="Bỏ dòng" onClick={() => setLines(p => p.filter(x => x.key !== l.key))}>
                  ✕
                </button>
              </li>
            ))}
          </ul>
          <div className="cart-foot">
            <span>
              Tạm tính <b>{vnd(total)}</b>
            </span>
            <button
              type="button"
              className="btn btn-primary"
              disabled={blocked > 0 || sending}
              onClick={() => {
                if (!onSend) return setSent(JSON.stringify(lines.map(l => toSendLine(l.state)), null, 1))
                setSending(true)
                onSend(lines.map(l => l.state)).then(
                  () => {
                    setLines([])
                    setSending(false)
                  },
                  () => setSending(false),
                )
              }}
            >
              {blocked > 0 ? `${blocked} món cần sửa` : sending ? 'Đang gửi…' : 'Gửi bếp'}
            </button>
          </div>
          {props.footExtra}
          {sent && (
            <details className="muted small">
              <summary>Chưa nối với đơn bàn: đây là dữ liệu sẽ gửi cho send_order_lines</summary>
              <pre>{sent}</pre>
            </details>
          )}
        </section>
      )}

      {open && (
        <ItemPicker
          key={open.item.id + (open.key ?? '')}
          menu={menu}
          item={open.item}
          initial={open.state}
          now={now}
          onAdd={s => addLine(s, open.key)}
          onClose={() => setOpen(null)}
        />
      )}
    </div>
  )
}
