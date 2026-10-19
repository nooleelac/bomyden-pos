// #/don: every open order as a small card (Sapo style): strip with where it is (Tại bàn · khu, Mang về, Chờ thanh
// toán), the table number on the left, time seated and amount on the right. Tap = the order screen. Rail on the left: Tất cả / Tại bàn / Mang về / Chờ thanh toán.

import { useState } from 'react'
import { vnd } from '../../menu/picker'
import { isOpen, minutesText, orderAmount, orderLabel } from '../logic'
import type { FloorState, Order, Role } from '../types'

type Filter = 'all' | 'dine_in' | 'takeaway' | 'bill'

const stateOf = (o: Order) => (o.payingAt ? 'paying' : o.billRequestedAt ? 'bill' : 'open')
const STATE_LABEL = { bill: 'Chờ thanh toán', paying: 'Đang thanh toán' } as const

export function OrdersPage(props: { floor: FloorState; now: Date; role: Role }) {
  const { floor, now } = props
  const [filter, setFilter] = useState<Filter>('all')
  const open = floor.orders.filter(isOpen).sort((a, b) => a.openedAt.localeCompare(b.openedAt))
  const groups: { id: Filter; label: string; icon: string; list: Order[] }[] = [
    { id: 'all', label: 'Tất cả', icon: '▦', list: open },
    { id: 'dine_in', label: 'Tại bàn', icon: '🍽️', list: open.filter(o => o.kind !== 'takeaway') },
    { id: 'takeaway', label: 'Mang về', icon: '🥡', list: open.filter(o => o.kind === 'takeaway') },
    { id: 'bill', label: 'Chờ thanh toán', icon: '🧮', list: open.filter(o => stateOf(o) !== 'open') },
  ]
  const shown = groups.find(g => g.id === filter)!.list
  // the strip says where the order is: Chờ / Đang thanh toán, else Mang về or Tại bàn · khu vực
  const placeOf = (o: Order) => {
    const st = stateOf(o)
    if (st !== 'open') return STATE_LABEL[st]
    if (o.kind === 'takeaway') return 'Mang về'
    const area = floor.areas.find(a => a.id === floor.tables.find(t => t.id === o.tableId)?.areaId)
    return area ? `Tại bàn · ${area.name}` : 'Tại bàn'
  }

  return (
    <div className="floor screen">
      <div className="floor-body">
        <nav className="area-rail" aria-label="Lọc đơn">
          {groups.map(g => (
            <button key={g.id} type="button" className={'rail-item' + (filter === g.id ? ' is-on' : '')} onClick={() => setFilter(g.id)}>
              <span className="rail-icon" aria-hidden>
                {g.icon}
              </span>
              {g.label}
              {g.list.length > 0 && <span className="rail-count">{g.list.length}</span>}
            </button>
          ))}
        </nav>
        <div className="floor-main">
          {shown.length === 0 && <p className="empty">Không có đơn nào</p>}
          <ul className="order-cards">
            {shown.map(o => {
              const st = stateOf(o)
              return (
                <li key={o.id}>
                  <a className={`order-card st-${st}`} href={`#/ban/don/${o.id}`}>
                    <span className="order-card-head">
                      <span className="order-card-tag" aria-hidden>
                        {st !== 'open' ? '🧮' : o.kind === 'takeaway' ? '🥡' : '🍽️'}
                      </span>
                      {placeOf(o)}
                    </span>
                    <span className="order-card-body">
                      <b className="order-card-table">{orderLabel(floor, o)}</b>
                      <span className="order-card-side">
                        <span>⏱ {minutesText(now.getTime() - new Date(o.openedAt).getTime())}</span>
                        <span>💲 {vnd(orderAmount(floor, o.id))}</span>
                      </span>
                    </span>
                  </a>
                </li>
              )
            })}
          </ul>
        </div>
      </div>
      <a className="fab" href="#/ban">
        ＋ Tạo đơn
      </a>
    </div>
  )
}
