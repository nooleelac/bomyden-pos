// Kiểm soát thất thoát: the sums and "Cần xem" flags of ControlPage, from audit log entries (kept apart for tests).

import type { AuditEntry } from '../auth/types'

/** The audit actions this page reads. */
export const ACTIONS = ['void_item', 'void_order', 'discount', 'reprint', 'close_shift', 'delete', 'modify_item', 'permissions', 'bank_manual', 'bank_link'] as const
export type Action = (typeof ACTIONS)[number]
export const LABEL: Record<Action, string> = {
  void_item: 'Huỷ món', void_order: 'Huỷ đơn', discount: 'Giảm giá', reprint: 'In lại hoá đơn', close_shift: 'Chốt ca',
  delete: 'Xoá vĩnh viễn', modify_item: 'Sửa món', permissions: 'Đổi quyền',
  bank_manual: 'CK xác nhận tay', bank_link: 'CK khác nội dung',
}

export const num = (v: unknown) => (typeof v === 'number' ? v : Number(v) || 0)
export const yes = (v: unknown) => v === true || v === 'true'

/** Why an entry is worth a question, or null. */
export function flagOf(a: AuditEntry): string | null {
  const d = a.detail
  switch (a.action) {
    case 'void_item':
      if (yes(d.in_order)) return null // counted once on its Huỷ đơn
      if (yes(d.after_bill)) return 'Huỷ sau khi đã in tạm tính'
      if (d.stage === 'ready' || d.stage === 'served') return 'Huỷ món bếp đã làm xong'
      if (!a.approvedBy) return 'Huỷ món không có người duyệt'
      return null
    case 'void_order':
      return num(d.amount) > 0 ? (yes(d.after_bill) ? 'Huỷ cả đơn sau tạm tính' : 'Huỷ cả đơn đã gửi bếp') : null
    case 'discount':
      return 'Giảm giá hoá đơn'
    case 'close_shift':
      return num(d.difference) !== 0 ? (num(d.difference) > 0 ? 'Két thừa tiền' : 'Két thiếu tiền') : null
    case 'delete':
      return d.kind === 'order' ? 'Xoá vĩnh viễn đơn / hoá đơn' : d.kind === 'shift' ? 'Xoá vĩnh viễn ca' : null
    case 'permissions':
      return 'Đổi quyền nhân viên'
    case 'bank_manual':
      return 'Chuyển khoản xác nhận tay: ngân hàng chưa báo tiền về'
    case 'bank_link':
      return 'Gắn khoản tiền về có nội dung khác đơn'
    case 'modify_item':
      return d.price_after != null && num(d.price_after) < num(d.price_before) ? 'Sửa món sang giá thấp hơn' : null
    default:
      return null
  }
}

/** Money an entry is about (0 when none). */
export function moneyOf(a: AuditEntry): number {
  const d = a.detail
  if (a.action === 'close_shift') return num(d.difference)
  if (a.action === 'modify_item') return d.price_after != null ? num(d.price_after) - num(d.price_before) : 0
  return num(d.amount)
}

export interface PersonRow {
  name: string
  voids: number
  voidAmount: number
  voidsLate: number
  discounts: number
  discountAmount: number
  reprints: number
  shiftDiff: number
  /** Chuyển khoản xác nhận tay or tied to another memo (0030). */
  bankHand: number
  flags: number
}

export interface Control {
  voids: number
  voidAmount: number
  lateAmount: number
  orders: number
  orderAmount: number
  discounts: number
  discountAmount: number
  reprints: number
  shiftsOff: number
  shiftDiff: number
  deletes: number
  bankHand: number
  bankHandAmount: number
  people: PersonRow[]
  flagged: AuditEntry[]
}

export function control(list: AuditEntry[]): Control {
  const c: Control = { voids: 0, voidAmount: 0, lateAmount: 0, orders: 0, orderAmount: 0, discounts: 0, discountAmount: 0, reprints: 0, shiftsOff: 0, shiftDiff: 0, deletes: 0, bankHand: 0, bankHandAmount: 0, people: [], flagged: [] }
  const people = new Map<string, PersonRow>()
  const person = (name: string) => {
    const key = name || 'Không rõ'
    let p = people.get(key)
    if (!p) people.set(key, (p = { name: key, voids: 0, voidAmount: 0, voidsLate: 0, discounts: 0, discountAmount: 0, reprints: 0, shiftDiff: 0, bankHand: 0, flags: 0 }))
    return p
  }
  for (const a of list) {
    const d = a.detail
    const p = person(a.staff)
    const flag = flagOf(a)
    if (flag) {
      c.flagged.push(a)
      p.flags++
    }
    switch (a.action) {
      case 'void_item': {
        const amt = num(d.amount)
        c.voids++
        c.voidAmount += amt
        p.voids++
        p.voidAmount += amt
        if (yes(d.after_bill) || d.stage === 'ready' || d.stage === 'served') {
          c.lateAmount += amt
          p.voidsLate++
        }
        break
      }
      case 'void_order':
        c.orders++
        c.orderAmount += num(d.amount)
        break
      case 'discount':
        c.discounts++
        c.discountAmount += num(d.amount)
        p.discounts++
        p.discountAmount += num(d.amount)
        break
      case 'reprint':
        c.reprints++
        p.reprints++
        break
      case 'close_shift':
        if (num(d.difference) !== 0) {
          c.shiftsOff++
          c.shiftDiff += num(d.difference)
          p.shiftDiff += num(d.difference)
        }
        break
      case 'delete':
        if (d.kind === 'order' || d.kind === 'shift') c.deletes++
        break
      case 'bank_manual':
      case 'bank_link':
        c.bankHand++
        c.bankHandAmount += num(d.amount)
        p.bankHand++
        break
    }
  }
  c.people = [...people.values()]
    .filter(p => p.voids || p.discounts || p.reprints || p.shiftDiff || p.bankHand || p.flags)
    .sort((a, b) => b.voidAmount + b.discountAmount + Math.abs(b.shiftDiff) - (a.voidAmount + a.discountAmount + Math.abs(a.shiftDiff)))
  return c
}
