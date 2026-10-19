// Which screens a person may open (hash routes), from the permissions the owner gave their role (permissions.ts,
// Nhân viên → Phân quyền). The server enforces the same permissions with RLS and has_perm() in every RPC (0009);
// these guards only keep people off screens they cannot use.

import { roleCan, roleCanAny, type Perm, type PermMatrix } from './permissions'
import { ROLES, type Role } from './types'

/** Manager or owner by role (labels only; what someone may do comes from their permissions). */
export const isManager = (r: Role | null | undefined): boolean => r === 'manager' || r === 'owner'

export type Screen = 'floor' | 'floor-setup' | 'kitchen' | 'cashier' | 'shift' | 'staff' | 'menu-order' | 'menu-soldout' | 'menu-admin' | 'settings' | 'payment-settings' | 'orders' | 'bills' | 'revenue'

/** A screen opens with any one of these permissions. */
const ACCESS: Record<Screen, Perm[]> = {
  floor: ['order.take'],
  'floor-setup': ['tables.edit', 'tables.temp'],
  kitchen: ['kitchen.work'],
  cashier: ['pay.collect'],
  shift: ['shift.manage'],
  staff: ['staff.manage', 'devices.manage', 'audit.view', 'settings.edit'],
  'menu-order': ['order.take'],
  'menu-soldout': ['order.take', 'menu.soldout'],
  'menu-admin': ['menu.edit'],
  settings: ['order.take', 'shift.manage', 'menu.soldout', 'menu.edit', 'tables.edit', 'tables.temp', 'staff.manage', 'devices.manage', 'audit.view', 'settings.edit'],
  'payment-settings': ['settings.edit'],
  orders: ['order.take'],
  // the database shows bills and payments to pay.collect or shift.manage (0009); Doanh thu goes with Xem nhật ký
  // (owner and manager by default)
  bills: ['pay.collect', 'shift.manage'],
  revenue: ['audit.view'],
}

export const SCREEN_LABEL: Record<Screen, string> = {
  floor: 'Sơ đồ bàn',
  'floor-setup': 'Cài đặt bàn',
  kitchen: 'Màn hình bếp',
  cashier: 'Thu ngân',
  shift: 'Ca thu ngân',
  staff: 'Nhân viên',
  'menu-order': 'Gọi món',
  'menu-soldout': 'Hết món',
  'menu-admin': 'Quản lý thực đơn',
  settings: 'Cài đặt',
  'payment-settings': 'Thanh toán',
  orders: 'Đơn',
  bills: 'Quản lý hoá đơn',
  revenue: 'Quản lý doanh thu',
}

/** The screen a route opens: #/ban, #/ban/caidat, #/bep/…, #/thu-ngan/…, #/ca, #/nhan-vien, #/cai-dat, menu routes. */
export function screenOf(route: string[]): Screen {
  const [top = '', sub] = route
  if (top === '' || top === 'ban') return sub === 'caidat' ? 'floor-setup' : 'floor'
  if (top === 'bep') return 'kitchen'
  if (top === 'thu-ngan') return 'cashier'
  if (top === 'ca') return 'shift'
  if (top === 'nhan-vien') return 'staff'
  if (top === 'cai-dat') return sub === 'thanh-toan' ? 'payment-settings' : 'settings'
  if (top === 'don') return 'orders'
  if (top === 'hoa-don') return 'bills'
  if (top === 'doanh-thu') return 'revenue'
  if (top === 'soldout') return 'menu-soldout'
  if (top === 'categories' || top === 'items' || top === 'groups') return 'menu-admin'
  return 'menu-order'
}

/** With the shop's current permissions, or with `m` (the owner's unsaved edits on Phân quyền). */
export function canOpen(role: Role | null | undefined, route: string[] | Screen, m?: PermMatrix): boolean {
  if (!role) return false
  const screen = Array.isArray(route) ? screenOf(route) : route
  return roleCanAny(role, ACCESS[screen], m)
}

/** Permissions that open a screen (for "cần quyền …" on the blocked screen). */
export const screenPerms = (screen: Screen): Perm[] => [...ACCESS[screen]]

/** Roles that may open a screen with the shop's current permissions. */
export const allowedRoles = (screen: Screen): Role[] => ROLES.filter(r => canOpen(r, screen))

/** Where a person lands after signing in: their role's usual screen, else the first one they may open. */
export function homeRoute(role: Role): string {
  const usual = role === 'kitchen' ? 'bep' : role === 'cashier' ? 'thu-ngan' : 'ban'
  const order = [usual, 'ban', 'thu-ngan', 'bep', 'cai-dat']
  return order.find(r => canOpen(role, [r])) ?? usual
}

export interface NavItem {
  href: string
  label: string
  icon: string
  screen: Screen
}

/** Tabs at the bottom, in order: the work screens only; the setup screens sit behind ☰ → Cài đặt. */
export function navFor(role: Role): NavItem[] {
  const all: NavItem[] = [
    { href: '#/don', label: 'Đơn', icon: '🧾', screen: 'orders' },
    { href: '#/ban', label: 'Bàn', icon: '🍽️', screen: 'floor' },
    { href: '#/bep', label: 'Bếp', icon: '🔥', screen: 'kitchen' },
    { href: '#/thu-ngan', label: 'Thu ngân', icon: '💵', screen: 'cashier' },
  ]
  return all.filter(l => canOpen(role, l.screen))
}

/** Cards on #/cai-dat for the screens a person may open. Thực đơn opens the menu editor with menu.edit, Hết món otherwise. */
export function settingsFor(role: Role): (NavItem & { hint: string })[] {
  const all: (NavItem & { hint: string })[] = [
    { href: '#/ca', label: 'Ca', icon: '🕒', hint: 'Mở ca, đếm tiền, chốt ca, báo cáo ca', screen: 'shift' },
    roleCan(role, 'menu.edit')
      ? { href: '#/items', label: 'Thực đơn', icon: '📋', hint: 'Món, nhóm món, tuỳ chọn, giá, hết món', screen: 'menu-admin' }
      : { href: '#/soldout', label: 'Hết món', icon: '📋', hint: 'Báo món hết hôm nay', screen: 'menu-soldout' },
    { href: '#/ban/caidat', label: 'Bàn', icon: '🪑', hint: 'Khu vực, thêm bàn, bàn tạm', screen: 'floor-setup' },
    { href: '#/cai-dat/thanh-toan', label: 'Thanh toán', icon: '💳', hint: 'Tiền mặt, ngân hàng, thẻ, thuế', screen: 'payment-settings' },
    { href: '#/nhan-vien', label: 'Nhân viên', icon: '👥', hint: role === 'owner' ? 'Nhân viên, phân quyền, PIN, máy, nhật ký' : 'Nhân viên, PIN, máy, nhật ký', screen: 'staff' },
  ]
  return all.filter(i => canOpen(role, i.screen))
}

/** Screens reached from Cài đặt: the top bar marks Cài đặt and shows a way back. */
export const isSettingsScreen = (s: Screen): boolean => !['floor', 'kitchen', 'cashier', 'orders', 'bills', 'revenue'].includes(s)

/** Menu module tabs a person sees. */
export function menuTabsFor(role: Role): ('order' | 'categories' | 'items' | 'groups' | 'stations' | 'soldout')[] {
  // dishes are ordered from the floor map (Sơ đồ bàn); #/order stays as a route but has no tab in Cài đặt
  if (roleCan(role, 'menu.edit')) return ['items', 'categories', 'groups', 'stations', 'soldout']
  return canOpen(role, 'menu-soldout') ? ['soldout'] : []
}

/** Nhân viên tabs: each needs its permission; Phân quyền is the owner's. */
export type StaffTab = '' | 'quyen' | 'may' | 'caidat' | 'nhatky'
export function staffTabsFor(role: Role): StaffTab[] {
  const tabs: [StaffTab, boolean][] = [
    ['', roleCan(role, 'staff.manage')],
    ['quyen', role === 'owner'],
    ['may', roleCan(role, 'devices.manage')],
    ['caidat', roleCan(role, 'settings.edit')],
    ['nhatky', roleCan(role, 'audit.view')],
  ]
  return tabs.filter(([, ok]) => ok).map(([t]) => t)
}

/** ☰ → Quản lý: invoices and revenue, for those who may see money. */
export function manageFor(role: Role): NavItem[] {
  const all: NavItem[] = [
    { href: '#/hoa-don', label: 'Quản lý hoá đơn', icon: '🧾', screen: 'bills' },
    { href: '#/doanh-thu', label: 'Quản lý doanh thu', icon: '📈', screen: 'revenue' },
  ]
  return all.filter(l => canOpen(role, l.screen))
}
