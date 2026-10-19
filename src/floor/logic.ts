// Read-side rules shared by the floor map, the order screen and the kitchen display: labels (5, 5-A, 5-B,
// nhóm gộp 3+4+5), table states, kitchen tickets, timers. Pure functions over FloorState.
// The same labels come from order_table_label / order_group_label in SQL (0002).

import type { Menu } from '../menu/types'
import type { FloorState, Line, LineStatus, Notice, Order, StationTiming, Table, TableState } from './types'

// ---------------------------------------------------------------- labels

export const isOpen = (o: Order) => o.status === 'open'

export function openOrdersAt(s: FloorState, tableId: string): Order[] {
  return s.orders
    .filter(o => isOpen(o) && o.tables.some(t => t.tableId === tableId))
    .sort((a, b) => suffixOf(a, tableId).localeCompare(suffixOf(b, tableId)))
}

function suffixOf(o: Order, tableId: string): string {
  return o.tables.find(t => t.tableId === tableId)?.suffix ?? 'A'
}

export function tableName(s: FloorState, tableId: string | null): string {
  return s.tables.find(t => t.id === tableId)?.name ?? '?'
}

/** "MV-07" */
export function takeawayLabel(no: number | null): string {
  return 'MV-' + String(no ?? 0).padStart(2, '0')
}

/** '5' alone; '5-A', '5-B' once the table holds several open orders (or this order is not the first). */
export function orderLabel(s: FloorState, o: Order, tableId: string | null = o.tableId): string {
  if (o.kind === 'takeaway') return takeawayLabel(o.takeawayNo)
  if (!tableId) return '?'
  const name = tableName(s, tableId)
  const ot = o.tables.find(t => t.tableId === tableId)
  if (!ot) return name
  const shared = isOpen(o) && s.orders.some(x => x.id !== o.id && isOpen(x) && x.tables.some(t => t.tableId === tableId))
  return ot.suffix !== 'A' || shared ? `${name}-${ot.suffix}` : name
}

/** 'nhóm gộp 3+4+5' while the order spans several tables, else ''. */
export function groupLabel(s: FloorState, o: Order): string {
  if (o.tables.length < 2) return ''
  const names = o.tables
    .map(t => s.tables.find(x => x.id === t.tableId))
    .filter((t): t is Table => !!t)
    .sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name, 'vi', { numeric: true }))
    .map(t => t.name)
  return 'nhóm gộp ' + names.join('+')
}

/** "Bàn 5-B" for numbered tables, the name as is otherwise ("VIP 1", "MV-03"). */
export function tableTitle(label: string): string {
  return /^\d/.test(label) ? `Bàn ${label}` : label
}

/** Full label of an order for lists: "Bàn 5-B · đầu bàn" / "MV-03 · chị Lan". */
export function orderTitle(s: FloorState, o: Order): string {
  const base = tableTitle(orderLabel(s, o))
  const extra = o.kind === 'takeaway' ? o.customerName : o.positionLabel
  return extra ? `${base} · ${extra}` : base
}

// ---------------------------------------------------------------- money and time

export const liveLines = (s: FloorState, orderId: string) => s.lines.filter(l => l.orderId === orderId && l.status !== 'void')

export function orderAmount(s: FloorState, orderId: string): number {
  return liveLines(s, orderId).reduce((sum, l) => sum + l.price * l.qty, 0)
}

/** "1g25p", "12p", "0p" */
export function formatDuration(ms: number): string {
  const m = Math.max(0, Math.floor(ms / 60_000))
  if (m < 60) return `${m}p`
  return `${Math.floor(m / 60)}g${String(m % 60).padStart(2, '0')}p`
}

/** "19:42" in Vietnam time. */
export function clock(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(new Date(iso).getTime() + 7 * 3600_000)
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
}

export const DEFAULT_TIMING: StationTiming = { warn: 10, late: 15 }

export function timingFor(s: FloorState, stationId: string): StationTiming {
  return s.settings.timing[stationId] ?? DEFAULT_TIMING
}

export type Heat = 'ok' | 'warn' | 'late'

export function heat(elapsedMs: number, t: StationTiming): Heat {
  const m = elapsedMs / 60_000
  return m >= t.late ? 'late' : m >= t.warn ? 'warn' : 'ok'
}

const UNFINISHED = new Set(['new', 'cooking'])
export const isUnfinished = (l: Pick<Line, 'status'>) => UNFINISHED.has(l.status)

// ---------------------------------------------------------------- one dish split by station (0012)

/**
 * A dish as one station sees it: the dish itself at its own station, or one of its side parts (salad, sốt, bánh mì
 * of a steak) at another station. Status and times are that part's; mods only those made there.
 */
export interface KitchenLine extends Line {
  /** The station of the side part (also in stationId); null for the dish's own part. */
  sideStationId: string | null
  /** Components made here, side parts only: "SALAD", "BÁNH MÌ x2". */
  parts: string[]
  /** The dish's other parts and their state ("Quầy rau: Xong" on the steak). */
  others: { stationId: string; status: LineStatus }[]
}

/** React key and identity of a kitchen line: one line has one per station. */
export const kitchenLineKey = (l: Pick<KitchenLine, 'id' | 'sideStationId'>) => `${l.id}|${l.sideStationId ?? ''}`

export function kitchenLines(l: Line): KitchenLine[] {
  const side = l.sideParts ?? []
  if (!side.length) return [{ ...l, sideStationId: null, parts: [], others: [] }]
  const sideIds = new Set(side.map(p => p.stationId))
  const stateOf = (st: LineStatus): LineStatus => (l.status === 'void' ? 'void' : st)
  const main: KitchenLine = {
    ...l, mods: l.mods.filter(m => !m.stationId || !sideIds.has(m.stationId)), sideStationId: null, parts: [],
    others: side.map(p => ({ stationId: p.stationId, status: stateOf(p.status) })),
  }
  return [
    main,
    ...side.map((p): KitchenLine => ({
      ...l, stationId: p.stationId, status: stateOf(p.status), startedAt: p.startedAt, readyAt: p.readyAt, servedAt: p.servedAt,
      mods: l.mods.filter(m => m.stationId === p.stationId), sideStationId: p.stationId, parts: p.parts,
      others: [{ stationId: l.stationId, status: l.status }, ...side.filter(x => x !== p).map(x => ({ stationId: x.stationId, status: stateOf(x.status) }))],
    })),
  ]
}

/** Every part at every station, for timers, chase and dishes to carry out. */
export const allKitchenLines = (s: FloorState, f: (l: Line) => boolean = () => true): KitchenLine[] => s.lines.filter(f).flatMap(kitchenLines)

// ---------------------------------------------------------------- tables on the floor map

export interface TableTile {
  table: Table
  state: TableState
  orders: Order[]
  guests: number
  seatedSince: string | null
  amount: number
  /** Oldest dish still at the kitchen: yellow / red dot. */
  kitchenHeat: Heat | null
  /** Dishes done and waiting to be carried out. */
  readyCount: number
  groupLabel: string
  overSeats: boolean
}

export function tableState(s: FloorState, t: Table, orders = openOrdersAt(s, t.id)): TableState {
  if (orders.length === 0) {
    if (!s.areas.find(a => a.id === t.areaId)?.active) return 'closed'
    return 'free'
  }
  if (orders.some(o => o.payingAt)) return 'paying'
  if (orders.every(o => o.billRequestedAt)) return 'bill'
  return 'occupied'
}

export function tableTile(s: FloorState, t: Table, now: Date): TableTile {
  const orders = openOrdersAt(s, t.id)
  const ids = new Set(orders.map(o => o.id))
  const lines = allKitchenLines(s, l => ids.has(l.orderId))
  let kitchenHeat: Heat | null = null
  for (const l of lines.filter(isUnfinished)) {
    const h = heat(now.getTime() - new Date(l.sentAt).getTime(), timingFor(s, l.stationId))
    if (h === 'late' || (h === 'warn' && kitchenHeat !== 'late')) kitchenHeat = h
  }
  const guests = orders.reduce((n, o) => n + (o.guestCount ?? 0), 0)
  const group = orders.find(o => o.tables.length > 1)
  return {
    table: t,
    state: tableState(s, t, orders),
    orders,
    guests,
    seatedSince: orders.length ? orders.map(o => o.openedAt).sort()[0] : null,
    amount: orders.reduce((sum, o) => sum + orderAmount(s, o.id), 0),
    kitchenHeat,
    readyCount: lines.filter(l => l.status === 'ready' && (l.deliveryTableId === t.id || !l.deliveryTableId)).reduce((n, l) => n + l.qty, 0),
    groupLabel: group ? groupLabel(s, group).replace('nhóm gộp', 'Gộp') : '',
    overSeats: guests > t.seats,
  }
}

export function areaTables(s: FloorState, areaId: string): Table[] {
  return s.tables
    .filter(t => t.areaId === areaId && (t.active || openOrdersAt(s, t.id).length > 0))
    .sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name, 'vi', { numeric: true }))
}

// ---------------------------------------------------------------- kitchen tickets

/** One Gửi bếp × one station × one order × one delivery table. 5-A and 5-B never share a ticket. */
export function ticketKey(l: Pick<Line, 'sendBatch' | 'stationId' | 'orderId' | 'deliveryTableId'>): string {
  return `${l.sendBatch}|${l.stationId}|${l.orderId}|${l.deliveryTableId ?? ''}`
}

export interface Ticket {
  key: string
  order: Order
  stationId: string
  sendBatch: string
  /** "5-B", "MV-03" */
  label: string
  /** "nhóm gộp 3+4+5" or '' */
  groupLabel: string
  positionLabel: string
  round: number
  sentAt: string
  sentBy: string
  guests: number | null
  takeaway: boolean
  /** Lines in send order (side parts as their own lines); void ones only while their HUỶ is not acknowledged. */
  lines: KitchenLine[]
  /** HUỶ / SỬA / GIỤC still waiting for "Đã biết" (or a decision). */
  notices: Notice[]
  rush: boolean
  rushReason: string
  recalled: boolean
  bumpedAt: string | null
  /** Nothing left to cook and nothing to acknowledge. */
  done: boolean
  /** Latest "CHUYỂN TỪ 5" within 15 minutes. */
  movedFrom: string
  elapsedMs: number
  heat: Heat
  /** Last time something on this ticket changed (done list order). */
  doneAt: string | null
}

const MOVE_LABEL_MS = 15 * 60_000

export function buildTickets(s: FloorState, now: Date): Ticket[] {
  const byKey = new Map<string, KitchenLine[]>()
  const unacked = s.notices.filter(n => !n.ackAt && n.kind !== 'modify_rejected' && (n.status === 'done' || n.status === 'pending'))
  const voidNotice = new Set(unacked.filter(n => n.kind === 'void' && n.lineId).map(n => n.lineId))
  for (const line of s.lines) {
    if (line.replacedBy) continue
    if (line.status === 'void' && !voidNotice.has(line.id)) continue
    for (const l of kitchenLines(line)) {
      const k = ticketKey(l)
      byKey.set(k, [...(byKey.get(k) ?? []), l])
    }
  }
  const out: Ticket[] = []
  for (const [key, lines] of byKey) {
    const order = s.orders.find(o => o.id === lines[0].orderId)
    if (!order) continue
    const first = lines[0]
    const lineIds = new Set(lines.map(l => l.id))
    const notices = unacked.filter(n =>
      (n.lineId && lineIds.has(n.lineId)) || (n.kind === 'chase' && n.orderId === order.id && n.stationId === first.stationId && !n.lineId),
    )
    const open = lines.filter(isUnfinished)
    const sentAt = lines.map(l => l.sentAt).sort()[0]
    const elapsedMs = Math.max(0, now.getTime() - new Date(sentAt).getTime())
    const st = s.tickets.find(t => t.key === key)
    const moved = lines
      .filter(l => l.movedAt && now.getTime() - new Date(l.movedAt).getTime() < MOVE_LABEL_MS && l.status !== 'served')
      .sort((a, b) => (b.movedAt ?? '').localeCompare(a.movedAt ?? ''))[0]
    const doneTimes = lines.map(l => l.readyAt ?? l.servedAt ?? l.voidedAt).filter((x): x is string => !!x).sort()
    out.push({
      key,
      order,
      stationId: first.stationId,
      sendBatch: first.sendBatch,
      label: orderLabel(s, order, first.deliveryTableId),
      groupLabel: groupLabel(s, order),
      positionLabel: order.positionLabel,
      round: first.round,
      sentAt,
      sentBy: first.sentBy,
      guests: order.guestCount,
      takeaway: order.kind === 'takeaway',
      lines: [...lines].sort((a, b) => a.sentAt.localeCompare(b.sentAt)),
      notices,
      rush: lines.some(l => l.rush && isUnfinished(l)),
      rushReason: lines.find(l => l.rush)?.rushReason ?? '',
      recalled: !!st?.recalledAt && open.length > 0,
      bumpedAt: st?.bumpedAt ?? null,
      done: open.length === 0 && notices.length === 0,
      movedFrom: moved?.movedFromLabel ?? '',
      elapsedMs,
      heat: open.length ? heat(elapsedMs, timingFor(s, first.stationId)) : 'ok',
      doneAt: st?.bumpedAt ?? doneTimes[doneTimes.length - 1] ?? null,
    })
  }
  return out
}

/** On screen for a station ('all' = every kitchen and bar station): urgent first, then oldest first. */
export function activeTickets(s: FloorState, menu: Menu, station: string, now: Date): Ticket[] {
  const prep = new Set(menu.stations.filter(x => x.kind !== 'none').map(x => x.id))
  const rank = (t: Ticket) => (t.notices.some(n => n.kind === 'void' || n.kind === 'modify') ? 0 : t.notices.some(n => n.kind === 'chase') ? 1 : t.rush ? 2 : 3)
  return buildTickets(s, now)
    .filter(t => !t.done && prep.has(t.stationId) && (station === 'all' || t.stationId === station))
    .sort((a, b) => rank(a) - rank(b) || a.sentAt.localeCompare(b.sentAt))
}

/** "Phiếu đã xong" of the last 2 hours, newest first, at most 50. */
export function doneTickets(s: FloorState, station: string, now: Date): Ticket[] {
  const since = now.getTime() - 2 * 3600_000
  return buildTickets(s, now)
    .filter(t => t.done && (station === 'all' || t.stationId === station) && t.doneAt && new Date(t.doneAt).getTime() >= since)
    .filter(t => t.lines.some(l => l.status === 'ready' || l.status === 'served'))
    .sort((a, b) => (b.doneAt ?? '').localeCompare(a.doneAt ?? ''))
    .slice(0, 50)
}

// ---------------------------------------------------------------- ticket text

/** Options for the cook (độ chín, sốt), removals in capitals with KHÔNG, add-ons with +. */
export function lineParts(l: Pick<Line, 'mods'>): { options: string[]; removals: string[]; addons: string[] } {
  const kn = (m: Line['mods'][number]) => (m.kitchenName || m.name).toUpperCase()
  return {
    options: l.mods.filter(m => m.kind === 'option').map(kn),
    removals: l.mods.filter(m => m.kind === 'removal').map(m => 'KHÔNG ' + kn(m)),
    addons: l.mods.filter(m => m.kind === 'addon').map(m => `${kn(m).startsWith('+') ? kn(m) : '+ ' + kn(m)}${m.qty > 1 ? ' x' + m.qty : ''}`),
  }
}

/** One-line description: "Steak bò nướng – 300g · MEDIUM · KHÔNG TRỨNG · ghi chú". */
export function lineText(l: Pick<Line, 'name' | 'variantName' | 'mods' | 'note'>): string {
  const p = lineParts(l)
  return [l.name + (l.variantName ? ` – ${l.variantName}` : ''), ...p.options, ...p.removals, ...p.addons, l.note].filter(Boolean).join(' · ')
}

// ---------------------------------------------------------------- waiter: dishes to carry out

export interface ReadyEntry {
  /** A side part (sideStationId set) is carried out on its own, often before the dish. */
  line: KitchenLine
  order: Order
  label: string
  waitMs: number
}

export function readyToServe(s: FloorState, now: Date): ReadyEntry[] {
  return allKitchenLines(s)
    .filter(l => l.status === 'ready')
    .flatMap(l => {
      const order = s.orders.find(o => o.id === l.orderId)
      if (!order || order.status === 'void' || order.status === 'merged') return []
      return [{ line: l, order, label: orderLabel(s, order, l.deliveryTableId), waitMs: now.getTime() - new Date(l.readyAt ?? l.sentAt).getTime() }]
    })
    .sort((a, b) => b.waitMs - a.waitMs)
}

/** Current wait per station: median minutes of dishes still at the kitchen. */
export function stationWait(s: FloorState, stationId: string, now: Date): number {
  const waits = allKitchenLines(s)
    .filter(l => l.stationId === stationId && isUnfinished(l))
    .map(l => (now.getTime() - new Date(l.sentAt).getTime()) / 60_000)
    .sort((a, b) => a - b)
  if (!waits.length) return 0
  return Math.round(waits[Math.floor(waits.length / 2)])
}

/** One compact line for the allergy box: "⚠ DỊ ỨNG: đậu phộng". */
export function allergyText(note: string | undefined): string {
  const what = (note ?? '').trim().replace(/^(có\s+)?(khách\s+)?(bị\s+)?dị\s*ứng\s*:?\s*/i, '')
  return what ? `⚠ DỊ ỨNG: ${what}` : '⚠ CÓ KHÁCH DỊ ỨNG'
}

/** "20 phút", "1 giờ 15 phút" (table tiles and the order list). */
export function minutesText(ms: number): string {
  const m = Math.max(0, Math.floor(ms / 60_000))
  if (m < 60) return `${m} phút`
  return `${Math.floor(m / 60)} giờ${m % 60 ? ` ${m % 60} phút` : ''}`
}

/** Table tiles: "20 phút", then "1g15p" so it fits. */
export function shortMinutes(ms: number): string {
  return ms < 3600_000 ? minutesText(ms) : formatDuration(ms)
}
