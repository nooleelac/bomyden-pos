// #/thu-ngan: orders waiting to be settled (Chờ thanh toán first), the open shift, and bills paid recently
// (tap to reprint).

import { formatVnd } from '../../lib/billing'
import { DEFAULT_REGISTER, quoteBill } from '../../floor/engine'
import { clock, formatDuration, isOpen, orderTitle } from '../../floor/logic'
import type { FloorState } from '../../floor/types'
import { billSummary } from '../bill'
import { openShiftOf, shiftSummary } from '../shift'

export function OrderList(props: { floor: FloorState; now: Date }) {
  const { floor, now } = props
  const shift = openShiftOf(floor.shifts, DEFAULT_REGISTER)
  const open = floor.orders
    .filter(o => isOpen(o) && floor.lines.some(l => l.orderId === o.id && l.status !== 'void'))
    .map(o => ({ o, total: quoteBill(floor, o.id).total }))
    .sort((a, b) => Number(!!b.o.payingAt) - Number(!!a.o.payingAt) || Number(!!b.o.billRequestedAt) - Number(!!a.o.billRequestedAt) || a.o.openedAt.localeCompare(b.o.openedAt))
  const bills = [...floor.bills].sort((a, b) => b.paidAt.localeCompare(a.paidAt)).slice(0, 30)
  const sum = shift ? shiftSummary(shift, floor.bills) : null

  return (
    <main className="cashier-main">
      <section className={'shift-strip' + (shift ? '' : ' is-closed')}>
        {shift && sum ? (
          <>
            <span>
              <b>Ca đang mở</b> · {shift.register} · {shift.openedBy} từ {clock(shift.openedAt)}
            </span>
            <span>
              {sum.bills} hoá đơn · {formatVnd(sum.sales)} · tiền mặt trong két dự kiến <b>{formatVnd(sum.expectedCash)}</b>
            </span>
            <a className="btn btn-small" href="#/ca">
              Chốt ca
            </a>
          </>
        ) : (
          <>
            <span>
              <b>Chưa mở ca.</b> Mở ca và nhập tiền đầu ca trước khi thu tiền.
            </span>
            <a className="btn btn-small btn-primary" href="#/ca">
              Mở ca
            </a>
          </>
        )}
      </section>

      <div className="cashier-cols">
        <section className="card">
          <div className="card-head">
            <h2>Đơn chờ thu tiền</h2>
            <span className="muted small">{open.length} đơn</span>
          </div>
          {!open.length && <p className="empty">Không có đơn nào đang mở.</p>}
          <ul className="pay-list">
            {open.map(({ o, total }) => (
              <li key={o.id}>
                <a href={`#/thu-ngan/${o.id}`} className="pay-pick">
                  <span>
                    <b>{orderTitle(floor, o)}</b>
                    <span className="muted small block">
                      {o.guestCount ? `${o.guestCount} khách · ` : ''}ngồi {formatDuration(now.getTime() - new Date(o.openedAt).getTime())}
                    </span>
                  </span>
                  <span className="pay-pick-side">
                    <b>{formatVnd(total)}</b>
                    {o.payingAt ? (
                      <span className="badge badge-paying">Đang thanh toán · {o.payingBy}</span>
                    ) : o.billRequestedAt ? (
                      <span className="badge badge-bill">Chờ thanh toán</span>
                    ) : (
                      <span className="badge">Đang ngồi</span>
                    )}
                  </span>
                </a>
              </li>
            ))}
          </ul>
        </section>

        <section className="card">
          <div className="card-head">
            <h2>Hoá đơn đã thu</h2>
            <span className="muted small">bấm để xem / in lại</span>
          </div>
          {!bills.length && <p className="empty">Chưa có hoá đơn.</p>}
          <ul className="pay-list">
            {bills.map(b => (
              <li key={b.id}>
                <a href={`#/thu-ngan/hd/${b.id}`} className="pay-pick">
                  <span>
                    <b>{billSummary(b)}</b>
                    <span className="muted small block">
                      {clock(b.paidAt)} · {b.cashier} · {b.payments.map(p => (p.method === 'cash' ? 'TM' : p.method === 'bank' ? 'CK' : 'Thẻ')).join(' + ')}
                    </span>
                  </span>
                  <span className="pay-pick-side">
                    {b.printCount > 1 && <span className="badge">in {b.printCount} lần</span>}
                    <span className="link">In lại ›</span>
                  </span>
                </a>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </main>
  )
}
