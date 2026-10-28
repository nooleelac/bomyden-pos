// Chi nhánh (0022): opening hours by weekday, the same rules as branch_is_open / opening_hours_ok in SQL.
// Times are Vietnam time; a close at or before the open runs past midnight; a missing day is closed; {} = always open.

import type { OpeningHours, Weekday } from './types'

export const WEEKDAYS: { key: Weekday; label: string; short: string }[] = [
  { key: '1', label: 'Thứ Hai', short: 'T2' },
  { key: '2', label: 'Thứ Ba', short: 'T3' },
  { key: '3', label: 'Thứ Tư', short: 'T4' },
  { key: '4', label: 'Thứ Năm', short: 'T5' },
  { key: '5', label: 'Thứ Sáu', short: 'T6' },
  { key: '6', label: 'Thứ Bảy', short: 'T7' },
  { key: '7', label: 'Chủ nhật', short: 'CN' },
]

const HHMM = /^([01][0-9]|2[0-3]):[0-5][0-9]$/
const minutes = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5))

/** Weekday ('1' = Monday) and minutes since midnight in Vietnam (UTC+7, no daylight saving). */
function vnClock(at: Date): { day: Weekday; min: number } {
  const vn = new Date(at.getTime() + 7 * 3600_000)
  const dow = vn.getUTCDay() // 0 = Sunday
  return { day: String(dow === 0 ? 7 : dow) as Weekday, min: vn.getUTCHours() * 60 + vn.getUTCMinutes() }
}

export function isOpenAt(hours: OpeningHours, at: Date): boolean {
  if (Object.keys(hours).length === 0) return true
  const { day, min } = vnClock(at)
  const today = hours[day]
  if (today) {
    const o = minutes(today.open)
    const c = minutes(today.close)
    if (o < c ? min >= o && min < c : min >= o) return true
  }
  const prev = hours[String(day === '1' ? 7 : Number(day) - 1) as Weekday]
  return !!prev && minutes(prev.close) <= minutes(prev.open) && min < minutes(prev.close)
}

/** A problem with the hours, or '' when they can be saved. */
export function hoursProblem(hours: OpeningHours): string {
  for (const d of WEEKDAYS) {
    const h = hours[d.key]
    if (!h) continue
    if (!HHMM.test(h.open) || !HHMM.test(h.close)) return `${d.label}: giờ dạng 07:00`
    if (h.open === h.close) return `${d.label}: giờ mở và giờ đóng trùng nhau`
  }
  return ''
}

/** "T2–T6 07:00–22:00 · T7, CN 08:00–02:00" (days with the same hours together), or "Chưa đặt giờ". */
export function hoursSummary(hours: OpeningHours): string {
  if (Object.keys(hours).length === 0) return 'Chưa đặt giờ (luôn mở)'
  const groups: { days: string[]; text: string }[] = []
  for (const d of WEEKDAYS) {
    const h = hours[d.key]
    const text = h ? `${h.open}–${h.close}` : 'nghỉ'
    const last = groups[groups.length - 1]
    if (last && last.text === text) last.days.push(d.short)
    else groups.push({ days: [d.short], text })
  }
  return groups
    .map(g => `${g.days.length > 2 ? `${g.days[0]}–${g.days[g.days.length - 1]}` : g.days.join(', ')} ${g.text}`)
    .join(' · ')
}
