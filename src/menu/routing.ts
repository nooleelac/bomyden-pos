// Quầy làm per part of a dish (0012). The dish goes to its station (its own, else its category's). A component or
// an option group may name another station: that station then gets its own ticket line for the part (steak at the
// hot kitchen; sốt, salad, bánh mì at the cold counter). Same rules as _send_lines in SQL; keep both in step.

import type { Component, Menu, MenuItem } from './types'

/** Station id of the dish itself, or null when neither the dish nor its category has one. */
export function itemStationId(menu: Menu, item: MenuItem): string | null {
  return item.stationId ?? menu.categories.find(c => c.id === item.categoryId)?.defaultStationId ?? null
}

/** Where a component is made: its own station, else the dish's. */
export function componentStationId(menu: Menu, item: MenuItem, c: Component): string | null {
  return c.stationId ?? itemStationId(menu, item)
}

/** Where a chosen option goes: the component it matches ("Thêm bánh mì" ↔ Bánh mì), else its group's station, else the dish's. */
export function optionStationId(menu: Menu, item: MenuItem, optionId: string): string | null {
  const linked = item.components.find(c => c.addonOptionId === optionId && c.stationId)
  if (linked) return linked.stationId
  const group = menu.groups.find(g => g.options.some(o => o.id === optionId))
  return group?.stationId ?? itemStationId(menu, item)
}

/** One component on a side ticket: "SALAD", "BÁNH MÌ x2" (per portion). */
export function componentTicketText(c: Pick<Component, 'name' | 'kitchenName' | 'qty'>): string {
  const name = (c.kitchenName.trim() || c.name.trim()).toUpperCase()
  return c.qty !== 1 ? `${name} x${Number(c.qty)}` : name
}
