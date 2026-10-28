// Khách quét mã QR trên bàn (#/goi/<token>): the menu with sizes and options like the waiter's, a cart, Gửi gọi món,
// then the request's state (Chờ nhân viên xác nhận → Đã nhận, bếp đang làm | Không nhận) and the table's dishes.
// No sign-in: the token in the link is the table. Nothing reaches the kitchen until a waiter taps Nhận.

import { useCallback, useEffect, useState } from 'react'
import { errText } from '../floor/hooks'
import { LINE_STATUS_LABEL, NOTE_MAX } from '../floor/types'
import { useCart } from '../menu/cart'
import '../menu/menu.css'
import '../floor/floor.css'
import { describeLine, quoteLine, toSendLine, vnd } from '../menu/picker'
import { newId } from '../menu/repo'
import { OrderScreen } from '../menu/screens/OrderScreen'
import { Sheet } from '../floor/screens/Sheet'
import './guest.css'
import type { GuestRepo, GuestStatus, GuestView } from './repo'

const POLL_MS = 5000
const MENU_MS = 60_000

/** This phone's requests at this table, newest last (kept so a reload still shows them). */
function useSentIds(token: string) {
  const key = `bmd-guest-sent-${token}`
  const [ids, setIds] = useState<string[]>(() => {
    try {
      const v = JSON.parse(localStorage.getItem(key) ?? '[]')
      return Array.isArray(v) ? v.slice(-20) : []
    } catch {
      return []
    }
  })
  const add = (id: string) =>
    setIds(prev => {
      const next = [...prev, id].slice(-20)
      try {
        localStorage.setItem(key, JSON.stringify(next))
      } catch {
        /* private mode: kept in memory */
      }
      return next
    })
  return [ids, add] as const
}

const REQUEST_LABEL = { pending: 'Chờ nhân viên xác nhận', accepted: 'Đã nhận, bếp đang làm', rejected: 'Nhân viên không nhận' } as const

export function GuestApp(props: { repo: GuestRepo; token: string }) {
  const { repo, token } = props
  const [view, setView] = useState<GuestView | null>(null)
  const [fatal, setFatal] = useState('')
  const [status, setStatus] = useState<GuestStatus | null>(null)
  const [tab, setTab] = useState<'menu' | 'sent'>('menu')
  const [confirm, setConfirm] = useState(false)
  const [toast, setToast] = useState<{ text: string; ok?: boolean } | null>(null)
  const [now, setNow] = useState(() => new Date())
  const cart = useCart(`bmd-guest-cart-${token}`)
  const [sentIds, addSent] = useSentIds(token)

  const loadMenu = useCallback(
    () =>
      repo.load(token).then(
        v => (setView(v), setFatal('')),
        e => setFatal(errText(e)),
      ),
    [repo, token],
  )
  const loadStatus = useCallback(() => repo.status(token, sentIds).then(setStatus, () => undefined), [repo, token, sentIds])

  useEffect(() => {
    void loadMenu()
    const t = setInterval(() => document.visibilityState === 'visible' && void loadMenu(), MENU_MS)
    return () => clearInterval(t)
  }, [loadMenu])
  useEffect(() => {
    if (!view) return
    void loadStatus()
    const t = setInterval(() => {
      setNow(new Date())
      if (document.visibilityState === 'visible') void loadStatus()
    }, POLL_MS)
    return () => clearInterval(t)
  }, [view, loadStatus])
  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), toast.ok ? 3000 : 6000)
    return () => clearTimeout(t)
  }, [toast])
  useEffect(() => {
    if (view) document.title = `Gọi món · Bàn ${view.tableName}`
  }, [view])

  if (fatal && !view)
    return (
      <div className="menu-app guest-app">
        <div className="guest-fatal">
          <p className="guest-fatal-icon" aria-hidden>
            🍽️
          </p>
          <p>{fatal}</p>
          <button type="button" className="btn" onClick={() => void loadMenu()}>
            Thử lại
          </button>
        </div>
      </div>
    )
  if (!view) return <div className="menu-app guest-app loading">Đang mở thực đơn…</div>

  const requests = status?.requests ?? []
  const waiting = requests.filter(r => r.status === 'pending').length
  const tableLines = status?.lines ?? []
  const tableTotal = tableLines.reduce((t, l) => t + l.price * l.qty, 0)

  return (
    <div className="menu-app guest-app">
      <header className="guest-head">
        <div>
          <b className="guest-shop">{view.shopName}</b>
          <span className="guest-table">Bàn {view.tableName}</span>
        </div>
        <nav className="guest-tabs" aria-label="Trang">
          <button type="button" className={tab === 'menu' ? 'is-on' : ''} onClick={() => setTab('menu')}>
            Thực đơn
          </button>
          <button type="button" className={tab === 'sent' ? 'is-on' : ''} onClick={() => setTab('sent')}>
            Món đã gọi
            {waiting > 0 && <span className="rail-count">{waiting}</span>}
          </button>
        </nav>
      </header>
      {!view.isOpen && <div className="offline-bar">Quán đang ngoài giờ phục vụ</div>}
      {waiting > 0 && tab === 'menu' && (
        <button type="button" className="guest-wait" onClick={() => setTab('sent')}>
          ⏳ {waiting} yêu cầu đang chờ nhân viên xác nhận ›
        </button>
      )}

      {tab === 'menu' ? (
        <OrderScreen menu={view.menu} now={now} cart={cart} onNext={() => setConfirm(true)} searchHint="🔍 Tìm món: gõ tên món, không cần dấu" />
      ) : (
        <main className="guest-sent">
          {requests.length > 0 && (
            <section className="card">
              <h2>Yêu cầu bạn đã gửi</h2>
              <ul className="rows">
                {[...requests].reverse().map(r => (
                  <li key={r.id} className={`guest-req st-${r.status}`}>
                    <b>{REQUEST_LABEL[r.status]}</b>
                    <span className="muted small">
                      {new Date(r.createdAt).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })}
                      {r.status === 'rejected' && r.reason ? ` · ${r.reason}` : ''}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}
          <section className="card">
            <h2>Món của bàn</h2>
            {tableLines.length === 0 ? (
              <p className="muted small">Chưa có món nào. Món bạn gọi hiện ở đây sau khi nhân viên xác nhận.</p>
            ) : (
              <>
                <ul className="rows">
                  {tableLines.map((l, i) => (
                    <li key={i} className="guest-line">
                      <span>
                        <b>
                          {l.qty} × {l.name}
                          {l.variantName ? ` ${l.variantName}` : ''}
                        </b>
                        <span className={`muted small ls-${l.status}`}>{LINE_STATUS_LABEL[l.status]}</span>
                      </span>
                      <span>{vnd(l.price * l.qty)}</span>
                    </li>
                  ))}
                </ul>
                <p className="guest-total">
                  Tạm tính: <b>{vnd(tableTotal)}</b>
                </p>
                <p className="muted small">Tạm tính chưa gồm giảm giá, phí phục vụ (nếu có). Thanh toán tại quầy hoặc gọi nhân viên.</p>
              </>
            )}
          </section>
          <button type="button" className="btn btn-primary btn-grow" onClick={() => setTab('menu')}>
            + Gọi thêm món
          </button>
        </main>
      )}

      {confirm && (
        <ConfirmSheet
          view={view}
          now={now}
          cart={cart}
          onClose={() => setConfirm(false)}
          onSend={async inp => {
            const id = newId()
            await repo.place(token, { id, ...inp })
            addSent(id)
            cart[1]([])
            setConfirm(false)
            setTab('sent')
            setToast({ text: 'Đã gửi. Nhân viên sẽ xác nhận trong giây lát.', ok: true })
          }}
          onError={m => setToast({ text: m })}
        />
      )}
      {toast && (
        <div className={'toast' + (toast.ok ? ' toast-ok' : '')} role={toast.ok ? 'status' : 'alert'} onClick={() => setToast(null)}>
          {toast.text}
        </div>
      )}
    </div>
  )
}

function ConfirmSheet(props: {
  view: GuestView
  now: Date
  cart: ReturnType<typeof useCart>
  onClose: () => void
  onSend: (inp: { lines: ReturnType<typeof toSendLine>[]; note: string; guestCount: number | null }) => Promise<void>
  onError: (m: string) => void
}) {
  const { view, now } = props
  const [lines] = props.cart
  const [note, setNote] = useState('')
  const [guests, setGuests] = useState(0)
  const [sending, setSending] = useState(false)
  const menu = view.menu
  const rows = lines.map(l => {
    const item = menu.items.find(i => i.id === l.state.itemId)
    return { l, item, q: item ? quoteLine(menu, item, l.state, now) : null }
  })
  const total = rows.reduce((t, r) => t + (r.q?.total ?? 0), 0)
  const bad = rows.some(r => !r.q?.canAdd)
  const send = () => {
    setSending(true)
    props
      .onSend({ lines: lines.map(l => toSendLine(l.state)), note: note.trim(), guestCount: guests || null })
      .catch(e => props.onError(errText(e)))
      .finally(() => setSending(false))
  }
  return (
    <Sheet
      title="Kiểm tra món trước khi gửi"
      subtitle={`Bàn ${view.tableName}`}
      onClose={props.onClose}
      foot={
        <button type="button" className="btn btn-primary btn-grow" disabled={!lines.length || bad || sending} onClick={send}>
          <span>{sending ? 'Đang gửi…' : 'Gửi gọi món'}</span>
          <b>{vnd(total)}</b>
        </button>
      }
    >
      <ul className="rows">
        {rows.map(({ l, item, q }) => (
          <li key={l.key} className={'guest-line' + (q?.canAdd ? '' : ' is-bad')}>
            <span>
              <b>
                {l.state.qty} × {item?.name ?? 'Món không còn bán'}
              </b>
              <span className="muted small">{item ? describeLine(menu, item, l.state) : ''}</span>
              {q && !q.canAdd && <span className="field-error">{q.issues.find(i => i.level === 'error')?.message}</span>}
            </span>
            <b>{q?.total != null ? vnd(q.total) : '—'}</b>
          </li>
        ))}
      </ul>
      <label className="field">
        <span className="field-label">Ghi chú cho quán (không bắt buộc)</span>
        <input maxLength={NOTE_MAX} placeholder="VD: dị ứng tôm, ra món chính trước" value={note} onChange={e => setNote(e.target.value)} />
      </label>
      <fieldset className="pick-group">
        <legend>Bàn mấy người? (không bắt buộc)</legend>
        <div className="chip-row">
          {Array.from({ length: 8 }, (_, i) => i + 1).map(n => (
            <button key={n} type="button" className={'chip' + (guests === n ? ' is-on' : '')} aria-pressed={guests === n} onClick={() => setGuests(g => (g === n ? 0 : n))}>
              {n}
            </button>
          ))}
        </div>
      </fieldset>
      <p className="muted small">Giá tạm tính theo thực đơn. Nhân viên xác nhận rồi món mới được làm.</p>
    </Sheet>
  )
}
