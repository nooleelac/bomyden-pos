// The bell: what staff did on any device (mở bàn, gửi bếp, món xong, huỷ món, giục, gọi tính tiền, thu tiền), newest
// first, built from the live floor state, so every device shows the same list without a separate table.

import { vnd } from '../menu/picker'
import { orderTitle, tableTitle } from './logic'
import type { FloorState } from './types'

export type EventKind = 'open' | 'send' | 'ready' | 'void' | 'chase' | 'bill' | 'paid'

export interface FloorEvent {
  id: string
  kind: EventKind
  at: string
  /** Who did it ('' when the kitchen screen did it without a name). */
  by: string
  text: string
  /** Where tapping the notification goes. */
  href: string
}

export const EVENT_ICON: Record<EventKind, string> = { open: '🍽️', send: '🧾', ready: '✅', void: '❌', chase: '⏰', bill: '🧮', paid: '💵' }

/** Events of the last `hours` hours, newest first, at most `max`. */
export function floorEvents(s: FloorState, now: Date, hours = 12, max = 60): FloorEvent[] {
  const since = now.getTime() - hours * 3600_000
  const recent = (iso: string | null | undefined): iso is string => !!iso && new Date(iso).getTime() >= since
  const orders = new Map(s.orders.map(o => [o.id, o]))
  const title = (orderId: string) => {
    const o = orders.get(orderId)
    return o ? orderTitle(s, o) : 'Đơn'
  }
  const ev: FloorEvent[] = []

  for (const o of s.orders) {
    const href = `#/ban/don/${o.id}`
    if (recent(o.openedAt)) ev.push({ id: `open-${o.id}`, kind: 'open', at: o.openedAt, by: o.openedBy, text: o.kind === 'takeaway' ? `tạo đơn ${title(o.id)}` : `mở ${title(o.id)}`, href })
    if (recent(o.billRequestedAt)) ev.push({ id: `bill-${o.id}-${o.billRequestedAt}`, kind: 'bill', at: o.billRequestedAt, by: '', text: `${title(o.id)} gọi tính tiền`, href: `#/thu-ngan/${o.id}` })
  }

  // one "gửi bếp" per send batch and order
  const batches = new Map<string, { at: string; by: string; orderId: string; qty: number; round: number }>()
  for (const l of s.lines) {
    if (!recent(l.sentAt)) continue
    const k = `${l.sendBatch}|${l.originOrderId}`
    const b = batches.get(k) ?? { at: l.sentAt, by: l.sentBy, orderId: l.orderId, qty: 0, round: l.round }
    b.qty += l.qty
    batches.set(k, b)
  }
  for (const [k, b] of batches) ev.push({ id: `send-${k}`, kind: 'send', at: b.at, by: b.by, text: `gửi bếp ${title(b.orderId)}: ${b.qty} món (lượt ${b.round})`, href: `#/ban/don/${b.orderId}` })

  // dishes done, grouped by order and minute
  const ready = new Map<string, { at: string; orderId: string; names: string[] }>()
  for (const l of s.lines) {
    if (!recent(l.readyAt) || l.status === 'void' || l.replacedBy) continue
    const k = `${l.orderId}|${l.readyAt.slice(0, 16)}`
    const r = ready.get(k) ?? { at: l.readyAt, orderId: l.orderId, names: [] }
    r.names.push(`${l.qty} ${l.name}${l.variantName ? ' ' + l.variantName : ''}`)
    if (l.readyAt > r.at) r.at = l.readyAt
    ready.set(k, r)
  }
  for (const [k, r] of ready) ev.push({ id: `ready-${k}`, kind: 'ready', at: r.at, by: '', text: `${title(r.orderId)}: xong ${r.names.join(', ')}`, href: `#/ban/don/${r.orderId}` })

  for (const l of s.lines) {
    if (recent(l.voidedAt) && !l.replacedBy) ev.push({ id: `void-${l.id}`, kind: 'void', at: l.voidedAt, by: '', text: `huỷ ${l.qty} ${l.name} · ${title(l.orderId)}${l.voidReason ? ` (${l.voidReason})` : ''}`, href: `#/ban/don/${l.orderId}` })
  }
  for (const n of s.notices) {
    if (n.kind === 'chase' && recent(n.createdAt)) ev.push({ id: `chase-${n.id}`, kind: 'chase', at: n.createdAt, by: n.createdBy, text: `giục món ${title(n.orderId)}`, href: `#/ban/don/${n.orderId}` })
  }
  for (const b of s.bills) {
    if (recent(b.paidAt)) ev.push({ id: `paid-${b.id}`, kind: 'paid', at: b.paidAt, by: b.cashier, text: `thu ${vnd(b.total)} ${tableTitle(b.tableLabel)} (${b.billNo})`, href: `#/thu-ngan/hd/${b.id}` })
  }

  return ev.sort((a, b) => b.at.localeCompare(a.at)).slice(0, max)
}
