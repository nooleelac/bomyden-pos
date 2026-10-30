// Đơn online (the rail item of Sơ đồ bàn and Đơn; #/ban/online opens it): what guests sent from the web page, oldest
// first. Staff look up the fee in Grab, Be or Xanh SM and Báo phí; once the guest agrees (and a transfer has arrived)
// Nhận & gửi bếp puts the lines on a takeaway order. The delivery itself is booked in the carrier's app.

import { useState } from 'react'
import { CARRIERS, carrierLabel, deliveryMapLink, onlineCode, type Carrier } from '../../lib/ship'
import { describeLine, quoteLine, vnd } from '../../menu/picker'
import type { Menu } from '../../menu/types'
import { toPicker } from '../engine'
import { formatDuration } from '../logic'
import type { FloorRepo } from '../repo'
import type { FloorState, OnlineOrder } from '../types'
import { DeliveryCard } from './DeliveryCard'
import { RejectSheet } from './GuestRequests'
import '../../guest/guest.css'

const REJECT_REASONS = ['Món đã hết', 'Ngoài phạm vi giao', 'Quán đang quá đông', 'Không gọi được cho khách']

const WAITING = ['pending', 'quoted', 'agreed']

export function OnlineOrders(props: { floor: FloorState; menu: Menu; repo: FloorRepo; now: Date; onError: (m: string) => void; onInfo: (m: string) => void }) {
  const { floor, repo } = props
  const [rejecting, setRejecting] = useState<OnlineOrder | null>(null)
  const all = floor.onlineOrders ?? []
  const open = all.filter(r => WAITING.includes(r.status)).sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  const decided = all
    .filter(r => !WAITING.includes(r.status) && r.decidedAt)
    .sort((a, b) => (b.decidedAt ?? '').localeCompare(a.decidedAt ?? ''))
  const fail = (e: unknown) => props.onError(e instanceof Error ? e.message : String(e))

  return (
    <div className="guest-requests">
      <h2 className="section-head">
        <span>🛵 Đơn online</span>
      </h2>
      {floor.settings.onlineOrder === false && (
        <p className="warn">
          Đang tắt nhận đơn online (<a href="#/cai-dat/dat-hang">Cài đặt → Đặt hàng online</a>).
        </p>
      )}
      {open.length === 0 && <p className="muted">Không có đơn nào đang chờ.</p>}
      {open.map(r => (
        <OnlineCard key={r.id} order={r} {...props} onReject={() => setRejecting(r)} />
      ))}

      {decided.length > 0 && (
        <section className="card">
          <h2>Đã xử lý gần đây</h2>
          <p className="muted small">Đơn đã thu tiền: xem lại địa chỉ ở Hoá đơn.</p>
          <ul className="rows">
            {decided.map(r => (
              <li key={r.id} className="online-done">
                {r.status === 'accepted' && <DeliveryCard order={r} />}
                <div className="guest-line">
                  <span>
                    <b>
                      {r.customerName}: {r.status === 'accepted' ? 'đã nhận' : r.status === 'cancelled' ? 'khách huỷ' : 'từ chối'}
                    </b>
                    <span className="muted small">{[onlineCode(r.id), r.decidedBy, r.reason].filter(Boolean).join(' · ')}</span>
                  </span>
                  {r.orderId && <a href={`#/ban/don/${r.orderId}`}>Xem đơn ›</a>}
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {rejecting && (
        <RejectSheet
          title={rejecting.customerName}
          reasons={REJECT_REASONS}
          onClose={() => setRejecting(null)}
          onReject={reason =>
            repo.rejectOnline(rejecting.id, reason).then(() => {
              setRejecting(null)
              props.onInfo(`Đã báo ${rejecting.customerName}: không nhận đơn`)
            }, fail)
          }
        />
      )}
    </div>
  )
}

function OnlineCard(props: { order: OnlineOrder; menu: Menu; repo: FloorRepo; now: Date; onReject: () => void; onError: (m: string) => void; onInfo: (m: string) => void }) {
  const { order: r, menu, repo, now } = props
  const [fee, setFee] = useState(String(r.shipFee ?? r.shipEstimate ?? ''))
  const [carrier, setCarrier] = useState<Carrier | ''>(r.carrier)
  const [busy, setBusy] = useState(false)
  const rows = r.lines.map(l => {
    const item = menu.items.find(i => i.id === l.menu_item_id)
    const st = toPicker(l)
    return { l, item, st, q: item ? quoteLine(menu, item, st, now) : null }
  })
  const total = rows.reduce((t, x) => t + (x.q?.total ?? 0), 0)
  const bad = rows.filter(x => !x.q?.canAdd)
  const fail = (e: unknown) => props.onError(e instanceof Error ? e.message : String(e))
  const run = (p: Promise<unknown>) => p.catch(fail).finally(() => setBusy(false))

  const quote = () => {
    const n = Number(fee)
    if (fee.trim() === '' || !Number.isInteger(n)) return props.onError('Nhập phí ship bằng số, VD 25000')
    if (!carrier) return props.onError('Chọn hãng giao hàng')
    setBusy(true)
    void run(repo.quoteOnline(r.id, { fee: n, carrier, foodTotal: total }).then(() => props.onInfo(`Đã báo phí ship cho ${r.customerName}`)))
  }
  const accept = () => {
    setBusy(true)
    void run(repo.acceptOnline(r.id).then(() => props.onInfo(`Đã gửi bếp đơn của ${r.customerName}`)))
  }
  const copy = () =>
    navigator.clipboard?.writeText(r.address).then(() => props.onInfo('Đã chép địa chỉ: dán vào app giao hàng'), () => props.onError('Không chép được: giữ vào địa chỉ để chép'))

  return (
    <section className="card guest-card">
      <header className="card-head">
        <h2>
          {r.customerName} · {onlineCode(r.id)}
        </h2>
        <span className="muted small">
          {formatDuration(now.getTime() - new Date(r.createdAt).getTime())} trước · {r.payMethod === 'cod' ? 'Tiền mặt khi nhận' : 'Chuyển khoản'}
        </span>
      </header>
      <p>
        📞 <a href={`tel:${r.phone}`}>{r.phone}</a>
      </p>
      <p>📍 {r.address}</p>
      <div className="btn-pair">
        <button type="button" className="btn btn-small" onClick={copy}>
          Chép địa chỉ
        </button>
        <a className="btn btn-small" href={deliveryMapLink(r)} target="_blank" rel="noreferrer">
          Xem bản đồ
        </a>
      </div>
      <ul className="rows">
        {rows.map(({ l, item, st, q }, i) => (
          <li key={i} className={'guest-line' + (q?.canAdd ? '' : ' is-bad')}>
            <span>
              <b>
                {l.qty} × {item?.name ?? 'Món không còn trên thực đơn'}
              </b>
              {item && <span className="muted small">{describeLine(menu, item, st)}</span>}
              {q && !q.canAdd && <span className="field-error">{q.issues.find(x => x.level === 'error')?.message}</span>}
            </span>
            <span>{q?.total != null ? vnd(q.total) : '—'}</span>
          </li>
        ))}
      </ul>
      {r.note && <p className="guest-note">📝 {r.note}</p>}
      <p className="guest-total">
        Tiền món: <b>{vnd(total)}</b>
      </p>
      {bad.length > 0 && <p className="warn">⚠ {bad.length} món không làm được: từ chối và báo khách.</p>}

      {r.status !== 'agreed' ? (
        <>
          <p className="muted small">
            {r.shipEstimate != null ? `Tạm tính theo bảng giá: ${vnd(r.shipEstimate)}${r.distanceM != null ? ` (${(r.distanceM / 1000).toFixed(1)} km đường chim bay)` : ''}. ` : 'Khách không gửi vị trí. '}
            Tra phí thật trên app giao hàng rồi nhập vào đây.
          </p>
          <div className="chip-row">
            {CARRIERS.map(c => (
              <button key={c.id} type="button" className={'chip' + (carrier === c.id ? ' is-on' : '')} aria-pressed={carrier === c.id} onClick={() => setCarrier(c.id)}>
                {c.label}
              </button>
            ))}
          </div>
          <label className="field">
            <span className="field-label">Phí ship báo khách (đồng)</span>
            <input type="number" inputMode="numeric" min={0} step={1000} value={fee} onChange={e => setFee(e.target.value)} />
          </label>
          {r.status === 'quoted' && <p className="muted small">Đã báo {vnd(r.shipFee ?? 0)} ({carrierLabel(r.carrier)}): đang chờ khách đồng ý. Báo lại nếu phí đổi.</p>}
          <div className="btn-row">
            <button type="button" className="btn" disabled={busy} onClick={props.onReject}>
              Từ chối
            </button>
            <button type="button" className="btn btn-primary btn-grow" disabled={busy || bad.length > 0} onClick={quote}>
              <span>{busy ? 'Đang gửi…' : r.status === 'quoted' ? 'Báo lại phí ship' : 'Báo phí cho khách'}</span>
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="guest-total">
            Khách đã đồng ý ship {vnd(r.shipFee ?? 0)} ({carrierLabel(r.carrier)}): <b>{vnd((r.foodTotal ?? 0) + (r.shipFee ?? 0))}</b>
          </p>
          {r.payMethod === 'transfer' && (
            <p className="warn">
              Kiểm tra tiền vào tài khoản, nội dung <b>BMD {onlineCode(r.id)}</b>, rồi mới nhận đơn.
            </p>
          )}
          <div className="btn-row">
            <button type="button" className="btn" disabled={busy} onClick={props.onReject}>
              Từ chối
            </button>
            <button type="button" className="btn btn-primary btn-grow" disabled={busy || bad.length > 0} onClick={accept}>
              <span>{busy ? 'Đang gửi…' : r.payMethod === 'transfer' ? 'Đã nhận tiền, gửi bếp' : 'Nhận & gửi bếp'}</span>
            </button>
          </div>
        </>
      )}
    </section>
  )
}
