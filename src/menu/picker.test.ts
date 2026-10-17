import { describe, expect, it } from 'vitest'
import { fold, initials } from '../lib/text'
import { initialState, itemBlock, priceLabel, quoteLine, searchItems, toSendLine, describeLine, type PickerState } from './picker'
import { createMemoryMenuRepo } from './repo'
import { seedMenu } from './seed'
import { soldOutUntilFor, type Menu } from './types'
import { validateCategory, validateItem } from './validate'

const NOW = new Date('2026-10-17T12:00:00Z') // 19:00 in Vietnam
const menu = seedMenu()
const steak = menu.items.find(i => i.id === 'i-steak')!
const errors = (m: Menu, s: PickerState) => quoteLine(m, m.items.find(i => i.id === s.itemId)!, s, NOW).issues.filter(i => i.level === 'error').map(i => i.message)
const pick = (over: Partial<PickerState> = {}): PickerState => ({ ...initialState(menu, steak, null, NOW), ...over })

describe('search', () => {
  const names = (q: string) => searchItems(menu, q).map(i => i.name)
  it('folds Vietnamese text', () => {
    expect(fold('Bò Nướng Lá Lốt')).toBe('bo nuong la lot')
    expect(fold('ĐỒ UỐNG')).toBe('do uong')
    expect(initials('Steak bò nướng')).toBe('sbn')
  })
  it('finds without diacritics, by initials, by code and by keyword', () => {
    expect(names('bo nuong')).toEqual(expect.arrayContaining(['Steak bò nướng', 'Bò nướng lá lốt']))
    expect(names('BO NUONG')).toEqual(names('Bò Nướng'))
    expect(names('sbn')[0]).toBe('Steak bò nướng')
    expect(names('101')[0]).toBe('Steak bò nướng')
    expect(names('101-300')[0]).toBe('Steak bò nướng')
    expect(names('bit tet')).toEqual(['Steak bò nướng'])
    expect(names('lau dam')).toEqual([])
    expect(names('lau giam')).toEqual(['Lẩu bò nhúng giấm'])
  })
  it('hides drafts and hidden categories', () => {
    expect(names('bo cuon')).toEqual([])
    const hidden = { ...menu, categories: menu.categories.map(c => (c.id === 'c-drink' ? { ...c, visible: false } : c)) }
    expect(searchItems(hidden, 'tiger')).toEqual([]) // child of a hidden parent
    expect(searchItems(hidden, '').some(i => i.id === 'i-coca')).toBe(false)
  })
  it('shows "từ" the cheapest size', () => {
    expect(priceLabel(steak)).toBe('từ 199.000đ')
  })
})

describe('picker validation and price', () => {
  it('a size and Độ chín are required; no size is picked by default', () => {
    const s = pick()
    expect(s.variantId).toBeNull()
    const q = quoteLine(menu, steak, s, NOW)
    expect(q.canAdd).toBe(false)
    expect(q.unit).toBeNull()
    expect(errors(menu, s)).toEqual(['Chọn size', 'Chọn Độ chín'])
    expect(errors(menu, pick({ variantId: 'v-300' }))).toEqual(['Chọn Độ chín'])
  })

  it('default sauce is pre-ticked, Độ chín never is', () => {
    expect(pick().options).toEqual({ 'o-pepper': 1 })
  })

  it('prices a 300g steak with no egg at 276.000đ (spec example)', () => {
    const s = pick({ variantId: 'v-300', options: { 'o-m': 1, 'o-pepper': 1 }, removals: ['k-egg'] })
    const q = quoteLine(menu, steak, s, NOW)
    expect(q).toMatchObject({ unit: 276000, total: 276000, canAdd: true, issues: [] })
    expect(describeLine(menu, steak, s)).toBe('300g · Medium · Sốt tiêu đen · Không trứng ốp la −3.000đ')
    expect(toSendLine(s)).toEqual({
      menu_item_id: 'i-steak', variant_id: 'v-300', qty: 1, options: [{ option_id: 'o-m' }, { option_id: 'o-pepper' }], removals: ['k-egg'],
    })
  })

  it('counts add-ons and paid options per portion', () => {
    // 2 × (279.000 + 15.000 vang + 2 × 8.000 trứng) = 620.000
    const s = pick({ variantId: 'v-300', qty: 2, options: { 'o-mr': 1, 'o-wine': 1, 'o-egg': 2 } })
    expect(quoteLine(menu, steak, s, NOW)).toMatchObject({ unit: 310000, total: 620000, canAdd: true })
    expect(toSendLine(s).options).toContainEqual({ option_id: 'o-egg', qty: 2 })
  })

  it('enforces group limits and add-on max per portion', () => {
    expect(errors(menu, pick({ variantId: 'v-200', options: { 'o-m': 1, 'o-wd': 1 } }))).toEqual(['Chọn Độ chín'])
    expect(errors(menu, pick({ variantId: 'v-200', options: { 'o-m': 1, 'o-pepper': 1, 'o-mushroom': 1, 'o-wine': 1 } }))).toEqual(['Nước sốt: chọn tối đa 2'])
    expect(errors(menu, pick({ variantId: 'v-200', options: { 'o-m': 1, 'o-egg': 4 } }))).toEqual(['"Thêm trứng ốp la" tối đa 3 mỗi phần'])
  })

  it('main component cannot be removed; no egg + extra egg is refused', () => {
    expect(errors(menu, pick({ variantId: 'v-200', options: { 'o-m': 1 }, removals: ['k-steak'] }))).toEqual(['Không bỏ được thành phần chính: Miếng steak bò'])
    expect(errors(menu, pick({ variantId: 'v-200', options: { 'o-m': 1, 'o-egg': 1 }, removals: ['k-egg'] }))).toEqual(['Không thể vừa bỏ vừa thêm trứng ốp la'])
  })

  it('removals may not take a portion below 50% of its size price', () => {
    const cheap: Menu = { ...menu, items: menu.items.map(i => (i.id === 'i-steak' ? { ...i, components: i.components.map(c => (c.id === 'k-salad' ? { ...c, removalDiscount: 98000 } : c)) } : i)) }
    const it = cheap.items.find(i => i.id === 'i-steak')!
    const s = { ...initialState(cheap, it, 'v-200', NOW), options: { 'o-m': 1 }, removals: ['k-egg', 'k-salad'] }
    expect(errors(cheap, s)).toEqual(['Bỏ thành phần giảm tối đa 99.500đ mỗi phần (không dưới 50% giá)'])
    expect(errors(cheap, { ...s, variantId: 'v-300' })).toEqual([])
  })

  it('rejects quantities outside 1..99 and a size on an item without sizes', () => {
    expect(errors(menu, pick({ variantId: 'v-200', options: { 'o-m': 1 }, qty: 0 }))).toEqual(['Số phần phải từ 1 đến 99'])
    const lau = menu.items.find(i => i.id === 'i-hotpot')!
    expect(quoteLine(menu, lau, { ...initialState(menu, lau, null, NOW), qty: 2 }, NOW)).toMatchObject({ unit: 399000, total: 798000, canAdd: true })
    expect(errors(menu, { ...initialState(menu, lau, null, NOW), variantId: 'v-300' })).toEqual(['Món này không có size'])
  })
})

describe('sold out', () => {
  it('"Hết hôm nay" lasts until the next 06:00 Vietnam time; hold is open-ended', () => {
    expect(soldOutUntilFor('today', '06:00', NOW)).toBe('2026-10-17T23:00:00.000Z') // 06:00 on 18/10 in Vietnam
    expect(soldOutUntilFor('today', '06:00', new Date('2026-10-16T21:30:00Z'))).toBe('2026-10-16T23:00:00.000Z') // 04:30 -> 06:00 same day
    expect(soldOutUntilFor('hold', '06:00', NOW)).toBe('infinity')
    expect(soldOutUntilFor('reopen', '06:00', NOW)).toBeNull()
  })

  it('a sold-out size blocks only that size', async () => {
    const repo = createMemoryMenuRepo(seedMenu(), { now: () => NOW })
    await repo.setSoldOut('variant', 'v-400', 'today')
    const m = await repo.load()
    const st = m.items.find(i => i.id === 'i-steak')!
    expect(itemBlock(m, st, NOW)).toBeNull()
    expect(errors(m, { ...initialState(m, st, 'v-400', NOW), options: { 'o-m': 1 } })).toEqual(['Hết size 400g'])
    expect(errors(m, { ...initialState(m, st, 'v-300', NOW), options: { 'o-m': 1 } })).toEqual([])
    // the next morning it sells again
    expect(quoteLine(m, st, { ...initialState(m, st, 'v-400', NOW), options: { 'o-m': 1 } }, new Date('2026-10-18T00:00:00Z')).canAdd).toBe(true)
  })

  it('sold-out egg: the line starts as "Không trứng" with a warning; adding it back is refused', async () => {
    const repo = createMemoryMenuRepo(seedMenu(), { now: () => NOW })
    await repo.setSoldOut('component', 'k-egg', 'hold')
    const m = await repo.load()
    const st = m.items.find(i => i.id === 'i-steak')!
    const s = { ...initialState(m, st, 'v-300', NOW), options: { 'o-m': 1 } }
    expect(s.removals).toEqual(['k-egg'])
    const q = quoteLine(m, st, s, NOW)
    expect(q).toMatchObject({ unit: 276000, canAdd: true })
    expect(q.issues.map(i => i.level)).toEqual(['warning'])
    expect(errors(m, { ...s, removals: [] })).toEqual(['Hết trứng ốp la: phải bỏ thành phần này mới gửi được'])
  })

  it('sold-out main component or every Độ chín option makes the dish sold out', async () => {
    const repo = createMemoryMenuRepo(seedMenu(), { now: () => NOW })
    await repo.setSoldOut('component', 'k-steak', 'today')
    let m = await repo.load()
    expect(itemBlock(m, m.items.find(i => i.id === 'i-steak')!, NOW)).toBe('Hết miếng steak bò')
    await repo.setSoldOut('component', 'k-steak', 'reopen')
    for (const id of ['o-rare', 'o-mr', 'o-m', 'o-mw', 'o-wd']) await repo.setSoldOut('option', id, 'today')
    m = await repo.load()
    expect(itemBlock(m, m.items.find(i => i.id === 'i-ribeye')!, NOW)).toBe('Hết lựa chọn Độ chín')
  })
})

describe('menu editor rules', () => {
  const e = (patch: Partial<typeof steak>) => validateItem(menu, { ...steak, ...patch })
  it('accepts the sample steak', () => {
    expect(e({})).toEqual({})
  })
  it('limits name lengths and keeps codes unique across items and sizes', () => {
    expect(e({ name: 'x'.repeat(41) }).name).toMatch(/tối đa 40/)
    expect(e({ shortName: 'X'.repeat(21) }).shortName).toMatch(/tối đa 20/)
    expect(e({ code: ' 201 ' }).code).toBe('Mã 201 đã có món khác dùng')
    expect(e({ code: '102-250' }).code).toBe('Mã 102-250 trùng mã size của món khác')
  })
  it('needs at least one size when sizes are on', () => {
    expect(e({ variants: [] }).sizes).toBe('Món có size cần ít nhất một size')
    expect(e({ variants: steak.variants.map(v => ({ ...v, archivedAt: '2026-01-01' })) }).sizes).toBeDefined()
    expect(e({ variants: [], hasSizes: false, price: 100000 })).toEqual({})
  })
  it('a main component has no removal discount', () => {
    expect(e({ components: steak.components.map(c => (c.id === 'k-steak' ? { ...c, removalDiscount: 5000 } : c)) })['component:k-steak']).toMatch(/không có tiền giảm/)
  })
  it('categories have at most 2 levels', () => {
    expect(validateCategory(menu, { ...menu.categories[0], id: 'new', name: 'Bia chai', parentId: 'c-beer' }).parentId).toBe('Chỉ có 2 cấp: nhóm lớn và nhóm con')
    expect(validateCategory(menu, { ...menu.categories.find(c => c.id === 'c-drink')!, parentId: 'c-steak' }).parentId).toMatch(/đang có nhóm con/)
  })
})
