// Chống phá bằng vị trí (0026): a guest orders only within the branch's radius. Same rule as _guest_geo_problem in
// SQL: the phone's GPS accuracy counts in the guest's favour up to ACC_ALLOWANCE metres.

/** The shop's position and the radius guests must be within, metres. */
export interface GuestGeo {
  lat: number
  lng: number
  radius: number
}

/** One GPS fix from the guest's phone. acc = accuracy in metres (the browser's estimate). */
export interface GeoFix {
  lat: number
  lng: number
  acc?: number | null
}

export const ACC_ALLOWANCE = 150
export const RADIUS_MIN = 20
export const RADIUS_MAX = 5000

/** Radius presets by the size of the place (Cài đặt → Mã QR gọi món). */
export const RADIUS_PRESETS = [
  { radius: 50, label: 'Quán nhỏ', hint: '50 m' },
  { radius: 100, label: 'Quán vừa', hint: '100 m' },
  { radius: 200, label: 'Quán lớn, sân vườn', hint: '200 m' },
  { radius: 500, label: 'Khu rất rộng', hint: '500 m' },
] as const

/** Metres between two points (haversine). */
export function distanceM(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const rad = (d: number) => (d * Math.PI) / 180
  const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2
  return 2 * 6371000 * Math.asin(Math.sqrt(h))
}

const validFix = (p: GeoFix | null | undefined): p is GeoFix =>
  !!p && Number.isFinite(p.lat) && Number.isFinite(p.lng) && Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180

/** null = may order (no geofence, or close enough); else what the guest is told. */
export function geoProblem(geo: GuestGeo | null | undefined, fix: GeoFix | null | undefined): string | null {
  if (!geo) return null
  if (!validFix(fix)) return 'Cần bật định vị (GPS) để gọi món: quán chỉ nhận món của khách đang ở quán'
  const d = distanceM(geo, fix)
  if (d - Math.min(Math.max(fix.acc ?? 0, 0), ACC_ALLOWANCE) <= geo.radius) return null
  const shown = d >= 1000 ? Math.round(d / 100) * 100 : Math.round(d)
  return `Bạn đang cách quán khoảng ${shown} m: chỉ gọi được khi ở trong quán (trong ${geo.radius} m)`
}

/** "10.7769, 106.7009" pasted from Google Maps (also "10,7769 106,7009"), or null. */
export function parseLatLng(text: string): { lat: number; lng: number } | null {
  const nums = text.match(/-?\d+(?:[.,]\d+)?/g)?.map(x => Number(x.replace(',', '.')))
  if (!nums || nums.length !== 2) return null
  const [lat, lng] = nums
  return validFix({ lat, lng }) ? { lat, lng } : null
}
