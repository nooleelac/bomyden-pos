// The floor map, order screen and kitchen display talk to this interface only.
// createMemoryFloorRepo runs on sample data now (engine.ts), shared between browser tabs through
// BroadcastChannel + localStorage so a waiter tab and a kitchen tab show the same orders.
// createSupabaseFloorRepo (supabaseRepo.ts) runs the same screens on the database with Realtime.

import type { Menu } from '../menu/types'
import { newId } from '../menu/repo'
import * as E from './engine'
import { seedFloor } from './seed'
import type { Actor, Area, FloorState, LineStatus, SendLineInput, Table } from './types'

export interface FloorRepo {
  readonly source: 'sample' | 'supabase'
  load(): Promise<FloorState>
  /**
   * Called whenever any device changes orders, lines or notices. Returns unsubscribe. With a state, this device's
   * own change is shown before the server confirms it (Supabase); without one, load again.
   */
  subscribe(onChange: (state?: FloorState) => void): () => void
  openTable(inp: E.OpenTableInput): Promise<string>
  addSharedOrder(inp: E.SharedOrderInput): Promise<string>
  openTakeaway(inp: { customerName?: string }): Promise<string>
  updateOrder(id: string, p: { guestCount?: number; positionLabel?: string; note?: string; allergy?: boolean }): Promise<void>
  closeEmptyOrder(id: string): Promise<void>
  /** Gửi bếp. `batch` is the client id of this tap: resending it never doubles the ticket. */
  sendLines(orderId: string, lines: SendLineInput[], batch: string, opts: E.SendOptions): Promise<void>
  voidLine(lineId: string, inp: E.VoidInput): Promise<void>
  /** Huỷ cả đơn đã gửi bếp: one reason, one manager approval (token) unless a manager does it. */
  voidOrder(orderId: string, inp: { reason: string; reasonNote?: string; approval?: string }): Promise<void>
  modifyLine(lineId: string, line: SendLineInput): Promise<void>
  decideModify(noticeId: string, accept: boolean): Promise<void>
  ackNotice(id: string): Promise<void>
  setLineStatus(lineIds: string[], to: LineStatus): Promise<void>
  bumpTicket(key: string): Promise<void>
  recallTicket(key: string): Promise<void>
  chaseOrder(orderId: string): Promise<void>
  mergeOrders(targetId: string, sourceIds: string[]): Promise<void>
  moveOrder(inp: Parameters<typeof E.moveOrder>[1]): Promise<void>
  moveItems(items: { id: string; qty?: number }[], targetOrderId: string): Promise<void>
  splitOrder(inp: Parameters<typeof E.splitOrder>[1]): Promise<string>
  releaseTable(orderId: string, tableId: string): Promise<void>
  splitTableFromGroup(inp: { orderId: string; tableId: string; guestCount: number }): Promise<string>
  requestBill(orderId: string): Promise<void>
  beginPayment(orderId: string): Promise<void>
  cancelPayment(orderId: string): Promise<void>
  /** Thanh toán (pay_order): one bill, split payments; resolves with the bill id. */
  payOrder(orderId: string, inp: E.PayInput): Promise<string>
  /** One more receipt printed (print_bill); resolves with the print count (2+ = IN LẠI). */
  printBill(billId: string): Promise<number>
  openShift(inp: { openingFloat: number; register?: string }): Promise<string>
  closeShift(inp: { shiftId: string; countedDetail: Record<string, number>; note?: string }): Promise<void>
  markClean(tableId: string): Promise<void>
  saveArea(a: Area): Promise<void>
  saveTable(t: Table): Promise<void>
  /** Sample only: back to the sample evening. */
  reset?(): Promise<void>
  /** Supabase only: the signed-in staff member (role decides what the screens offer). */
  whoAmI?(): Promise<Actor | null>
}

export interface MemoryFloorOptions {
  initial?: FloorState
  menu: () => Promise<Menu> | Menu
  actor: () => Actor
  /** Checks manager approval tokens (the sample auth repo's consumeApproval). */
  approve?: E.Ctx['approve']
  now?: () => Date
  /** Share state with other tabs of this browser (off in tests). */
  sync?: { channel: string; storageKey: string; reset?: () => FloorState }
}

// 2: lines carry VAT flags, bills and shifts (0005); 3: settings.voidApproval, owner role (0006)
const STORAGE_VERSION = 3

export function createMemoryFloorRepo(opts: MemoryFloorOptions): FloorRepo {
  const now = opts.now ?? (() => new Date())
  const listeners = new Set<() => void>()
  const changed = () => listeners.forEach(l => l())
  let state: FloorState = structuredClone(opts.initial ?? seedFloor())

  let channel: BroadcastChannel | null = null
  const sync = opts.sync
  if (sync) {
    try {
      const saved = localStorage.getItem(sync.storageKey)
      const parsed = saved ? (JSON.parse(saved) as { v: number; at?: number; state: FloorState }) : null
      // a sample evening left from yesterday would show 20-hour timers: start a fresh one instead
      if (parsed?.v === STORAGE_VERSION && Date.now() - (parsed.at ?? 0) < 12 * 3600_000) state = parsed.state
    } catch {
      /* private mode or bad data: start from the sample */
    }
    if (typeof BroadcastChannel !== 'undefined') {
      channel = new BroadcastChannel(sync.channel)
      channel.onmessage = e => {
        const msg = e.data as { v: number; state: FloorState }
        if (msg?.v !== STORAGE_VERSION) return
        state = msg.state
        changed()
      }
    }
  }

  const commit = (next: FloorState) => {
    state = next
    if (sync) {
      const msg = { v: STORAGE_VERSION, at: Date.now(), state: next }
      try {
        localStorage.setItem(sync.storageKey, JSON.stringify(msg))
      } catch {
        /* storage full or blocked: tabs still sync through the channel */
      }
      channel?.postMessage(msg)
    }
    queueMicrotask(changed)
  }

  const ctx = async (): Promise<E.Ctx> => ({ now: now(), actor: opts.actor(), menu: await opts.menu(), newId, approve: opts.approve })
  /** Run one transition on the latest state; errors leave the state untouched. */
  const run = async (f: (s: FloorState, c: E.Ctx) => FloorState) => {
    const c = await ctx()
    commit(f(state, c))
  }
  const runId = async (f: (s: FloorState, c: E.Ctx) => { state: FloorState; orderId: string }) => {
    const c = await ctx()
    const r = f(state, c)
    commit(r.state)
    return r.orderId
  }

  return {
    source: 'sample',
    async load() {
      return structuredClone(state)
    },
    subscribe(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    openTable: inp => runId((s, c) => E.openTable(s, inp, c)),
    addSharedOrder: inp => runId((s, c) => E.addSharedOrder(s, inp, c)),
    openTakeaway: inp => runId((s, c) => E.openTakeaway(s, inp, c)),
    updateOrder: (id, p) => run((s, c) => E.updateOrder(s, id, p, c)),
    closeEmptyOrder: id => run((s, c) => E.closeEmptyOrder(s, id, c)),
    sendLines: (orderId, lines, batch, o) => run((s, c) => E.sendLines(s, orderId, lines, batch, o, c).state),
    voidLine: (id, inp) => run((s, c) => E.voidLine(s, id, inp, c)),
    voidOrder: (id, inp) => run((s, c) => E.voidOrder(s, id, inp, c)),
    modifyLine: (id, line) => run((s, c) => E.modifyLine(s, id, line, c)),
    decideModify: (id, accept) => run((s, c) => E.decideModify(s, id, accept, c)),
    ackNotice: id => run((s, c) => E.ackNotice(s, id, c)),
    setLineStatus: (ids, to) => run((s, c) => E.setLineStatus(s, ids, to, c)),
    bumpTicket: key => run((s, c) => E.bumpTicket(s, key, c)),
    recallTicket: key => run((s, c) => E.recallTicket(s, key, c)),
    chaseOrder: id => run((s, c) => E.chaseOrder(s, id, c)),
    mergeOrders: (t, src) => run((s, c) => E.mergeOrders(s, t, src, c)),
    moveOrder: inp => run((s, c) => E.moveOrder(s, inp, c)),
    moveItems: (items, target) => run((s, c) => E.moveItems(s, items, target, c)),
    splitOrder: inp => runId((s, c) => E.splitOrder(s, inp, c)),
    releaseTable: (o, t) => run((s, c) => E.releaseTable(s, o, t, c)),
    splitTableFromGroup: inp => runId((s, c) => E.splitTableFromGroup(s, inp, c)),
    requestBill: id => run((s, c) => E.requestBill(s, id, c)),
    beginPayment: id => run((s, c) => E.beginPayment(s, id, c)),
    cancelPayment: id => run((s, c) => E.cancelPayment(s, id, c)),
    payOrder: async (id, inp) => {
      const c = await ctx()
      const r = E.payOrder(state, id, inp, c)
      commit(r.state)
      return r.billId
    },
    printBill: async id => {
      const c = await ctx()
      const r = E.printBill(state, id, c)
      commit(r.state)
      return r.count
    },
    openShift: async inp => {
      const c = await ctx()
      const r = E.openShift(state, inp, c)
      commit(r.state)
      return r.shiftId
    },
    closeShift: inp => run((s, c) => E.closeShift(s, inp, c)),
    markClean: id => run((s, c) => E.markClean(s, id, c)),
    saveArea: a => run((s, c) => E.saveArea(s, a, c)),
    saveTable: t => run((s, c) => E.saveTable(s, t, c)),
    async reset() {
      commit(structuredClone(sync?.reset?.() ?? opts.initial ?? seedFloor()))
    },
  }
}
