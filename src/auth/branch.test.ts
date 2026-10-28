import { describe, expect, it } from 'vitest'
import { hoursProblem, hoursSummary, isOpenAt } from './branch'

// Vietnam time is UTC+7: 2026-10-26 is a Monday
const vn = (s: string) => new Date(`${s}+07:00`)

describe('opening hours', () => {
  it('no hours set: always open', () => {
    expect(isOpenAt({}, vn('2026-10-27T03:00:00'))).toBe(true)
  })

  it('same-day hours, closed days, and hours past midnight', () => {
    const h = { '1': { open: '08:00', close: '22:00' }, '5': { open: '17:00', close: '02:00' } }
    expect(isOpenAt(h, vn('2026-10-26T09:00:00'))).toBe(true)
    expect(isOpenAt(h, vn('2026-10-26T22:00:00'))).toBe(false)
    expect(isOpenAt(h, vn('2026-10-27T09:00:00'))).toBe(false) // Tuesday: closed
    expect(isOpenAt(h, vn('2026-10-30T23:30:00'))).toBe(true) // Friday night
    expect(isOpenAt(h, vn('2026-10-31T01:30:00'))).toBe(true) // still Friday's shift
    expect(isOpenAt(h, vn('2026-10-31T02:30:00'))).toBe(false)
  })

  it('checks and sums up the hours', () => {
    expect(hoursProblem({ '1': { open: '7h', close: '22:00' } })).toBe('Thứ Hai: giờ dạng 07:00')
    expect(hoursProblem({ '2': { open: '07:00', close: '07:00' } })).toContain('trùng nhau')
    const week = { open: '07:00', close: '22:00' }
    expect(hoursSummary({ '1': week, '2': week, '3': week, '4': week, '5': week, '6': { open: '08:00', close: '02:00' } })).toBe(
      'T2–T6 07:00–22:00 · T7 08:00–02:00 · CN nghỉ',
    )
    expect(hoursSummary({})).toBe('Chưa đặt giờ (luôn mở)')
  })
})
