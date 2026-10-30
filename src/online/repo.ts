// What the web page dathang.bomyden.vn talks to: branches, a branch's menu, sending an order and what became of it. On
// Supabase these are the anon RPCs of 0027 (no device, no PIN); on sample data the order goes into the shared sample
// floor, so a staff tab of the same browser sees it at once.

import type { SupabaseClient } from '@supabase/supabase-js'
import type { OnlinePlaceInput } from '../floor/engine'
import type { FloorRepo } from '../floor/repo'
import type { OnlinePay, OnlineStatus } from '../floor/types'
import { distanceM, type GeoFix } from '../lib/geo'
import { DEFAULT_SHIP, shipEstimate, shipTooFar } from '../lib/ship'
import type { MenuRepo } from '../menu/repo'
import { MENU_KEYS, menuFromRows } from '../menu/supabaseRepo'
import type { Menu } from '../menu/types'

export interface OnlineBranch {
  id: string
  name: string
  shopName: string
  address: string
  isOpen: boolean
  /** With the guest's position and the branch's; else null. */
  distanceM: number | null
  shipEstimate: number | null
  tooFar: boolean
}

export interface OnlineMenuView {
  shopName: string
  isOpen: boolean
  menu: Menu
}

export interface OnlineOrderView {
  id: string
  status: OnlineStatus
  reason: string
  createdAt: string
  payMethod: OnlinePay
  foodTotal: number | null
  shipFee: number | null
  carrier: string
  shipEstimate: number | null
  shopName: string
  phone: string
  /** Only while a transfer is due. */
  bank: { bin: string; bankName: string; account: string; holder: string } | null
}

export type OnlineOrderInput = OnlinePlaceInput & { branchId: string }

export interface OnlineRepo {
  /** Nearest first when the position is given. */
  branches(fix: GeoFix | null): Promise<OnlineBranch[]>
  menu(branchId: string): Promise<OnlineMenuView>
  place(inp: OnlineOrderInput): Promise<void>
  status(ids: string[]): Promise<OnlineOrderView[]>
  /** fee = the one the guest saw. */
  agree(id: string, fee: number): Promise<void>
  cancel(id: string): Promise<void>
}

type Row = Record<string, unknown>
const s = (v: unknown) => (v == null ? '' : String(v))
const nn = (v: unknown) => (v == null ? null : Number(v))

async function rpc<T>(db: SupabaseClient, fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await db.rpc(fn, args)
  if (error) throw new Error(/PGRST202|schema cache/i.test(error.message) ? 'Quán chưa mở đặt hàng online' : error.message)
  return data as T
}

export function createSupabaseOnlineRepo(db: SupabaseClient): OnlineRepo {
  return {
    async branches(fix) {
      const r = await rpc<Row[]>(db, 'online_branches', { p_lat: fix?.lat ?? null, p_lng: fix?.lng ?? null })
      return r.map(b => ({
        id: s(b.id), name: s(b.name), shopName: s(b.shop_name), address: s(b.address), isOpen: b.is_open !== false,
        distanceM: nn(b.distance_m), shipEstimate: nn(b.ship_estimate), tooFar: b.too_far === true,
      }))
    },
    async menu(branchId) {
      const r = await rpc<Row>(db, 'online_menu', { p_branch: branchId })
      const m = (r.menu as Record<string, Row[]> | null) ?? {}
      return { shopName: s(r.shop_name), isOpen: r.is_open !== false, menu: menuFromRows(MENU_KEYS.map(k => m[k] ?? [])) }
    },
    async place(inp) {
      await rpc(db, 'online_place_order', {
        p_id: inp.id, p_branch: inp.branchId, p_lines: inp.lines, p_name: inp.customerName, p_phone: inp.phone, p_address: inp.address,
        p_pay: inp.payMethod, p_note: inp.note ?? '', p_lat: inp.fix?.lat ?? null, p_lng: inp.fix?.lng ?? null,
      })
    },
    async status(ids) {
      const r = await rpc<Row[]>(db, 'online_status', { p_ids: ids })
      return r.map(x => {
        const b = x.bank as Row | null
        return {
          id: s(x.id), status: x.status as OnlineStatus, reason: s(x.reason), createdAt: s(x.created_at), payMethod: x.pay_method === 'cod' ? 'cod' : 'transfer',
          foodTotal: nn(x.food_total), shipFee: nn(x.ship_fee), carrier: s(x.carrier), shipEstimate: nn(x.ship_estimate), shopName: s(x.shop_name), phone: s(x.phone),
          bank: b ? { bin: s(b.bin), bankName: s(b.bank_name), account: s(b.account), holder: s(b.holder) } : null,
        }
      })
    },
    agree: (id, fee) => rpc(db, 'online_agree', { p_id: id, p_fee: fee }).then(() => undefined),
    cancel: id => rpc(db, 'online_cancel', { p_id: id }).then(() => undefined),
  }
}

const SAMPLE_BRANCH = 'sample'

export function createMemoryOnlineRepo(floor: FloorRepo, menu: MenuRepo): OnlineRepo {
  return {
    async branches(fix) {
      const st = await floor.load()
      if (st.settings.onlineOrder === false) return []
      const pos = st.settings.guestGeo
      const rules = st.settings.onlineShip ?? DEFAULT_SHIP
      const metres = fix && pos?.lat != null && pos.lng != null ? distanceM({ lat: pos.lat, lng: pos.lng }, fix) : null
      return [{
        id: SAMPLE_BRANCH, name: 'Chi nhánh chính', shopName: st.shop.name, address: st.shop.address, isOpen: true, distanceM: metres == null ? null : Math.round(metres),
        shipEstimate: metres == null ? null : shipEstimate(rules, metres), tooFar: metres != null && shipTooFar(rules, metres),
      }]
    },
    async menu() {
      const st = await floor.load()
      return { shopName: st.shop.name, isOpen: true, menu: await menu.load() }
    },
    async place(inp) {
      if (!floor.placeOnline) throw new Error('Chưa nối được với quán')
      await floor.placeOnline(inp)
    },
    async status(ids) {
      const st = await floor.load()
      return (st.onlineOrders ?? [])
        .filter(r => ids.includes(r.id))
        .map(r => ({
          id: r.id, status: r.status, reason: r.reason, createdAt: r.createdAt, payMethod: r.payMethod, foodTotal: r.foodTotal, shipFee: r.shipFee,
          carrier: r.carrier, shipEstimate: r.shipEstimate, shopName: st.shop.name, phone: st.shop.phone,
          bank: r.payMethod === 'transfer' && r.status === 'agreed' ? { bin: st.shop.bankBin, bankName: st.shop.bankName, account: st.shop.bankAccount, holder: st.shop.bankAccountName } : null,
        }))
    },
    async agree(id, fee) {
      if (!floor.agreeOnline) throw new Error('Chưa nối được với quán')
      await floor.agreeOnline(id, fee)
    },
    async cancel(id) {
      if (!floor.cancelOnline) throw new Error('Chưa nối được với quán')
      await floor.cancelOnline(id)
    },
  }
}
