// What the guest's phone talks to on the QR page (#/goi/<token>): the table's menu, sending a request, and what
// became of it. On Supabase these are the anon RPCs of 0023 (no device, no PIN); on sample data the request goes into
// the shared sample floor, so a waiter tab of the same browser sees it at once.

import type { SupabaseClient } from '@supabase/supabase-js'
import type { GuestCallInput, GuestOrderInput } from '../floor/engine'
import { guestTable } from '../floor/engine'
import { openOrdersAt } from '../floor/logic'
import type { FloorRepo } from '../floor/repo'
import { callChips, type CallChips, type GuestRequestKind, type GuestRequestStatus, type LineStatus } from '../floor/types'
import { chipsFrom } from '../floor/supabaseRepo'
import type { MenuRepo } from '../menu/repo'
import { MENU_KEYS, menuFromRows } from '../menu/supabaseRepo'
import type { Menu } from '../menu/types'

export interface GuestView {
  tableId: string
  tableName: string
  shopName: string
  /** Inside opening hours (always true when the branch sets none). */
  isOpen: boolean
  /** Quick picks on Gọi phục vụ / Gọi thanh toán. */
  callChips: CallChips
  menu: Menu
}

export interface GuestStatus {
  /** This phone's requests. */
  requests: { id: string; kind: GuestRequestKind; status: GuestRequestStatus; reason: string; createdAt: string }[]
  /** Dishes already on the table's open orders. */
  lines: { name: string; variantName: string; qty: number; price: number; status: LineStatus }[]
}

export interface GuestRepo {
  load(token: string): Promise<GuestView>
  place(token: string, inp: GuestOrderInput): Promise<void>
  /** Gọi thanh toán / Gọi phục vụ; resolves with the id to follow (the call already waiting, if any). */
  call(token: string, inp: GuestCallInput): Promise<string>
  status(token: string, ids: string[]): Promise<GuestStatus>
}

type Row = Record<string, unknown>
const s = (v: unknown) => (v == null ? '' : String(v))
const kindOf = (v: unknown): GuestRequestKind => (v === 'bill' || v === 'service' ? v : 'order')

async function rpc<T>(db: SupabaseClient, fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await db.rpc(fn, args)
  if (error) throw new Error(/guest_|PGRST202|schema cache/i.test(error.message) ? 'Quán chưa bật gọi món qua mã QR, mời bạn gọi nhân viên' : error.message)
  return data as T
}

export function createSupabaseGuestRepo(db: SupabaseClient): GuestRepo {
  return {
    async load(token) {
      const r = await rpc<Row>(db, 'guest_menu', { p_token: token })
      const t = (r.table as Row | null) ?? {}
      const m = (r.menu as Record<string, Row[]> | null) ?? {}
      return { tableId: s(t.id), tableName: s(t.name), shopName: s(r.shop_name), isOpen: r.is_open !== false, callChips: callChips(chipsFrom(r.call_chips)), menu: menuFromRows(MENU_KEYS.map(k => m[k] ?? [])) }
    },
    async place(token, inp) {
      await rpc(db, 'guest_place_order', { p_token: token, p_id: inp.id, p_lines: inp.lines, p_note: inp.note ?? '', p_guests: inp.guestCount ?? null })
    },
    async call(token, inp) {
      const r = await rpc<Row>(db, 'guest_call', { p_token: token, p_id: inp.id, p_kind: inp.kind, p_note: inp.note ?? '' })
      return s(r.id) || inp.id
    },
    async status(token, ids) {
      const r = await rpc<Row>(db, 'guest_status', { p_token: token, p_ids: ids })
      return {
        requests: ((r.requests as Row[] | null) ?? []).map(x => ({ id: s(x.id), kind: kindOf(x.kind), status: x.status as GuestRequestStatus, reason: s(x.reason), createdAt: s(x.created_at) })),
        lines: ((r.lines as Row[] | null) ?? []).map(x => ({ name: s(x.name), variantName: s(x.variant_name), qty: Number(x.qty), price: Number(x.price), status: x.status as LineStatus })),
      }
    },
  }
}

export function createMemoryGuestRepo(floor: FloorRepo, menu: MenuRepo): GuestRepo {
  return {
    async load(token) {
      const st = await floor.load()
      const t = guestTable(st, token)
      return { tableId: t.id, tableName: t.name, shopName: st.shop.name, isOpen: true, callChips: callChips(st.settings.guestCallChips), menu: await menu.load() }
    },
    async place(token, inp) {
      if (!floor.placeGuestOrder) throw new Error('Chưa nối được với quán')
      await floor.placeGuestOrder(token, inp)
    },
    async call(token, inp) {
      if (!floor.placeGuestCall) throw new Error('Chưa nối được với quán')
      return floor.placeGuestCall(token, inp)
    },
    async status(token, ids) {
      const st = await floor.load()
      const t = guestTable(st, token)
      const orders = new Set(openOrdersAt(st, t.id).map(o => o.id))
      return {
        requests: (st.guestRequests ?? []).filter(r => r.tableId === t.id && ids.includes(r.id)).map(r => ({ id: r.id, kind: r.kind ?? 'order', status: r.status, reason: r.reason, createdAt: r.createdAt })),
        lines: st.lines
          .filter(l => orders.has(l.orderId) && l.status !== 'void' && !l.replacedBy)
          .map(l => ({ name: l.name, variantName: l.variantName, qty: l.qty, price: l.price, status: l.status })),
      }
    },
  }
}
