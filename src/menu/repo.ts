// The screens talk to this interface only. createMemoryMenuRepo runs on the sample menu now;
// createSupabaseMenuRepo (supabaseRepo.ts) runs the same screens against the database later.

import { seedMenu } from './seed'
import { soldOutUntilFor, type Category, type Menu, type MenuItem, type ModifierGroup, type SoldOutKind, type SoldOutMode } from './types'
import { categoryDeleteBlock, validateCategory, validateGroup, validateItem } from './validate'

export interface MenuRepo {
  readonly source: 'sample' | 'supabase'
  load(): Promise<Menu>
  /** Called whenever any device changes the menu (Realtime on Supabase). Returns unsubscribe. */
  subscribe(onChange: () => void): () => void
  saveCategory(c: Category): Promise<void>
  deleteCategory(id: string): Promise<void>
  /** New order of categories that share one parent. */
  reorderCategories(ids: string[]): Promise<void>
  /** Item with its sizes, components and option-group links, as one unit. */
  saveItem(item: MenuItem): Promise<void>
  /** Only drafts that were never sold; everything else is archived instead. */
  deleteItem(id: string): Promise<void>
  reorderItems(ids: string[]): Promise<void>
  saveGroup(g: ModifierGroup): Promise<void>
  setSoldOut(kind: SoldOutKind, id: string, mode: SoldOutMode): Promise<string | null>
}

/** Empty draft dish in a category. */
export function blankItem(menu: Menu, categoryId: string): MenuItem {
  return {
    id: newId(), categoryId, name: '', shortName: '', code: '', unit: 'phần', stationId: null, prepMinutes: null, status: 'draft',
    description: '', keywords: [], price: 0, hasSizes: false, vatGroup: null, priceIncludesVat: null, discountable: true, serviceCharge: true,
    soldOutUntil: null, sort: menu.items.filter(i => i.categoryId === categoryId).length + 1, variants: [], components: [], groups: [], optionOverrides: [],
  }
}

export function newId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return 'id-' + Math.random().toString(36).slice(2) + Date.now().toString(36)
}

function firstError(e: Record<string, string>): void {
  const msg = Object.values(e)[0]
  if (msg) throw new Error(msg)
}

export function createMemoryMenuRepo(initial: Menu = seedMenu(), opts: { now?: () => Date } = {}): MenuRepo {
  let menu: Menu = structuredClone(initial)
  const listeners = new Set<() => void>()
  const now = opts.now ?? (() => new Date())
  const changed = () => listeners.forEach(l => l())
  const commit = (m: Menu) => {
    menu = m
    queueMicrotask(changed)
  }

  return {
    source: 'sample',
    async load() {
      return structuredClone(menu)
    },
    subscribe(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    async saveCategory(c) {
      firstError(validateCategory(menu, c))
      const exists = menu.categories.some(x => x.id === c.id)
      commit({ ...menu, categories: exists ? menu.categories.map(x => (x.id === c.id ? structuredClone(c) : x)) : [...menu.categories, structuredClone(c)] })
    },
    async deleteCategory(id) {
      const block = categoryDeleteBlock(menu, id)
      if (block) throw new Error(block)
      commit({ ...menu, categories: menu.categories.filter(c => c.id !== id) })
    },
    async reorderCategories(ids) {
      commit({ ...menu, categories: menu.categories.map(c => (ids.includes(c.id) ? { ...c, sort: ids.indexOf(c.id) + 1 } : c)) })
    },
    async saveItem(item) {
      firstError(validateItem(menu, item))
      const exists = menu.items.some(x => x.id === item.id)
      commit({ ...menu, items: exists ? menu.items.map(x => (x.id === item.id ? structuredClone(item) : x)) : [...menu.items, structuredClone(item)] })
    },
    async deleteItem(id) {
      const it = menu.items.find(x => x.id === id)
      if (it && it.status !== 'draft') throw new Error('Chỉ xoá được món nháp; món đã bán thì chuyển sang Ngừng kinh doanh')
      commit({ ...menu, items: menu.items.filter(x => x.id !== id) })
    },
    async reorderItems(ids) {
      commit({ ...menu, items: menu.items.map(i => (ids.includes(i.id) ? { ...i, sort: ids.indexOf(i.id) + 1 } : i)) })
    },
    async saveGroup(g) {
      firstError(validateGroup(menu, g))
      const exists = menu.groups.some(x => x.id === g.id)
      commit({ ...menu, groups: exists ? menu.groups.map(x => (x.id === g.id ? structuredClone(g) : x)) : [...menu.groups, structuredClone(g)] })
    },
    async setSoldOut(kind, id, mode) {
      const until = soldOutUntilFor(mode, menu.settings.businessDayStart, now())
      let found = false
      const items = menu.items.map(it => {
        if (kind === 'item' && it.id === id) return (found = true), { ...it, soldOutUntil: until }
        if (kind === 'variant' && it.variants.some(v => v.id === id)) {
          found = true
          return { ...it, variants: it.variants.map(v => (v.id === id ? { ...v, soldOutUntil: until } : v)) }
        }
        if (kind === 'component' && it.components.some(c => c.id === id)) {
          found = true
          return { ...it, components: it.components.map(c => (c.id === id ? { ...c, soldOutUntil: until } : c)) }
        }
        return it
      })
      const groups = menu.groups.map(g => {
        if (kind !== 'option' || !g.options.some(o => o.id === id)) return g
        found = true
        return { ...g, options: g.options.map(o => (o.id === id ? { ...o, soldOutUntil: until } : o)) }
      })
      if (!found) throw new Error('Không tìm thấy mục cần báo hết')
      commit({ ...menu, items, groups })
      return until
    },
  }
}
