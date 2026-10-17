// Sample menu so the screens run before Supabase is connected.
// GIÁ CHỈ LÀ VÍ DỤ: every price below is a placeholder; the shop sets the real ones.

import type { Component, Menu, MenuItem, ModifierOption } from './types'

const opt = (groupId: string, id: string, name: string, kitchenName: string, sort: number, extra: Partial<ModifierOption> = {}): ModifierOption => ({
  id, groupId, name, kitchenName, priceDelta: 0, maxQty: 1, isDefault: false, sort, soldOutUntil: null, ...extra,
})

const comp = (id: string, name: string, kitchenName: string, sort: number, extra: Partial<Component> = {}): Component => ({
  id, name, kitchenName, qty: 1, unit: '', removable: false, removalDiscount: 0, addonOptionId: null, sort, soldOutUntil: null, ...extra,
})

const item = (x: Partial<MenuItem> & Pick<MenuItem, 'id' | 'categoryId' | 'name' | 'shortName' | 'code'>): MenuItem => ({
  unit: 'phần', stationId: null, prepMinutes: null, status: 'active', description: '', keywords: [], price: 0, hasSizes: false,
  vatGroup: null, priceIncludesVat: null, discountable: true, serviceCharge: true, soldOutUntil: null, sort: 0,
  variants: [], components: [], groups: [], optionOverrides: [], ...x,
})

export function seedMenu(): Menu {
  return {
    sample: true,
    settings: { pricesIncludeVat: true, businessDayStart: '06:00', minPriceRatio: 0.5 },
    stations: [
      { id: 'st-grill', code: 'grill', name: 'Bếp nướng', kind: 'kitchen' },
      { id: 'st-hotpot', code: 'hotpot', name: 'Bếp lẩu', kind: 'kitchen' },
      { id: 'st-bar', code: 'bar', name: 'Bar', kind: 'bar' },
      { id: 'st-none', code: 'none', name: 'Không qua bếp', kind: 'none' },
    ],
    vatGroups: [
      { code: 'food', name: 'Món ăn, đồ uống', rate: 8 },
      { code: 'alcohol', name: 'Bia, rượu', rate: 10 },
    ],
    categories: [
      { id: 'c-steak', parentId: null, name: 'Steak', sort: 1, color: '#c62828', visible: true, defaultStationId: 'st-grill', vatGroup: 'food' },
      { id: 'c-grill', parentId: null, name: 'Bò nướng', sort: 2, color: '#ef6c00', visible: true, defaultStationId: 'st-grill', vatGroup: 'food' },
      { id: 'c-hotpot', parentId: null, name: 'Lẩu', sort: 3, color: '#6d4c41', visible: true, defaultStationId: 'st-hotpot', vatGroup: 'food' },
      { id: 'c-drink', parentId: null, name: 'Đồ uống', sort: 4, color: '#1565c0', visible: true, defaultStationId: 'st-bar', vatGroup: 'food' },
      { id: 'c-beer', parentId: 'c-drink', name: 'Bia', sort: 1, color: '#f9a825', visible: true, defaultStationId: 'st-bar', vatGroup: 'alcohol' },
      { id: 'c-soft', parentId: 'c-drink', name: 'Nước ngọt', sort: 2, color: '#00838f', visible: true, defaultStationId: 'st-bar', vatGroup: 'food' },
    ],
    groups: [
      {
        id: 'g-doneness', name: 'Độ chín', kind: 'choice', minSelect: 1, maxSelect: 1, printReceipt: 'never', sort: 1,
        options: [
          opt('g-doneness', 'o-rare', 'Rare', 'RARE', 1),
          opt('g-doneness', 'o-mr', 'Medium rare', 'MED RARE', 2),
          opt('g-doneness', 'o-m', 'Medium', 'MEDIUM', 3),
          opt('g-doneness', 'o-mw', 'Medium well', 'MED WELL', 4),
          opt('g-doneness', 'o-wd', 'Well done', 'WELL DONE', 5),
        ],
      },
      {
        id: 'g-sauce', name: 'Nước sốt', kind: 'choice', minSelect: 0, maxSelect: 2, printReceipt: 'if_priced', sort: 2,
        options: [
          opt('g-sauce', 'o-pepper', 'Sốt tiêu đen', 'TIÊU ĐEN', 1, { isDefault: true }),
          opt('g-sauce', 'o-mushroom', 'Sốt nấm', 'NẤM', 2),
          opt('g-sauce', 'o-wine', 'Sốt vang đỏ', 'VANG', 3, { priceDelta: 15000 }),
        ],
      },
      {
        id: 'g-extra', name: 'Món thêm', kind: 'addon', minSelect: 0, maxSelect: null, printReceipt: 'always', sort: 3,
        options: [
          opt('g-extra', 'o-egg', 'Thêm trứng ốp la', '+ TRỨNG', 1, { priceDelta: 8000, maxQty: 3 }),
          opt('g-extra', 'o-bread', 'Thêm bánh mì', '+ BÁNH MÌ', 2, { priceDelta: 5000, maxQty: 3 }),
        ],
      },
    ],
    items: [
      item({
        id: 'i-steak', categoryId: 'c-steak', name: 'Steak bò nướng', shortName: 'STEAK BÒ', code: '101', prepMinutes: 15, sort: 1,
        hasSizes: true, keywords: ['bít tết', 'beefsteak'],
        description: 'Gồm 1 miếng steak, 1 trứng ốp la, 1 đĩa salad',
        variants: [
          { id: 'v-200', name: '200g', code: '101-200', price: 199000, sort: 1, soldOutUntil: null, archivedAt: null },
          { id: 'v-300', name: '300g', code: '101-300', price: 279000, sort: 2, soldOutUntil: null, archivedAt: null },
          { id: 'v-400', name: '400g', code: '101-400', price: 359000, sort: 3, soldOutUntil: null, archivedAt: null },
        ],
        components: [
          comp('k-steak', 'Miếng steak bò', 'STEAK', 1, { unit: 'miếng' }),
          comp('k-egg', 'Trứng ốp la', 'TRỨNG', 2, { unit: 'quả', removable: true, removalDiscount: 3000, addonOptionId: 'o-egg' }),
          comp('k-salad', 'Salad trộn', 'SALAD', 3, { unit: 'đĩa', removable: true, removalDiscount: 0 }),
        ],
        groups: [
          { groupId: 'g-doneness', sort: 1, minOverride: null, maxOverride: null },
          { groupId: 'g-sauce', sort: 2, minOverride: null, maxOverride: null },
          { groupId: 'g-extra', sort: 3, minOverride: null, maxOverride: null },
        ],
      }),
      item({
        id: 'i-ribeye', categoryId: 'c-steak', name: 'Steak thăn lưng Mỹ', shortName: 'RIBEYE', code: '102', prepMinutes: 15, sort: 2,
        hasSizes: true, keywords: ['ribeye'],
        variants: [
          { id: 'v-rb-250', name: '250g', code: '102-250', price: 329000, sort: 1, soldOutUntil: null, archivedAt: null },
          { id: 'v-rb-350', name: '350g', code: '102-350', price: 429000, sort: 2, soldOutUntil: null, archivedAt: null },
        ],
        components: [comp('k-rb-steak', 'Miếng thăn lưng', 'STEAK', 1, { unit: 'miếng' })],
        groups: [
          { groupId: 'g-doneness', sort: 1, minOverride: null, maxOverride: null },
          { groupId: 'g-sauce', sort: 2, minOverride: null, maxOverride: null },
        ],
      }),
      item({ id: 'i-lalot', categoryId: 'c-grill', name: 'Bò nướng lá lốt', shortName: 'BÒ LÁ LỐT', code: '201', unit: 'đĩa', price: 129000, prepMinutes: 12, sort: 1 }),
      item({ id: 'i-ba-chi', categoryId: 'c-grill', name: 'Ba chỉ bò Mỹ nướng', shortName: 'BA CHỈ BÒ', code: '202', unit: 'đĩa', price: 149000, prepMinutes: 10, sort: 2 }),
      item({ id: 'i-hotpot', categoryId: 'c-hotpot', name: 'Lẩu bò nhúng giấm', shortName: 'LẨU GIẤM', code: '301', unit: 'nồi', price: 399000, prepMinutes: 10, sort: 1 }),
      item({
        id: 'i-tiger', categoryId: 'c-beer', name: 'Bia Tiger lon', shortName: 'TIGER', code: 'B01', unit: 'lon', price: 25000, sort: 1,
        discountable: false,
      }),
      item({ id: 'i-coca', categoryId: 'c-soft', name: 'Coca-Cola', shortName: 'COCA', code: 'N01', unit: 'lon', price: 20000, sort: 1 }),
      item({ id: 'i-draft', categoryId: 'c-grill', name: 'Bò cuộn nấm kim châm', shortName: 'BÒ CUỘN NẤM', code: '203', unit: 'đĩa', price: 119000, status: 'draft', sort: 3 }),
    ],
  }
}
