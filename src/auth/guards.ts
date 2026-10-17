// Which screens each role may open (hash routes). The server enforces the same split with RLS and role checks
// in every RPC (0001–0006); these guards only keep people off screens they cannot use.

import type { Role } from './types'

export const isManager = (r: Role | null | undefined): boolean => r === 'manager' || r === 'owner'

export type Screen = 'floor' | 'floor-setup' | 'kitchen' | 'cashier' | 'shift' | 'staff' | 'menu-order' | 'menu-soldout' | 'menu-admin'

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
}

/** The screen a route opens: #/ban, #/ban/caidat, #/bep/…, #/thu-ngan/…, #/ca, #/nhan-vien, menu routes. */
export function screenOf(route: string[]): Screen {
  const [top = '', sub] = route
  if (top === '' || top === 'ban') return sub === 'caidat' ? 'floor-setup' : 'floor'
  if (top === 'bep') return 'kitchen'
  if (top === 'thu-ngan') return 'cashier'
  if (top === 'ca') return 'shift'
  if (top === 'nhan-vien') return 'staff'
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

/** Links for the top bar, in order. */
export function navFor(role: Role): { href: string; label: string; screen: Screen }[] {
  const all: { href: string; label: string; screen: Screen }[] = [
    { href: '#/ban', label: 'Sơ đồ bàn', screen: 'floor' },
    { href: '#/thu-ngan', label: 'Thu ngân', screen: 'cashier' },
    { href: '#/ca', label: 'Ca', screen: 'shift' },
    { href: '#/bep', label: 'Bếp', screen: 'kitchen' },
    { href: '#/order', label: 'Thực đơn', screen: 'menu-order' },
    { href: '#/ban/caidat', label: 'Bàn', screen: 'floor-setup' },
    { href: '#/nhan-vien', label: 'Nhân viên', screen: 'staff' },
  ]
  return all.filter(l => canOpen(role, l.screen))
}

/** Menu module tabs a role sees. */
export function menuTabsFor(role: Role): ('order' | 'categories' | 'items' | 'groups' | 'soldout')[] {
  if (role === 'kitchen') return []
  return isManager(role) ? ['order', 'categories', 'items', 'groups', 'soldout'] : ['order', 'soldout']
}
