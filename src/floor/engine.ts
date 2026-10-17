// Floor and kitchen state transitions for the in-memory (sample) repo: open, ghép (5-B), gộp, chuyển, tách,
// huỷ, gửi bếp, trạng thái món. Each function takes the state and returns a new one or throws a Vietnamese
// message. The Supabase repo runs the same rules in SQL (0002 + 0004); keep both in step.

import { countedTotal, openShiftOf, shiftSummary } from '../cashier/shift'
import { settle, type Discount, type PaymentInput } from '../lib/billing'
import { billTotals, vatRateOn, type TaxedLine } from '../lib/pricing'
import { itemGroups, quoteLine, type PickerState } from '../menu/picker'
import { isManager } from '../auth/guards'
import type { ApprovalRequest } from '../auth/types'
import type { Menu } from '../menu/types'
import { groupLabel, isOpen, isUnfinished, lineText, openOrdersAt, orderLabel, tableName, ticketKey } from './logic'
import {
  NOTE_MAX, VOID_REASONS, RUSH_REASONS,
  type Actor, type Area, type Bill, type FloorSettings, type FloorState, type Line, type LineMod, type LineStatus, type Notice, type Order, type SendLineInput, type Shift, type Table,
} from './types'

export interface Ctx {
  now: Date
  actor: Actor
  menu: Menu
  newId: () => string
  /**
   * Manager approval check (sample stand-in for p_approval in 0006): the approving manager's name for a valid,
   * unused token for exactly this request, else null. The token is used up.
   */
  approve?: (token: string | undefined, need: ApprovalRequest) => string | null
}

function fail(msg: string): never {
  throw new Error(msg)
}
const iso = (c: Ctx) => c.now.toISOString()
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'

/** A manager (or the owner) approves `need`: themselves, or through a token from verify_manager_pin. Returns who. */
function approval(c: Ctx, token: string | undefined, need: ApprovalRequest, missing: string): string {
  if (isManager(c.actor.role)) return c.actor.name
  if (!token) fail(missing)
  return c.approve?.(token, need) ?? fail('Mã duyệt của quản lý không hợp lệ, đã dùng hoặc đã hết hạn: nhập PIN lại')
}

function floorStaff(c: Ctx) {
  if (c.actor.role === 'kitchen') fail('Tài khoản bếp không thao tác đơn được')
}
function cashierUp(c: Ctx, what: string) {
  if (c.actor.role !== 'cashier' && !isManager(c.actor.role)) fail(`Chỉ thu ngân hoặc quản lý được ${what}`)
}
function kitchenUp(c: Ctx) {
  if (c.actor.role !== 'kitchen' && !isManager(c.actor.role)) fail('Chỉ máy bếp, bar hoặc quản lý được đổi trạng thái này')
}

function getOrder(s: FloorState, id: string): Order {
  return s.orders.find(o => o.id === id) ?? fail('Không tìm thấy đơn')
}
function getTable(s: FloorState, id: string): Table {
  return s.tables.find(t => t.id === id) ?? fail('Không tìm thấy bàn')
}
/** Open, and not on another cashier's payment screen. */
function editable(s: FloorState, id: string, c: Ctx): Order {
  const o = getOrder(s, id)
  if (!isOpen(o)) fail('Đơn không còn mở')
  if (o.payingAt && o.payingBy !== c.actor.name) fail(`Đơn đang thanh toán (${o.payingBy}): chưa sửa được`)
  return o
}

const patchOrder = (s: FloorState, id: string, p: Partial<Order>): FloorState => ({ ...s, orders: s.orders.map(o => (o.id === id ? { ...o, ...p } : o)) })
const patchLines = (s: FloorState, f: (l: Line) => Line): FloorState => ({ ...s, lines: s.lines.map(f) })
/** Anything that changes the bill makes the printed pre-bill stale: back to Đang ngồi. */
const staleBill = (s: FloorState, ...ids: string[]) => ({ ...s, orders: s.orders.map(o => (ids.includes(o.id) && o.billRequestedAt ? { ...o, billRequestedAt: null } : o)) })

function checkGuests(n: number) {
  if (!Number.isInteger(n) || n < 1 || n > 99) fail('Số khách phải từ 1 đến 99')
}
function checkNote(note: string, what = 'Ghi chú') {
  if (note.length > NOTE_MAX) fail(`${what} tối đa ${NOTE_MAX} ký tự`)
}

function blankOrder(c: Ctx, p: Partial<Order>): Order {
  return {
    id: c.newId(), kind: 'dine_in', takeawayNo: null, customerName: '', tableId: null, tables: [], guestCount: null, positionLabel: '',
    note: '', allergy: false, status: 'open', openedAt: iso(c), openedBy: c.actor.name, closedAt: null, mergedInto: null, rounds: 0,
    billRequestedAt: null, billPrintCount: 0, payingAt: null, payingBy: null, chasedAt: null, chaseCount: 0, ...p,
  }
}

function nextSuffix(s: FloorState, tableId: string): string {
  const used = new Set(openOrdersAt(s, tableId).map(o => o.tables.find(t => t.tableId === tableId)!.suffix))
  if (used.size >= s.settings.maxOrdersPerTable) fail(`Bàn ${tableName(s, tableId)} đã có đủ ${s.settings.maxOrdersPerTable} đơn`)
  return [...LETTERS].find(x => !used.has(x)) ?? fail('Hết chữ cho đơn ghép')
}

/** Every order sharing a table with another must carry a position label. */
function checkSharedLabels(s: FloorState, tableId: string) {
  const orders = openOrdersAt(s, tableId)
  if (orders.length > 1 && orders.some(o => !o.positionLabel.trim())) fail(`Bàn ${tableName(s, tableId)} đang có nhiều đơn: mỗi đơn phải ghi vị trí ngồi`)
}

// ---------------------------------------------------------------- open

export interface OpenTableInput {
  tableId: string
  guestCount: number
  /** Gộp bàn at opening: these tables join the same order. */
  extraTableIds?: string[]
  positionLabel?: string
}

/** Opens a table. If another device opened it meanwhile, returns that order instead of a second one. */
export function openTable(s: FloorState, inp: OpenTableInput, c: Ctx): { state: FloorState; orderId: string } {
  floorStaff(c)
  const t = getTable(s, inp.tableId)
  if (!t.active) fail('Bàn đã ngừng sử dụng')
  if (!s.areas.find(a => a.id === t.areaId)?.active) fail('Khu này đang tạm đóng')
  const existing = openOrdersAt(s, t.id)
  if (existing.length) return { state: s, orderId: existing[0].id }
  checkGuests(inp.guestCount)
  const extra = [...new Set(inp.extraTableIds ?? [])].filter(id => id !== t.id)
  if (1 + extra.length > s.settings.maxMergeTables) fail(`Một nhóm gộp tối đa ${s.settings.maxMergeTables} bàn`)
  for (const id of extra) {
    const x = getTable(s, id)
    if (!x.active) fail(`Bàn ${x.name} đã ngừng sử dụng`)
    if (openOrdersAt(s, id).length) fail(`Bàn ${x.name} đang có khách: dùng Gộp bàn sau khi mở`)
  }
  const o = blankOrder(c, {
    tableId: t.id,
    tables: [t.id, ...extra].map(id => ({ tableId: id, suffix: 'A', joinedAt: iso(c) })),
    guestCount: inp.guestCount,
    positionLabel: (inp.positionLabel ?? '').trim(),
  })
  const state = { ...s, orders: [...s.orders], tables: s.tables.map(x => (x.id === t.id || extra.includes(x.id) ? { ...x, needsCleaning: false } : x)) }
  state.orders.push(o)
  return { state, orderId: o.id }
}

export interface SharedOrderInput {
  tableId: string
  guestCount: number
  positionLabel: string
  /** Labels for orders already on the table that have none yet ("đầu bàn"). */
  existingLabels?: Record<string, string>
}

/** Ghép bàn (khách lạ ngồi chung): a separate order on an occupied table, 5-B. */
export function addSharedOrder(s: FloorState, inp: SharedOrderInput, c: Ctx): { state: FloorState; orderId: string } {
  floorStaff(c)
  const t = getTable(s, inp.tableId)
  const existing = openOrdersAt(s, t.id)
  if (!existing.length) fail('Bàn đang trống: mở bàn bình thường')
  checkGuests(inp.guestCount)
  if (!inp.positionLabel.trim()) fail('Ghi vị trí ngồi cho đơn ghép (ví dụ: 2 khách áo xanh)')
  let state = s
  for (const [id, label] of Object.entries(inp.existingLabels ?? {})) if (label.trim()) state = patchOrder(state, id, { positionLabel: label.trim().slice(0, 30) })
  const o = blankOrder(c, {
    tableId: t.id,
    tables: [{ tableId: t.id, suffix: nextSuffix(state, t.id), joinedAt: iso(c) }],
    guestCount: inp.guestCount,
    positionLabel: inp.positionLabel.trim().slice(0, 30),
  })
  state = { ...state, orders: [...state.orders, o] }
  checkSharedLabels(state, t.id)
  return { state, orderId: o.id }
}

/** Đơn mang về: MV-01, MV-02 … restarting each business day. */
export function openTakeaway(s: FloorState, inp: { customerName?: string }, c: Ctx): { state: FloorState; orderId: string } {
  floorStaff(c)
  const [h, m] = s.settings.businessDayStart.split(':').map(Number)
  const OFFSET = 7 * 3600_000
  const local = new Date(c.now.getTime() + OFFSET)
  let start = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), h, m) - OFFSET
  if (c.now.getTime() < start) start -= 86400_000
  const today = s.orders.filter(o => o.kind === 'takeaway' && new Date(o.openedAt).getTime() >= start)
  const no = Math.max(0, ...today.map(o => o.takeawayNo ?? 0)) + 1
  const o = blankOrder(c, { kind: 'takeaway', takeawayNo: no, customerName: (inp.customerName ?? '').trim().slice(0, 40) })
  return { state: { ...s, orders: [...s.orders, o] }, orderId: o.id }
}

export function updateOrder(s: FloorState, id: string, p: { guestCount?: number; positionLabel?: string; note?: string; allergy?: boolean }, c: Ctx): FloorState {
  floorStaff(c)
  const o = editable(s, id, c)
  if (p.guestCount !== undefined && o.kind === 'dine_in') checkGuests(p.guestCount)
  if (p.note !== undefined) checkNote(p.note, 'Ghi chú đơn')
  const next = patchOrder(s, id, {
    ...(p.guestCount !== undefined ? { guestCount: p.guestCount } : {}),
    ...(p.positionLabel !== undefined ? { positionLabel: p.positionLabel.trim().slice(0, 30) } : {}),
    ...(p.note !== undefined ? { note: p.note.trim() } : {}),
    ...(p.allergy !== undefined ? { allergy: p.allergy } : {}),
  })
  for (const t of o.tables) checkSharedLabels(next, t.tableId)
  return next
}

/** An order with nothing on it can be closed right away (wrong table, guests left). */
export function closeEmptyOrder(s: FloorState, id: string, c: Ctx): FloorState {
  floorStaff(c)
  editable(s, id, c)
  if (s.lines.some(l => l.orderId === id && l.status !== 'void')) fail('Đơn còn món: huỷ món trước khi đóng đơn')
  return patchOrder(s, id, { status: 'void', closedAt: iso(c) })
}

// ---------------------------------------------------------------- Gửi bếp

function toPicker(l: SendLineInput): PickerState {
  return {
    itemId: l.menu_item_id,
    variantId: l.variant_id ?? null,
    qty: l.qty,
    options: Object.fromEntries(l.options.map(o => [o.option_id, o.qty ?? 1])),
    removals: [...l.removals],
    note: l.note ?? '',
  }
}

/** Prices one line from the menu (never from the client), like send_order_lines does on the server. */
function priceLine(menu: Menu, inp: SendLineInput, now: Date) {
  const item = menu.items.find(i => i.id === inp.menu_item_id) ?? fail('Món không có trong thực đơn')
  const state = toPicker(inp)
  checkNote(state.note)
  const q = quoteLine(menu, item, state, now)
  if (!q.canAdd || q.unit == null) fail(q.issues.find(i => i.level === 'error')?.message ?? `Không gửi được ${item.name}`)
  const cat = menu.categories.find(x => x.id === item.categoryId)
  const station = menu.stations.find(x => x.id === (item.stationId ?? cat?.defaultStationId)) ?? fail(`Món ${item.name} chưa chọn khu chế biến`)
  const mods: LineMod[] = []
  for (const g of itemGroups(menu, item)) {
    for (const o of g.options) {
      const n = state.options[o.id] ?? 0
      if (n > 0) mods.push({ kind: g.group.kind === 'choice' ? 'option' : 'addon', name: o.name, kitchenName: o.kitchenName, qty: n, unitDelta: o.priceDelta })
    }
  }
  for (const id of state.removals) {
    const comp = item.components.find(x => x.id === id)!
    mods.push({ kind: 'removal', name: comp.name, kitchenName: comp.kitchenName, qty: 1, unitDelta: -comp.removalDiscount })
  }
  const variant = item.variants.find(v => v.id === state.variantId)
  // tax flags are locked at send, like send_order_lines: VAT group of the item (else its category), rate of the day
  const group = item.vatGroup ?? cat?.vatGroup ?? 'food'
  const vatRate = vatRateOn(group, now) ?? menu.vatGroups.find(g => g.code === group)?.rate ?? fail(`Nhóm thuế ${group} chưa có thuế suất`)
  const tax = { vatRate, priceIncludesVat: item.priceIncludesVat ?? menu.settings.pricesIncludeVat, discountable: item.discountable, serviceCharge: item.serviceCharge }
  return { item, state, unit: q.unit, station, mods, variantName: variant?.name ?? '', tax }
}

export interface SendOptions {
  /** GẤP, with a reason from RUSH_REASONS. */
  rush?: boolean
  rushReason?: string
}

/**
 * One Gửi bếp tap = one round (Lượt n). Resending the same batch id is a no-op, so a slow network never
 * doubles a ticket. Price is locked here.
 */
export function sendLines(s: FloorState, orderId: string, lines: SendLineInput[], batch: string, opts: SendOptions, c: Ctx): { state: FloorState; lineIds: string[] } {
  floorStaff(c)
  const prior = s.lines.filter(l => l.sendBatch === batch)
  if (prior.length) return { state: s, lineIds: prior.map(l => l.id) }
  const o = editable(s, orderId, c)
  if (!lines.length) fail('Không có món để gửi')
  if (opts.rush && !RUSH_REASONS.includes((opts.rushReason ?? '') as (typeof RUSH_REASONS)[number])) fail('Chọn lý do GẤP')
  const round = o.rounds + 1
  const out: Line[] = lines.map(inp => {
    const p = priceLine(c.menu, inp, c.now)
    const table = inp.delivery_table_id ?? o.tableId
    if (o.kind === 'dine_in' && !o.tables.some(t => t.tableId === table)) fail('Bàn ra món phải là một bàn của đơn')
    return {
      id: c.newId(), orderId: o.id, originOrderId: o.id, menuItemId: p.item.id, name: p.item.name, shortName: p.item.shortName || p.item.name.toUpperCase(),
      variantId: p.state.variantId, variantName: p.variantName, qty: p.state.qty, price: p.unit, stationId: p.station.id,
      status: p.station.kind === 'none' ? 'ready' : 'new', note: p.state.note.trim(), mods: p.mods,
      deliveryTableId: o.kind === 'dine_in' ? table : null, round, sendBatch: batch, sentAt: iso(c), sentBy: c.actor.name,
      rush: !!opts.rush, rushReason: opts.rush ? opts.rushReason ?? '' : '', startedAt: null,
      readyAt: p.station.kind === 'none' ? iso(c) : null, servedAt: null, voidReason: '', voidedAt: null, voidStage: null, replacedBy: null,
      movedFromLabel: '', movedAt: null, options: p.state.options, removals: p.state.removals, ...p.tax,
    }
  })
  let state: FloorState = { ...s, lines: [...s.lines, ...out] }
  state = staleBill(patchOrder(state, o.id, { rounds: round }), o.id)
  return { state, lineIds: out.map(l => l.id) }
}

// ---------------------------------------------------------------- huỷ món

export interface VoidInput {
  qty: number
  reason: string
  /** Required for "Khác". */
  reasonNote?: string
  /** Token from verify_manager_pin when voidNeedsManager (not needed when a manager voids). */
  approval?: string
}

/** Voiding this line needs a manager: once sent (shop setting 'sent', the default) or once started ('started'). */
export function voidNeedsManager(l: Line, settings?: Pick<FloorSettings, 'voidApproval'>): boolean {
  if (l.status === 'cooking' || l.status === 'ready' || l.status === 'served') return true
  return l.status === 'new' && (settings?.voidApproval ?? 'sent') === 'sent'
}

/**
 * Huỷ / bớt a sent line, with a reason. A manager approves (their own session, or a PIN token) as
 * voidNeedsManager says. The kitchen is told (HUỶ, struck red, long horn) only while it still has the dish to make.
 */
export function voidLine(s: FloorState, lineId: string, inp: VoidInput, c: Ctx): FloorState {
  floorStaff(c)
  const l = s.lines.find(x => x.id === lineId) ?? fail('Không tìm thấy món')
  const o = editable(s, l.orderId, c)
  if (l.status === 'void') fail('Món đã huỷ')
  const reason = voidReason(inp)
  if (!Number.isInteger(inp.qty) || inp.qty < 1 || inp.qty > l.qty) fail('Số lượng huỷ không hợp lệ')
  if (o.billRequestedAt && c.actor.role === 'waiter') fail('Đơn đã in tạm tính: huỷ món cần thu ngân hoặc quản lý')
  if (voidNeedsManager(l, s.settings)) {
    approval(c, inp.approval, { action: 'void_item', orderId: o.id, lineId: l.id }, l.status === 'new' ? 'Huỷ món đã gửi bếp: cần quản lý nhập mã PIN' : 'Món bếp đã làm: cần quản lý nhập mã PIN')
  }
  return staleBill(applyVoid(s, l, inp.qty, reason, c), o.id)
}

function voidReason(inp: { reason: string; reasonNote?: string }): string {
  if (!VOID_REASONS.includes(inp.reason as (typeof VOID_REASONS)[number])) fail('Chọn lý do huỷ')
  const note = (inp.reasonNote ?? '').trim()
  if (inp.reason === 'Khác' && !note) fail('Lý do "Khác": ghi rõ lý do')
  return inp.reason === 'Khác' ? note : note ? `${inp.reason}: ${note}` : inp.reason
}

function applyVoid(s: FloorState, l: Line, qty: number, reason: string, c: Ctx): FloorState {
  const stage = l.status
  const voidId = qty < l.qty ? c.newId() : l.id
  const voided: Line = { ...l, id: voidId, qty, status: 'void', voidReason: reason, voidedAt: iso(c), voidStage: stage }
  let state: FloorState =
    qty < l.qty ? { ...s, lines: [...s.lines.map(x => (x.id === l.id ? { ...x, qty: x.qty - qty } : x)), voided] } : patchLines(s, x => (x.id === l.id ? voided : x))
  if (stage === 'new' || stage === 'cooking') {
    const rest = l.qty - qty
    const n: Notice = {
      id: c.newId(), kind: 'void', orderId: l.orderId, lineId: voidId, stationId: l.stationId, sendBatch: l.sendBatch,
      text: `HUỶ ${qty} ${l.shortName}${rest ? ` (bớt ${qty}, còn ${rest})` : ''} – ${reason}`,
      before: '', createdAt: iso(c), createdBy: c.actor.name, ackAt: null, status: 'done', payload: null,
    }
    state = { ...state, notices: [...state.notices, n] }
  }
  return state
}

/**
 * Huỷ cả đơn after Gửi bếp (void_order): every live line with one reason and one manager approval, then the
 * order closes as void and its tables are free.
 */
export function voidOrder(s: FloorState, orderId: string, inp: { reason: string; reasonNote?: string; approval?: string }, c: Ctx): FloorState {
  floorStaff(c)
  const o = editable(s, orderId, c)
  const reason = voidReason(inp)
  if (o.billRequestedAt && c.actor.role === 'waiter') fail('Đơn đã in tạm tính: huỷ đơn cần thu ngân hoặc quản lý')
  const live = s.lines.filter(l => l.orderId === o.id && l.status !== 'void')
  if (live.some(l => voidNeedsManager(l, s.settings))) approval(c, inp.approval, { action: 'void_order', orderId: o.id }, 'Huỷ đơn đã gửi bếp: cần quản lý nhập mã PIN')
  let state = s
  for (const l of live) state = applyVoid(state, l, l.qty, reason, c)
  return patchOrder(state, o.id, { status: 'void', closedAt: iso(c), payingAt: null, payingBy: null, billRequestedAt: null })
}

// ---------------------------------------------------------------- SỬA món đã gửi

function applyModify(s: FloorState, old: Line, inp: SendLineInput, c: Ctx): { state: FloorState; newId: string } {
  const p = priceLine(c.menu, { ...inp, qty: old.qty }, c.now)
  if (p.item.id !== old.menuItemId) fail('Sửa món chỉ đổi size, tuỳ chọn và ghi chú; đổi món khác thì huỷ rồi gọi mới')
  const id = c.newId()
  const line: Line = {
    ...old, id, variantId: p.state.variantId, variantName: p.variantName, price: p.unit, note: p.state.note.trim(), mods: p.mods,
    options: p.state.options, removals: p.state.removals, replacedBy: null,
  }
  const state: FloorState = {
    ...s,
    lines: [...s.lines.map(x => (x.id === old.id ? { ...x, status: 'void' as const, voidReason: 'Sửa món', voidedAt: iso(c), voidStage: old.status, replacedBy: id } : x)), line],
    notices: s.notices.map(n => (n.lineId === old.id ? { ...n, lineId: id } : n)),
  }
  return { state, newId: id }
}

/**
 * SỬA: change size, options, removals or note of a sent line (same dish, same quantity).
 * Chờ làm: applied now, kitchen sees SỬA and taps Đã biết. Đang làm: waits for the kitchen (Nhận sửa / Không kịp).
 * Xong or Đã bưng: refused (huỷ rồi gọi món mới).
 */
export function modifyLine(s: FloorState, lineId: string, inp: SendLineInput, c: Ctx): FloorState {
  floorStaff(c)
  const l = s.lines.find(x => x.id === lineId) ?? fail('Không tìm thấy món')
  const o = editable(s, l.orderId, c)
  if (l.status === 'ready' || l.status === 'served') fail('Món đã xong: huỷ món rồi gọi món mới')
  if (l.status === 'void') fail('Món đã huỷ')
  if (inp.qty !== l.qty) fail('Đổi số lượng không phải là sửa: tăng thì gọi thêm, giảm thì huỷ bớt')
  if (s.notices.some(n => n.lineId === l.id && n.kind === 'modify' && n.status === 'pending')) fail('Đang chờ bếp xác nhận lần sửa trước')
  const before = lineText(l)
  const preview = priceLine(c.menu, inp, c.now)
  const after = lineText({ name: preview.item.name, variantName: preview.variantName, mods: preview.mods, note: preview.state.note.trim() })
  if (after === before) fail('Chưa có gì thay đổi')
  const notice = (lineRef: string, status: Notice['status']): Notice => ({
    id: c.newId(), kind: 'modify', orderId: o.id, lineId: lineRef, stationId: l.stationId, sendBatch: l.sendBatch,
    text: after, before, createdAt: iso(c), createdBy: c.actor.name, ackAt: null, status, payload: status === 'pending' ? inp : null,
  })
  if (l.status === 'cooking') return { ...s, notices: [...s.notices, notice(l.id, 'pending')] }
  const r = applyModify(s, l, inp, c)
  return staleBill({ ...r.state, notices: [...r.state.notices, notice(r.newId, 'done')] }, o.id)
}

/** Kitchen answers a SỬA on a dish already cooking. Không kịp: the waiter is told to explain to the guest. */
export function decideModify(s: FloorState, noticeId: string, accept: boolean, c: Ctx): FloorState {
  kitchenUp(c)
  const n = s.notices.find(x => x.id === noticeId) ?? fail('Không tìm thấy thông báo')
  if (n.kind !== 'modify' || n.status !== 'pending' || !n.payload) fail('Thông báo này không chờ xác nhận')
  const l = s.lines.find(x => x.id === n.lineId) ?? fail('Không tìm thấy món')
  if (!accept || l.status === 'void') {
    const back: Notice = { ...n, id: c.newId(), kind: 'modify_rejected', stationId: null, text: `Bếp không kịp sửa: ${n.text}`, createdAt: iso(c), createdBy: c.actor.name, ackAt: null, status: 'done', payload: null }
    return { ...s, notices: [...s.notices.map(x => (x.id === n.id ? { ...x, status: 'rejected' as const, ackAt: iso(c) } : x)), back] }
  }
  const r = applyModify(s, l, n.payload, c)
  return staleBill({ ...r.state, notices: r.state.notices.map(x => (x.id === n.id ? { ...x, status: 'accepted' as const, lineId: r.newId, ackAt: iso(c) } : x)) }, l.orderId)
}

export function ackNotice(s: FloorState, id: string, c: Ctx): FloorState {
  const n = s.notices.find(x => x.id === id) ?? fail('Không tìm thấy thông báo')
  if (n.kind === 'modify_rejected') floorStaff(c)
  else kitchenUp(c)
  if (n.status === 'pending') fail('Chọn Nhận sửa hoặc Không kịp')
  return { ...s, notices: s.notices.map(x => (x.id === id ? { ...x, ackAt: iso(c) } : x)) }
}

// ---------------------------------------------------------------- trạng thái món, xong phiếu, gọi lại

const UNDO_MS = 2 * 60_000

/**
 * Kitchen: Chờ làm → Đang làm → Xong (or straight to Xong); one step back within 2 minutes (manager any time).
 * Floor: Xong → Đã bưng.
 */
export function setLineStatus(s: FloorState, lineIds: string[], to: LineStatus, c: Ctx): FloorState {
  const ids = new Set(lineIds)
  const lines = s.lines.filter(l => ids.has(l.id))
  if (!lines.length) fail('Không tìm thấy món')
  for (const l of lines) {
    const from = l.status
    if (from === to) continue
    if (from === 'void') fail('Món đã huỷ')
    if (to === 'served') {
      floorStaff(c)
      if (from !== 'ready') fail('Chỉ bưng món đã xong')
      continue
    }
    kitchenUp(c)
    const forward = (from === 'new' && (to === 'cooking' || to === 'ready')) || (from === 'cooking' && to === 'ready')
    const back = (from === 'cooking' && to === 'new') || (from === 'ready' && to === 'cooking')
    if (!forward && !back) fail('Không đổi được trạng thái này')
    if (back && !isManager(c.actor.role)) {
      const at = from === 'ready' ? l.readyAt : l.startedAt
      if (!at || c.now.getTime() - new Date(at).getTime() > UNDO_MS) fail('Quá 2 phút: chỉ quản lý lùi được trạng thái')
    }
  }
  const t = iso(c)
  return patchLines(s, l => {
    if (!ids.has(l.id) || l.status === to) return l
    if (to === 'cooking') return { ...l, status: to, startedAt: l.status === 'new' ? t : l.startedAt, readyAt: null }
    if (to === 'ready') return { ...l, status: to, startedAt: l.startedAt ?? t, readyAt: t }
    if (to === 'served') return { ...l, status: to, servedAt: t }
    return { ...l, status: to, startedAt: null }
  })
}

function ticketLines(s: FloorState, key: string): Line[] {
  return s.lines.filter(l => !l.replacedBy && l.status !== 'void' && ticketKey(l) === key)
}

function setTicket(s: FloorState, key: string, p: Partial<FloorState['tickets'][number]>): FloorState {
  const has = s.tickets.some(t => t.key === key)
  const base = { key, bumpedAt: null, recalledAt: null, recallCount: 0 }
  return { ...s, tickets: has ? s.tickets.map(t => (t.key === key ? { ...t, ...p } : t)) : [...s.tickets, { ...base, ...p }] }
}

/** Xong phiếu: every dish left on the ticket becomes Xong and the ticket leaves the screen. */
export function bumpTicket(s: FloorState, key: string, c: Ctx): FloorState {
  kitchenUp(c)
  const lines = ticketLines(s, key)
  if (!lines.length) fail('Không tìm thấy phiếu')
  const ids = new Set(s.lines.filter(l => ticketKey(l) === key).map(l => l.id))
  if (s.notices.some(n => !n.ackAt && n.lineId && ids.has(n.lineId) && (n.kind === 'void' || n.kind === 'modify'))) fail('Bấm Đã biết HUỶ / SỬA trước khi báo xong phiếu')
  const open = lines.filter(isUnfinished).map(l => l.id)
  let state = open.length ? setLineStatus(s, open, 'ready', c) : s
  const order = lines[0].orderId
  state = { ...state, notices: state.notices.map(n => (n.kind === 'chase' && !n.ackAt && n.orderId === order && n.stationId === lines[0].stationId ? { ...n, ackAt: iso(c) } : n)) }
  return setTicket(state, key, { bumpedAt: iso(c) })
}

/** Gọi lại: dishes not yet carried out go back to Đang làm; the timer keeps counting from the original send. */
export function recallTicket(s: FloorState, key: string, c: Ctx): FloorState {
  kitchenUp(c)
  const lines = ticketLines(s, key)
  if (!lines.length) fail('Không tìm thấy phiếu')
  const st = s.tickets.find(t => t.key === key)
  const doneAt = st?.bumpedAt ?? lines.map(l => l.readyAt).filter(Boolean).sort().pop()
  if (doneAt && c.now.getTime() - new Date(doneAt).getTime() > 30 * 60_000 && !isManager(c.actor.role)) fail('Phiếu xong quá 30 phút: cần quản lý gọi lại')
  const back = new Set(lines.filter(l => l.status === 'ready').map(l => l.id))
  if (!back.size) fail('Món của phiếu đã bưng hết')
  const state = patchLines(s, l => (back.has(l.id) ? { ...l, status: 'cooking', readyAt: null } : l))
  return setTicket(state, key, { recalledAt: iso(c), recallCount: (st?.recallCount ?? 0) + 1, bumpedAt: null })
}

// ---------------------------------------------------------------- giục món

/** Giục: the station's ticket jumps to the top with a bell. At least 3 minutes between two chases. */
export function chaseOrder(s: FloorState, orderId: string, c: Ctx): FloorState {
  floorStaff(c)
  const o = editable(s, orderId, c)
  if (o.chasedAt && c.now.getTime() - new Date(o.chasedAt).getTime() < 3 * 60_000) fail('Vừa giục xong: chờ 3 phút rồi giục lại')
  const stations = [...new Set(s.lines.filter(l => l.orderId === o.id && isUnfinished(l)).map(l => l.stationId))]
  if (!stations.length) fail('Không có món nào đang chờ bếp')
  const n = o.chaseCount + 1
  const notices: Notice[] = stations.map(st => ({
    id: c.newId(), kind: 'chase', orderId: o.id, lineId: null, stationId: st, sendBatch: null, text: `GIỤC lần ${n}`, before: '',
    createdAt: iso(c), createdBy: c.actor.name, ackAt: null, status: 'done', payload: null,
  }))
  return patchOrder({ ...s, notices: [...s.notices, ...notices] }, o.id, { chasedAt: iso(c), chaseCount: n })
}

// ---------------------------------------------------------------- gộp, chuyển, tách

/** Gộp bàn after ordering: every line moves to the target and keeps its delivery table and kitchen state. No notice ticket. */
export function mergeOrders(s: FloorState, targetId: string, sourceIds: string[], c: Ctx): FloorState {
  floorStaff(c)
  const target = editable(s, targetId, c)
  const sources = [...new Set(sourceIds)].filter(id => id !== targetId).map(id => editable(s, id, c))
  if (!sources.length) fail('Chọn đơn cần gộp')
  if ([target, ...sources].some(o => o.kind !== 'dine_in')) fail('Đơn mang về không gộp với đơn tại bàn')
  let state = s
  let tables = [...target.tables]
  let guests = target.guestCount ?? 0
  let openedAt = target.openedAt
  for (const src of sources) {
    const srcIds = new Set([src.id])
    state = patchOrder(state, src.id, { tables: [], status: 'merged', mergedInto: target.id, closedAt: iso(c) })
    for (const t of src.tables) {
      if (tables.some(x => x.tableId === t.tableId)) continue
      const tmp = patchOrder(state, target.id, { tables })
      tables = [...tables, { tableId: t.tableId, suffix: nextSuffix(tmp, t.tableId), joinedAt: iso(c) }]
    }
    state = patchLines(state, l => (srcIds.has(l.orderId) ? { ...l, orderId: target.id } : l))
    state = { ...state, notices: state.notices.map(n => (srcIds.has(n.orderId) ? { ...n, orderId: target.id } : n)) }
    guests += src.guestCount ?? 0
    if (src.openedAt < openedAt) openedAt = src.openedAt
  }
  if (tables.length > s.settings.maxMergeTables) fail(`Một nhóm gộp tối đa ${s.settings.maxMergeTables} bàn`)
  state = patchOrder(state, target.id, { tables, guestCount: guests || null, openedAt, billRequestedAt: null })
  return state
}

/** Label each line is delivered under now ("5", "5-A"), to show CHUYỂN TỪ after a move. */
function labelsOf(s: FloorState, ids: Iterable<string>): Map<string, string> {
  const out = new Map<string, string>()
  for (const id of ids) {
    const l = s.lines.find(x => x.id === id)
    const o = l && s.orders.find(x => x.id === l.orderId)
    if (l && o) out.set(id, orderLabel(s, o, l.deliveryTableId))
  }
  return out
}

function markMoved(s: FloorState, from: Map<string, string>, c: Ctx): FloorState {
  return patchLines(s, l => {
    const old = from.get(l.id)
    if (old === undefined || !(isUnfinished(l) || l.status === 'ready')) return l
    const o = s.orders.find(x => x.id === l.orderId)
    return !o || orderLabel(s, o, l.deliveryTableId) === old ? l : { ...l, movedFromLabel: old, movedAt: iso(c) }
  })
}

/**
 * Chuyển bàn. 'move': to a free table, the old one is free at once. 'shared': to an occupied table as a separate
 * order (7-B; needs position labels). For a group, `fromTableId` swaps one table of the group.
 * Unfinished dishes follow the guests (CHUYỂN TỪ on the kitchen screen); served ones keep their history.
 */
export function moveOrder(
  s: FloorState,
  inp: { orderId: string; toTableId: string; fromTableId?: string; mode?: 'move' | 'shared'; positionLabel?: string; existingLabels?: Record<string, string> },
  c: Ctx,
): FloorState {
  floorStaff(c)
  const o = editable(s, inp.orderId, c)
  if (o.kind !== 'dine_in') fail('Đơn mang về không có bàn')
  const from = inp.fromTableId ?? o.tableId!
  if (!o.tables.some(t => t.tableId === from)) fail('Bàn cũ không thuộc đơn')
  const to = getTable(s, inp.toTableId)
  if (!to.active) fail('Bàn đã ngừng sử dụng')
  if (o.tables.some(t => t.tableId === to.id)) fail('Đơn đã ở bàn này')
  const busy = openOrdersAt(s, to.id)
  const mode = inp.mode ?? 'move'
  if (mode === 'move' && busy.length) fail(`Bàn ${to.name} đang có khách: chọn Gộp vào đơn hoặc Thành đơn ghép`)
  let state = s
  if (mode === 'shared') {
    if (!busy.length) fail('Bàn mới đang trống: chuyển bình thường')
    for (const [id, label] of Object.entries(inp.existingLabels ?? {})) if (label.trim()) state = patchOrder(state, id, { positionLabel: label.trim() })
    if (inp.positionLabel?.trim()) state = patchOrder(state, o.id, { positionLabel: inp.positionLabel.trim() })
  }
  const suffix = mode === 'shared' ? nextSuffix(state, to.id) : 'A'
  const tables = o.tables.map(t => (t.tableId === from ? { tableId: to.id, suffix, joinedAt: iso(c) } : t))
  const moved = new Set(state.lines.filter(l => l.orderId === o.id && l.deliveryTableId === from && (isUnfinished(l) || l.status === 'ready')).map(l => l.id))
  const fromLabels = labelsOf(state, moved)
  state = patchOrder(state, o.id, { tables, tableId: o.tableId === from ? to.id : o.tableId })
  state = patchLines(state, l => (moved.has(l.id) ? { ...l, deliveryTableId: to.id } : l))
  state = { ...state, tables: state.tables.map(t => (t.id === to.id ? { ...t, needsCleaning: false } : t)) }
  if (mode === 'shared') checkSharedLabels(state, to.id)
  return markMoved(state, fromLabels, c)
}

/**
 * Chuyển món: a qty below the line's splits it; price, size, options and note travel with it.
 * Waiters move unfinished dishes; moving finished or served ones (money between bills) needs cashier or manager.
 */
export function moveItems(s: FloorState, items: { id: string; qty?: number }[], targetOrderId: string, c: Ctx): FloorState {
  floorStaff(c)
  const target = editable(s, targetOrderId, c)
  if (!items.length) fail('Chọn món cần chuyển')
  let state = s
  const fromLabels = labelsOf(s, items.map(i => i.id))
  const moved = new Map<string, string>()
  const sources = new Set<string>()
  for (const it of items) {
    const l = state.lines.find(x => x.id === it.id) ?? fail('Không tìm thấy món')
    editable(state, l.orderId, c)
    if (l.orderId === target.id) fail('Món đã ở đơn này')
    if (l.status === 'void') fail('Món đã huỷ')
    if ((l.status === 'ready' || l.status === 'served') && c.actor.role === 'waiter') fail('Chuyển món đã xong hoặc đã ra cần thu ngân hoặc quản lý')
    const qty = it.qty ?? l.qty
    if (!Number.isInteger(qty) || qty < 1 || qty > l.qty) fail(`Số lượng chuyển không hợp lệ: ${l.name}`)
    sources.add(l.orderId)
    const delivery = target.kind === 'takeaway' ? null : target.tables.some(t => t.tableId === l.deliveryTableId) ? l.deliveryTableId : target.tableId
    const id = qty < l.qty ? c.newId() : l.id
    const movedLine: Line = { ...l, id, qty, orderId: target.id, deliveryTableId: delivery }
    state = qty < l.qty
      ? { ...state, lines: [...state.lines.map(x => (x.id === l.id ? { ...x, qty: x.qty - qty } : x)), movedLine] }
      : patchLines(state, x => (x.id === l.id ? movedLine : x))
    moved.set(id, fromLabels.get(l.id) ?? '')
  }
  state = markMoved(state, moved, c)
  return staleBill(state, target.id, ...sources)
}

/** Tách đơn: chosen lines go to a new order on the same table (5-B), paid separately. Kitchen keeps cooking. */
export function splitOrder(
  s: FloorState,
  inp: { orderId: string; items: { id: string; qty?: number }[]; positionLabel: string; guestCount: number; sourceLabel?: string },
  c: Ctx,
): { state: FloorState; orderId: string } {
  floorStaff(c)
  cashierUp(c, 'tách đơn')
  const src = editable(s, inp.orderId, c)
  if (src.kind !== 'dine_in') fail('Đơn mang về không tách theo bàn')
  if (!inp.items.length) fail('Chọn món cần tách')
  for (const it of inp.items) if (s.lines.find(l => l.id === it.id)?.orderId !== src.id) fail('Món không thuộc đơn cần tách')
  const labels: Record<string, string> = inp.sourceLabel?.trim() ? { [src.id]: inp.sourceLabel } : {}
  if (!src.positionLabel && !inp.sourceLabel?.trim()) fail('Ghi vị trí ngồi cho đơn gốc (ví dụ: đầu bàn)')
  const r = addSharedOrder(s, { tableId: src.tableId!, guestCount: inp.guestCount, positionLabel: inp.positionLabel, existingLabels: labels }, c)
  // splitting is a cashier job: the new order stays with the same delivery tables
  let state = patchOrder(r.state, r.orderId, { openedAt: src.openedAt })
  state = moveItems(state, inp.items, r.orderId, c)
  return { state, orderId: r.orderId }
}

/** Trả bớt bàn: a table leaves the group once no unfinished dish is still headed there. */
export function releaseTable(s: FloorState, orderId: string, tableId: string, c: Ctx): FloorState {
  floorStaff(c)
  const o = editable(s, orderId, c)
  if (o.tables.length < 2) fail('Đơn chỉ có một bàn: dùng Chuyển bàn hoặc thanh toán')
  if (!o.tables.some(t => t.tableId === tableId)) fail('Bàn không thuộc nhóm')
  const pending = s.lines.filter(l => l.orderId === o.id && l.deliveryTableId === tableId && (isUnfinished(l) || l.status === 'ready'))
  if (pending.length) fail(`Còn ${pending.length} món sẽ ra bàn ${tableName(s, tableId)}: chuyển bàn ra món trước`)
  const tables = o.tables.filter(t => t.tableId !== tableId)
  return patchOrder(s, o.id, { tables, tableId: o.tableId === tableId ? tables[0].tableId : o.tableId })
}

/** Tách một bàn khỏi nhóm gộp: the dishes delivered to that table go back to an order of its own. */
export function splitTableFromGroup(s: FloorState, inp: { orderId: string; tableId: string; guestCount: number }, c: Ctx): { state: FloorState; orderId: string } {
  floorStaff(c)
  cashierUp(c, 'tách bàn khỏi nhóm')
  const o = editable(s, inp.orderId, c)
  if (o.tables.length < 2) fail('Đơn không phải nhóm gộp')
  if (!o.tables.some(t => t.tableId === inp.tableId)) fail('Bàn không thuộc nhóm')
  checkGuests(inp.guestCount)
  const tables = o.tables.filter(t => t.tableId !== inp.tableId)
  let state = patchOrder(s, o.id, {
    tables, tableId: o.tableId === inp.tableId ? tables[0].tableId : o.tableId,
    guestCount: Math.max(1, (o.guestCount ?? 0) - inp.guestCount), billRequestedAt: null,
  })
  const n = blankOrder(c, { tableId: inp.tableId, tables: [{ tableId: inp.tableId, suffix: 'A', joinedAt: iso(c) }], guestCount: inp.guestCount, openedAt: o.openedAt, rounds: o.rounds })
  n.tables[0].suffix = nextSuffix(state, inp.tableId)
  state = { ...state, orders: [...state.orders, n] }
  state = patchLines(state, l => (l.orderId === o.id && l.deliveryTableId === inp.tableId ? { ...l, orderId: n.id } : l))
  return { state, orderId: n.id }
}

// ---------------------------------------------------------------- tạm tính, thanh toán, dọn bàn

/** In tạm tính: Chờ thanh toán (cam). Each reprint is numbered (Lần 2, Lần 3). */
export function requestBill(s: FloorState, orderId: string, c: Ctx): FloorState {
  floorStaff(c)
  const o = editable(s, orderId, c)
  if (!s.lines.some(l => l.orderId === o.id && l.status !== 'void')) fail('Đơn chưa có món')
  return patchOrder(s, o.id, { billRequestedAt: iso(c), billPrintCount: o.billPrintCount + 1 })
}

/** Đang thanh toán: other devices cannot change the order until payment ends or is cancelled. */
export function beginPayment(s: FloorState, orderId: string, c: Ctx): FloorState {
  cashierUp(c, 'thanh toán')
  const o = editable(s, orderId, c)
  return patchOrder(s, o.id, { payingAt: iso(c), payingBy: c.actor.name })
}

export function cancelPayment(s: FloorState, orderId: string, c: Ctx): FloorState {
  cashierUp(c, 'thanh toán')
  getOrder(s, orderId)
  return patchOrder(s, orderId, { payingAt: null, payingBy: null })
}

/** Lines of an order as the bill maths sees them (pricing.ts billTotals / calc_bill). */
export function taxedLines(s: FloorState, orderId: string): TaxedLine[] {
  return s.lines
    .filter(l => l.orderId === orderId && l.status !== 'void')
    .map(l => ({ price: l.price, qty: l.qty, vatRate: l.vatRate, priceIncludesVat: l.priceIncludesVat, discountable: l.discountable, serviceCharge: l.serviceCharge }))
}

/** Bill totals of an open order with a bill discount (% or amount), using the shop's rounding and service charge. */
export function quoteBill(s: FloorState, orderId: string, discount: Discount | null = null) {
  return billTotals(taxedLines(s, orderId), {
    discount,
    serviceChargePct: s.shop.serviceChargePct,
    roundingMode: s.shop.roundingMode,
    roundingUnit: s.shop.roundingUnit,
  })
}

/** Label printed on the bill: '5-B', 'nhóm gộp 3+4+5', 'MV-02'. */
export function billTableLabel(s: FloorState, o: Order): string {
  return groupLabel(s, o) || orderLabel(s, o)
}

export interface PayInput {
  /** Bill discount as the cashier entered it; the bill stores the amount. */
  discount?: Discount | null
  discountReason?: string
  /** Token from verify_manager_pin for a discount by a cashier (bound to the order and the amount). */
  approval?: string
  /** Amounts add up to the total; cash may carry `tendered` above its amount (change). */
  payments: (PaymentInput & { ref?: string })[]
  register?: string
}

export function needsManagerForDiscount(role: Actor['role'], discount: number): boolean {
  return discount > 0 && !isManager(role)
}

/**
 * Thanh toán: one bill for the order, split over any mix of cash, transfer and card (pay_order in SQL).
 * The settled amounts must equal the rounded total exactly; only cash may be handed over above it (change).
 * A bill discount needs a reason and a manager (PIN). Money goes into the register's open shift.
 * Unfinished dishes stay on the kitchen screen. A table is free once every order on it is closed,
 * or Chờ dọn when the shop turns cleaning on.
 */
export function payOrder(s: FloorState, orderId: string, inp: PayInput, c: Ctx): { state: FloorState; billId: string } {
  cashierUp(c, 'thanh toán')
  const o = editable(s, orderId, c)
  const shift = openShiftOf(s.shifts, inp.register ?? DEFAULT_REGISTER) ?? fail('Chưa mở ca thu ngân: mở ca trước khi thu tiền')
  if (!s.lines.some(l => l.orderId === o.id && l.status !== 'void')) fail('Đơn chưa có món')
  const bill = quoteBill(s, o.id, inp.discount ?? null)
  const reason = (inp.discountReason ?? '').trim()
  if (bill.discount > 0) {
    if (!reason) fail('Chọn lý do giảm giá')
    approval(c, inp.approval, { action: 'discount', orderId: o.id, amount: bill.discount }, 'Giảm giá hoá đơn cần quản lý nhập mã PIN')
  }
  for (const p of inp.payments) {
    if (!['cash', 'bank', 'card'].includes(p.method)) fail('Cách trả không hợp lệ')
    if (!Number.isInteger(p.amount) || p.amount <= 0) fail('Số tiền mỗi khoản phải là số đồng dương')
    if (p.tendered != null && (p.method !== 'cash' || !Number.isInteger(p.tendered) || p.tendered < p.amount)) fail('Tiền khách đưa chỉ ghi cho tiền mặt và không nhỏ hơn số thu')
  }
  const nonCash = inp.payments.filter(p => p.method !== 'cash').reduce((n, p) => n + p.amount, 0)
  if (nonCash > bill.total) fail('Chuyển khoản và thẻ không được vượt số phải thu')
  const paid = inp.payments.reduce((n, p) => n + p.amount, 0)
  if (paid !== bill.total) fail(`Tổng thanh toán ${paid} khác số phải trả ${bill.total}`)
  // same rule the cashier screen shows (settle): kept here so a direct call cannot close a short bill
  if (!settle(bill.total, inp.payments.map(p => ({ ...p, confirmed: true }))).canSettle) fail('Chưa thu đủ tiền')

  const t = iso(c)
  const seq = Math.max(0, ...s.bills.map(b => Number(b.billNo.replace(/\D/g, '')) || 0)) + 1
  const row: Bill = {
    id: c.newId(), orderId: o.id, billNo: 'HD' + String(seq).padStart(6, '0'), tableLabel: billTableLabel(s, o),
    subtotal: bill.subtotal, discount: bill.discount, discountReason: bill.discount > 0 ? reason : '', serviceCharge: bill.serviceCharge,
    vatAdded: bill.vatAdded, vatTotal: bill.vatTotal, rounding: bill.rounding, total: bill.total, vatLines: bill.vat,
    payments: inp.payments.map(p => ({
      id: c.newId(), method: p.method, amount: p.amount, tendered: p.method === 'cash' && p.tendered != null && p.tendered > p.amount ? p.tendered : null,
      ref: (p.ref ?? '').trim().slice(0, 40), receivedBy: c.actor.name, receivedAt: t,
    })),
    cashier: c.actor.name, paidAt: t, shiftId: shift.id, printCount: 0, lastPrintAt: null, lastPrintBy: '',
  }
  let state = patchOrder({ ...s, bills: [...s.bills, row] }, o.id, { status: 'paid', closedAt: t, payingAt: null, payingBy: null })
  if (s.settings.requireCleaning) {
    const free = new Set(o.tables.map(x => x.tableId).filter(id => openOrdersAt(state, id).length === 0))
    state = { ...state, tables: state.tables.map(x => (free.has(x.id) ? { ...x, needsCleaning: true } : x)) }
  }
  return { state, billId: row.id }
}

/** One more receipt printed for a bill (print_bill). The 2nd and later print "IN LẠI – lần n". */
export function printBill(s: FloorState, billId: string, c: Ctx): { state: FloorState; count: number } {
  cashierUp(c, 'in hoá đơn')
  const b = s.bills.find(x => x.id === billId) ?? fail('Không tìm thấy hoá đơn')
  const count = b.printCount + 1
  return { state: { ...s, bills: s.bills.map(x => (x.id === billId ? { ...x, printCount: count, lastPrintAt: iso(c), lastPrintBy: c.actor.name } : x)) }, count }
}

// ---------------------------------------------------------------- ca thu ngân

export const DEFAULT_REGISTER = 'Quầy 1'

/** Mở ca: one open shift per register, with the opening float (tiền lẻ đầu ca). */
export function openShift(s: FloorState, inp: { openingFloat: number; register?: string }, c: Ctx): { state: FloorState; shiftId: string } {
  cashierUp(c, 'mở ca')
  const register = inp.register ?? DEFAULT_REGISTER
  if (openShiftOf(s.shifts, register)) fail(`${register} đang có ca mở: chốt ca cũ trước`)
  if (!Number.isInteger(inp.openingFloat) || inp.openingFloat < 0) fail('Tiền đầu ca phải là số đồng không âm')
  const sh: Shift = {
    id: c.newId(), register, openedBy: c.actor.name, openedAt: iso(c), openingFloat: inp.openingFloat,
    closedAt: null, closedBy: null, countedCash: null, countedDetail: {}, expectedCash: null, note: '',
  }
  return { state: { ...s, shifts: [...s.shifts, sh] }, shiftId: sh.id }
}

/**
 * Chốt ca: the counted cash (by note) is compared with opening float + cash taken. A difference needs a note.
 * Refused while an order is on someone's payment screen.
 */
export function closeShift(s: FloorState, inp: { shiftId: string; countedDetail: Record<string, number>; note?: string }, c: Ctx): FloorState {
  cashierUp(c, 'chốt ca')
  const sh = s.shifts.find(x => x.id === inp.shiftId) ?? fail('Không tìm thấy ca')
  if (sh.closedAt) fail('Ca đã chốt')
  if (s.orders.some(o => isOpen(o) && o.payingAt)) fail('Còn đơn đang thanh toán: thu xong hoặc huỷ thanh toán trước khi chốt ca')
  let counted: number
  try {
    counted = countedTotal(inp.countedDetail)
  } catch (e) {
    fail((e as Error).message)
  }
  const expected = shiftSummary(sh, s.bills).expectedCash
  const note = (inp.note ?? '').trim()
  if (counted !== expected && !note) fail('Két lệch so với dự kiến: ghi lý do')
  const detail = Object.fromEntries(Object.entries(inp.countedDetail).filter(([, n]) => n > 0))
  return {
    ...s,
    shifts: s.shifts.map(x => (x.id === sh.id ? { ...x, closedAt: iso(c), closedBy: c.actor.name, countedCash: counted, countedDetail: detail, expectedCash: expected, note } : x)),
  }
}

/** Dọn xong: Chờ dọn → Trống. */
export function markClean(s: FloorState, tableId: string, c: Ctx): FloorState {
  floorStaff(c)
  getTable(s, tableId)
  return { ...s, tables: s.tables.map(t => (t.id === tableId ? { ...t, needsCleaning: false } : t)) }
}

// ---------------------------------------------------------------- khu vực và bàn

function managerOnly(c: Ctx) {
  if (!isManager(c.actor.role)) fail('Chỉ quản lý được sửa khu vực và bàn')
}

export function saveArea(s: FloorState, a: Area, c: Ctx): FloorState {
  managerOnly(c)
  if (!a.name.trim()) fail('Nhập tên khu vực')
  if (!a.active && s.tables.some(t => t.areaId === a.id && openOrdersAt(s, t.id).length)) fail('Khu còn đơn chưa thanh toán: chưa tạm đóng được')
  const exists = s.areas.some(x => x.id === a.id)
  return { ...s, areas: exists ? s.areas.map(x => (x.id === a.id ? { ...a, name: a.name.trim() } : x)) : [...s.areas, { ...a, name: a.name.trim() }] }
}

export function saveTable(s: FloorState, t: Table, c: Ctx): FloorState {
  if (!(t.temporary && c.actor.role === 'cashier')) managerOnly(c)
  const name = t.name.trim()
  if (!name) fail('Nhập tên bàn')
  if (!Number.isInteger(t.seats) || t.seats < 1 || t.seats > 99) fail('Số ghế từ 1 đến 99')
  if (s.tables.some(x => x.id !== t.id && x.active && x.areaId === t.areaId && x.name.toLowerCase() === name.toLowerCase())) fail(`Khu này đã có bàn "${name}"`)
  if (s.tables.some(x => x.id !== t.id && x.active && x.name.toLowerCase() === name.toLowerCase())) fail(`Đã có bàn "${name}" ở khu khác: đặt tên khác để bếp không nhầm`)
  if (!t.active && openOrdersAt(s, t.id).length) fail('Bàn còn đơn chưa thanh toán: chưa ngừng dùng được')
  const exists = s.tables.some(x => x.id === t.id)
  const row = { ...t, name }
  return { ...s, tables: exists ? s.tables.map(x => (x.id === t.id ? row : x)) : [...s.tables, row] }
}

