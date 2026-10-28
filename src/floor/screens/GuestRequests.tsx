// Khách gọi món qua QR (#/ban/khach): what guests sent from their table, oldest first. Nhận sends it to the kitchen
// on the table's order (opened if the table is free) as one round; Từ chối tells the guest why. Below: the last
// ones decided, so a second waiter sees who took which.

import { useState } from 'react'
import { describeLine, quoteLine, vnd } from '../../menu/picker'
import type { Menu } from '../../menu/types'
import { toPicker } from '../engine'
import { go } from '../hooks'
import { formatDuration, openOrdersAt, pendingGuests, tableName, tableTitle } from '../logic'
import type { FloorRepo } from '../repo'
import type { FloorState, GuestRequest } from '../types'
import { Sheet } from './Sheet'
import '../../guest/guest.css'

const REJECT_REASONS = ['Món đã hết', 'Bàn chưa có khách', 'Nhân viên sẽ tới tư vấn', 'Gửi trùng'] as const

export function GuestRequests(props: { floor: FloorState; menu: Menu; repo: FloorRepo; now: Date; onError: (m: string) => void; onInfo: (m: string) => void }) {
  const { floor, menu, repo, now } = props
  const [busy, setBusy] = useState<string | null>(null)
  const [rejecting, setRejecting] = useState<GuestRequest | null>(null)
  const pending = pendingGuests(floor)
  const decided = (floor.guestRequests ?? [])
    .filter(r => r.status !== 'pending' && r.decidedAt && now.getTime() - new Date(r.decidedAt).getTime() < 2 * 3600_000)
    .sort((a, b) => (b.decidedAt ?? '').localeCompare(a.decidedAt ?? ''))
  const title = (r: GuestRequest) => tableTitle(tableName(floor, r.tableId))
  const fail = (e: unknown) => props.onError(e instanceof Error ? e.message : String(e))

  const accept = (r: GuestRequest) => {
    setBusy(r.id)
    repo
      .acceptGuest(r.id)
      .then(orderId => {
        props.onInfo(`Đã gửi bếp món của ${title(r)}`)
        if (pendingGuests(floor).length <= 1) go(`ban/don/${orderId}`)
      }, fail)
      .finally(() => setBusy(null))
  }

  return (
    <main className="guest-requests">
      <header className="card-head">
        <h1>🙋 Khách gọi món qua QR</h1>
        <a className="btn btn-small" href="#/ban">
          ‹ Sơ đồ bàn
        </a>
      </header>
      {floor.settings.guestOrder === false && <p className="warn">Đang tắt gọi món qua QR (Cài đặt → Mã QR gọi món).</p>}
      {pending.length === 0 && <p className="muted">Không có yêu cầu nào đang chờ.</p>}
      {pending.map(r => {
        const rows = r.lines.map(l => {
          const item = menu.items.find(i => i.id === l.menu_item_id)
          const st = toPicker(l)
          return { l, item, st, q: item ? quoteLine(menu, item, st, now) : null }
        })
        const total = rows.reduce((t, x) => t + (x.q?.total ?? 0), 0)
        const bad = rows.filter(x => !x.q?.canAdd)
        const seated = openOrdersAt(floor, r.tableId).length > 0
        return (
          <section key={r.id} className="card guest-card">
            <header className="card-head">
              <h2>{title(r)}</h2>
              <span className="muted small">
                {formatDuration(now.getTime() - new Date(r.createdAt).getTime())} trước
                {r.guestCount ? ` · ${r.guestCount} người` : ''}
                {seated ? ' · bàn đang ngồi' : ' · bàn trống: Nhận sẽ mở bàn'}
              </span>
            </header>
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
              Tạm tính: <b>{vnd(total)}</b>
            </p>
            {bad.length > 0 && <p className="warn">⚠ {bad.length} món không gửi được: từ chối và báo khách, hoặc ra bàn gọi lại.</p>}
            <div className="btn-row">
              <button type="button" className="btn" disabled={busy === r.id} onClick={() => setRejecting(r)}>
                Từ chối
              </button>
              <button type="button" className="btn btn-primary btn-grow" disabled={busy === r.id || bad.length > 0} onClick={() => accept(r)}>
                <span>{busy === r.id ? 'Đang gửi…' : 'Nhận & gửi bếp'}</span>
                <b>{r.lines.reduce((n, l) => n + l.qty, 0)} món</b>
              </button>
            </div>
          </section>
        )
      })}

      {decided.length > 0 && (
        <section className="card">
          <h2>Đã xử lý (2 giờ qua)</h2>
          <ul className="rows">
            {decided.map(r => (
              <li key={r.id} className="guest-line">
                <span>
                  <b>
                    {title(r)}: {r.status === 'accepted' ? 'đã nhận' : 'từ chối'}
                  </b>
                  <span className="muted small">
                    {r.decidedBy}
                    {r.reason ? ` · ${r.reason}` : ''}
                  </span>
                </span>
                {r.orderId && <a href={`#/ban/don/${r.orderId}`}>Xem đơn ›</a>}
              </li>
            ))}
          </ul>
        </section>
      )}

      {rejecting && (
        <RejectSheet
          title={title(rejecting)}
          onClose={() => setRejecting(null)}
          onReject={reason =>
            repo.rejectGuest(rejecting.id, reason).then(() => {
              setRejecting(null)
              props.onInfo(`Đã báo ${title(rejecting)}: không nhận`)
            }, fail)
          }
        />
      )}
    </main>
  )
}

function RejectSheet(props: { title: string; onClose: () => void; onReject: (reason: string) => void }) {
  const [reason, setReason] = useState('')
  return (
    <Sheet
      title={`Từ chối yêu cầu ${props.title}`}
      subtitle="Khách thấy lý do này trên điện thoại"
      onClose={props.onClose}
      foot={
        <button type="button" className="btn btn-danger btn-grow" onClick={() => props.onReject(reason)}>
          <span>Từ chối</span>
        </button>
      }
    >
      <div className="chip-row">
        {REJECT_REASONS.map(x => (
          <button key={x} type="button" className={'chip' + (reason === x ? ' is-on' : '')} aria-pressed={reason === x} onClick={() => setReason(x)}>
            {x}
          </button>
        ))}
      </div>
      <label className="field">
        <span className="field-label">Hoặc ghi lý do</span>
        <input maxLength={80} value={reason} onChange={e => setReason(e.target.value)} />
      </label>
    </Sheet>
  )
}
