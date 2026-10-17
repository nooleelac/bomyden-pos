// FloorRepo on Supabase (0001–0006). Every change goes through an RPC that checks the role and prices lines on
// the server (send_order_lines), so the screens never send a price. Realtime on orders, lines, notices and
// tables reloads every device; the floor state is one call (get_floor_state, 0008).
// Not exercised against a live project yet: the screens run on createMemoryFloorRepo; the SQL is tested on a
// local Postgres 16 (supabase/tests). Who is calling comes from the staff session (src/auth, 0006).

import type { SupabaseClient } from '@supabase/supabase-js'
import { SAMPLE_SHOP } from '../cashier/config'
import { discountAmount, type PayMethod } from '../lib/billing'
import type { VatGroup } from '../lib/pricing'
import type { Menu } from '../menu/types'
import { newId } from '../menu/repo'
import * as E from './engine'
import type { FloorRepo } from './repo'
import type { Actor, Bill, FloorState, Line, LineMod, LineStatus, Notice, Order, Role, Shift } from './types'

// realtime channels need a fresh name per listener (the app frame and a screen may listen to the same tables)
let channelNo = 0

type Row = Record<string, unknown>
type Res<T> = PromiseLike<{ data: T | null; error: { message: string } | null }>

async function rows(q: Res<Row[]>): Promise<Row[]> {
  const { data, error } = await q
  if (error) throw new Error(error.message)
  return data ?? []
}
async function rpc<T = Row>(db: SupabaseClient, fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await db.rpc(fn, args)
  if (error) throw new Error(error.message)
  return data as T
}
async function ok(q: PromiseLike<{ error: { message: string } | null }>): Promise<void> {
  const { error } = await q
  if (error) throw new Error(error.message)
}

const s = (v: unknown) => (v == null ? '' : String(v))
const sn = (v: unknown) => (v == null ? null : String(v))
const n = (v: unknown) => Number(v ?? 0)
const nn = (v: unknown) => (v == null ? null : Number(v))
const idOf = (r: unknown) => s((r as Row | null)?.id)

export interface SupabaseFloorOptions {
  /** The loaded menu, for this device's own changes shown before the server answers (engine transitions). */
  menu?: () => Menu | null
  /** Who is signed in on this tab. */
  actor?: () => Actor
}

export function createSupabaseFloorRepo(db: SupabaseClient, opts: SupabaseFloorOptions = {}): FloorRepo & { whoAmI(): Promise<Actor | null> } {
  const listeners = new Set<(state?: FloorState) => void>()
  let cache: FloorState | null = null // last loaded state, with this device's changes on top
  let loadNo = 0

  async function load(): Promise<FloorState> {
    const no = ++loadNo
    // one round trip (get_floor_state, 0008); the server keeps 4 hours of closed orders, tickets and notices (the
    // done list shows 2) and 7 days of shifts
    const t0 = Date.now()
    const st = await rpc<Record<string, Row[] | string>>(db, 'get_floor_state', {})
    const clockOffset = st.now ? new Date(st.now as string).getTime() - (t0 + Date.now()) / 2 : 0
    const list = (k: string) => (st[k] as Row[] | undefined) ?? []
    const [shop, stations, areas, tables, staff, orders, notices, tickets, shifts, bills, memberships, items] = [
      'shop', 'stations', 'areas', 'tables', 'staff', 'orders', 'notices', 'tickets', 'shifts', 'bills', 'order_tables', 'items',
    ].map(list)
    const names = new Map(staff.map(x => [x.id, s(x.name)]))
    const name = (id: unknown) => names.get(id) ?? ''

    const toOrder = (o: Row): Order => ({
      id: s(o.id), kind: o.kind === 'takeaway' ? 'takeaway' : 'dine_in', takeawayNo: nn(o.takeaway_no), customerName: s(o.customer_name),
      tableId: sn(o.table_id),
      tables: memberships.filter(m => m.order_id === o.id).map(m => ({ tableId: s(m.table_id), suffix: s(m.suffix), joinedAt: s(m.joined_at) })),
      guestCount: nn(o.guest_count), positionLabel: s(o.position_label), note: s(o.note), allergy: o.allergy === true,
      status: o.status as Order['status'], openedAt: s(o.opened_at), openedBy: name(o.opened_by), closedAt: sn(o.closed_at),
      mergedInto: sn(o.merged_into), rounds: n(o.rounds), billRequestedAt: sn(o.bill_requested_at), billPrintCount: n(o.bill_print_count),
      payingAt: sn(o.paying_at), payingBy: o.paying_by ? name(o.paying_by) : null, chasedAt: sn(o.chased_at), chaseCount: n(o.chase_count),
    })
    const toLine = (i: Row): Line => {
      const ms = (i.mods as Row[] | null) ?? []
      return {
        id: s(i.id), orderId: s(i.order_id), originOrderId: s(i.origin_order_id ?? i.order_id), menuItemId: s(i.menu_item_id), name: s(i.name),
        shortName: s(i.name).toUpperCase(), variantId: sn(i.variant_id), variantName: s(i.variant_name), qty: n(i.qty), price: n(i.price),
        stationId: s(i.station_id), status: i.status as LineStatus, note: s(i.note),
        mods: ms.map((m): LineMod => ({ kind: m.kind as LineMod['kind'], name: s(m.name), kitchenName: s(m.kitchen_name), qty: n(m.qty), unitDelta: n(m.unit_delta) })),
        deliveryTableId: sn(i.delivery_table_id), round: n(i.round), sendBatch: s(i.send_batch), sentAt: s(i.sent_at), sentBy: name(i.created_by),
        rush: i.rush === true, rushReason: s(i.rush_reason), startedAt: sn(i.started_at), readyAt: sn(i.ready_at), servedAt: sn(i.served_at),
        voidReason: s(i.void_reason), voidedAt: sn(i.voided_at), voidStage: (i.void_stage as LineStatus | null) ?? null, replacedBy: sn(i.replaced_by),
        movedFromLabel: s(i.moved_from_label), movedAt: sn(i.moved_at),
        options: Object.fromEntries(ms.filter(m => m.option_id).map(m => [s(m.option_id), n(m.qty)])),
        removals: ms.filter(m => m.component_id).map(m => s(m.component_id)),
        vatRate: n(i.vat_rate), priceIncludesVat: i.price_includes_vat !== false, discountable: i.discountable !== false, serviceCharge: i.service_charge !== false,
      }
    }
    const toBill = (b: Row): Bill => ({
      id: s(b.id), orderId: s(b.order_id), billNo: s(b.bill_no), tableLabel: s(b.table_label), subtotal: n(b.subtotal), discount: n(b.discount),
      discountReason: s(b.discount_reason), serviceCharge: n(b.service_charge), vatAdded: n(b.vat_added), vatTotal: n(b.vat_total), rounding: n(b.rounding),
      total: n(b.total),
      vatLines: ((b.vat_lines as Row[] | null) ?? []).map((v): VatGroup => ({ vatRate: n(v.vat_rate), priceIncludesVat: v.price_includes_vat !== false, base: n(v.base), vat: n(v.vat) })),
      payments: ((b.payments as Row[] | null) ?? []).map(p => ({
          id: s(p.id), method: p.method as PayMethod, amount: n(p.amount), tendered: nn(p.tendered), ref: s(p.ref),
          receivedBy: name(p.received_by), receivedAt: s(p.received_at ?? b.paid_at),
        })),
      cashier: name(b.cashier_id), paidAt: s(b.paid_at), shiftId: sn(b.shift_id), printCount: n(b.print_count),
      lastPrintAt: sn(b.last_print_at), lastPrintBy: b.last_print_by ? name(b.last_print_by) : '',
    })
    const toShift = (x: Row): Shift => ({
      id: s(x.id), register: s(x.register), openedBy: name(x.opened_by), openedAt: s(x.opened_at), openingFloat: n(x.opening_float),
      closedAt: sn(x.closed_at), closedBy: x.closed_by ? name(x.closed_by) : null, countedCash: nn(x.counted_cash),
      countedDetail: Object.fromEntries(Object.entries((x.counted_detail as Record<string, unknown> | null) ?? {}).map(([k, v]) => [k, n(v)])),
      expectedCash: nn(x.expected_cash), note: s(x.note),
    })
    const toNotice = (x: Row): Notice => ({
      id: s(x.id), kind: x.kind as Notice['kind'], orderId: s(x.order_id), lineId: sn(x.order_item_id), stationId: sn(x.station_id),
      sendBatch: sn(x.send_batch), text: s(x.text), before: s(x.before), createdAt: s(x.created_at), createdBy: name(x.created_by),
      ackAt: sn(x.ack_at), status: x.status as Notice['status'], payload: (x.payload as Notice['payload']) ?? null,
    })
    const sh = shop[0] ?? {}
    const out: FloorState = {
      settings: {
        maxOrdersPerTable: n(sh.max_orders_per_table ?? 4),
        maxMergeTables: n(sh.max_merge_tables ?? 30),
        requireCleaning: sh.require_table_cleaning !== false,
        waiterSeesAmounts: sh.waiter_sees_amounts === true,
        businessDayStart: s(sh.business_day_start || '06:00').slice(0, 5),
        voidApproval: sh.void_approval === 'started' ? 'started' : 'sent',
        timing: Object.fromEntries(stations.map(st => [s(st.id), { warn: n(st.sla_warn_min), late: n(st.sla_late_min) }])),
      },
      areas: areas.map(a => ({ id: s(a.id), name: s(a.name), sort: n(a.sort), active: a.active !== false })),
      tables: tables.map(t => ({
        id: s(t.id), areaId: s(t.area_id), name: s(t.name), seats: n(t.seats ?? 4), sort: n(t.sort), active: t.active !== false,
        temporary: t.is_temporary === true, needsCleaning: t.needs_cleaning === true,
      })),
      orders: orders.map(toOrder),
      lines: items.map(toLine),
      notices: notices.map(toNotice),
      tickets: tickets.map(t => ({ key: s(t.key), bumpedAt: sn(t.bumped_at), recalledAt: sn(t.recalled_at), recallCount: n(t.recall_count) })),
      bills: bills.map(toBill),
      shifts: shifts.map(toShift),
      shop: {
        name: s(sh.shop_name) || SAMPLE_SHOP.name, address: s(sh.address), phone: s(sh.phone), taxCode: s(sh.tax_code),
        bankBin: s(sh.bank_bin), bankName: s(sh.bank_name), bankAccount: s(sh.bank_account), bankAccountName: s(sh.bank_account_name),
        footer: s(sh.receipt_footer), serviceChargePct: n(sh.service_charge_pct), roundingMode: sh.rounding_mode === 'nearest' ? 'nearest' : 'down',
        roundingUnit: n(sh.rounding_unit ?? 1000) || 1000,
      },
      clockOffset,
    }
    if (no === loadNo) cache = out
    return out
  }

  // This device shows a change at once instead of after RPC → Realtime → reload: the engine's own transition (the
  // one the sample floor runs) is applied to the last loaded state, and the state is reloaded as soon as the RPC
  // returns. A guess the engine refuses is skipped (the server gives the real error); an RPC error reloads too,
  // which takes the guess back. Realtime still brings every other device's changes.
  async function act<T>(run: () => Promise<T>, guess?: (st: FloorState, c: E.Ctx) => FloorState): Promise<T> {
    const menu = guess && cache ? opts.menu?.() : null
    if (guess && cache && menu) {
      try {
        const c: E.Ctx = { now: new Date(Date.now() + (cache.clockOffset ?? 0)), actor: opts.actor?.() ?? { name: '', role: 'waiter' }, menu, newId }
        const next = guess(cache, c)
        loadNo++ // a load already on its way predates this change
        cache = next
        listeners.forEach(f => f(next))
      } catch {
        /* the server decides */
      }
    }
    try {
      return await run()
    } finally {
      listeners.forEach(f => f())
    }
  }
  const call = (fn: string, args: Record<string, unknown>, guess?: (st: FloorState, c: E.Ctx) => FloorState) =>
    act(() => rpc(db, fn, args), guess).then(() => undefined)
  const callId = (fn: string, args: Record<string, unknown>) => act(() => rpc(db, fn, args)).then(idOf)

  return {
    source: 'supabase',
    load,
    async whoAmI() {
      const id = await rpc<string | null>(db, 'my_staff_id', {})
      if (!id) return null
      const r = await rows(db.from('staff').select('name, role').eq('id', id))
      return r[0] ? { name: s(r[0].name), role: r[0].role as Role } : null
    },
    subscribe(onChange) {
      let t: ReturnType<typeof setTimeout> | null = null
      const fire = () => {
        if (t) clearTimeout(t)
        t = setTimeout(() => onChange(), 80) // one reload for a burst of row changes
      }
      const ch = db.channel(`floor-changes-${++channelNo}`) // one channel per listener: a second .on() on a subscribed channel throws
      for (const table of ['orders', 'order_items', 'order_tables', 'kitchen_notices', 'ticket_states', 'tables', 'areas', 'bills', 'shifts']) {
        ch.on('postgres_changes', { event: '*', schema: 'public', table }, fire)
      }
      ch.subscribe()
      listeners.add(onChange)
      return () => {
        if (t) clearTimeout(t)
        listeners.delete(onChange)
        void db.removeChannel(ch)
      }
    },
    openTable: inp => callId('open_table', { p_table: inp.tableId, p_guests: inp.guestCount, p_extra: inp.extraTableIds ?? [], p_label: inp.positionLabel ?? null }),
    addSharedOrder: inp => callId('add_shared_order', { p_table: inp.tableId, p_guests: inp.guestCount, p_label: inp.positionLabel, p_existing: inp.existingLabels ?? {} }),
    openTakeaway: inp => callId('open_takeaway', { p_customer: inp.customerName ?? '' }),
    updateOrder(id, p) {
      const row: Row = {}
      if (p.guestCount !== undefined) row.guest_count = p.guestCount
      if (p.positionLabel !== undefined) row.position_label = p.positionLabel.trim() || null
      if (p.note !== undefined) row.note = p.note.trim()
      if (p.allergy !== undefined) row.allergy = p.allergy
      return act(() => ok(db.from('orders').update(row).eq('id', id)))
    },
    closeEmptyOrder: id => act(() => ok(db.from('orders').update({ status: 'void' }).eq('id', id))),
    sendLines: (orderId, lines, batch, o) =>
      call('send_order_lines', { p_order: orderId, p_lines: lines, p_batch: batch, p_rush_reason: o.rush ? o.rushReason : null }, (st, c) =>
        E.sendLines(st, orderId, lines, batch, o, c).state),
    // A non-manager passes the approval token from verify_manager_pin; void_item checks it again (0006).
    voidLine: (id, inp) => call('void_item', { p_line: id, p_qty: inp.qty, p_reason: inp.reason, p_note: inp.reasonNote ?? null, p_approval: inp.approval ?? null }),
    voidOrder: (id, inp) => call('void_order', { p_order: id, p_reason: inp.reason, p_note: inp.reasonNote ?? null, p_approval: inp.approval ?? null }),
    modifyLine: (id, line) => call('modify_item', { p_line: id, p_new: line }),
    decideModify: (id, accept) => call('decide_modify', { p_notice: id, p_accept: accept }),
    ackNotice: id => call('ack_notice', { p_notice: id }, (st, c) => E.ackNotice(st, id, c)),
    setLineStatus: (ids, to) => call('set_item_status', { p_ids: ids, p_to: to }, (st, c) => E.setLineStatus(st, ids, to, c)),
    bumpTicket: key => call('bump_ticket', { p_key: key }, (st, c) => E.bumpTicket(st, key, c)),
    recallTicket: key => call('recall_ticket', { p_key: key }, (st, c) => E.recallTicket(st, key, c)),
    chaseOrder: id => call('chase_order', { p_order: id }, (st, c) => E.chaseOrder(st, id, c)),
    mergeOrders: (target, sources) => call('merge_orders', { p_target: target, p_sources: sources }),
    moveOrder: inp =>
      call('move_order', {
        p_order: inp.orderId, p_to: inp.toTableId, p_from: inp.fromTableId ?? null, p_mode: inp.mode ?? 'move',
        p_label: inp.positionLabel ?? null, p_existing: inp.existingLabels ?? {},
      }),
    moveItems: (items, target) => call('move_items', { p_items: items, p_target: target }),
    splitOrder: inp =>
      callId('split_order', { p_order: inp.orderId, p_items: inp.items, p_position_label: inp.positionLabel, p_guest_count: inp.guestCount, p_source_label: inp.sourceLabel ?? null }),
    releaseTable: (orderId, tableId) => call('release_table', { p_order: orderId, p_table: tableId }),
    splitTableFromGroup: inp => callId('split_table_from_group', { p_order: inp.orderId, p_table: inp.tableId, p_guests: inp.guestCount }),
    requestBill: id => call('request_bill', { p_order: id }, (st, c) => E.requestBill(st, id, c)),
    beginPayment: id => call('begin_payment', { p_order: id }),
    cancelPayment: id => call('cancel_payment', { p_order: id }),
    // The screen sends the discount as an amount (a % is turned into đồng by billTotals, the same way calc_bill
    // would); the server recomputes the total and refuses payments that do not add up to it.
    // A cashier's discount carries the approval token (bound to this order and at most the approved amount).
    // The discount base comes from the loaded lines (what the cashier sees); a select only before the first load.
    async payOrder(id, inp) {
      const lines: Row[] = cache
        ? cache.lines.filter(l => l.orderId === id && l.status !== 'void').map(l => ({ price: l.price, qty: l.qty, discountable: l.discountable }))
        : await rows(db.from('order_items').select('price, qty, discountable').eq('order_id', id).neq('status', 'void'))
      const base = lines.filter(l => l.discountable !== false).reduce((t, l) => t + n(l.price) * n(l.qty), 0)
      const amount = discountAmount(base, inp.discount ?? null)
      return callId('pay_order', {
        p_order: id,
        p_discount: amount,
        p_payments: inp.payments.map(p => ({ method: p.method, amount: p.amount, ...(p.tendered != null ? { tendered: p.tendered } : {}), ref: p.ref ?? '' })),
        p_discount_reason: inp.discountReason ?? null,
        p_register: inp.register ?? 'Quầy 1',
        p_approval: inp.approval ?? null,
      })
    },
    printBill: id => act(() => rpc<number>(db, 'print_bill', { p_bill: id })).then(n),
    openShift: inp => callId('open_shift', { p_float: inp.openingFloat, p_register: inp.register ?? 'Quầy 1' }),
    closeShift: inp => call('close_shift', { p_shift: inp.shiftId, p_detail: inp.countedDetail, p_note: inp.note ?? '' }),
    markClean: id => call('mark_table_clean', { p_table: id }),
    saveArea: a => act(() => ok(db.from('areas').upsert({ id: a.id, name: a.name.trim(), sort: a.sort, active: a.active }))),
    saveTable: t =>
      act(async () => {
        const row = { id: t.id, area_id: t.areaId, name: t.name.trim(), seats: t.seats, sort: t.sort, active: t.active, is_temporary: t.temporary }
        const exists = (await rows(db.from('tables').select('id').eq('id', t.id))).length > 0
        await ok(exists ? db.from('tables').update(row).eq('id', t.id) : db.from('tables').insert(row))
      }),
  }
}
