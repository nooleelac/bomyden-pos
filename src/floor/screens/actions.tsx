// Dialogs for the order actions: huỷ món (manager approval by PIN), huỷ cả đơn, chuyển bàn, gộp bàn, chuyển món, tách đơn, trả bớt / tách bàn khỏi nhóm.

import { useState } from 'react'
import { useAuth } from '../../auth/context'
import { vnd } from '../../menu/picker'
import { Stepper } from '../../menu/ui'
import type { VoidInput } from '../engine'
import { areaTables, groupLabel, openOrdersAt, orderAmount, orderLabel, orderTitle, tableName, tableTile, tableTitle } from '../logic'
import type { FloorRepo } from '../repo'
import { TABLE_STATE_LABEL, VOID_REASONS, type FloorState, type Line, type Order } from '../types'
import { GuestPicker, Sheet } from './Sheet'

export function VoidSheet(props: { line: Line; needsManager: boolean; onClose: () => void; onVoid: (inp: VoidInput) => void }) {
  const l = props.line
  const { requestApproval } = useAuth()
  const [qty, setQty] = useState(l.qty)
  const [reason, setReason] = useState('')
  const [note, setNote] = useState('')
  const ok = reason && (reason !== 'Khác' || note.trim())
  const title = `${qty < l.qty ? `Bớt ${qty}` : `Huỷ ${qty}`} ${l.name}${l.variantName ? ' – ' + l.variantName : ''}`
  const go = async () => {
    const inp: VoidInput = { qty, reason, reasonNote: note }
    if (props.needsManager) {
      const a = await requestApproval({ action: 'void_item', orderId: l.orderId, lineId: l.id, title, subtitle: `Lý do: ${reason === 'Khác' ? note.trim() : reason} · −${vnd(l.price * qty)}` })
      if (!a) return
      inp.approval = a.token
    }
    props.onVoid(inp)
  }
  return (
    <Sheet
      title={`Huỷ ${l.name}${l.variantName ? ' – ' + l.variantName : ''}`}
      subtitle={l.status === 'new' ? 'Bếp chưa làm: bếp nhận báo HUỶ ngay' : `Món đang ở bước: ${l.status === 'cooking' ? 'Đang làm' : l.status === 'ready' ? 'Xong' : 'Đã bưng'}`}
      onClose={props.onClose}
      foot={
        <>
          {l.qty > 1 && <Stepper label="số phần huỷ" min={1} max={l.qty} value={qty} onChange={setQty} />}
          <button type="button" className="btn btn-primary btn-grow" disabled={!ok} onClick={go}>
            <span>{props.needsManager ? '🔐 Quản lý duyệt' : qty < l.qty ? `Bớt ${qty}, còn ${l.qty - qty}` : `Huỷ ${qty} phần`}</span>
            <b>−{vnd(l.price * qty)}</b>
          </button>
        </>
      }
    >
      <fieldset className="pick-group">
        <legend>
          Lý do <span className="badge badge-req">Bắt buộc</span>
        </legend>
        <div className="chip-row">
          {VOID_REASONS.map(r => (
            <button key={r} type="button" className={'chip' + (reason === r ? ' is-on' : '')} aria-pressed={reason === r} onClick={() => setReason(r)}>
              {r}
            </button>
          ))}
        </div>
      </fieldset>
      <label className="field">
        <span className="field-label">Ghi thêm{reason === 'Khác' ? ' (bắt buộc)' : ''}</span>
        <input maxLength={60} value={note} onChange={e => setNote(e.target.value)} />
      </label>
      {props.needsManager && <p className="muted small">Món đã gửi bếp: quản lý chọn tên và nhập mã PIN trên máy này để duyệt (mã duyệt dùng một lần).</p>}
    </Sheet>
  )
}

/** Huỷ cả đơn đã gửi bếp: every live line, one reason, one manager approval. */
export function VoidOrderSheet(props: { floor: FloorState; order: Order; needsManager: boolean; onClose: () => void; onVoid: (inp: { reason: string; reasonNote?: string; approval?: string }) => void }) {
  const { floor, order } = props
  const { requestApproval } = useAuth()
  const [reason, setReason] = useState('')
  const [note, setNote] = useState('')
  const live = floor.lines.filter(l => l.orderId === order.id && l.status !== 'void')
  const amount = live.reduce((n, l) => n + l.price * l.qty, 0)
  const ok = reason && (reason !== 'Khác' || note.trim())
  const go = async () => {
    const inp: { reason: string; reasonNote?: string; approval?: string } = { reason, reasonNote: note }
    if (props.needsManager) {
      const a = await requestApproval({ action: 'void_order', orderId: order.id, title: `Huỷ cả đơn ${orderTitle(floor, order)}`, subtitle: `${live.length} món · −${vnd(amount)} · ${reason === 'Khác' ? note.trim() : reason}` })
      if (!a) return
      inp.approval = a.token
    }
    props.onVoid(inp)
  }
  return (
    <Sheet
      title={`Huỷ cả đơn ${orderTitle(floor, order)}`}
      subtitle={`${live.length} món đã gửi bếp bị huỷ, bếp nhận báo HUỶ, bàn được trả`}
      onClose={props.onClose}
      foot={
        <button type="button" className="btn btn-primary btn-grow" disabled={!ok} onClick={go}>
          <span>{props.needsManager ? '🔐 Quản lý duyệt' : 'Huỷ đơn'}</span>
          <b>−{vnd(amount)}</b>
        </button>
      }
    >
      <fieldset className="pick-group">
        <legend>
          Lý do <span className="badge badge-req">Bắt buộc</span>
        </legend>
        <div className="chip-row">
          {VOID_REASONS.map(r => (
            <button key={r} type="button" className={'chip' + (reason === r ? ' is-on' : '')} aria-pressed={reason === r} onClick={() => setReason(r)}>
              {r}
            </button>
          ))}
        </div>
      </fieldset>
      <label className="field">
        <span className="field-label">Ghi thêm{reason === 'Khác' ? ' (bắt buộc)' : ''}</span>
        <input maxLength={60} value={note} onChange={e => setNote(e.target.value)} />
      </label>
    </Sheet>
  )
}

/** Chuyển bàn: free table = move; occupied = gộp vào đơn (tính chung) or thành đơn ghép (tính riêng). */
export function MoveTableSheet(props: { floor: FloorState; order: Order; now: Date; repo: FloorRepo; onClose: () => void; onDone: (orderId: string) => void; onError: (e: unknown) => void }) {
  const { floor, order, repo } = props
  const [from, setFrom] = useState(order.tableId!)
  const [to, setTo] = useState<string | null>(null)
  const [label, setLabel] = useState(order.positionLabel)
  const [labels, setLabels] = useState<Record<string, string>>({})
  const areas = [...floor.areas].sort((a, b) => a.sort - b.sort)
  const target = to ? floor.tables.find(t => t.id === to) : null
  const busy = to ? openOrdersAt(floor, to) : []
  return (
    <Sheet title={`Chuyển ${tableTitle(orderLabel(floor, order))}`} subtitle="Món đang làm đi theo khách, giờ ngồi giữ nguyên" onClose={props.onClose}>
      {order.tables.length > 1 && (
        <label className="field">
          <span className="field-label">Đổi bàn nào trong nhóm</span>
          <select value={from} onChange={e => setFrom(e.target.value)}>
            {order.tables.map(t => (
              <option key={t.tableId} value={t.tableId}>
                Bàn {tableName(floor, t.tableId)}
              </option>
            ))}
          </select>
        </label>
      )}
      {!target &&
        areas.map(a => (
          <div key={a.id}>
            <h3 className="small muted">{a.name}</h3>
            <div className="chip-row">
              {areaTables(floor, a.id)
                .filter(t => !order.tables.some(x => x.tableId === t.id))
                .map(t => {
                  const st = tableTile(floor, t, props.now).state
                  return (
                    <button key={t.id} type="button" className={`chip table-chip st-${st}`} disabled={st === 'closed' || st === 'paying'} onClick={() => setTo(t.id)}>
                      {t.name} <small>{TABLE_STATE_LABEL[st]}</small>
                    </button>
                  )
                })}
            </div>
          </div>
        ))}
      {target && busy.length === 0 && (
        <div className="action-grid">
          <p>
            Chuyển sang bàn <b>{target.name}</b> (đang trống).
          </p>
          <button type="button" className="btn btn-primary" onClick={() => repo.moveOrder({ orderId: order.id, toTableId: target.id, fromTableId: from }).then(() => props.onDone(order.id), props.onError)}>
            Chuyển bàn
          </button>
          <button type="button" className="btn" onClick={() => setTo(null)}>
            Chọn bàn khác
          </button>
        </div>
      )}
      {target && busy.length > 0 && (
        <div className="action-grid">
          <p>
            Bàn <b>{target.name}</b> đang có khách.
          </p>
          {busy.map(b => (
            <button key={b.id} type="button" className="btn" onClick={() => repo.mergeOrders(b.id, [order.id]).then(() => props.onDone(b.id), props.onError)}>
              Gộp vào đơn {orderTitle(floor, b)} (tính chung)
            </button>
          ))}
          {busy
            .filter(b => !b.positionLabel)
            .map(b => (
              <label key={b.id} className="field">
                <span className="field-label">Vị trí ngồi của đơn {orderLabel(floor, b)}</span>
                <input maxLength={30} placeholder="VD: đầu bàn" value={labels[b.id] ?? ''} onChange={e => setLabels(p => ({ ...p, [b.id]: e.target.value }))} />
              </label>
            ))}
          <label className="field">
            <span className="field-label">Vị trí ngồi của đơn này</span>
            <input maxLength={30} placeholder="VD: cuối bàn" value={label} onChange={e => setLabel(e.target.value)} />
          </label>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!label.trim() || busy.some(b => !b.positionLabel && !labels[b.id]?.trim())}
            onClick={() => repo.moveOrder({ orderId: order.id, toTableId: target.id, fromTableId: from, mode: 'shared', positionLabel: label, existingLabels: labels }).then(() => props.onDone(order.id), props.onError)}
          >
            Thành đơn ghép (tính riêng)
          </button>
          <button type="button" className="btn" onClick={() => setTo(null)}>
            Chọn bàn khác
          </button>
        </div>
      )}
    </Sheet>
  )
}

/** Gộp bàn: this order is the main one; chosen orders fold into it. Lines keep their delivery table. */
export function MergeSheet(props: { floor: FloorState; order: Order; onClose: () => void; onMerge: (ids: string[]) => void }) {
  const { floor, order } = props
  const [ids, setIds] = useState<string[]>([])
  const others = floor.orders.filter(o => o.status === 'open' && o.kind === 'dine_in' && o.id !== order.id && !o.payingAt)
  const n = new Set([...order.tables.map(t => t.tableId), ...others.filter(o => ids.includes(o.id)).flatMap(o => o.tables.map(t => t.tableId))]).size
  return (
    <Sheet
      title={`Gộp vào ${tableTitle(orderLabel(floor, order))}`}
      subtitle="Bàn chính là đơn này. Món đã gửi giữ nguyên trạng thái, không in lại phiếu."
      onClose={props.onClose}
      foot={
        <button type="button" className="btn btn-primary btn-grow" disabled={!ids.length} onClick={() => props.onMerge(ids)}>
          <span>Gộp {ids.length} đơn</span>
          <b>{n} bàn</b>
        </button>
      }
    >
      {others.length === 0 && <p className="muted">Không có đơn tại bàn nào khác đang mở.</p>}
      <ul className="rows">
        {others.map(o => (
          <li key={o.id}>
            <label className="check-line">
              <input type="checkbox" checked={ids.includes(o.id)} onChange={e => setIds(p => (e.target.checked ? [...p, o.id] : p.filter(x => x !== o.id)))} />
              <span>
                <b>{orderTitle(floor, o)}</b> <span className="muted small">{groupLabel(floor, o)}</span>
                <span className="muted small block">
                  {o.guestCount} khách · {vnd(orderAmount(floor, o.id))}
                </span>
              </span>
            </label>
          </li>
        ))}
      </ul>
    </Sheet>
  )
}

function PickedLines(props: { floor: FloorState; picked: Record<string, number>; qty: Record<string, number>; setQty: (id: string, n: number) => void }) {
  return (
    <ul className="rows">
      {Object.keys(props.picked).map(id => {
        const l = props.floor.lines.find(x => x.id === id)
        if (!l) return null
        return (
          <li key={id} className="picked-line">
            <span>
              {l.name}
              {l.variantName && ` – ${l.variantName}`} <span className="muted small">/ {l.qty}</span>
            </span>
            {l.qty > 1 ? <Stepper label={`số phần ${l.name}`} min={1} max={l.qty} value={props.qty[id]} onChange={n => props.setQty(id, n)} /> : <b>1</b>}
          </li>
        )
      })}
    </ul>
  )
}

export function MoveItemsSheet(props: { floor: FloorState; order: Order; picked: Record<string, number>; onClose: () => void; onMove: (items: { id: string; qty: number }[], target: string) => void }) {
  const { floor, order } = props
  const [qty, setQtyState] = useState(props.picked)
  const [target, setTarget] = useState('')
  const targets = floor.orders.filter(o => o.status === 'open' && o.id !== order.id && !o.payingAt)
  return (
    <Sheet
      title="Chuyển món"
      subtitle="Món mang theo nguyên giá, size, tuỳ chọn và ghi chú"
      onClose={props.onClose}
      foot={
        <button type="button" className="btn btn-primary btn-grow" disabled={!target} onClick={() => props.onMove(Object.entries(qty).map(([id, n]) => ({ id, qty: n })), target)}>
          <span>Chuyển sang {target ? orderTitle(floor, floor.orders.find(o => o.id === target)!) : '…'}</span>
        </button>
      }
    >
      <PickedLines floor={floor} picked={props.picked} qty={qty} setQty={(id, n) => setQtyState(p => ({ ...p, [id]: n }))} />
      <label className="field">
        <span className="field-label">Đơn nhận</span>
        <select value={target} onChange={e => setTarget(e.target.value)}>
          <option value="">Chọn đơn đang mở…</option>
          {targets.map(o => (
            <option key={o.id} value={o.id}>
              {orderTitle(floor, o)}
            </option>
          ))}
        </select>
        <span className="field-hint">Bàn trống: mở bàn trên sơ đồ trước rồi chuyển món sang.</span>
      </label>
    </Sheet>
  )
}

export function SplitSheet(props: {
  floor: FloorState
  order: Order
  picked: Record<string, number>
  onClose: () => void
  onSplit: (inp: { items: { id: string; qty: number }[]; positionLabel: string; guestCount: number; sourceLabel?: string }) => void
}) {
  const { floor, order } = props
  const [qty, setQtyState] = useState(props.picked)
  const [label, setLabel] = useState('')
  const [src, setSrc] = useState(order.positionLabel)
  const [guests, setGuests] = useState(0)
  const ok = label.trim() && src.trim() && guests >= 1
  return (
    <Sheet
      title={`Tách đơn ${tableTitle(orderLabel(floor, order))}`}
      subtitle="Món chọn sang đơn mới cùng bàn, thanh toán riêng. Bếp vẫn làm bình thường."
      onClose={props.onClose}
      foot={
        <button
          type="button"
          className="btn btn-primary btn-grow"
          disabled={!ok}
          onClick={() => props.onSplit({ items: Object.entries(qty).map(([id, n]) => ({ id, qty: n })), positionLabel: label, guestCount: guests, sourceLabel: src !== order.positionLabel ? src : undefined })}
        >
          <span>Tách sang đơn mới</span>
        </button>
      }
    >
      <PickedLines floor={floor} picked={props.picked} qty={qty} setQty={(id, n) => setQtyState(p => ({ ...p, [id]: n }))} />
      <label className="field">
        <span className="field-label">Vị trí ngồi của đơn gốc</span>
        <input maxLength={30} placeholder="VD: nhóm A" value={src} onChange={e => setSrc(e.target.value)} />
      </label>
      <label className="field">
        <span className="field-label">Vị trí ngồi của đơn mới</span>
        <input maxLength={30} placeholder="VD: nhóm B" value={label} onChange={e => setLabel(e.target.value)} />
      </label>
      <GuestPicker value={guests} onChange={setGuests} />
    </Sheet>
  )
}

/** Trả bớt bàn (no dish left for it) or tách một bàn khỏi nhóm (its dishes go back to an order of its own). */
export function ReleaseSheet(props: { floor: FloorState; order: Order; cashier: boolean; repo: FloorRepo; onClose: () => void; onError: (e: unknown) => void }) {
  const { floor, order, repo } = props
  const [splitTable, setSplitTable] = useState<string | null>(null)
  const [guests, setGuests] = useState(0)
  return (
    <Sheet title="Trả bớt / tách bàn" subtitle={groupLabel(floor, order)} onClose={props.onClose}>
      {!splitTable && (
        <ul className="rows">
          {order.tables.map(t => {
            const pending = floor.lines.filter(l => l.orderId === order.id && l.deliveryTableId === t.tableId && ['new', 'cooking', 'ready'].includes(l.status)).length
            return (
              <li key={t.tableId} className="picked-line">
                <span>
                  <b>Bàn {tableName(floor, t.tableId)}</b>
                  {t.tableId === order.tableId && <span className="badge">bàn chính</span>}
                  <span className="muted small block">{pending ? `${pending} món chưa ra` : 'không còn món chờ ra'}</span>
                </span>
                <span className="btn-pair">
                  <button type="button" className="btn btn-small" disabled={pending > 0} onClick={() => repo.releaseTable(order.id, t.tableId).then(props.onClose, props.onError)}>
                    Trả bàn
                  </button>
                  {props.cashier && (
                    <button type="button" className="btn btn-small" onClick={() => setSplitTable(t.tableId)}>
                      Tách riêng
                    </button>
                  )}
                </span>
              </li>
            )
          })}
        </ul>
      )}
      {splitTable && (
        <>
          <p>
            Món ra bàn {tableName(floor, splitTable)} quay về một đơn riêng của bàn đó. Số khách của bàn {tableName(floor, splitTable)}:
          </p>
          <GuestPicker value={guests} onChange={setGuests} />
          <button
            type="button"
            className="btn btn-primary"
            disabled={guests < 1}
            onClick={() => repo.splitTableFromGroup({ orderId: order.id, tableId: splitTable, guestCount: guests }).then(props.onClose, props.onError)}
          >
            Tách bàn {tableName(floor, splitTable)} khỏi nhóm
          </button>
        </>
      )}
    </Sheet>
  )
}
