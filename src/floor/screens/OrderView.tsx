// One order: header (bàn, khách, giờ ngồi, ghi chú đơn + dị ứng), Gọi món (the menu OrderScreen with an
// unsent cart kept on this device) and Đã gửi (rounds with each dish's kitchen state, Sửa / Huỷ / Đã bưng),
// plus the table actions: giục, tạm tính, thanh toán, chuyển bàn, gộp, ghép, chuyển món, tách đơn, trả bàn.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { isManager } from '../../auth/guards'
import { describeLine, quoteLine, toSendLine, vnd, type PickerState } from '../../menu/picker'
import { draftKey, useCart } from '../../menu/cart'
import { newId } from '../../menu/repo'
import { ItemPicker } from '../../menu/screens/ItemPicker'
import { OrderScreen } from '../../menu/screens/OrderScreen'
import type { Menu } from '../../menu/types'
import { prebillData } from '../../cashier/bill'
import { printBlocks } from '../../cashier/print'
import { receiptBlocks } from '../../cashier/receipt'
import { quoteBill, voidNeedsManager } from '../engine'
import { errText, go, takeQuickOpened } from '../hooks'
import { clock, formatDuration, groupLabel, isUnfinished, lineParts, orderAmount, orderLabel, orderTitle, stationWait, tableName, tableTitle } from '../logic'
import type { FloorRepo } from '../repo'
import { LINE_STATUS_LABEL, NOTE_MAX, RUSH_REASONS, type FloorState, type Line, type Role } from '../types'
import { MergeSheet, MoveItemsSheet, MoveTableSheet, ReleaseSheet, SplitSheet, VoidOrderSheet, VoidSheet } from './actions'
import { SharedOrderSheet } from './FloorMap'
import { Sheet } from './Sheet'

type Dialog =
  | { kind: 'void'; line: Line; qty?: number }
  | { kind: 'line'; line: Line }
  | { kind: 'tax' }
  | { kind: 'modify'; line: Line }
  | { kind: 'actions' | 'moveTable' | 'merge' | 'shared' | 'release' | 'leave' | 'voidOrder' }
  | { kind: 'moveItems' | 'split'; picked: Record<string, number> }

export function OrderView(props: { floor: FloorState; menu: Menu; repo: FloorRepo; now: Date; role: Role; me: string; orderId: string; onError: (m: string) => void; onInfo: (m: string) => void }) {
  const { floor, menu, repo, now, role } = props
  const order = floor.orders.find(o => o.id === props.orderId)
  const lines = useMemo(() => floor.lines.filter(l => l.orderId === props.orderId && !l.replacedBy), [floor.lines, props.orderId])
  // a table that already ordered opens on Chi tiết hoá đơn (Sapo style); a new one straight on Gọi món
  const [tab, setTab] = useState<'detail' | 'menu' | 'sent'>(() => (order?.payingAt || lines.length ? 'detail' : 'menu'))
  const [dialog, setDialog] = useState<Dialog | null>(null)
  const [selecting, setSelecting] = useState<null | 'moveItems' | 'split'>(null)
  const [picked, setPicked] = useState<Record<string, number>>({})
  const [rush, setRush] = useState<string | null>(null)
  const [delivery, setDelivery] = useState<string>('')
  const [saving, setSaving] = useState(false)
  const cart = useCart(`bmd-cart-${props.orderId}`)
  const [drafts, setDrafts] = cart
  const cartCount = drafts.length
  const batch = useRef<string | null>(null)
  const fail = useCallback((e: unknown) => props.onError(errText(e)), [props])

  // A table opened by one tap and left with nothing sent and nothing in the cart goes back to Trống.
  const unused = useRef(true)
  useEffect(() => {
    unused.current = lines.length === 0 && cartCount === 0
  }, [lines.length, cartCount])
  const { orderId, onInfo } = props
  useEffect(
    () => () => {
      // checked after the route settles, so a remount of this same order (StrictMode) keeps the table
      setTimeout(() => {
        if (location.hash.includes(`/don/${orderId}`)) return
        if (unused.current && takeQuickOpened(orderId)) repo.closeEmptyOrder(orderId).then(() => onInfo('Chưa gọi món nên đã trả lại bàn trống'), () => undefined)
      })
    },
    [orderId, repo, onInfo],
  )

  if (!order) return <p className="empty">Không tìm thấy đơn. <a href="#/ban">Về sơ đồ bàn</a></p>
  if (order.status !== 'open') {
    const target = order.mergedInto ? floor.orders.find(o => o.id === order.mergedInto) : null
    return (
      <div className="screen">
        <p className="empty">
          {order.status === 'merged' && target ? (
            <>
              Đơn đã gộp vào <a href={`#/ban/don/${target.id}`}>{orderTitle(floor, target)}</a>
            </>
          ) : order.status === 'paid' ? 'Đơn đã thanh toán.' : 'Đơn đã đóng.'}{' '}
          <a href="#/ban">Về sơ đồ bàn</a>
        </p>
      </div>
    )
  }

  const label = orderLabel(floor, order)
  const group = groupLabel(floor, order)
  const cashier = role === 'cashier' || isManager(role)
  const locked = !!order.payingAt
  const live = lines.filter(l => l.status !== 'void')
  const total = orderAmount(floor, order.id)
  const rounds = [...new Set(lines.map(l => l.sendBatch))]
    .map(b => lines.filter(l => l.sendBatch === b))
    .sort((a, b) => a[0].sentAt.localeCompare(b[0].sentAt))
  const notices = floor.notices.filter(n => n.orderId === order.id)
  const rejected = notices.filter(n => n.kind === 'modify_rejected' && !n.ackAt)
  const lastChase = notices.filter(n => n.kind === 'chase').sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
  const waits = menu.stations
    .filter(s => s.kind !== 'none')
    .map(s => ({ s, m: stationWait(floor, s.id, now) }))
    .filter(x => x.m > 0)
  const storageKey = `bmd-cart-${order.id}`

  const send = async (states: PickerState[]) => {
    batch.current ??= newId()
    const payload = states.map(s => ({ ...toSendLine(s), ...(delivery ? { delivery_table_id: delivery } : {}) }))
    try {
      await repo.sendLines(order.id, payload, batch.current, rush ? { rush: true, rushReason: rush } : {})
      batch.current = null
      setRush(null)
      setTab('detail')
      props.onInfo(`Đã lưu, gửi bếp lượt ${order.rounds + 1}`)
    } catch (e) {
      fail(e)
      throw e
    }
  }
  // Lưu: the dishes added since the last save go to the kitchen as one round
  const save = () => {
    if (!drafts.length || saving) return
    setSaving(true)
    send(drafts.map(d => d.state)).then(
      () => {
        setDrafts([])
        setSaving(false)
      },
      () => setSaving(false),
    )
  }
  const leave = () => (cartCount > 0 ? setDialog({ kind: 'leave' }) : go('ban'))
  const back = () => {
    if (tab !== 'detail' && (live.length || cartCount)) {
      setTab('detail')
      setSelecting(null)
    } else leave()
  }
  const act = (p: Promise<unknown>, after?: () => void) =>
    p.then(() => {
      setDialog(null)
      after?.()
    }, fail)
  const pay = () => act(locked ? Promise.resolve() : repo.beginPayment(order.id), () => go(`thu-ngan/${order.id}`))

  const pickerFor = (l: Line): PickerState => ({ itemId: l.menuItemId, variantId: l.variantId, qty: l.qty, options: l.options, removals: l.removals, note: l.note })
  // the unsent dishes, priced from the menu
  const quotedDrafts = drafts.map(d => {
    const item = menu.items.find(i => i.id === d.state.itemId)
    return { d, item, q: item ? quoteLine(menu, item, d.state, now) : null }
  })
  const draftTotal = quotedDrafts.reduce((s, x) => s + (x.q?.total ?? 0), 0)
  const draftBlocked = quotedDrafts.some(x => !x.q?.canAdd)
  const bill = quoteBill(floor, order.id)
  const qtySum = live.reduce((n, l) => n + l.qty, 0) + drafts.reduce((n, d) => n + d.state.qty, 0)
  const vatRates = [...new Set(bill.vat.map(v => v.vatRate))].sort((a, b) => a - b)
  const setDraftQty = (key: number, qty: number) => setDrafts(prev => (qty < 1 ? prev.filter(d => d.key !== key) : prev.map(d => (d.key === key ? { ...d, state: { ...d.state, qty } } : d))))
  const sendExtra = (
    <div className="send-extra">
      <div className="chip-row">
        <button type="button" className={'chip chip-sm chip-rush' + (rush ? ' is-on' : '')} aria-pressed={!!rush} onClick={() => setRush(rush ? null : RUSH_REASONS[0])}>
          GẤP
        </button>
        {rush &&
          RUSH_REASONS.map(r => (
            <button key={r} type="button" className={'chip chip-sm' + (rush === r ? ' is-on' : '')} onClick={() => setRush(r)}>
              {r}
            </button>
          ))}
      </div>
      {order.tables.length > 1 && (
        <label className="field">
          <span className="field-label">Ra bàn</span>
          <select value={delivery} onChange={e => setDelivery(e.target.value)}>
            <option value="">Bàn chính ({tableName(floor, order.tableId)})</option>
            {order.tables
              .filter(t => t.tableId !== order.tableId)
              .map(t => (
                <option key={t.tableId} value={t.tableId}>
                  Bàn {tableName(floor, t.tableId)}
                </option>
              ))}
          </select>
        </label>
      )}
    </div>
  )

  return (
    <div className={`order-view view-${tab}`}>
      <header className="detail-head">
        <button type="button" className="detail-back" aria-label="Quay lại" onClick={back}>
          ←
        </button>
        <h1>{tab === 'menu' ? (live.length ? 'Gọi thêm món' : 'Gọi món') : tab === 'sent' ? 'Bếp làm tới đâu' : 'Chi tiết hoá đơn'}</h1>
        <button type="button" className="detail-more" aria-label="Thao tác khác" onClick={() => setDialog({ kind: 'actions' })}>
          ⋮
        </button>
      </header>
      <div className="detail-strip">
        <span className="detail-kind">{order.kind === 'takeaway' ? '🥡 Mang về' : '🛎️ Dùng tại bàn'}</span>
        <span className="detail-table">
          {tableTitle(label)}
          {order.kind === 'takeaway' ? (order.customerName ? ` · ${order.customerName}` : '') : order.positionLabel ? ` · ${order.positionLabel}` : ''}
          {group && <span className="badge"> {group}</span>}
        </span>
      </div>

      {rejected.map(n => (
        <p key={n.id} className="notice-bar">
          ⚠ {n.text}
          <button type="button" className="btn btn-small" onClick={() => repo.ackNotice(n.id).catch(fail)}>
            Đã biết
          </button>
        </p>
      ))}

      {(tab === 'detail' || (tab === 'menu' && !live.length)) && (
        <div className="order-head">
          <p className="order-meta">
            {order.kind === 'dine_in' && (
              <label className="inline-guests">
                Khách
                <input
                  type="number"
                  min={1}
                  max={99}
                  aria-label="Số khách"
                  defaultValue={order.guestCount ?? ''}
                  key={order.guestCount}
                  onBlur={e => Number(e.target.value) !== order.guestCount && repo.updateOrder(order.id, { guestCount: Number(e.target.value) }).catch(fail)}
                />
              </label>
            )}
            <span>Ngồi {formatDuration(now.getTime() - new Date(order.openedAt).getTime())}</span>
            {order.billRequestedAt && <span className="badge badge-bill">Chờ thanh toán · tạm tính lần {order.billPrintCount}</span>}
            {locked && <span className="badge badge-paying">Đang thanh toán ({order.payingBy})</span>}
          </p>
          <div className="order-note">
            <input
              aria-label="Ghi chú đơn cho bếp"
              maxLength={NOTE_MAX}
              placeholder="Ghi chú đơn (in đầu mọi phiếu bếp): sinh nhật, cần nhanh…"
              defaultValue={order.note}
              key={order.note}
              onBlur={e => e.target.value.trim() !== order.note && repo.updateOrder(order.id, { note: e.target.value }).catch(fail)}
            />
            <label className={'allergy-toggle' + (order.allergy ? ' is-on' : '')}>
              <input type="checkbox" checked={order.allergy} onChange={e => repo.updateOrder(order.id, { allergy: e.target.checked }).catch(fail)} />⚠ Dị ứng
            </label>
          </div>
        </div>
      )}

      <main>
        {tab === 'detail' && (
          <section className="bill-detail" aria-label="Món của đơn">
            {live.length === 0 && drafts.length === 0 && <p className="empty">Chưa có món nào. Bấm “Thêm” để gọi món.</p>}
            <ul className="detail-lines">
              {live.map(l => {
                const p = lineParts(l)
                const pending = notices.some(n => n.lineId === l.id && n.kind === 'modify' && n.status === 'pending')
                return (
                  <li key={l.id} className="detail-line">
                    <button type="button" className="detail-line-main" onClick={() => setDialog({ kind: 'line', line: l })}>
                      <b className="detail-name">{l.name}</b>
                      {l.variantName && <span>Size {l.variantName}</span>}
                      {[...p.options, ...p.addons].length > 0 && <span>{[...p.options, ...p.addons].join(' · ')}</span>}
                      {p.removals.length > 0 && <span className="removal">{p.removals.join(' · ')}</span>}
                      {l.note && <i>✎ {l.note}</i>}
                      <span className={`badge ls-badge ls-${l.status}`}>
                        {LINE_STATUS_LABEL[l.status]}
                        {pending ? ' · chờ bếp nhận sửa' : ''}
                      </span>
                    </button>
                    <div className="detail-line-side">
                      <b>{vnd(l.price * l.qty)}</b>
                      <span className="qty-stepper">
                        <button type="button" aria-label={`Bớt ${l.name}`} disabled={locked} onClick={() => setDialog({ kind: 'void', line: l, qty: 1 })}>
                          −
                        </button>
                        <span>{l.qty}</span>
                        <button type="button" aria-label={`Thêm ${l.name}`} disabled={locked} onClick={() => setDrafts(prev => [...prev, { key: draftKey(), state: { ...pickerFor(l), qty: 1 } }])}>
                          +
                        </button>
                      </span>
                    </div>
                  </li>
                )
              })}
              {quotedDrafts.map(({ d, item, q }) => (
                <li key={d.key} className={'detail-line is-draft' + (q?.canAdd ? '' : ' is-bad')}>
                  <div className="detail-line-main">
                    <b className="detail-name">{item?.name ?? 'Món đã xoá'}</b>
                    {item && <span>{describeLine(menu, item, d.state)}</span>}
                    {q && !q.canAdd && <span className="field-error">{q.issues.find(i => i.level === 'error')?.message}</span>}
                    <span className="badge badge-draft">Chưa lưu</span>
                  </div>
                  <div className="detail-line-side">
                    <b>{q?.total != null ? vnd(q.total) : '—'}</b>
                    <span className="qty-stepper">
                      <button type="button" aria-label="Bớt" onClick={() => setDraftQty(d.key, d.state.qty - 1)}>
                        −
                      </button>
                      <span>{d.state.qty}</span>
                      <button type="button" aria-label="Thêm" onClick={() => setDraftQty(d.key, d.state.qty + 1)}>
                        +
                      </button>
                    </span>
                  </div>
                </li>
              ))}
            </ul>
            <div className="detail-sum-row">
              <span>💰 Tiền hàng</span>
              <span>{vnd(bill.subtotal + draftTotal)}</span>
            </div>
            {bill.serviceCharge > 0 && (
              <div className="detail-sum-row">
                <span>🧾 Phí phục vụ</span>
                <span>{vnd(bill.serviceCharge)}</span>
              </div>
            )}
            <div className="detail-sum-row">
              <span>🏷️ Thuế VAT{vatRates.length ? ` (${vatRates.map(r => r + '%').join(', ')})` : ''}</span>
              <span className="muted">{bill.vatAdded > 0 ? vnd(bill.vatAdded) : 'Giá đã bao gồm thuế'}</span>
            </div>
            {waits.length > 0 && <p className="muted small wait-line">Bếp đang chờ: {waits.map(w => `${w.s.name} ~${w.m} phút`).join(' · ')}</p>}
            <button type="button" className="link" onClick={() => setTab('sent')}>
              Xem bếp làm tới đâu (theo lượt) ›
            </button>
          </section>
        )}

        <div hidden={tab !== 'menu'}>
          {waits.length > 0 && <p className="muted small wait-line">Đang chờ: {waits.map(w => `${w.s.name} ~${w.m} phút`).join(' · ')}</p>}
          {locked ? (
            <p className="warn">Đơn đang thanh toán: chưa thêm món được.</p>
          ) : (
            <OrderScreen menu={menu} now={now} storageKey={storageKey} cart={cart} onSend={send} onReview={() => setTab('detail')} footExtra={sendExtra} />
          )}
        </div>

        {tab === 'sent' && (
          <section className="sent">
            {lastChase && (
              <p className="muted small">
                Đã giục {lastChase.text.replace('GIỤC ', '')} lúc {clock(lastChase.createdAt)}
                {lastChase.ackAt ? ` · Bếp đã nhận lúc ${clock(lastChase.ackAt)}` : ' · bếp chưa nhận'}
              </p>
            )}
            {selecting && (
              <p className="warn select-bar">
                {selecting === 'split' ? 'Chọn món tách sang đơn mới' : 'Chọn món cần chuyển'} ({Object.keys(picked).length})
                <span className="btn-pair">
                  <button type="button" className="btn btn-small" onClick={() => (setSelecting(null), setPicked({}))}>
                    Huỷ
                  </button>
                  <button type="button" className="btn btn-small btn-primary" disabled={!Object.keys(picked).length} onClick={() => setDialog({ kind: selecting, picked })}>
                    Tiếp
                  </button>
                </span>
              </p>
            )}
            {rounds.length === 0 && <p className="empty">Chưa gửi món nào.</p>}
            {rounds.map(r => (
              <div key={r[0].sendBatch} className="round">
                <h3 className="round-head">
                  Lượt {r[0].round} · {clock(r[0].sentAt)} · {r[0].sentBy}
                  {r.some(l => l.rush) && <span className="badge badge-rush">GẤP: {r.find(l => l.rush)?.rushReason}</span>}
                </h3>
                <ul className="rows">
                  {r.map(l => {
                    const p = lineParts(l)
                    const pending = notices.some(n => n.lineId === l.id && n.kind === 'modify' && n.status === 'pending')
                    const selectable = selecting && l.status !== 'void'
                    return (
                      <li key={l.id} className={`sent-line ls-${l.status}`}>
                        {selectable && (
                          <input
                            type="checkbox"
                            aria-label={`Chọn ${l.name}`}
                            checked={l.id in picked}
                            onChange={e =>
                              setPicked(prev => {
                                const n = { ...prev }
                                if (e.target.checked) n[l.id] = l.qty
                                else delete n[l.id]
                                return n
                              })
                            }
                          />
                        )}
                        <div className="sent-main">
                          <b>
                            {l.qty} × {l.name}
                            {l.variantName && ` – ${l.variantName}`}
                          </b>
                          <span className="small">
                            {[...p.options, ...p.addons].join(' · ')}
                            {p.removals.length > 0 && <span className="removal"> {p.removals.join(' · ')}</span>}
                            {l.note && <i> ✎ {l.note}</i>}
                          </span>
                          {order.tables.length > 1 && l.deliveryTableId && <span className="small muted">ra bàn {tableName(floor, l.deliveryTableId)}</span>}
                          {l.status === 'void' && <span className="small void-reason">Đã huỷ: {l.voidReason}</span>}
                          {pending && <span className="small warn-text">Đang chờ bếp nhận sửa</span>}
                        </div>
                        <div className="sent-side">
                          <span className={`badge ls-badge ls-${l.status}`}>{LINE_STATUS_LABEL[l.status]}</span>
                          <span className="small">{vnd(l.price * l.qty)}</span>
                          {!selecting && !locked && l.status !== 'void' && (
                            <span className="btn-pair">
                              {l.status === 'ready' && (
                                <button type="button" className="btn btn-small btn-primary" onClick={() => repo.setLineStatus([l.id], 'served').catch(fail)}>
                                  Đã bưng
                                </button>
                              )}
                              {isUnfinished(l) && !pending && (
                                <button type="button" className="btn btn-small" onClick={() => setDialog({ kind: 'modify', line: l })}>
                                  Sửa
                                </button>
                              )}
                              <button type="button" className="btn btn-small btn-danger" onClick={() => setDialog({ kind: 'void', line: l })}>
                                Huỷ
                              </button>
                            </span>
                          )}
                        </div>
                      </li>
                    )
                  })}
                </ul>
              </div>
            ))}
            <p className="sent-total">
              Tạm tính <b>{vnd(total)}</b>
            </p>
          </section>
        )}
      </main>

      {tab === 'detail' && !locked && (
        <footer className="detail-foot">
          {drafts.length > 0 && sendExtra}
          <div className="detail-total">
            <span>
              SL: <b>{qtySum}</b>
            </span>
            <span>
              TỔNG: <b>{vnd(bill.total + draftTotal)}</b>
            </span>
          </div>
          {cashier && (
            <div className="detail-links">
              <button type="button" onClick={pay} disabled={!live.length || drafts.length > 0}>
                Khuyến mại
              </button>
              <button type="button" onClick={pay} disabled={!live.length || drafts.length > 0}>
                Chiết khấu
              </button>
              <button type="button" onClick={() => setDialog({ kind: 'tax' })}>
                Thuế & Phí
              </button>
            </div>
          )}
          <div className="detail-actions">
            <button type="button" className="btn btn-add" onClick={() => setTab('menu')}>
              ⊕ Thêm
            </button>
            <button type="button" className={'btn btn-save' + (drafts.length ? ' is-dirty' : '')} disabled={!drafts.length || saving || draftBlocked} onClick={save}>
              {saving ? 'Đang lưu…' : drafts.length ? (draftBlocked ? 'Món cần sửa' : 'Lưu') : 'Đã lưu'}
            </button>
            {cashier ? (
              <button type="button" className="btn btn-primary btn-pay" disabled={!live.length || drafts.length > 0} title={drafts.length ? 'Lưu món mới trước khi thanh toán' : undefined} onClick={pay}>
                Thanh toán
              </button>
            ) : (
              <button
                type="button"
                className="btn btn-primary btn-pay"
                disabled={!live.length || drafts.length > 0}
                onClick={() => act(repo.requestBill(order.id), () => props.onInfo('Đã báo thu ngân: bàn chờ thanh toán'))}
              >
                {order.billRequestedAt ? 'Đã báo tính tiền' : 'Báo tính tiền'}
              </button>
            )}
          </div>
        </footer>
      )}
      {dialog?.kind === 'line' &&
        (() => {
          const l = dialog.line
          const pendingFix = notices.some(n => n.lineId === l.id && n.kind === 'modify' && n.status === 'pending')
          return (
            <Sheet title={`${l.qty} × ${l.name}${l.variantName ? ' – ' + l.variantName : ''}`} subtitle={`${LINE_STATUS_LABEL[l.status]} · gửi ${clock(l.sentAt)} · ${l.sentBy}`} onClose={() => setDialog(null)}>
              <div className="action-grid">
                {l.status === 'ready' && (
                  <button type="button" className="btn btn-primary" onClick={() => act(repo.setLineStatus([l.id], 'served'))}>
                    Đã bưng
                  </button>
                )}
                {isUnfinished(l) && !pendingFix && (
                  <button type="button" className="btn" disabled={locked} onClick={() => setDialog({ kind: 'modify', line: l })}>
                    Sửa món
                  </button>
                )}
                <button
                  type="button"
                  className="btn"
                  disabled={locked}
                  onClick={() => {
                    setDrafts(prev => [...prev, { key: draftKey(), state: { ...pickerFor(l), qty: 1 } }])
                    setDialog(null)
                  }}
                >
                  Gọi thêm 1 phần
                </button>
                <button type="button" className="btn btn-danger" disabled={locked} onClick={() => setDialog({ kind: 'void', line: l })}>
                  Huỷ món
                </button>
              </div>
            </Sheet>
          )
        })()}
      {dialog?.kind === 'tax' && (
        <Sheet title="Thuế & Phí" onClose={() => setDialog(null)}>
          <ul className="rows">
            {bill.vat.map(v => (
              <li key={`${v.vatRate}-${String(v.priceIncludesVat)}`} className="detail-sum-row">
                <span>
                  VAT {v.vatRate}% {v.priceIncludesVat ? '(đã gồm trong giá)' : '(cộng thêm)'}
                </span>
                <span>{vnd(v.vat)}</span>
              </li>
            ))}
            <li className="detail-sum-row">
              <span>Phí phục vụ</span>
              <span>{vnd(bill.serviceCharge)}</span>
            </li>
            <li className="detail-sum-row">
              <b>Tổng thuế VAT</b>
              <b>{vnd(bill.vatTotal)}</b>
            </li>
          </ul>
          <p className="muted small">Thuế suất theo nhóm món trong Thực đơn. Chiết khấu và khuyến mại nhập ở màn Thanh toán.</p>
        </Sheet>
      )}
      {locked && cashier && (
        <div className="save-bar pay-bar">
          <button type="button" className="btn" onClick={() => repo.cancelPayment(order.id).catch(fail)}>
            Huỷ thanh toán
          </button>
          <button type="button" className="btn btn-primary btn-grow" onClick={() => go(`thu-ngan/${order.id}`)}>
            <span>{vnd(quoteBill(floor, order.id).total)}</span>
            <b>Mở màn thu tiền</b>
          </button>
        </div>
      )}

      {dialog?.kind === 'actions' && (
        <Sheet title={`Thao tác · ${tableTitle(label)}`} onClose={() => setDialog(null)}>
          <div className="action-grid">
            <button type="button" className="btn" disabled={locked} onClick={() => act(repo.chaseOrder(order.id), () => props.onInfo('Đã giục bếp'))}>
              🔔 Giục bếp
            </button>
            <button
              type="button"
              className="btn"
              disabled={locked || !live.length}
              onClick={() => {
                const open = live.filter(l => isUnfinished(l)).length
                if (open && !confirm(`Còn ${open} món chưa ra. Vẫn in tạm tính?`)) return
                const blocks = receiptBlocks(prebillData(floor, order, quoteBill(floor, order.id), { at: new Date().toISOString(), printNo: order.billPrintCount + 1 }))
                act(repo.requestBill(order.id), () => {
                  props.onInfo(`Đã in tạm tính lần ${order.billPrintCount + 1}`)
                  printBlocks(blocks, 'Phiếu tạm tính').catch(fail)
                })
              }}
            >
              🧾 In tạm tính
            </button>
            {cashier && (
              <button type="button" className="btn btn-primary" disabled={(locked && order.payingBy !== props.me) || !live.length} onClick={() => act(locked ? Promise.resolve() : repo.beginPayment(order.id), () => go(`thu-ngan/${order.id}`))}>
                Thanh toán
              </button>
            )}
            {order.kind === 'dine_in' && (
              <>
                <button type="button" className="btn" disabled={locked} onClick={() => setDialog({ kind: 'moveTable' })}>
                  Chuyển bàn
                </button>
                <button type="button" className="btn" disabled={locked} onClick={() => setDialog({ kind: 'merge' })}>
                  Gộp bàn
                </button>
                <button type="button" className="btn" disabled={locked} onClick={() => setDialog({ kind: 'shared' })}>
                  Thêm đơn ghép
                </button>
              </>
            )}
            <button type="button" className="btn" disabled={locked || !live.length} onClick={() => (setDialog(null), setTab('sent'), setSelecting('moveItems'), setPicked({}))}>
              Chuyển món
            </button>
            {order.kind === 'dine_in' && cashier && (
              <button type="button" className="btn" disabled={locked || !live.length} onClick={() => (setDialog(null), setTab('sent'), setSelecting('split'), setPicked({}))}>
                Tách đơn
              </button>
            )}
            {order.tables.length > 1 && (
              <button type="button" className="btn" disabled={locked} onClick={() => setDialog({ kind: 'release' })}>
                Trả bớt / tách bàn
              </button>
            )}
            {!live.length ? (
              <button type="button" className="btn btn-danger" onClick={() => act(repo.closeEmptyOrder(order.id), () => go('ban'))}>
                Đóng đơn trống
              </button>
            ) : (
              <button type="button" className="btn btn-danger" disabled={locked} onClick={() => setDialog({ kind: 'voidOrder' })}>
                Huỷ cả đơn
              </button>
            )}
          </div>
        </Sheet>
      )}
      {dialog?.kind === 'void' && (
        <VoidSheet
          line={dialog.line}
          needsManager={voidNeedsManager(dialog.line, floor.settings) && !isManager(role)}
          initialQty={dialog.qty}
          onClose={() => setDialog(null)}
          onVoid={inp => act(repo.voidLine(dialog.line.id, inp))}
        />
      )}
      {dialog?.kind === 'voidOrder' && (
        <VoidOrderSheet
          floor={floor}
          order={order}
          needsManager={live.some(l => voidNeedsManager(l, floor.settings)) && !isManager(role)}
          onClose={() => setDialog(null)}
          onVoid={inp => act(repo.voidOrder(order.id, inp), () => go('ban'))}
        />
      )}
      {dialog?.kind === 'modify' && (() => {
        const item = menu.items.find(i => i.id === dialog.line.menuItemId)
        if (!item) return null
        return (
          <ItemPicker
            menu={menu}
            item={item}
            initial={pickerFor(dialog.line)}
            now={now}
            addLabel={dialog.line.status === 'cooking' ? 'Gửi yêu cầu sửa' : 'Lưu sửa'}
            lockQty
            onClose={() => setDialog(null)}
            onAdd={s =>
              act(repo.modifyLine(dialog.line.id, { ...toSendLine(s), ...(dialog.line.deliveryTableId ? { delivery_table_id: dialog.line.deliveryTableId } : {}) }), () =>
                props.onInfo(dialog.line.status === 'cooking' ? 'Đã gửi yêu cầu sửa: chờ bếp nhận' : `Đã sửa: ${describeLine(menu, item, s)}`),
              )
            }
          />
        )
      })()}
      {dialog?.kind === 'moveTable' && <MoveTableSheet floor={floor} order={order} now={now} repo={repo} onClose={() => setDialog(null)} onDone={id => (setDialog(null), id !== order.id && go(`ban/don/${id}`))} onError={fail} />}
      {dialog?.kind === 'merge' && <MergeSheet floor={floor} order={order} onClose={() => setDialog(null)} onMerge={ids => act(repo.mergeOrders(order.id, ids), () => props.onInfo('Đã gộp bàn'))} />}
      {dialog?.kind === 'shared' && order.tableId && (
        <SharedOrderSheet floor={floor} tableId={order.tableId} onClose={() => setDialog(null)} onCreate={inp => repo.addSharedOrder({ tableId: order.tableId!, ...inp }).then(id => (setDialog(null), go(`ban/don/${id}`)), fail)} />
      )}
      {dialog?.kind === 'release' && <ReleaseSheet floor={floor} order={order} cashier={cashier} repo={repo} onClose={() => setDialog(null)} onError={fail} />}
      {dialog?.kind === 'moveItems' && (
        <MoveItemsSheet
          floor={floor}
          order={order}
          picked={dialog.picked}
          onClose={() => setDialog(null)}
          onMove={(items, target) =>
            act(repo.moveItems(items, target), () => {
              setSelecting(null)
              setPicked({})
              const left = floor.lines.filter(l => l.orderId === order.id && l.status !== 'void').reduce((n, l) => n + l.qty, 0) - items.reduce((n, i) => n + (i.qty ?? 0), 0)
              if (left <= 0 && confirm('Đơn đã hết món. Đóng đơn và trả bàn?')) repo.closeEmptyOrder(order.id).then(() => go('ban'), fail)
            })
          }
        />
      )}
      {dialog?.kind === 'split' && (
        <SplitSheet
          floor={floor}
          order={order}
          picked={dialog.picked}
          onClose={() => setDialog(null)}
          onSplit={inp =>
            repo.splitOrder({ orderId: order.id, ...inp }).then(id => {
              setDialog(null)
              setSelecting(null)
              setPicked({})
              props.onInfo('Đã tách đơn')
              go(`ban/don/${id}`)
            }, fail)
          }
        />
      )}
      {dialog?.kind === 'leave' && (
        <Sheet title="Còn món chưa lưu" onClose={() => setDialog(null)}>
          <p>{cartCount} món mới chưa lưu (chưa gửi bếp).</p>
          <div className="action-grid">
            <button type="button" className="btn btn-primary" onClick={() => (setDialog(null), setTab('detail'))}>
              Ở lại để lưu
            </button>
            <button type="button" className="btn" onClick={() => go('ban')}>
              Giữ lại để gửi sau
            </button>
            <button
              type="button"
              className="btn btn-danger"
              onClick={() => {
                try {
                  localStorage.removeItem(storageKey)
                } catch {
                  /* ignore */
                }
                go('ban')
              }}
            >
              Bỏ món chưa gửi
            </button>
          </div>
        </Sheet>
      )}
    </div>
  )
}
