// Waiter item picker: what can be ordered, what a line costs, and whether it may be sent.
// Prices come from pricing.ts; the same checks run again on the server in send_order_lines.

import { formatVnd } from '../lib/billing'
import { linePrice, unitPrice, type LineModifier } from '../lib/pricing'
import { fold, initials } from '../lib/text'
import { isSoldOut, type Category, type Menu, type MenuItem, type ModifierGroup, type ModifierOption, type Variant } from './types'

export const vnd = formatVnd
export const minusVnd = (n: number) => '−' + formatVnd(n)

// ---------------------------------------------------------------- what is on the order screen

function categoryVisible(menu: Menu, c: Category | undefined): boolean {
  if (!c || !c.visible) return false
  if (!c.parentId) return true
  return categoryVisible(menu, menu.categories.find(p => p.id === c.parentId))
}

export function liveVariants(item: MenuItem): Variant[] {
  return item.variants.filter(v => !v.archivedAt).sort((a, b) => a.sort - b.sort)
}

/** On the order screen at all: active, in a visible category (and its parent), sizes set up if needed. */
export function isListed(menu: Menu, item: MenuItem): boolean {
  if (item.status !== 'active') return false
  if (!categoryVisible(menu, menu.categories.find(c => c.id === item.categoryId))) return false
  return !item.hasSizes || liveVariants(item).length > 0
}

export interface ItemGroup {
  group: ModifierGroup
  min: number
  max: number | null
  /** Options this item may use, with the item's price override applied. */
  options: ModifierOption[]
}

export function itemGroups(menu: Menu, item: MenuItem): ItemGroup[] {
  return [...item.groups]
    .sort((a, b) => a.sort - b.sort)
    .flatMap(link => {
      const group = menu.groups.find(g => g.id === link.groupId)
      if (!group) return []
      const options = [...group.options]
        .sort((a, b) => a.sort - b.sort)
        .flatMap(o => {
          const ov = item.optionOverrides.find(x => x.optionId === o.id)
          if (ov?.hidden) return []
          return [ov?.priceDelta != null ? { ...o, priceDelta: ov.priceDelta } : o]
        })
      return [{ group, min: link.minOverride ?? group.minSelect, max: link.maxOverride ?? group.maxSelect, options }]
    })
}

/** Why the whole item cannot be ordered right now, or null. */
export function itemBlock(menu: Menu, item: MenuItem, now = new Date()): string | null {
  if (isSoldOut(item.soldOutUntil, now)) return 'Hết món'
  const main = item.components.find(c => !c.removable && isSoldOut(c.soldOutUntil, now))
  if (main) return `Hết ${main.name.toLowerCase()}`
  if (item.hasSizes && liveVariants(item).every(v => isSoldOut(v.soldOutUntil, now))) return 'Hết mọi size'
  for (const g of itemGroups(menu, item)) {
    if (g.min > 0 && g.options.filter(o => !isSoldOut(o.soldOutUntil, now)).length < g.min) return `Hết lựa chọn ${g.group.name}`
  }
  return null
}

/** "từ 199.000đ" for sized items, the price otherwise. */
export function priceLabel(item: MenuItem): string {
  if (!item.hasSizes) return vnd(item.price)
  const prices = liveVariants(item).map(v => v.price)
  return prices.length ? 'từ ' + vnd(Math.min(...prices)) : 'chưa có size'
}

// ---------------------------------------------------------------- search

function haystack(item: MenuItem): { words: string[]; inits: string[]; codes: string[] } {
  const names = [item.name, item.shortName, ...item.keywords].filter(Boolean)
  return {
    words: names.map(fold),
    inits: names.map(initials),
    codes: [item.code, ...item.variants.map(v => v.code)].filter(Boolean).map(fold),
  }
}

/** Rank: exact code 0, code prefix 1, initials prefix 2, word prefix 3, substring 4; null = no match. */
function score(item: MenuItem, q: string): number | null {
  const h = haystack(item)
  const qc = q.replace(/ /g, '')
  if (h.codes.some(c => c === q)) return 0
  if (h.codes.some(c => c.startsWith(q))) return 1
  if (!q.includes(' ') && h.inits.some(i => i.startsWith(qc))) return 2
  const terms = q.split(' ')
  const words = h.words.map(w => w.split(' '))
  if (words.some(ws => terms.every(t => ws.some(w => w.startsWith(t))))) return 3
  if (h.words.some(w => w.includes(q))) return 4
  return null
}

/** Items on the order screen matching the query (no diacritics needed, initials, code, keywords). Empty query = all. */
export function searchItems(menu: Menu, query: string, categoryId?: string | null): MenuItem[] {
  const q = fold(query)
  const inCat = (it: MenuItem) => {
    if (!categoryId) return true
    if (it.categoryId === categoryId) return true
    return menu.categories.find(c => c.id === it.categoryId)?.parentId === categoryId
  }
  const catSort = (it: MenuItem) => {
    const c = menu.categories.find(x => x.id === it.categoryId)
    const p = c?.parentId ? menu.categories.find(x => x.id === c.parentId) : undefined
    return (p ?? c)!.sort * 1000 + (p ? c!.sort : 0)
  }
  return menu.items
    .filter(it => isListed(menu, it) && inCat(it))
    .map(it => ({ it, s: q ? score(it, q) : 0 }))
    .filter((x): x is { it: MenuItem; s: number } => x.s !== null)
    .sort((a, b) => a.s - b.s || catSort(a.it) - catSort(b.it) || a.it.sort - b.it.sort || a.it.name.localeCompare(b.it.name, 'vi'))
    .map(x => x.it)
}

// ---------------------------------------------------------------- one line being picked

export interface PickerState {
  itemId: string
  variantId: string | null
  qty: number
  /** optionId -> units per portion (choices: 1) */
  options: Record<string, number>
  /** component ids left out */
  removals: string[]
  note: string
}

/** Fresh line: default options ticked (never for required groups like Độ chín), sold-out removable components left out. */
export function initialState(menu: Menu, item: MenuItem, variantId: string | null = null, now = new Date()): PickerState {
  const options: Record<string, number> = {}
  for (const g of itemGroups(menu, item)) {
    if (g.group.kind !== 'choice' || g.min > 0) continue
    let n = 0
    for (const o of g.options) {
      if (o.isDefault && !isSoldOut(o.soldOutUntil, now) && (g.max == null || n < g.max)) {
        options[o.id] = 1
        n++
      }
    }
  }
  const removals = item.components.filter(c => c.removable && isSoldOut(c.soldOutUntil, now)).map(c => c.id)
  return { itemId: item.id, variantId: item.hasSizes ? variantId : null, qty: 1, options, removals, note: '' }
}

export type Issue = { level: 'error' | 'warning'; field: string; message: string }

function findOption(menu: Menu, item: MenuItem, optionId: string): { g: ItemGroup; o: ModifierOption } | null {
  for (const g of itemGroups(menu, item)) {
    const o = g.options.find(x => x.id === optionId)
    if (o) return { g, o }
  }
  return null
}

export function basePrice(item: MenuItem, s: PickerState): number | null {
  if (!item.hasSizes) return item.price
  return item.variants.find(v => v.id === s.variantId)?.price ?? null
}

/** Modifiers in pricing.ts form, prices from the menu (never typed by the waiter). */
export function lineModifiers(menu: Menu, item: MenuItem, s: PickerState): LineModifier[] {
  const mods: LineModifier[] = []
  for (const [id, qty] of Object.entries(s.options)) {
    const f = findOption(menu, item, id)
    if (f && qty > 0) mods.push({ kind: f.g.group.kind === 'choice' ? 'option' : 'addon', amount: f.o.priceDelta, qty })
  }
  for (const id of s.removals) {
    const c = item.components.find(x => x.id === id)
    if (c?.removable) mods.push({ kind: 'removal', amount: c.removalDiscount })
  }
  return mods
}

export function removalTotal(item: MenuItem, s: PickerState): number {
  return s.removals.reduce((sum, id) => {
    const c = item.components.find(x => x.id === id)
    return sum + (c?.removable ? c.removalDiscount : 0)
  }, 0)
}

export function validateLine(menu: Menu, item: MenuItem, s: PickerState, now = new Date()): Issue[] {
  const out: Issue[] = []
  const err = (field: string, message: string) => out.push({ level: 'error', field, message })
  const warn = (field: string, message: string) => out.push({ level: 'warning', field, message })

  if (!isListed(menu, item)) err('item', 'Món không có trên thực đơn')
  const block = itemBlock(menu, item, now)
  if (block) err('item', `${block}: ${item.name}`)

  if (!Number.isInteger(s.qty) || s.qty < 1 || s.qty > 99) err('qty', 'Số phần phải từ 1 đến 99')

  if (item.hasSizes) {
    const v = item.variants.find(x => x.id === s.variantId && !x.archivedAt)
    if (!s.variantId) err('size', 'Chọn size')
    else if (!v) err('size', 'Size không còn bán')
    else if (isSoldOut(v.soldOutUntil, now)) err('size', `Hết size ${v.name}`)
  } else if (s.variantId) {
    err('size', 'Món này không có size')
  }

  for (const [id, qty] of Object.entries(s.options)) {
    if (!qty) continue
    const f = findOption(menu, item, id)
    if (!f) {
      err('options', 'Tuỳ chọn không dùng được cho món này')
      continue
    }
    if (isSoldOut(f.o.soldOutUntil, now)) err(`group:${f.g.group.id}`, `Hết: ${f.o.name}`)
    const maxQty = f.g.group.kind === 'choice' ? 1 : f.o.maxQty
    if (!Number.isInteger(qty) || qty < 1 || qty > maxQty) err(`group:${f.g.group.id}`, `"${f.o.name}" tối đa ${maxQty} mỗi phần`)
  }
  for (const g of itemGroups(menu, item)) {
    const n = g.options.filter(o => (s.options[o.id] ?? 0) > 0).length
    if (n < g.min || (g.max != null && n > g.max)) {
      const msg =
        g.min === 1 && g.max === 1 ? `Chọn ${g.group.name}`
        : g.max == null ? `${g.group.name}: chọn ít nhất ${g.min}`
        : g.min === 0 ? `${g.group.name}: chọn tối đa ${g.max}`
        : `${g.group.name}: chọn từ ${g.min} đến ${g.max}`
      err(`group:${g.group.id}`, msg)
    }
  }

  for (const id of s.removals) {
    const c = item.components.find(x => x.id === id)
    if (!c) err('components', 'Thành phần không thuộc món này')
    else if (!c.removable) err('components', `Không bỏ được thành phần chính: ${c.name}`)
    else if (c.addonOptionId && (s.options[c.addonOptionId] ?? 0) > 0) err('components', `Không thể vừa bỏ vừa thêm ${c.name.toLowerCase()}`)
  }
  for (const c of item.components) {
    if (c.removable && isSoldOut(c.soldOutUntil, now)) {
      if (s.removals.includes(c.id)) warn('components', `Hết ${c.name.toLowerCase()}: bán dạng "Không ${c.name.toLowerCase()}"${c.removalDiscount ? `, giảm ${vnd(c.removalDiscount)}` : ''}. Báo khách trước.`)
      else err('components', `Hết ${c.name.toLowerCase()}: phải bỏ thành phần này mới gửi được`)
    }
  }

  const base = basePrice(item, s)
  if (base != null) {
    const floor = Math.ceil(base * menu.settings.minPriceRatio)
    const removed = removalTotal(item, s)
    if (removed > 0 && base - removed < floor) {
      err('components', `Bỏ thành phần giảm tối đa ${vnd(base - floor)} mỗi phần (không dưới ${Math.round(menu.settings.minPriceRatio * 100)}% giá)`)
    }
  }
  return out
}

export interface LineQuote {
  /** null until a size is chosen */
  unit: number | null
  total: number | null
  issues: Issue[]
  canAdd: boolean
}

export function quoteLine(menu: Menu, item: MenuItem, s: PickerState, now = new Date()): LineQuote {
  const issues = validateLine(menu, item, s, now)
  const base = basePrice(item, s)
  let unit: number | null = null
  let total: number | null = null
  if (base != null) {
    const mods = lineModifiers(menu, item, s)
    unit = unitPrice({ basePrice: base, modifiers: mods })
    if (Number.isInteger(s.qty) && s.qty >= 1) total = linePrice({ basePrice: base, qty: s.qty, modifiers: mods })
  }
  return { unit, total, issues, canAdd: !issues.some(i => i.level === 'error') }
}

/** One element of send_order_lines' p_lines. The server re-prices it from the menu. */
export interface SendLine {
  menu_item_id: string
  variant_id?: string
  qty: number
  note?: string
  options: { option_id: string; qty?: number }[]
  removals: string[]
}

export function toSendLine(s: PickerState): SendLine {
  const line: SendLine = {
    menu_item_id: s.itemId,
    qty: s.qty,
    options: Object.entries(s.options)
      .filter(([, q]) => q > 0)
      .map(([option_id, qty]) => (qty === 1 ? { option_id } : { option_id, qty })),
    removals: [...s.removals],
  }
  if (s.variantId) line.variant_id = s.variantId
  if (s.note.trim()) line.note = s.note.trim()
  return line
}

/** Short summary for the order list: "300g · Medium · Không trứng −3.000đ · + Thêm trứng ốp la x2". */
export function describeLine(menu: Menu, item: MenuItem, s: PickerState): string {
  const parts: string[] = []
  const v = item.variants.find(x => x.id === s.variantId)
  if (v) parts.push(v.name)
  for (const [id, qty] of Object.entries(s.options)) {
    const f = findOption(menu, item, id)
    if (!f || !qty) continue
    parts.push(f.g.group.kind === 'addon' ? `+ ${f.o.name}${qty > 1 ? ` x${qty}` : ''}` : f.o.name)
  }
  for (const id of s.removals) {
    const c = item.components.find(x => x.id === id)
    if (c) parts.push(`Không ${c.name.toLowerCase()}${c.removalDiscount ? ' ' + minusVnd(c.removalDiscount) : ''}`)
  }
  if (s.note.trim()) parts.push(s.note.trim())
  return parts.join(' · ')
}
