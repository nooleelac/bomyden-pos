import { describe, expect, it } from 'vitest'
import type { AuditEntry } from '../auth/types'
import { control, flagOf } from './control'

let n = 0
const e = (action: string, staff: string, detail: Record<string, unknown>, approvedBy = ''): AuditEntry => ({
  id: String(++n), at: '2026-11-25T05:00:00Z', action, staff, approvedBy, device: '', detail,
})

describe('Kiểm soát thất thoát', () => {
  it('flags what may hide money', () => {
    expect(flagOf(e('void_item', 'Lan', { amount: 30000, stage: 'new' }, 'Hà'))).toBeNull()
    expect(flagOf(e('void_item', 'Lan', { amount: 30000, stage: 'served' }, 'Hà'))).toBe('Huỷ món bếp đã làm xong')
    expect(flagOf(e('void_item', 'Lan', { amount: 30000, stage: 'new', after_bill: true }, 'Hà'))).toBe('Huỷ sau khi đã in tạm tính')
    expect(flagOf(e('void_item', 'Lan', { amount: 30000, stage: 'new' }))).toBe('Huỷ món không có người duyệt')
    expect(flagOf(e('void_item', 'Lan', { amount: 30000, stage: 'served', in_order: true }, 'Hà'))).toBeNull()
    expect(flagOf(e('close_shift', 'Lan', { difference: 0 }))).toBeNull()
    expect(flagOf(e('close_shift', 'Lan', { difference: -50000 }))).toBe('Két thiếu tiền')
    expect(flagOf(e('modify_item', 'Hùng', { price_before: 329000, price_after: 199000 }))).toBe('Sửa món sang giá thấp hơn')
    expect(flagOf(e('modify_item', 'Hùng', { price_before: 199000, price_after: 329000 }))).toBeNull()
    expect(flagOf(e('delete', 'Chủ', { kind: 'item' }))).toBeNull()
    expect(flagOf(e('delete', 'Chủ', { kind: 'order', amount: 500000 }))).toBe('Xoá vĩnh viễn đơn / hoá đơn')
    expect(flagOf(e('bank_manual', 'Lan', { amount: 296000, bill: 'HD000012' }))).toMatch('xác nhận tay')
    expect(flagOf(e('bank_link', 'Lan', { amount: 296000, received: 300000 }))).toMatch('nội dung khác')
  })

  it('counts transfers confirmed by hand', () => {
    const c = control([e('bank_manual', 'Lan', { amount: 296000 }), e('bank_link', 'Lan', { amount: 100000 }), e('bank_manual', 'Hà', { amount: 50000 })])
    expect([c.bankHand, c.bankHandAmount]).toEqual([3, 446000])
    expect(c.people.find(p => p.name === 'Lan')).toMatchObject({ bankHand: 2, flags: 2 })
  })

  it('adds up per person', () => {
    const c = control([
      e('void_item', 'Lan', { amount: 30000, stage: 'served' }, 'Hà'),
      e('void_item', 'Lan', { amount: 20000, stage: 'new' }, 'Hà'),
      e('discount', 'Lan', { amount: 15000, bill: 'HD1' }, 'Hà'),
      e('reprint', 'Mai', { bill: 'HD1', print: 2 }),
      e('close_shift', 'Lan', { difference: -50000, counted: 1, expected: 2 }),
    ])
    expect(c).toMatchObject({ voids: 2, voidAmount: 50000, lateAmount: 30000, discounts: 1, discountAmount: 15000, reprints: 1, shiftsOff: 1, shiftDiff: -50000 })
    expect(c.flagged).toHaveLength(3)
    expect(c.people[0]).toMatchObject({ name: 'Lan', voids: 2, voidsLate: 1, discounts: 1, shiftDiff: -50000, flags: 3 })
    expect(c.people[1]).toMatchObject({ name: 'Mai', reprints: 1, flags: 0 })
  })
})
