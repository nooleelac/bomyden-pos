// #/thu-ngan/<orderId>: settle one order.
// Left: the bill (items with size, options and removed components, subtotal, discount, VAT by rate, rounding, total).
// Right: payment rows in any mix of cash, transfer (VietQR with exact amount and memo) and card; cash change with
// quick amounts; chia đều N người (one bill, one share per person); tách hoá đơn theo món (separate bill).
// "Thu tiền" stays off until the settled amounts equal the total.

import { useEffect, useMemo, useRef, useState } from 'react'
import { METHOD_LABEL, formatMoney, formatVnd, quickCash, settle, splitEven, type Discount, type PayMethod, type PayRow } from '../../lib/billing'
import { newId } from '../../menu/repo'
import { useAuth, type Approved } from '../../auth/context'
import { needsManagerForDiscount, quoteBill } from '../../floor/engine'
import { errText, go } from '../../floor/hooks'
import { isOpen, isUnfinished, orderTitle } from '../../floor/logic'
import type { FloorRepo } from '../../floor/repo'
import { GuestPicker, Sheet } from '../../floor/screens/Sheet'
import type { FloorState, Order, Role } from '../../floor/types'
import { payMemo, prebillData, receiptGroups, vietQr } from '../bill'
import { DISCOUNT_REASONS, enabledMethods } from '../config'
import { printBlocks } from '../print'
import { receiptBlocks } from '../receipt'
import { MoneyInput, QrImage, ReceiptPreview } from './ui'

interface UiRow extends PayRow {
  id: string
  ref?: string
  /** Share letter of a split bill (A, B, C…), also on the transfer memo. */
  part?: string
}

interface DiscountState {
  d: Discount
  reason: string
  approvedBy: string
  /** Manager approval token for a cashier's discount (single-use, short-lived; asked again when expired). */
  approval?: Approved
}

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'

function loadRows(orderId: string): UiRow[] {
  try {
    const raw = sessionStorage.getItem(`bmd-pay-${orderId}`)
    return raw ? (JSON.parse(raw) as UiRow[]) : []
  } catch {
    return []
  }
}

export function PayScreen(props: { floor: FloorState; repo: FloorRepo; role: Role; me: string; orderId: string; now: Date; onError: (m: string) => void; onInfo: (m: string) => void }) {
  const { floor, repo, role } = props
  const order = floor.orders.find(o => o.id === props.orderId)
  const [rows, setRows] = useState<UiRow[]>(() => loadRows(props.orderId))
  const [disc, setDisc] = useState<DiscountState | null>(null)
  const [dialog, setDialog] = useState<null | 'discount' | 'split' | 'prebill' | { qr: string }>(null)
  const [busy, setBusy] = useState(false)
  const fail = (e: unknown) => props.onError(errText(e))
  // Cài đặt → Thanh toán: only the methods the shop takes
  const methods = enabledMethods(floor.shop)
  const { requestApproval } = useAuth()

  const totals = useMemo(() => (order ? quoteBill(floor, order.id, disc?.d ?? null) : null), [floor, order, disc])
  const st = useMemo(() => settle(totals?.total ?? 0, rows), [totals, rows])

  useEffect(() => {
    try {
      sessionStorage.setItem(`bmd-pay-${props.orderId}`, JSON.stringify(rows))
    } catch {
      /* no storage: rows live in memory only */
    }
  }, [rows, props.orderId])

  // Đang thanh toán: lock the order for other devices while this screen is open
  const mine = !!order && order.payingBy === props.me
  const lockedByOther = !!order?.payingAt && !mine
  const leaving = useRef(false)
  useEffect(() => {
    if (order && isOpen(order) && !order.payingAt && !leaving.current) repo.beginPayment(order.id).catch(e => props.onError(errText(e)))
    // only when the order or its lock changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [order?.id, order?.payingAt])

  if (!order) return <p className="empty">Không tìm thấy đơn. <a href="#/thu-ngan">Về thu ngân</a></p>
  if (!isOpen(order)) {
    const bill = floor.bills.find(b => b.orderId === order.id)
    return (
      <p className="empty">
        Đơn đã đóng. {bill && <a href={`#/thu-ngan/hd/${bill.id}`}>Xem hoá đơn {bill.billNo}</a>} · <a href="#/thu-ngan">Về thu ngân</a>
      </p>
    )
  }
  if (!totals) return null
  const total = totals.total
  const unfinished = floor.lines.filter(l => l.orderId === order.id && isUnfinished(l)).length
  const others = (id: string) => rows.filter(r => r.id !== id).reduce((s, r) => s + Math.max(0, r.amount || 0), 0)
  const leftFor = (id: string) => Math.max(0, total - others(id))

  const setRow = (id: string, p: Partial<UiRow>) => setRows(rs => rs.map(r => (r.id === id ? { ...r, ...p } : r)))
  const addRow = (method: PayMethod) => {
    const amount = Math.max(0, total - rows.reduce((s, r) => s + Math.max(0, r.amount || 0), 0))
    const row: UiRow = { id: newId(), method, amount, tendered: null, confirmed: false }
    setRows(rs => [...rs, row])
    if (method === 'bank' && amount > 0) setDialog({ qr: row.id })
  }
  const splitBy = (n: number) => {
    const kept = rows.filter(r => r.confirmed)
    const left = total - kept.reduce((s, r) => s + r.amount, 0)
    if (left <= 0) return
    const used = new Set(kept.map(r => r.part))
    const letters = [...LETTERS].filter(x => !used.has(x))
    setRows([...kept, ...splitEven(left, n).map((amount, i): UiRow => ({ id: newId(), method: methods[0], amount, tendered: null, confirmed: false, part: letters[i] }))])
  }

  const cancel = async () => {
    if (rows.some(r => r.confirmed) && !confirm('Đã xác nhận một số khoản. Vẫn huỷ thanh toán?')) return
    leaving.current = true
    try {
      await repo.cancelPayment(order.id)
      sessionStorage.removeItem(`bmd-pay-${order.id}`)
    } catch (e) {
      fail(e)
    }
    go('thu-ngan')
  }
  const pay = async () => {
    if (!st.canSettle) return
    if (unfinished && !confirm(`Còn ${unfinished} món bếp chưa ra. Vẫn thu tiền?`)) return
    let approval = disc?.approval
    if (disc && needsManagerForDiscount(role, totals.discount) && (!approval || Date.parse(approval.expiresAt) - Date.now() < 5000)) {
      // the approval from the discount dialog expired while the guest was paying: ask again
      const a = await requestApproval({ action: 'discount', orderId: order.id, amount: totals.discount, title: `Giảm ${formatVnd(totals.discount)}`, subtitle: `Lý do: ${disc.reason} · mã duyệt trước đã hết hạn` })
      if (!a) return
      approval = a
      setDisc({ ...disc, approval: a, approvedBy: a.managerName })
    }
    setBusy(true)
    leaving.current = true
    try {
      const payments = st.payments.map((p, i) => ({ ...p, ref: rows[st.from[i]]?.ref ?? '' }))
      const billId = await repo.payOrder(order.id, {
        discount: disc?.d ?? null,
        discountReason: disc?.reason,
        approval: approval?.token,
        payments,
      })
      try {
        sessionStorage.removeItem(`bmd-pay-${order.id}`)
      } catch {
        /* ignore */
      }
      props.onInfo(st.change ? `Đã thu. Thối lại ${formatVnd(st.change)}` : 'Đã thu đủ')
      go(`thu-ngan/hd/${billId}`)
    } catch (e) {
      leaving.current = false
      fail(e)
    } finally {
      setBusy(false)
    }
  }

  const memoFor = (r: UiRow) => payMemo(floor, order, r.part ?? '')
  const qrRow = dialog && typeof dialog === 'object' ? rows.find(r => r.id === dialog.qr) : undefined

  return (
    <main className="cashier-main pay-screen">
      <div className="pay-head">
        <button type="button" className="link" onClick={cancel}>
          ← Huỷ thanh toán
        </button>
        <h1>{orderTitle(floor, order)}</h1>
        <span className="muted">
          {order.guestCount ? `${order.guestCount} khách · ` : ''}phục vụ {order.openedBy}
        </span>
        {lockedByOther && <span className="badge badge-paying">Đang thanh toán ở máy khác ({order.payingBy})</span>}
        {unfinished > 0 && <span className="badge badge-bill">{unfinished} món bếp chưa ra</span>}
      </div>

      <div className="cashier-cols">
        <BillCard floor={floor} order={order} totals={totals} disc={disc} onDiscount={() => setDialog('discount')} onClearDiscount={() => setDisc(null)} />

        <section className="card pay-card" aria-label="Thu tiền">
          <div className="due-box">
            <div>
              <span className="muted small">Phải thu</span>
              <b className="due-total">{formatVnd(total)}</b>
            </div>
            <div className="due-side">
              <span>
                Đã thu <b>{formatVnd(st.paid)}</b>
              </span>
              {st.remaining > 0 ? (
                <span className="due-left">
                  Còn phải thu <b>{formatVnd(st.remaining)}</b>
                </span>
              ) : st.change > 0 ? (
                <span className="due-change">
                  Tiền thối <b>{formatVnd(st.change)}</b>
                </span>
              ) : (
                <span className="due-ok">Đủ tiền</span>
              )}
            </div>
          </div>

          <div className="add-pay" role="group" aria-label="Thêm cách trả">
            {methods.map(m => (
              <button key={m} type="button" className="btn" onClick={() => addRow(m)}>
                + {METHOD_LABEL[m]}
              </button>
            ))}
          </div>
          <div className="split-row">
            <span className="muted small">Chia đều:</span>
            {[2, 3, 4, 5, 6].map(n => (
              <button key={n} type="button" className="chip chip-sm" onClick={() => splitBy(n)}>
                {n} người
              </button>
            ))}
            {order.kind === 'dine_in' && (
              <button type="button" className="chip chip-sm" onClick={() => setDialog('split')}>
                Tách hoá đơn theo món
              </button>
            )}
          </div>

          {!rows.length && <p className="muted small">Chọn cách trả.{methods.length > 1 && ` Một hoá đơn trả được bằng nhiều cách: ${methods.map(m => METHOD_LABEL[m].toLowerCase()).join(', ')}.`}</p>}
          <ul className="pay-rows">
            {rows.map(r => {
              const cash = r.method === 'cash'
              const due = r.amount || 0
              const tendered = r.tendered ?? null
              const change = cash && tendered != null ? Math.max(0, tendered - due) : 0
              const short = cash && tendered != null && tendered < due
              return (
                <li key={r.id} className={`pay-row m-${r.method}` + (r.confirmed ? ' is-confirmed' : '')}>
                  <div className="pay-row-head">
                    <select
                      aria-label="Cách trả"
                      value={r.method}
                      disabled={r.confirmed}
                      onChange={e => setRow(r.id, { method: e.target.value as PayMethod, confirmed: false, tendered: null })}
                    >
                      {(['cash', 'bank', 'card'] as PayMethod[]).filter(m => methods.includes(m) || m === r.method).map(m => (
                        <option key={m} value={m}>
                          {METHOD_LABEL[m]}
                        </option>
                      ))}
                    </select>
                    {r.part && <span className="badge">Người {r.part}</span>}
                    <MoneyInput label={`Số tiền ${METHOD_LABEL[r.method]}`} value={r.amount || null} disabled={r.confirmed} onChange={v => setRow(r.id, { amount: v ?? 0 })} />
                    <button type="button" className="icon-btn" aria-label="Bỏ dòng" disabled={r.confirmed} onClick={() => setRows(rs => rs.filter(x => x.id !== r.id))}>
                      ✕
                    </button>
                  </div>
                  {r.amount !== leftFor(r.id) && !r.confirmed && leftFor(r.id) > 0 && (
                    <button type="button" className="link small" onClick={() => setRow(r.id, { amount: leftFor(r.id) })}>
                      Điền số còn lại {formatVnd(leftFor(r.id))}
                    </button>
                  )}
                  {cash && due > 0 && (
                    <div className="cash-box">
                      <label className="cash-given">
                        <span className="field-label">Khách đưa</span>
                        <MoneyInput label="Khách đưa" value={tendered} placeholder={formatMoney(due)} onChange={v => setRow(r.id, { tendered: v })} />
                      </label>
                      <div className="quick-cash" role="group" aria-label="Tiền khách đưa nhanh">
                        <button type="button" className={'chip chip-sm' + (tendered === due ? ' is-on' : '')} onClick={() => setRow(r.id, { tendered: due })}>
                          Đủ tiền
                        </button>
                        {quickCash(due, 4).map(v => (
                          <button key={v} type="button" className={'chip chip-sm' + (tendered === v ? ' is-on' : '')} onClick={() => setRow(r.id, { tendered: v })}>
                            {formatMoney(v)}
                          </button>
                        ))}
                      </div>
                      {short ? (
                        <p className="warn-text">Khách đưa thiếu {formatVnd(due - tendered!)}: dòng này chỉ tính {formatVnd(tendered!)}</p>
                      ) : (
                        <p className="change-line">
                          Tiền thối <b>{formatVnd(change)}</b>
                        </p>
                      )}
                    </div>
                  )}
                  {r.method === 'bank' && due > 0 && (
                    <div className="pay-row-foot">
                      <span className="muted small">Nội dung: {memoFor(r)}</span>
                      {r.confirmed ? (
                        <span className="pay-ok">
                          ✓ Đã nhận tiền{' '}
                          <button type="button" className="link small" onClick={() => setRow(r.id, { confirmed: false })}>
                            Huỷ xác nhận
                          </button>
                        </span>
                      ) : (
                        <button type="button" className="btn btn-small btn-primary" onClick={() => setDialog({ qr: r.id })}>
                          Hiện mã VietQR
                        </button>
                      )}
                    </div>
                  )}
                  {r.method === 'card' && due > 0 && (
                    <div className="pay-row-foot">
                      <input className="card-ref" aria-label="4 số cuối thẻ hoặc số hoá đơn máy cà thẻ" placeholder="4 số cuối / số HĐ máy thẻ (không bắt buộc)" maxLength={20} value={r.ref ?? ''} disabled={r.confirmed} onChange={e => setRow(r.id, { ref: e.target.value })} />
                      {r.confirmed ? (
                        <span className="pay-ok">
                          ✓ Đã cà thẻ{' '}
                          <button type="button" className="link small" onClick={() => setRow(r.id, { confirmed: false })}>
                            Huỷ
                          </button>
                        </span>
                      ) : (
                        <button type="button" className="btn btn-small btn-primary" onClick={() => setRow(r.id, { confirmed: true })}>
                          Máy thẻ báo thành công
                        </button>
                      )}
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
          {st.problems.length > 0 && rows.length > 0 && (
            <ul className="problems">
              {st.problems.map(p => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <div className="save-bar pay-bar cashier-bar">
        <button type="button" className="btn" onClick={() => setDialog('prebill')}>
          🧾 Tạm tính
        </button>
        <button type="button" className="btn btn-primary btn-grow" disabled={!st.canSettle || busy || lockedByOther} onClick={pay}>
          <span>{st.canSettle ? (st.change ? `Thối ${formatVnd(st.change)}` : 'Đủ tiền') : st.remaining ? `Còn ${formatVnd(st.remaining)}` : 'Chưa đủ điều kiện'}</span>
          <b>Thu tiền &amp; in hoá đơn</b>
        </button>
      </div>

      {dialog === 'discount' && (
        <DiscountSheet
          role={role}
          me={props.me}
          base={totals.discountBase}
          initial={disc}
          orderId={order.id}
          quote={d => quoteBill(floor, order.id, d).discount}
          onClose={() => setDialog(null)}
          onApply={d => (setDisc(d), setDialog(null))}
        />
      )}
      {qrRow && (
        <QrSheet
          floor={floor}
          order={order}
          amount={qrRow.amount}
          memo={memoFor(qrRow)}
          onClose={() => setDialog(null)}
          onPrint={() => {
            const data = prebillData(floor, order, totals, { at: new Date().toISOString(), cashier: props.me, discount: disc?.d, discountReason: disc?.reason, qrAmount: qrRow.amount, qrPart: qrRow.part })
            printBlocks(receiptBlocks(data), 'Phiếu chuyển khoản').catch(fail)
          }}
          onConfirm={() => (setRow(qrRow.id, { confirmed: true }), setDialog(null))}
        />
      )}
      {dialog === 'prebill' && (
        <PrebillSheet
          floor={floor}
          order={order}
          blocks={receiptBlocks(
            prebillData(floor, order, totals, { at: new Date().toISOString(), cashier: props.me, discount: disc?.d, discountReason: disc?.reason, printNo: order.billPrintCount + 1 }),
          )}
          onClose={() => setDialog(null)}
          onPrint={async blocks => {
            try {
              await repo.requestBill(order.id)
              await printBlocks(blocks, 'Phiếu tạm tính')
            } catch (e) {
              fail(e)
            }
          }}
        />
      )}
      {dialog === 'split' && (
        <ItemSplitSheet
          floor={floor}
          order={order}
          onClose={() => setDialog(null)}
          onSplit={inp =>
            repo.splitOrder({ orderId: order.id, ...inp }).then(() => {
              setDialog(null)
              setRows(rs => rs.filter(r => r.confirmed))
              props.onInfo('Đã tách sang hoá đơn mới: thu riêng ở danh sách đơn')
            }, fail)
          }
        />
      )}
    </main>
  )
}

// ---------------------------------------------------------------- bill (left column)

function BillCard(props: { floor: FloorState; order: Order; totals: ReturnType<typeof quoteBill>; disc: DiscountState | null; onDiscount: () => void; onClearDiscount: () => void }) {
  const { floor, order, totals: t, disc } = props
  const groups = receiptGroups(floor, order)
  return (
    <section className="card bill-card" aria-label="Hoá đơn">
      {groups.map(g => (
        <div key={g.label || 'all'}>
          {g.label && <h3 className="bill-group">{g.label}</h3>}
          <ul className="bill-items">
            {g.items.map((it, i) => (
              <li key={i}>
                <div className="bill-item">
                  <span>
                    <b>{it.qty}</b> × {it.name}
                    {it.variant && <span className="muted"> ({it.variant})</span>}
                  </span>
                  <span>{formatMoney(it.unitPrice * it.qty)}</span>
                </div>
                {it.mods.map((m, j) => (
                  <div key={j} className={'bill-mod' + (m.kind === 'removal' ? ' removal' : '')}>
                    <span>{m.kind === 'removal' ? `Không ${m.name.toLowerCase()}` : m.kind === 'addon' ? `+ ${m.name}${m.qty > 1 ? ` x${m.qty}` : ''}` : m.name}</span>
                    {m.unitDelta !== 0 && <span>{(m.unitDelta > 0 ? '+' : '') + formatMoney(m.unitDelta * m.qty)}/phần</span>}
                  </div>
                ))}
                {it.qty > 1 && <div className="bill-mod muted">{formatMoney(it.unitPrice)} / phần</div>}
              </li>
            ))}
          </ul>
        </div>
      ))}
      <dl className="bill-sums">
        <div>
          <dt>Tạm tính</dt>
          <dd>{formatMoney(t.subtotal)}</dd>
        </div>
        <div className="disc-line">
          <dt>
            {disc ? (
              <>
                Giảm giá {disc.d.kind === 'percent' ? `${disc.d.value}%` : ''} ({disc.reason}){' '}
                <button type="button" className="link small" onClick={props.onClearDiscount}>
                  Bỏ
                </button>
              </>
            ) : (
              <button type="button" className="btn btn-small" onClick={props.onDiscount}>
                Giảm giá hoá đơn…
              </button>
            )}
          </dt>
          <dd>{t.discount ? formatMoney(-t.discount) : ''}</dd>
        </div>
        {disc && <p className="muted small disc-who">Duyệt: {disc.approvedBy}{t.discountBase < t.subtotal ? ` · chỉ tính trên món được giảm (${formatMoney(t.discountBase)})` : ''}</p>}
        {t.serviceCharge > 0 && (
          <div>
            <dt>Phí phục vụ {floor.shop.serviceChargePct}%</dt>
            <dd>{formatMoney(t.serviceCharge)}</dd>
          </div>
        )}
        {t.vat
          .filter(v => !v.priceIncludesVat)
          .map(v => (
            <div key={`a${v.vatRate}`}>
              <dt>Thuế GTGT {v.vatRate}%</dt>
              <dd>{formatMoney(v.vat)}</dd>
            </div>
          ))}
        {t.rounding !== 0 && (
          <div>
            <dt>Làm tròn</dt>
            <dd>{formatMoney(t.rounding)}</dd>
          </div>
        )}
        <div className="bill-total">
          <dt>TỔNG THANH TOÁN</dt>
          <dd>{formatVnd(t.total)}</dd>
        </div>
      </dl>
      {t.vat.some(v => v.priceIncludesVat) && (
        <table className="vat-table">
          <caption>Giá đã gồm thuế GTGT</caption>
          <thead>
            <tr>
              <th>Thuế suất</th>
              <th>Trước thuế</th>
              <th>Thuế GTGT</th>
            </tr>
          </thead>
          <tbody>
            {t.vat
              .filter(v => v.priceIncludesVat)
              .map(v => (
                <tr key={v.vatRate}>
                  <td>{v.vatRate}%{v.vatRate === 8 ? ' (món ăn)' : v.vatRate === 10 ? ' (bia, rượu)' : ''}</td>
                  <td>{formatMoney(v.base)}</td>
                  <td>{formatMoney(v.vat)}</td>
                </tr>
              ))}
          </tbody>
        </table>
      )}
    </section>
  )
}

// ---------------------------------------------------------------- dialogs

function DiscountSheet(props: {
  role: Role
  me: string
  base: number
  initial: DiscountState | null
  orderId: string
  /** The bill discount in đồng for this entry (what the manager approves). */
  quote: (d: Discount) => number
  onClose: () => void
  onApply: (d: DiscountState) => void
}) {
  const [kind, setKind] = useState<Discount['kind']>(props.initial?.d.kind ?? 'percent')
  const [value, setValue] = useState<number | null>(props.initial?.d.value ?? null)
  const [reason, setReason] = useState(props.initial?.reason ?? '')
  const [note, setNote] = useState('')
  const [err, setErr] = useState('')
  const { requestApproval } = useAuth()
  const amount = value && value > 0 && !(kind === 'percent' && value > 100) ? props.quote({ kind, value }) : 0
  const needPin = needsManagerForDiscount(props.role, amount)
  const fullReason = reason === 'Khác' ? note.trim() : reason
  const apply = async () => {
    if (!value || value <= 0) return setErr('Nhập mức giảm')
    if (kind === 'percent' && value > 100) return setErr('Giảm tối đa 100%')
    if (!fullReason) return setErr(reason === 'Khác' ? 'Ghi rõ lý do' : 'Chọn lý do giảm giá')
    if (!needPin) return props.onApply({ d: { kind, value }, reason: fullReason, approvedBy: props.me })
    // verify_manager_pin: the token is bound to this order and at most this amount; pay_order checks it again
    const a = await requestApproval({ action: 'discount', orderId: props.orderId, amount, title: `Giảm ${formatVnd(amount)}`, subtitle: `Lý do: ${fullReason}` })
    if (!a) return setErr('Chưa được quản lý duyệt')
    props.onApply({ d: { kind, value }, reason: fullReason, approvedBy: a.managerName, approval: a })
  }
  return (
    <Sheet
      title="Giảm giá hoá đơn"
      subtitle={`Tính trên ${formatVnd(props.base)} (món được giảm). Mỗi khoản giảm in trên hoá đơn và vào báo cáo.`}
      onClose={props.onClose}
      foot={
        <button type="button" className="btn btn-primary btn-grow" onClick={apply}>
          <span>{amount ? `−${formatVnd(amount)}` : ''}</span>
          <b>{needPin ? '🔐 Quản lý duyệt' : 'Áp dụng'}</b>
        </button>
      }
    >
      <div className="seg" role="group" aria-label="Kiểu giảm">
        <button type="button" className={'chip' + (kind === 'percent' ? ' is-on' : '')} onClick={() => setKind('percent')}>
          Theo %
        </button>
        <button type="button" className={'chip' + (kind === 'amount' ? ' is-on' : '')} onClick={() => setKind('amount')}>
          Số tiền
        </button>
      </div>
      {kind === 'percent' ? (
        <div className="quick-cash">
          {[5, 10, 15, 20, 50, 100].map(p => (
            <button key={p} type="button" className={'chip chip-sm' + (value === p ? ' is-on' : '')} onClick={() => setValue(p)}>
              {p}%
            </button>
          ))}
          <input className="w-qty" type="number" min={1} max={100} aria-label="Phần trăm giảm" value={value ?? ''} onChange={e => setValue(Number(e.target.value) || null)} />
        </div>
      ) : (
        <MoneyInput label="Số tiền giảm" value={value} onChange={setValue} />
      )}
      <p className="field-label">Lý do</p>
      <div className="quick-cash">
        {DISCOUNT_REASONS.map(r => (
          <button key={r} type="button" className={'chip chip-sm' + (reason === r ? ' is-on' : '')} onClick={() => setReason(r)}>
            {r}
          </button>
        ))}
      </div>
      {reason === 'Khác' && <input aria-label="Lý do khác" maxLength={40} placeholder="Ghi rõ lý do" value={note} onChange={e => setNote(e.target.value)} />}
      {needPin && <p className="muted small">Giảm giá của thu ngân cần quản lý chọn tên và nhập mã PIN trên máy này.</p>}
      {err && <p className="field-error block">{err}</p>}
    </Sheet>
  )
}

function QrSheet(props: { floor: FloorState; order: Order; amount: number; memo: string; onClose: () => void; onPrint: () => void; onConfirm: () => void }) {
  const shop = props.floor.shop
  const payload = vietQr(shop, props.amount, props.memo)
  return (
    <Sheet
      title="Chuyển khoản VietQR"
      subtitle={`${orderTitle(props.floor, props.order)} · khách quét bằng app ngân hàng, MoMo hoặc ZaloPay`}
      onClose={props.onClose}
      foot={
        <>
          <button type="button" className="btn" onClick={props.onPrint} disabled={!payload}>
            🖨 In mã
          </button>
          <button type="button" className="btn btn-primary btn-grow" onClick={props.onConfirm} disabled={!payload}>
            <span>{formatVnd(props.amount)}</span>
            <b>Đã nhận tiền</b>
          </button>
        </>
      }
    >
      {payload ? (
        <div className="qr-step">
          <QrImage payload={payload} label={`VietQR ${formatVnd(props.amount)}`} />
          <dl className="qr-info">
            <div>
              <dt>Số tiền</dt>
              <dd className="qr-amount">{formatVnd(props.amount)}</dd>
            </div>
            <div>
              <dt>Nội dung</dt>
              <dd>
                <code>{props.memo}</code>
              </dd>
            </div>
            <div>
              <dt>Ngân hàng</dt>
              <dd>{shop.bankName}</dd>
            </div>
            <div>
              <dt>Số tài khoản</dt>
              <dd>{shop.bankAccount}</dd>
            </div>
            <div>
              <dt>Chủ tài khoản</dt>
              <dd>{shop.bankAccountName}</dd>
            </div>
          </dl>
          <p className="muted small">Mở app ngân hàng của quán, thấy tiền về đúng số và đúng nội dung rồi mới bấm “Đã nhận tiền”.</p>
          {shop.sample && <p className="warn-text small">Tài khoản mẫu: không chuyển tiền thật vào mã này.</p>}
        </div>
      ) : (
        <p className="field-error block">Chưa cài tài khoản nhận tiền của quán (ngân hàng, số tài khoản) hoặc số tiền bằng 0.</p>
      )}
    </Sheet>
  )
}

function PrebillSheet(props: { floor: FloorState; order: Order; blocks: ReturnType<typeof receiptBlocks>; onClose: () => void; onPrint: (b: ReturnType<typeof receiptBlocks>) => void }) {
  return (
    <Sheet
      title="Phiếu tạm tính"
      subtitle={`${orderTitle(props.floor, props.order)} · in lần ${props.order.billPrintCount + 1}`}
      onClose={props.onClose}
      foot={
        <button type="button" className="btn btn-primary btn-grow" onClick={() => props.onPrint(props.blocks)}>
          <span>80mm</span>
          <b>🖨 In tạm tính</b>
        </button>
      }
    >
      <ReceiptPreview blocks={props.blocks} title="Phiếu tạm tính" />
    </Sheet>
  )
}

/** Tách hoá đơn theo món: chosen lines (or part of a line) go to a new order on the same table, its own bill. */
function ItemSplitSheet(props: {
  floor: FloorState
  order: Order
  onClose: () => void
  onSplit: (inp: { items: { id: string; qty: number }[]; positionLabel: string; guestCount: number; sourceLabel?: string }) => void
}) {
  const { floor, order } = props
  const lines = floor.lines.filter(l => l.orderId === order.id && l.status !== 'void')
  const [qty, setQty] = useState<Record<string, number>>({})
  const [label, setLabel] = useState('Hoá đơn 2')
  const [src, setSrc] = useState(order.positionLabel || 'Hoá đơn 1')
  const [guests, setGuests] = useState(1)
  const picked = Object.entries(qty).filter(([, n]) => n > 0)
  const amount = picked.reduce((s, [id, n]) => s + (lines.find(l => l.id === id)?.price ?? 0) * n, 0)
  const all = picked.length === lines.length && picked.every(([id, n]) => lines.find(l => l.id === id)?.qty === n)
  return (
    <Sheet
      title="Tách hoá đơn theo món"
      subtitle="Món chọn sang hoá đơn mới cùng bàn, có số hoá đơn, giảm giá, VAT và QR riêng."
      onClose={props.onClose}
      foot={
        <button
          type="button"
          className="btn btn-primary btn-grow"
          disabled={!picked.length || all || !label.trim() || !src.trim() || guests < 1}
          onClick={() => props.onSplit({ items: picked.map(([id, n]) => ({ id, qty: n })), positionLabel: label, guestCount: guests, sourceLabel: src !== order.positionLabel ? src : undefined })}
        >
          <span>{picked.length ? formatVnd(amount) : 'Chọn món'}</span>
          <b>Tách sang hoá đơn mới</b>
        </button>
      }
    >
      <ul className="rows">
        {lines.map(l => {
          const n = qty[l.id] ?? 0
          return (
            <li key={l.id} className="picked-line">
              <span>
                {l.name}
                {l.variantName && ` (${l.variantName})`}
                <span className="muted small block">
                  {l.qty} × {formatMoney(l.price)}
                </span>
              </span>
              <span className="stepper">
                <button type="button" className="icon-btn" aria-label={`Bớt ${l.name}`} disabled={!n} onClick={() => setQty(q => ({ ...q, [l.id]: n - 1 }))}>
                  −
                </button>
                <b>{n}</b>
                <button type="button" className="icon-btn" aria-label={`Thêm ${l.name}`} disabled={n >= l.qty} onClick={() => setQty(q => ({ ...q, [l.id]: n + 1 }))}>
                  +
                </button>
              </span>
            </li>
          )
        })}
      </ul>
      {all && <p className="warn-text">Phải để lại ít nhất một món ở hoá đơn gốc.</p>}
      <label className="field">
        <span className="field-label">Tên hoá đơn gốc (vị trí ngồi)</span>
        <input maxLength={30} value={src} onChange={e => setSrc(e.target.value)} />
      </label>
      <label className="field">
        <span className="field-label">Tên hoá đơn mới</span>
        <input maxLength={30} value={label} onChange={e => setLabel(e.target.value)} />
      </label>
      <GuestPicker value={guests} onChange={setGuests} />
    </Sheet>
  )
}
