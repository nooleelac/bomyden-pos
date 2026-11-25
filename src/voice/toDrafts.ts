// Voice ordering, client side: the lines the voice-order Edge Function understood → PickerState lines for the cart.
// The server already dropped ids that are not on the menu; this runs the same checks as tapping the item by hand
// (initialState, quoteLine), so a line the AI got wrong shows its problem in red and cannot be sent.

import type { VoiceLine, VoiceResult } from '../../supabase/functions/voice-order/core'
import { describeLine, initialState, isListed, itemGroups, liveVariants, quoteLine, type LineQuote, type PickerState } from '../menu/picker'
import type { Menu, MenuItem } from '../menu/types'

export type { VoiceLine, VoiceResult }

export interface VoiceDraft {
  item: MenuItem
  state: PickerState
  /** The words this line came from, shown under it so the waiter can check. */
  heard: string
  quote: LineQuote
  /** "300g · Medium · + Thêm trứng ốp la x2", as on the order list */
  summary: string
}

/** One spoken line → the state the item picker would hold after the same taps. null = not orderable from this menu. */
export function lineToState(menu: Menu, line: VoiceLine, now = new Date()): { item: MenuItem; state: PickerState } | null {
  const item = menu.items.find(i => i.id === line.itemId)
  if (!item || !isListed(menu, item)) return null
  const variantId = item.hasSizes && liveVariants(item).some(v => v.id === line.variantId) ? line.variantId : null
  const state = initialState(menu, item, variantId, now)

  const groups = itemGroups(menu, item)
  const said = new Map(line.options.map(o => [o.optionId, o.qty]))
  for (const g of groups) {
    const picked = g.options.filter(o => said.has(o.id))
    if (!picked.length) continue
    // naming a sauce replaces the default one instead of adding a second
    if (g.group.kind === 'choice') for (const o of g.options) delete state.options[o.id]
    for (const o of picked) {
      const max = g.group.kind === 'choice' ? 1 : Math.max(1, o.maxQty)
      state.options[o.id] = Math.min(max, Math.max(1, Math.round(said.get(o.id) ?? 1)))
    }
  }

  const removable = new Set(item.components.filter(c => c.removable).map(c => c.id))
  for (const id of line.removalIds) if (removable.has(id) && !state.removals.includes(id)) state.removals.push(id)

  state.qty = Math.min(99, Math.max(1, Math.round(line.qty) || 1))
  state.note = line.note.trim().slice(0, 60)
  return { item, state }
}

/** All lines of one spoken order. Lines for items that are not on the order screen join `unmatched`. */
export function toDrafts(menu: Menu, result: VoiceResult, now = new Date()): { drafts: VoiceDraft[]; unmatched: string[] } {
  const drafts: VoiceDraft[] = []
  const unmatched = [...result.unmatched]
  for (const line of result.lines) {
    const r = lineToState(menu, line, now)
    if (!r) {
      unmatched.push(line.heard || line.itemId)
      continue
    }
    drafts.push({
      ...r,
      heard: line.heard,
      quote: quoteLine(menu, r.item, r.state, now),
      summary: describeLine(menu, r.item, r.state),
    })
  }
  return { drafts, unmatched }
}
