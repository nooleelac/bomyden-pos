// FloorRepo on Supabase (0001–0006). Every change goes through an RPC that checks the role and prices lines on
// the server (send_order_lines), so the screens never send a price. Realtime on orders, lines, notices and
// tables reloads every device within a second or two.
// Not exercised against a live project yet: the screens run on createMemoryFloorRepo; the SQL is tested on a
// local Postgres 16 (supabase/tests). Who is calling comes from the staff session (src/auth, 0006).

import type { SupabaseClient } from '@supabase/supabase-js'
import { SAMPLE_SHOP } from '../cashier/config'
import { discountAmount, type PayMethod } from '../lib/billing'
import type { VatGroup } from '../lib/pricing'
import type { FloorRepo } from './repo'
import type { Actor, Bill, FloorState, Line, LineMod, LineStatus, Notice, Order, Role, Shift } from './types'

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
async function chunked(ids: string[], f: (part: string[]) => Promise<Row[]>): Promise<Row[]> {
  const out: Row[] = []
  for (let i = 0; i < ids.length; i += 100) out.push(...(await f(ids.slice(i, i + 100))))
  return out
}

const s = (v: unknown) => (v == null ? '' : String(v))
const sn = (v: unknown) => (v == null ? null : String(v))
const n = (v: unknown) => Number(v ?? 0)
const nn = (v: unknown) => (v == null ? null : Number(v))
const idOf = (r: unknown) => s((r as Row | null)?.id)

/** How far back closed orders, done tickets and notices are loaded (done list keeps 2 hours). */
const KEEP_MS = 4 * 3600_000

export function createSupabaseFloorRepo(db: SupabaseClient): FloorRepo & { whoAmI(): Promise<Actor | null> } {
  async function load(): Promise<FloorState> {
    const t0 = Date.now()
    const serverNow = await rpc<string>(db, 'server_now', {}).catch(() => null)
    const clockOffset = serverNow ? new Date(serverNow).getTime() - (t0 + Date.now()) / 2 : 0
    const since = new Date(Date.now() + clockOffset - KEEP_MS).toISOString()
    const [shop, stations, areas, tables, staff, orders, notices, tickets, shifts] = await Promise.all([
      rows(db.from('shop_settings').select('*').limit(1)),
      rows(db.from('stations').select('id, sla_warn_min, sla_late_min')),
      rows(db.from('areas').select('*').order('sort')),
      rows(db.from('tables').select('*').order('sort')),
      rows(db.from('staff').select('id, name')),
      rows(db.from('orders').select('*').or(`status.eq.open,closed_at.gt.${since}`)),
      rows(db.from('kitchen_notices').select('*').gt('created_at', since)),
      rows(db.from('ticket_states').select('*').or(`bumped_at.gt.${since},recalled_at.gt.${since}`)),
      rows(db.from('shifts').select('*').or(`closed_at.is.null,closed_at.gt.${new Date(Date.now() + clockOffset - 7 * 86400_000).toISOString()}`).order('opened_at')),
    ])
    // bills: recent ones (reprint) and every bill of the open shifts (shift close)
    const openShiftIds = shifts.filter(x => x.closed_at == null).map(x => s(x.id))
    const bills = await rows(
      db.from('bills').select('*').or(openShiftIds.length ? `paid_at.gt.${since},shift_id.in.(${openShiftIds.join(',')})` : `paid_at.gt.${since}`).order('paid_at'),
    )
    const payments = await chunked(bills.map(b => s(b.id)), part => rows(db.from('payments').select('*').in('bill_id', part)))
    const orderIds = orders.map(o => s(o.id))
    const [memberships, items] = await Promise.all([
      chunked(orderIds, part => rows(db.from('order_tables').select('order_id, table_id, suffix, joined_at').in('order_id', part).is('left_at', null))),
      chunked(orderIds, part => rows(db.from('order_items').select('*').in('order_id', part))),
    ])
    const mods = await chunked(items.map(i => s(i.id)), part => rows(db.from('order_item_modifiers').select('*').in('order_item_id', part)))
    const name = (id: unknown) => s(staff.find(x => x.id === id)?.name)

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
      const ms = mods.filter(m => m.order_item_id === i.id)
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
      payments: payments
        .filter(p => p.bill_id === b.id)
        .map(p => ({
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
    return {
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
  }

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
        t = setTimeout(onChange, 150) // one reload for a burst of row changes
      }
      const ch = db.channel('floor-changes')
      for (const table of ['orders', 'order_items', 'order_tables', 'kitchen_notices', 'ticket_states', 'tables', 'areas', 'bills', 'shifts']) {
        ch.on('postgres_changes', { event: '*', schema: 'public', table }, fire)
      }
      ch.subscribe()
      return () => {
        if (t) clearTimeout(t)
        void db.removeChannel(ch)
      }
    },
    openTable: async inp => idOf(await rpc(db, 'open_table', { p_table: inp.tableId, p_guests: inp.guestCount, p_extra: inp.extraTableIds ?? [], p_label: inp.positionLabel ?? null })),
    addSharedOrder: async inp =>
      idOf(await rpc(db, 'add_shared_order', { p_table: inp.tableId, p_guests: inp.guestCount, p_label: inp.positionLabel, p_existing: inp.existingLabels ?? {} })),
    openTakeaway: async inp => idOf(await rpc(db, 'open_takeaway', { p_customer: inp.customerName ?? '' })),
    async updateOrder(id, p) {
      const row: Row = {}
      if (p.guestCount !== undefined) row.guest_count = p.guestCount
      if (p.positionLabel !== undefined) row.position_label = p.positionLabel.trim() || null
      if (p.note !== undefined) row.note = p.note.trim()
      if (p.allergy !== undefined) row.allergy = p.allergy
      await ok(db.from('orders').update(row).eq('id', id))
    },
    closeEmptyOrder: id => ok(db.from('orders').update({ status: 'void' }).eq('id', id)),
    sendLines: async (orderId, lines, batch, o) => void (await rpc(db, 'send_order_lines', { p_order: orderId, p_lines: lines, p_batch: batch, p_rush_reason: o.rush ? o.rushReason : null })),
    // A non-manager passes the approval token from verify_manager_pin; void_item checks it again (0006).
    voidLine: async (id, inp) =>
      void (await rpc(db, 'void_item', { p_line: id, p_qty: inp.qty, p_reason: inp.reason, p_note: inp.reasonNote ?? null, p_approval: inp.approval ?? null })),
    voidOrder: async (id, inp) => void (await rpc(db, 'void_order', { p_order: id, p_reason: inp.reason, p_note: inp.reasonNote ?? null, p_approval: inp.approval ?? null })),
    modifyLine: async (id, line) => void (await rpc(db, 'modify_item', { p_line: id, p_new: line })),
    decideModify: async (id, accept) => void (await rpc(db, 'decide_modify', { p_notice: id, p_accept: accept })),
    ackNotice: async id => void (await rpc(db, 'ack_notice', { p_notice: id })),
    setLineStatus: async (ids, to) => void (await rpc(db, 'set_item_status', { p_ids: ids, p_to: to })),
    bumpTicket: async key => void (await rpc(db, 'bump_ticket', { p_key: key })),
    recallTicket: async key => void (await rpc(db, 'recall_ticket', { p_key: key })),
    chaseOrder: async id => void (await rpc(db, 'chase_order', { p_order: id })),
    mergeOrders: async (target, sources) => void (await rpc(db, 'merge_orders', { p_target: target, p_sources: sources })),
    moveOrder: async inp =>
      void (await rpc(db, 'move_order', {
        p_order: inp.orderId, p_to: inp.toTableId, p_from: inp.fromTableId ?? null, p_mode: inp.mode ?? 'move',
        p_label: inp.positionLabel ?? null, p_existing: inp.existingLabels ?? {},
      })),
    moveItems: async (items, target) => void (await rpc(db, 'move_items', { p_items: items, p_target: target })),
    splitOrder: async inp =>
      idOf(await rpc(db, 'split_order', { p_order: inp.orderId, p_items: inp.items, p_position_label: inp.positionLabel, p_guest_count: inp.guestCount, p_source_label: inp.sourceLabel ?? null })),
    releaseTable: async (orderId, tableId) => void (await rpc(db, 'release_table', { p_order: orderId, p_table: tableId })),
    splitTableFromGroup: async inp => idOf(await rpc(db, 'split_table_from_group', { p_order: inp.orderId, p_table: inp.tableId, p_guests: inp.guestCount })),
    requestBill: async id => void (await rpc(db, 'request_bill', { p_order: id })),
    beginPayment: async id => void (await rpc(db, 'begin_payment', { p_order: id })),
    cancelPayment: async id => void (await rpc(db, 'cancel_payment', { p_order: id })),
    // The screen sends the discount as an amount (a % is turned into đồng by billTotals, the same way calc_bill
    // would); the server recomputes the total and refuses payments that do not add up to it.
    // A cashier's discount carries the approval token (bound to this order and at most the approved amount).
    async payOrder(id, inp) {
      const lines = await rows(db.from('order_items').select('price, qty, discountable').eq('order_id', id).neq('status', 'void'))
      const base = lines.filter(l => l.discountable !== false).reduce((t, l) => t + n(l.price) * n(l.qty), 0)
      const amount = discountAmount(base, inp.discount ?? null)
      const bill = await rpc<Row>(db, 'pay_order', {
        p_order: id,
        p_discount: amount,
        p_payments: inp.payments.map(p => ({ method: p.method, amount: p.amount, ...(p.tendered != null ? { tendered: p.tendered } : {}), ref: p.ref ?? '' })),
        p_discount_reason: inp.discountReason ?? null,
        p_register: inp.register ?? 'Quầy 1',
        p_approval: inp.approval ?? null,
      })
      return idOf(bill)
    },
    printBill: async id => n(await rpc<number>(db, 'print_bill', { p_bill: id })),
    openShift: async inp => idOf(await rpc(db, 'open_shift', { p_float: inp.openingFloat, p_register: inp.register ?? 'Quầy 1' })),
    closeShift: async inp => void (await rpc(db, 'close_shift', { p_shift: inp.shiftId, p_detail: inp.countedDetail, p_note: inp.note ?? '' })),
    markClean: async id => void (await rpc(db, 'mark_table_clean', { p_table: id })),
    saveArea: a => ok(db.from('areas').upsert({ id: a.id, name: a.name.trim(), sort: a.sort, active: a.active })),
    async saveTable(t) {
      const row = { id: t.id, area_id: t.areaId, name: t.name.trim(), seats: t.seats, sort: t.sort, active: t.active, is_temporary: t.temporary }
      const exists = (await rows(db.from('tables').select('id').eq('id', t.id))).length > 0
      await ok(exists ? db.from('tables').update(row).eq('id', t.id) : db.from('tables').insert(row))
    },
  }
}
