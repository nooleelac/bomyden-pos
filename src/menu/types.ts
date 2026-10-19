// Menu model as the screens see it. Mirrors the tables in 0001/0002/0003 (snake_case there, camelCase here).
// Money is whole VND. `soldOutUntil`: null = selling, ISO time = back at that time, 'infinity' = until reopened.

export type StationKind = 'kitchen' | 'bar' | 'none'
export const STATION_KIND_LABEL: Record<StationKind, string> = {
  kitchen: 'Bếp',
  bar: 'Bar',
  none: 'Không qua bếp',
}
export interface Station {
  id: string
  /** Lower-case, used in the kitchen screen link #/bep/<code>. */
  code: string
  name: string
  kind: StationKind
  sort: number
  /** Minutes before a ticket turns yellow / red on the kitchen screen. */
  warnMin: number
  lateMin: number
}

export interface VatGroup {
  code: string
  name: string
  /** Rate in force today, from vat_rates. */
  rate: number
}

export interface Category {
  id: string
  /** null = top level. At most 2 levels. */
  parentId: string | null
  name: string
  sort: number
  /** '#rrggbb' */
  color: string
  visible: boolean
  defaultStationId: string | null
  vatGroup: string
}

export type ItemStatus = 'draft' | 'active' | 'archived'

export const ITEM_STATUS_LABEL: Record<ItemStatus, string> = {
  draft: 'Nháp',
  active: 'Đang bán',
  archived: 'Ngừng kinh doanh',
}

export const UNITS = ['phần', 'đĩa', 'nồi', 'chai', 'lon', 'ly', 'kg', 'gram'] as const

export interface Variant {
  id: string
  name: string
  code: string
  price: number
  sort: number
  soldOutUntil: string | null
  archivedAt: string | null
}

export interface Component {
  id: string
  name: string
  /** Short ticket text: 'TRỨNG' -> KHÔNG TRỨNG. */
  kitchenName: string
  qty: number
  unit: string
  /** false = main component, cannot be left out (and has no discount). */
  removable: boolean
  removalDiscount: number
  /** The matching "Thêm trứng" add-on, to refuse "Không trứng" + "Thêm trứng" on one portion. */
  addonOptionId: string | null
  /** Quầy làm: null = the dish's station. Another station gets its own ticket for this part (salad, sốt, bánh mì). */
  stationId: string | null
  sort: number
  soldOutUntil: string | null
}

export type GroupKind = 'choice' | 'addon'
export type ReceiptPrint = 'always' | 'if_priced' | 'never'

export interface ModifierOption {
  id: string
  groupId: string
  name: string
  kitchenName: string
  priceDelta: number
  /** Per portion; choices are always 1. */
  maxQty: number
  isDefault: boolean
  sort: number
  soldOutUntil: string | null
}

export interface ModifierGroup {
  id: string
  name: string
  kind: GroupKind
  minSelect: number
  /** null = no limit */
  maxSelect: number | null
  printReceipt: ReceiptPrint
  /**
   * Quầy làm for the choices of this group ("Nước sốt" at the cold counter): null = the dish's station. An add-on
   * linked to a component ("Thêm bánh mì" ↔ Bánh mì) goes where that component is made.
   */
  stationId: string | null
  sort: number
  options: ModifierOption[]
}

export interface ItemGroupLink {
  groupId: string
  sort: number
  minOverride: number | null
  maxOverride: number | null
}

export interface OptionOverride {
  optionId: string
  /** null = the group's price */
  priceDelta: number | null
  hidden: boolean
}

export interface MenuItem {
  id: string
  categoryId: string
  /** Full name, printed on the bill. ≤ 40 characters. */
  name: string
  /** Kitchen ticket name, printed in capitals. ≤ 20 characters. */
  shortName: string
  code: string
  unit: string
  /** null = category default */
  stationId: string | null
  prepMinutes: number | null
  status: ItemStatus
  description: string
  keywords: string[]
  /** Used only when hasSizes is false. */
  price: number
  hasSizes: boolean
  /** null = category's group */
  vatGroup: string | null
  /** null = shop setting */
  priceIncludesVat: boolean | null
  discountable: boolean
  serviceCharge: boolean
  soldOutUntil: string | null
  sort: number
  variants: Variant[]
  components: Component[]
  groups: ItemGroupLink[]
  optionOverrides: OptionOverride[]
}

export interface ShopMenuSettings {
  pricesIncludeVat: boolean
  /** HH:MM, local time; "Hết hôm nay" reopens then. */
  businessDayStart: string
  /** Removals may not take a portion below this share of its size price (spec: 50%). */
  minPriceRatio: number
}

export interface Menu {
  /** true for the built-in seed: names are real dishes, prices are examples only. */
  sample?: boolean
  settings: ShopMenuSettings
  stations: Station[]
  vatGroups: VatGroup[]
  categories: Category[]
  items: MenuItem[]
  groups: ModifierGroup[]
}

export type SoldOutKind = 'item' | 'variant' | 'option' | 'component'
export type SoldOutMode = 'today' | 'hold' | 'reopen'

export function isSoldOut(until: string | null, now: Date = new Date()): boolean {
  if (until == null) return false
  if (until === 'infinity') return true
  return new Date(until).getTime() > now.getTime()
}

/** When "Hết hôm nay" ends: the next business-day start in Vietnam time (UTC+7, no DST). */
export function soldOutUntilFor(mode: SoldOutMode, businessDayStart: string, now: Date = new Date()): string | null {
  if (mode === 'reopen') return null
  if (mode === 'hold') return 'infinity'
  const [h, m] = businessDayStart.split(':').map(Number)
  const OFFSET = 7 * 3600_000
  const local = new Date(now.getTime() + OFFSET)
  const start = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), h, m) - OFFSET
  const until = now.getTime() < start ? start : start + 86400_000
  return new Date(until).toISOString()
}

/** Colour choices for categories on the order screen. */
export const CATEGORY_COLORS = ['#c62828', '#ef6c00', '#f9a825', '#2e7d32', '#00838f', '#1565c0', '#6a1b9a', '#6d4c41', '#455a64', '#ad1457']
