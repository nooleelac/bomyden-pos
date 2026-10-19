// Waiter: search the menu, tap a size, fill the picker, collect lines. Lines are re-checked on every menu
// change, so a dish sold out on another device turns red here before it can be sent.
// With `onSend` (order on a table) Gửi bếp sends the cart as one round; without it, it only previews the data.
// With `onNext` the button is Tiếp theo: the order shows the cart on a check screen and sends it from there.
// With `storageKey` the unsent cart is kept on this device (per order) until it is sent or removed.

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { describeLine, initialState, itemBlock, liveVariants, priceLabel, quoteLine, searchItems, toSendLine, vnd, type PickerState } from '../picker'
import { isSoldOut, type Menu, type MenuItem } from '../types'
import { ItemPicker } from './ItemPicker'
import { draftKey, useCart, type Cart } from '../cart'

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
  /** The cart, when the screen around it shows it too (Chi tiết hoá đơn); otherwise the screen keeps its own. */
  cart?: Cart
  /** Tapping Thành tiền opens this (the order's detail) instead of the list below the menu. */
  onReview?: () => void
  /** Tiếp theo instead of Gửi bếp: the screen around it shows the cart to check, and sends it from there. */
  onNext?: () => void
}) {
  const { menu, now, onSend, storageKey, onCartChange } = props
  const [query, setQuery] = useState('')
  const [cat, setCat] = useState<string | null>(null)
  const [open, setOpen] = useState<{ item: MenuItem; state: PickerState; key?: number } | null>(null)
  const own = useCart(props.cart ? undefined : storageKey)
  const [lines, setLines] = props.cart ?? own
  const [sent, setSent] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const [cartOpen, setCartOpen] = useState(false)
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
    setLines(prev => (key != null ? prev.map(l => (l.key === key ? { key, state } : l)) : [...prev, { key: draftKey(), state }]))
    setOpen(null)
  }

  const quoted = lines.map(l => {
    const item = menu.items.find(i => i.id === l.state.itemId)
    return { l, item, q: item ? quoteLine(menu, item, l.state, now) : null }
  })
  const total = quoted.reduce((s, x) => s + (x.q?.total ?? 0), 0)
  const blocked = quoted.filter(x => !x.q?.canAdd).length

  // "Tất cả": every dish under its top-level group heading (Sapo style); one group or a search: one list.
  const topOf = (catId: string) => {
    const c = menu.categories.find(x => x.id === catId)
    return c?.parentId ?? catId
  }
  const sections = query
    ? [{ id: 'q', name: `Kết quả tìm “${query}”`, color: undefined as string | undefined, items: results }]
    : tops
        .filter(c => cat == null || c.id === cat)
        .map(c => ({ id: c.id, name: c.name, color: c.color as string | undefined, items: results.filter(i => topOf(i.categoryId) === c.id) }))
        .filter(s => s.items.length > 0)
  const count = lines.reduce((n, l) => n + l.state.qty, 0)
  const send = () => {
    if (!onSend) return setSent(JSON.stringify(lines.map(l => toSendLine(l.state)), null, 1))
    setSending(true)
    onSend(lines.map(l => l.state)).then(
      () => {
        setLines([])
        setCartOpen(false)
        setSending(false)
      },
      () => setSending(false),
    )
  }

  return (
    <div className="order">
      <div className="search-bar">
        <input
          type="search"
          value={query}
          placeholder="🔍 Tìm món: gõ không dấu, chữ đầu (sbn) hoặc mã (101)"
          aria-label="Tìm món"
          onChange={e => setQuery(e.target.value)}
        />
      </div>
      <div className="order-body">
        <nav className="cat-rail" aria-label="Nhóm món">
          <button type="button" className={'rail-item' + (cat == null && !query ? ' is-on' : '')} onClick={() => (setCat(null), setQuery(''))}>
            <span className="cat-dot" aria-hidden>
              ★
            </span>
            Tất cả
          </button>
          {tops.map(c => (
            <button
              key={c.id}
              type="button"
              className={'rail-item' + (cat === c.id && !query ? ' is-on' : '')}
              style={{ ['--cat' as string]: c.color }}
              onClick={() => (setCat(c.id), setQuery(''))}
            >
              <span className="cat-dot" aria-hidden>
                {c.name.trim().charAt(0).toUpperCase()}
              </span>
              {c.name}
            </button>
          ))}
        </nav>

        <div className="order-items">
          {sections.length === 0 && <p className="empty">Không tìm thấy món “{query}”</p>}
          {sections.map(s => (
            <section key={s.id} className="item-section">
              <h3 className="section-head">
                <span>{s.name}</span>
              </h3>
              <ul className="item-grid">
                {s.items.map(item => {
                  const block = itemBlock(menu, item, now)
                  const color = menu.categories.find(c => c.id === item.categoryId)?.color ?? s.color
                  const sizes = item.hasSizes ? liveVariants(item) : []
                  return (
                    <li key={item.id} className={'item-card' + (block ? ' is-out' : '')} style={{ ['--cat' as string]: color }}>
                      <button type="button" className="item-card-main" disabled={!!block} onClick={() => openItem(item)}>
                        <span className="item-card-name">{item.name}</span>
                        <span className="item-card-code">{item.code}</span>
                        <span className="item-card-price">{block ?? (sizes.length > 1 ? `${sizes.length} giá · ${priceLabel(item)}` : priceLabel(item))}</span>
                      </button>
                      {sizes.length > 0 && !block && (
                        <div className="size-row">
                          {sizes.map(v => {
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
            </section>
          ))}
          {sent && (
            <details className="muted small">
              <summary>Chưa nối với đơn bàn: đây là dữ liệu sẽ gửi cho send_order_lines</summary>
              <pre>{sent}</pre>
            </details>
          )}
        </div>
      </div>

      <section className={'cart-bar' + (cartOpen && lines.length ? ' is-open' : '')} aria-label="Món đang chọn">
        {cartOpen && lines.length > 0 && (
          <div className="cart-panel">
            <h2>Món đang chọn</h2>
            <ul>
              {quoted.map(({ l, item, q }) => (
                <li key={l.key} className={q?.canAdd ? '' : 'is-bad'}>
                  <button type="button" className="cart-line" onClick={() => item && setOpen({ item, state: l.state, key: l.key })}>
                    <span>
                      <b>
                        {l.state.qty} × {item?.name ?? 'Món đã xoá'}
                      </b>
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
            {props.footExtra}
          </div>
        )}
        <div className="cart-foot">
          <button type="button" className="cart-sum" disabled={!lines.length && !props.onReview} onClick={() => (props.onReview ? props.onReview() : setCartOpen(o => !o))} aria-expanded={cartOpen}>
            <span className="cart-total">
              Thành tiền: <b>{vnd(total)}</b>
            </span>
            <span className="muted small">
              Mặt hàng: {count}
              {props.onReview ? ' · Xem đơn ›' : lines.length > 0 && (cartOpen ? ' · Thu gọn ▾' : ' · Xem / sửa ▴')}
            </span>
          </button>
          <button type="button" className="btn btn-primary btn-send" disabled={!lines.length || blocked > 0 || sending} onClick={props.onNext ?? send}>
            {blocked > 0 ? `${blocked} món cần sửa` : sending ? 'Đang gửi…' : props.onNext ? 'Tiếp theo ›' : 'Gửi bếp ›'}
          </button>
        </div>
      </section>

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
