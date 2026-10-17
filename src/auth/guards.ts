// Which screens each role may open (hash routes). The server enforces the same split with RLS and role checks
// in every RPC (0001–0006); these guards only keep people off screens they cannot use.

import type { Role } from './types'

export const isManager = (r: Role | null | undefined): boolean => r === 'manager' || r === 'owner'

export type Screen = 'floor' | 'floor-setup' | 'kitchen' | 'cashier' | 'shift' | 'staff' | 'menu-order' | 'menu-soldout' | 'menu-admin' | 'settings' | 'orders'

const ACCESS: Record<Screen, Role[]> = {
  floor: ['waiter', 'cashier', 'manager', 'owner'],
  'floor-setup': ['cashier', 'manager', 'owner'],          // cashiers add a temporary table; managers edit
  kitchen: ['kitchen', 'manager', 'owner'],
  cashier: ['cashier', 'manager', 'owner'],
  shift: ['cashier', 'manager', 'owner'],
  staff: ['manager', 'owner'],
  'menu-order': ['waiter', 'cashier', 'manager', 'owner'],
  'menu-soldout': ['waiter', 'cashier', 'manager', 'owner'],
  'menu-admin': ['manager', 'owner'],
  settings: ['waiter', 'cashier', 'manager', 'owner'],
  orders: ['waiter', 'cashier', 'manager', 'owner'],
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
  orders: 'Đơn',
}

/** The screen a route opens: #/ban, #/ban/caidat, #/bep/…, #/thu-ngan/…, #/ca, #/nhan-vien, #/cai-dat, menu routes. */
export function screenOf(route: string[]): Screen {
  const [top = '', sub] = route
  if (top === '' || top === 'ban') return sub === 'caidat' ? 'floor-setup' : 'floor'
  if (top === 'bep') return 'kitchen'
  if (top === 'thu-ngan') return 'cashier'
  if (top === 'ca') return 'shift'
  if (top === 'nhan-vien') return 'staff'
  if (top === 'cai-dat') return 'settings'
  if (top === 'don') return 'orders'
  if (top === 'soldout') return 'menu-soldout'
  if (top === 'categories' || top === 'items' || top === 'groups') return 'menu-admin'
  return 'menu-order'
}

export function canOpen(role: Role | null | undefined, route: string[] | Screen): boolean {
  if (!role) return false
  const screen = Array.isArray(route) ? screenOf(route) : route
  return ACCESS[screen].includes(role)
}

export const allowedRoles = (screen: Screen): Role[] => [...ACCESS[screen]]

/** Where a person lands after signing in. */
export function homeRoute(role: Role): string {
  if (role === 'kitchen') return 'bep'
  if (role === 'cashier') return 'thu-ngan'
  return 'ban'
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

/** Cards on #/cai-dat for the screens a role may open. Thực đơn opens the menu editor for managers, Hết món for others. */
export function settingsFor(role: Role): (NavItem & { hint: string })[] {
  const all: (NavItem & { hint: string })[] = [
    { href: '#/ca', label: 'Ca', icon: '🕒', hint: 'Mở ca, đếm tiền, chốt ca, báo cáo ca', screen: 'shift' },
    isManager(role)
      ? { href: '#/items', label: 'Thực đơn', icon: '📋', hint: 'Món, nhóm món, tuỳ chọn, giá, hết món', screen: 'menu-admin' }
      : { href: '#/soldout', label: 'Hết món', icon: '📋', hint: 'Báo món hết hôm nay', screen: 'menu-soldout' },
    { href: '#/ban/caidat', label: 'Bàn', icon: '🪑', hint: 'Khu vực, thêm bàn, bàn tạm', screen: 'floor-setup' },
    { href: '#/nhan-vien', label: 'Nhân viên', icon: '👥', hint: 'Nhân viên, PIN, máy, nhật ký', screen: 'staff' },
  ]
  return all.filter(i => canOpen(role, i.screen))
}

/** Screens reached from Cài đặt: the top bar marks Cài đặt and shows a way back. */
export const isSettingsScreen = (s: Screen): boolean => s !== 'floor' && s !== 'kitchen' && s !== 'cashier' && s !== 'orders'

/** Menu module tabs a role sees. */
export function menuTabsFor(role: Role): ('order' | 'categories' | 'items' | 'groups' | 'soldout')[] {
  if (role === 'kitchen') return []
  // dishes are ordered from the floor map (Sơ đồ bàn); #/order stays as a route but has no tab in Cài đặt
  return isManager(role) ? ['items', 'categories', 'groups', 'soldout'] : ['soldout']
}
