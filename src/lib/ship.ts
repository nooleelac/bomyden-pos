// Phí ship tạm tính cho đơn online (0027): the shop's own price table, shown as an estimate. Same rule as _ship_estimate
// in SQL. The fee a guest pays is always the one staff read off Grab, Be or Xanh SM.

/** Cài đặt → Đặt hàng online. Fees in đồng. */
export interface ShipRules {
  /** The base fee covers this many km. */
  baseKm: number
  baseFee: number
  /** Each started km after that. */
  perKm: number
  /** Delivery range. */
  maxKm: number
}

export const DEFAULT_SHIP: ShipRules = { baseKm: 2, baseFee: 15000, perKm: 5000, maxKm: 10 }

/** Roads wind: straight-line metres × this ≈ the distance a rider drives. */
const ROAD_FACTOR = 1.3

export const roadKm = (metres: number) => (metres * ROAD_FACTOR) / 1000

export function shipEstimate(r: ShipRules, metres: number): number {
  return r.baseFee + Math.ceil(Math.max(roadKm(metres) - r.baseKm, 0)) * r.perKm
}

export const shipTooFar = (r: ShipRules, metres: number) => roadKm(metres) > r.maxKm

/** null = fine; else what the owner is told. Same rules as set_online_settings. */
export function shipRulesProblem(r: ShipRules): string | null {
  const money = (x: number) => Number.isInteger(x) && x >= 0 && x <= 9_999_999
  const km = (x: number) => Number.isFinite(x) && Number.isInteger(x * 10)
  if (!money(r.baseFee) || !money(r.perKm)) return 'Phí ship từ 0 đến 9.999.999đ'
  if (!km(r.baseKm) || r.baseKm < 0 || r.baseKm >= 100) return 'Số km đầu từ 0 đến 99,9'
  if (!km(r.maxKm) || r.maxKm <= 0 || r.maxKm >= 1000) return 'Phạm vi giao từ 0,1 đến 999,9 km'
  return null
}

/** Delivery services staff book by hand. */
export const CARRIERS = [
  { id: 'grab', label: 'Grab' },
  { id: 'be', label: 'Be' },
  { id: 'xanhsm', label: 'Xanh SM' },
  { id: 'other', label: 'Khác' },
] as const

export type Carrier = (typeof CARRIERS)[number]['id']

export const carrierLabel = (c: string) => CARRIERS.find(x => x.id === c)?.label ?? ''

/** Google Maps at the guest's position, else a search for the address. */
export const deliveryMapLink = (r: { lat: number | null; lng: number | null; address: string }) =>
  r.lat != null && r.lng != null ? `https://www.google.com/maps?q=${r.lat},${r.lng}` : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(r.address)}`

/** The short code a guest and staff say out loud, and the VietQR transfer note. */
export const onlineCode = (id: string) => id.slice(0, 6).toUpperCase()
