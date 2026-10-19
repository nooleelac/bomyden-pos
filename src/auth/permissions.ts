// Quyền theo vai trò (0009): the owner decides, per role, what each of waiter / cashier / kitchen / manager may do
// (Nhân viên → Phân quyền). The owner always has every permission and is the only one who changes this table or
// manages managers and owners. The defaults reproduce the fixed rules of 0001–0008.
//
// Same catalog and defaults as perm_ids() / role_permissions in 0009_role_permissions.sql; keep them in step.
// The server checks every permission again (has_perm); the client only hides what a person cannot use.

import type { ApprovalAction, Role } from './types'

export type Perm =
  | 'order.take'
  | 'order.move_done'
  | 'order.split'
  | 'order.void_after_bill'
  | 'order.void_sent'
  | 'pay.collect'
  | 'pay.discount'
  | 'shift.manage'
  | 'kitchen.work'
  | 'kitchen.override'
  | 'menu.soldout'
  | 'menu.edit'
  | 'tables.temp'
  | 'tables.edit'
  | 'staff.manage'
  | 'devices.manage'
  | 'audit.view'
  | 'settings.edit'
  | 'admin.delete'

export interface PermInfo {
  id: Perm
  label: string
  hint: string
}

export const PERM_GROUPS: { title: string; perms: PermInfo[] }[] = [
  {
    title: 'Gọi món và bàn',
    perms: [
      { id: 'order.take', label: 'Mở bàn, gọi món, gửi bếp', hint: 'Sơ đồ bàn, Đơn, ghép / gộp bàn, bưng món, dọn bàn' },
      { id: 'order.move_done', label: 'Chuyển món đã xong hoặc đã ra', hint: 'Món chưa xong thì ai gọi món được cũng chuyển được' },
      { id: 'order.split', label: 'Tách đơn, tách bàn khỏi nhóm', hint: '' },
      { id: 'order.void_after_bill', label: 'Huỷ món sau khi in tạm tính', hint: '' },
      { id: 'order.void_sent', label: 'Huỷ món đã gửi bếp không cần duyệt', hint: 'Và duyệt huỷ món bằng PIN cho người khác' },
    ],
  },
  {
    title: 'Thu ngân',
    perms: [
      { id: 'pay.collect', label: 'Thu tiền, in hoá đơn', hint: 'Màn Thu ngân, Quản lý hoá đơn' },
      { id: 'pay.discount', label: 'Giảm giá không cần duyệt', hint: 'Và duyệt giảm giá bằng PIN cho người khác' },
      { id: 'shift.manage', label: 'Mở ca, chốt ca', hint: 'Đếm tiền, báo cáo ca' },
    ],
  },
  {
    title: 'Bếp',
    perms: [
      { id: 'kitchen.work', label: 'Màn hình bếp', hint: 'Nhận món, báo xong, gọi lại phiếu; đăng nhập được máy bếp' },
      { id: 'kitchen.override', label: 'Lùi trạng thái quá 2 phút, gọi lại phiếu quá 30 phút', hint: '' },
    ],
  },
  {
    title: 'Thực đơn và bàn',
    perms: [
      { id: 'menu.soldout', label: 'Báo hết món / có lại', hint: 'Không có quyền này thì chỉ xem danh sách hết món' },
      { id: 'menu.edit', label: 'Sửa thực đơn', hint: 'Món, nhóm món, tuỳ chọn, giá, trạm bếp, VAT' },
      { id: 'tables.temp', label: 'Thêm bàn tạm', hint: '' },
      { id: 'tables.edit', label: 'Sửa khu vực và bàn', hint: '' },
    ],
  },
  {
    title: 'Quản trị',
    perms: [
      { id: 'staff.manage', label: 'Quản lý nhân viên', hint: 'Thêm, sửa, đặt lại PIN phục vụ, thu ngân, bếp' },
      { id: 'devices.manage', label: 'Thêm và khoá máy', hint: '' },
      { id: 'audit.view', label: 'Xem nhật ký', hint: 'Và Quản lý doanh thu' },
      { id: 'settings.edit', label: 'Cài đặt đăng nhập và quán', hint: 'Tự đăng xuất, khoá PIN, mã duyệt' },
      {
        id: 'admin.delete',
        label: 'Xoá vĩnh viễn',
        hint: 'Xoá hẳn món, nhóm món, tuỳ chọn, khu, bàn, đơn, hoá đơn, ca, nhân viên, máy (thay vì ẩn / tạm đóng / ngừng / khoá). Không khôi phục được',
      },
    ],
  },
]

export const PERMS: Perm[] = PERM_GROUPS.flatMap(g => g.perms.map(p => p.id))
export const PERM_LABEL = Object.fromEntries(PERM_GROUPS.flatMap(g => g.perms.map(p => [p.id, p.label]))) as Record<Perm, string>

/** Roles the owner sets permissions for (the owner has all of them). */
export type PermRole = Exclude<Role, 'owner'>
export const PERM_ROLES: PermRole[] = ['waiter', 'cashier', 'kitchen', 'manager']
export type PermMatrix = Record<PermRole, Perm[]>

export const DEFAULT_PERMS: PermMatrix = {
  waiter: ['order.take'],
  cashier: ['order.take', 'order.move_done', 'order.split', 'order.void_after_bill', 'pay.collect', 'shift.manage', 'menu.soldout', 'tables.temp'],
  kitchen: ['kitchen.work', 'menu.soldout'],
  // Xoá vĩnh viễn stays with the owner (quản trị viên) until the owner gives it to a role
  manager: PERMS.filter(p => p !== 'admin.delete'),
}

/** Who approves which request with their PIN: anyone with the permission that lets them do it themselves. */
export const APPROVAL_PERM: Record<ApprovalAction, Perm> = { discount: 'pay.discount', void_item: 'order.void_sent', void_order: 'order.void_sent' }

/** Known permissions only, in catalog order, no repeats. */
export function cleanPerms(list: readonly string[]): Perm[] {
  return PERMS.filter(p => list.includes(p))
}

export function normalizeMatrix(m: Partial<Record<string, readonly string[]>>): PermMatrix {
  return Object.fromEntries(PERM_ROLES.map(r => [r, cleanPerms(m[r] ?? [])])) as PermMatrix
}

// The shop's table, set by AuthGate when it loads or changes (like floor/hooks `session.actor`), so the route
// guards and the sample engine read the same rules without passing them through every screen.
let current: PermMatrix = DEFAULT_PERMS

export function setPermMatrix(m: PermMatrix): void {
  current = m
}
export function permMatrix(): PermMatrix {
  return current
}

export function roleCan(role: Role | null | undefined, perm: Perm, m: PermMatrix = current): boolean {
  if (!role) return false
  if (role === 'owner') return true
  return m[role]?.includes(perm) ?? false
}

export const roleCanAny = (role: Role | null | undefined, perms: readonly Perm[], m: PermMatrix = current): boolean => perms.some(p => roleCan(role, p, m))
