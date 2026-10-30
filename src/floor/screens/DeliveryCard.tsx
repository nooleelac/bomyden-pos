// Giao tới đâu: who an online order is for, shown wherever staff look at it after Nhận (the order screen, Đơn online,
// the paid bill).

import { useState } from 'react'
import { carrierLabel, deliveryMapLink, onlineCode } from '../../lib/ship'
import { vnd } from '../../menu/picker'
import type { OnlineOrder } from '../types'
import '../floor.css'

export function DeliveryCard(props: { order: OnlineOrder }) {
  const { order: r } = props
  const [copied, setCopied] = useState(false)
  const copy = () => navigator.clipboard?.writeText(r.address).then(() => setCopied(true), () => undefined)
  return (
    <section className="delivery-card" aria-label="Thông tin giao hàng">
      <p>
        <b>🛵 Giao cho {r.customerName}</b> <span className="muted small">· {onlineCode(r.id)}</span>
      </p>
      <p>
        📞 <a href={`tel:${r.phone}`}>{r.phone}</a>
      </p>
      <p>📍 {r.address}</p>
      {r.note && <p>📝 {r.note}</p>}
      <p className="muted small">
        {r.shipFee != null ? `Ship ${vnd(r.shipFee)}${r.carrier ? ` (${carrierLabel(r.carrier)})` : ''} · ` : ''}
        {r.payMethod === 'cod' ? 'Tiền mặt khi nhận' : 'Chuyển khoản'}
      </p>
      <div className="btn-pair">
        <button type="button" className="btn btn-small" onClick={copy}>
          {copied ? 'Đã chép' : 'Chép địa chỉ'}
        </button>
        <a className="btn btn-small" href={deliveryMapLink(r)} target="_blank" rel="noreferrer">
          Xem bản đồ
        </a>
      </div>
    </section>
  )
}
