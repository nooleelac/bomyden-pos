// MenuRepo on Supabase (tables from 0001/0002/0003). Row-level security lets only managers write;
// sold-out goes through the set_sold_out RPC so kitchen and cashier can use it too.
// Not exercised against a live project yet: the screens currently run on createMemoryMenuRepo.

import type { SupabaseClient } from '@supabase/supabase-js'
import type { MenuRepo } from './repo'
import type { Category, Menu, MenuItem, ModifierGroup } from './types'

type Row = Record<string, unknown>

const MENU_TABLES = [
  'menu_categories', 'menu_items', 'menu_item_variants', 'item_components', 'modifier_groups',
  'modifier_options', 'item_modifier_groups', 'item_option_overrides', 'stations',
] as const

async function rows(q: PromiseLike<{ data: Row[] | null; error: { message: string } | null }>): Promise<Row[]> {
  const { data, error } = await q
  if (error) throw new Error(error.message)
  return data ?? []
}

async function ok(q: PromiseLike<{ error: { message: string } | null }>): Promise<void> {
  const { error } = await q
  if (error) throw new Error(error.message)
}

const s = (v: unknown) => (v == null ? '' : String(v))
const n = (v: unknown) => Number(v)
const nn = (v: unknown) => (v == null ? null : Number(v))
const sn = (v: unknown) => (v == null ? null : String(v))

export function createSupabaseMenuRepo(db: SupabaseClient): MenuRepo {
  async function load(): Promise<Menu> {
    const today = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10)
    const [shop, stations, vatGroups, vatRates, cats, items, variants, comps, groups, options, links, overrides] = await Promise.all([
      rows(db.from('shop_settings').select('prices_include_vat, business_day_start, min_price_ratio').limit(1)),
      rows(db.from('stations').select('*').eq('active', true).order('sort')),
      rows(db.from('vat_groups').select('*')),
      rows(db.from('vat_rates').select('*').lte('valid_from', today).order('valid_from')),
      rows(db.from('menu_categories').select('*').order('sort')),
      rows(db.from('menu_items').select('*').order('sort')),
      rows(db.from('menu_item_variants').select('*').order('sort')),
      rows(db.from('item_components').select('*').is('archived_at', null).order('sort')),
      rows(db.from('modifier_groups').select('*').is('archived_at', null).order('sort')),
      rows(db.from('modifier_options').select('*').is('archived_at', null).order('sort')),
      rows(db.from('item_modifier_groups').select('*').order('sort')),
      rows(db.from('item_option_overrides').select('*')),
    ])
    const rateOf = (code: string) => n(vatRates.filter(r => r.vat_group === code).pop()?.rate ?? 0)
    return {
      settings: {
        pricesIncludeVat: shop[0]?.prices_include_vat !== false,
        businessDayStart: s(shop[0]?.business_day_start || '06:00').slice(0, 5),
        minPriceRatio: shop[0]?.min_price_ratio == null ? 0.5 : n(shop[0].min_price_ratio),
      },
      stations: stations.map(r => ({ id: s(r.id), code: s(r.code), name: s(r.name), kind: r.kind as Menu['stations'][number]['kind'] })),
      vatGroups: vatGroups.map(r => ({ code: s(r.code), name: s(r.name), rate: rateOf(s(r.code)) })),
      categories: cats.map(r => ({
        id: s(r.id), parentId: sn(r.parent_id), name: s(r.name), sort: n(r.sort), color: s(r.color), visible: r.visible !== false,
        defaultStationId: sn(r.default_station_id), vatGroup: s(r.vat_group),
      })),
      groups: groups.map(g => ({
        id: s(g.id), name: s(g.name), kind: g.kind as ModifierGroup['kind'], minSelect: n(g.min_select), maxSelect: nn(g.max_select),
        printReceipt: g.print_receipt as ModifierGroup['printReceipt'], sort: n(g.sort),
        options: options.filter(o => o.group_id === g.id).map(o => ({
          id: s(o.id), groupId: s(o.group_id), name: s(o.name), kitchenName: s(o.kitchen_name), priceDelta: n(o.price_delta),
          maxQty: n(o.max_qty), isDefault: o.is_default === true, sort: n(o.sort), soldOutUntil: sn(o.sold_out_until),
        })),
      })),
      items: items.map(r => ({
        id: s(r.id), categoryId: s(r.category_id), name: s(r.name), shortName: s(r.short_name), code: s(r.code), unit: s(r.unit),
        stationId: sn(r.station_id), prepMinutes: nn(r.prep_minutes), status: r.status as MenuItem['status'],
        description: s(r.description), keywords: (r.keywords as string[] | null) ?? [], price: n(r.price), hasSizes: r.has_sizes === true,
        vatGroup: sn(r.vat_group), priceIncludesVat: r.price_includes_vat == null ? null : r.price_includes_vat === true,
        discountable: r.discountable !== false, serviceCharge: r.service_charge !== false, soldOutUntil: sn(r.sold_out_until), sort: n(r.sort),
        variants: variants.filter(v => v.item_id === r.id).map(v => ({
          id: s(v.id), name: s(v.name), code: s(v.code), price: n(v.price), sort: n(v.sort), soldOutUntil: sn(v.sold_out_until), archivedAt: sn(v.archived_at),
        })),
        components: comps.filter(c => c.item_id === r.id).map(c => ({
          id: s(c.id), name: s(c.name), kitchenName: s(c.kitchen_name), qty: n(c.qty), unit: s(c.unit), removable: c.removable === true,
          removalDiscount: n(c.removal_discount), addonOptionId: sn(c.addon_option_id), sort: n(c.sort), soldOutUntil: sn(c.sold_out_until),
        })),
        groups: links.filter(l => l.item_id === r.id).map(l => ({
          groupId: s(l.group_id), sort: n(l.sort), minOverride: nn(l.min_override), maxOverride: nn(l.max_override),
        })),
        optionOverrides: overrides.filter(o => o.item_id === r.id).map(o => ({ optionId: s(o.option_id), priceDelta: nn(o.price_delta), hidden: o.hidden === true })),
      })),
    }
  }

  const categoryRow = (c: Category) => ({
    id: c.id, parent_id: c.parentId, name: c.name.trim(), sort: c.sort, color: c.color, visible: c.visible,
    default_station_id: c.defaultStationId, vat_group: c.vatGroup,
  })

  return {
    source: 'supabase',
    load,
    subscribe(onChange) {
      const ch = db.channel('menu-changes')
      for (const table of MENU_TABLES) ch.on('postgres_changes', { event: '*', schema: 'public', table }, () => onChange())
      ch.subscribe()
      return () => void db.removeChannel(ch)
    },
    async saveCategory(c) {
      await ok(db.from('menu_categories').upsert(categoryRow(c)))
    },
    async deleteCategory(id) {
      await ok(db.from('menu_categories').delete().eq('id', id))
    },
    async reorderCategories(ids) {
      await Promise.all(ids.map((id, i) => ok(db.from('menu_categories').update({ sort: i + 1 }).eq('id', id))))
    },
    // Several writes, not one transaction: a failure part-way leaves the earlier parts saved. A save_menu_item RPC
    // would make it atomic; until then the screen reloads after an error so the manager sees what was kept.
    async saveItem(it) {
      await ok(db.from('menu_items').upsert({
        id: it.id, category_id: it.categoryId, name: it.name.trim(), short_name: it.shortName.trim(), code: it.code.trim(), unit: it.unit,
        station_id: it.stationId, prep_minutes: it.prepMinutes, status: it.status, description: it.description, keywords: it.keywords,
        price: it.hasSizes ? 0 : it.price, has_sizes: it.hasSizes, vat_group: it.vatGroup, price_includes_vat: it.priceIncludesVat,
        discountable: it.discountable, service_charge: it.serviceCharge, sort: it.sort,
      }))
      const now = new Date().toISOString()
      // Sizes and components that were sold are kept and archived, never deleted.
      const oldVar = await rows(db.from('menu_item_variants').select('id').eq('item_id', it.id).is('archived_at', null))
      const keepVar = new Set(it.variants.map(v => v.id))
      const goneVar = oldVar.map(r => s(r.id)).filter(id => !keepVar.has(id))
      if (goneVar.length) await ok(db.from('menu_item_variants').update({ archived_at: now }).in('id', goneVar))
      if (it.variants.length) {
        await ok(db.from('menu_item_variants').upsert(it.variants.map(v => ({
          id: v.id, item_id: it.id, name: v.name.trim(), code: v.code.trim() || null, price: v.price, sort: v.sort, archived_at: v.archivedAt,
        }))))
      }
      const oldComp = await rows(db.from('item_components').select('id').eq('item_id', it.id).is('archived_at', null))
      const keepComp = new Set(it.components.map(c => c.id))
      const goneComp = oldComp.map(r => s(r.id)).filter(id => !keepComp.has(id))
      if (goneComp.length) await ok(db.from('item_components').update({ archived_at: now }).in('id', goneComp))
      if (it.components.length) {
        await ok(db.from('item_components').upsert(it.components.map(c => ({
          id: c.id, item_id: it.id, name: c.name.trim(), kitchen_name: c.kitchenName.trim(), qty: c.qty, unit: c.unit,
          removable: c.removable, removal_discount: c.removable ? c.removalDiscount : 0, addon_option_id: c.addonOptionId, sort: c.sort,
        }))))
      }
      await ok(db.from('item_modifier_groups').delete().eq('item_id', it.id))
      if (it.groups.length) {
        await ok(db.from('item_modifier_groups').insert(it.groups.map(l => ({
          item_id: it.id, group_id: l.groupId, sort: l.sort, min_override: l.minOverride, max_override: l.maxOverride,
        }))))
      }
    },
    async deleteItem(id) {
      await ok(db.from('menu_items').delete().eq('id', id).eq('status', 'draft'))
    },
    async reorderItems(ids) {
      await Promise.all(ids.map((id, i) => ok(db.from('menu_items').update({ sort: i + 1 }).eq('id', id))))
    },
    async saveGroup(g) {
      await ok(db.from('modifier_groups').upsert({
        id: g.id, name: g.name.trim(), kind: g.kind, min_select: g.minSelect, max_select: g.maxSelect, print_receipt: g.printReceipt, sort: g.sort,
      }))
      const old = await rows(db.from('modifier_options').select('id').eq('group_id', g.id).is('archived_at', null))
      const keep = new Set(g.options.map(o => o.id))
      const gone = old.map(r => s(r.id)).filter(id => !keep.has(id))
      if (gone.length) await ok(db.from('modifier_options').update({ archived_at: new Date().toISOString() }).in('id', gone))
      if (g.options.length) {
        await ok(db.from('modifier_options').upsert(g.options.map(o => ({
          id: o.id, group_id: g.id, name: o.name.trim(), kitchen_name: o.kitchenName.trim(), price_delta: o.priceDelta,
          max_qty: g.kind === 'choice' ? 1 : o.maxQty, is_default: o.isDefault, sort: o.sort,
        }))))
      }
    },
    async setSoldOut(kind, id, mode) {
      const { data, error } = await db.rpc('set_sold_out', { p_kind: kind, p_id: id, p_mode: mode })
      if (error) throw new Error(error.message)
      return (data as string | null) ?? null
    },
  }
}
