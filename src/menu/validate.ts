// Manager-side checks before saving the menu. The database enforces the same limits (0002/0003).

import { fold } from '../lib/text'
import { UNITS, type Category, type Menu, type MenuItem, type ModifierGroup } from './types'

export type FieldErrors = Record<string, string>

export const NAME_MAX = 40
export const SHORT_NAME_MAX = 20

const isVnd = (n: number) => Number.isSafeInteger(n) && n >= 0
const key = (s: string) => fold(s).replace(/ /g, '')

export function validateItem(menu: Menu, item: MenuItem): FieldErrors {
  const e: FieldErrors = {}
  const name = item.name.trim()
  if (!name) e.name = 'Nhập tên món'
  else if (name.length > NAME_MAX) e.name = `Tên đầy đủ tối đa ${NAME_MAX} ký tự (đang ${name.length})`
  const short = item.shortName.trim()
  if (!short) e.shortName = 'Nhập tên ngắn in phiếu bếp'
  else if (short.length > SHORT_NAME_MAX) e.shortName = `Tên ngắn tối đa ${SHORT_NAME_MAX} ký tự (đang ${short.length})`

  const code = item.code.trim()
  if (!code) e.code = 'Nhập mã món'
  else {
    const others = menu.items.filter(x => x.id !== item.id)
    if (others.some(x => key(x.code) === key(code))) e.code = `Mã ${code} đã có món khác dùng`
    else if (others.some(x => x.variants.some(v => key(v.code) === key(code)))) e.code = `Mã ${code} trùng mã size của món khác`
  }

  if (!(UNITS as readonly string[]).includes(item.unit)) e.unit = 'Chọn đơn vị tính'
  const cat = menu.categories.find(c => c.id === item.categoryId)
  if (!cat) e.categoryId = 'Chọn nhóm món'
  if (!item.stationId && !cat?.defaultStationId) e.stationId = 'Chọn khu chế biến (nhóm món chưa có khu mặc định)'
  if (item.prepMinutes != null && (!Number.isInteger(item.prepMinutes) || item.prepMinutes < 1 || item.prepMinutes > 240)) {
    e.prepMinutes = 'Thời gian làm từ 1 đến 240 phút'
  }

  if (item.hasSizes) {
    const live = item.variants.filter(v => !v.archivedAt)
    if (live.length === 0) e.sizes = 'Món có size cần ít nhất một size'
    const seen = new Set<string>()
    const codes = new Set<string>()
    live.forEach(v => {
      const k = `size:${v.id}`
      if (!v.name.trim()) e[k] = 'Nhập tên size'
      else if (seen.has(key(v.name))) e[k] = `Size ${v.name} bị trùng`
      else if (!isVnd(v.price)) e[k] = 'Giá phải là số đồng nguyên không âm'
      else if (v.code.trim() && (codes.has(key(v.code)) || key(v.code) === key(code))) e[k] = `Mã ${v.code} bị trùng`
      else if (v.code.trim() && menu.items.some(x => x.id !== item.id && (key(x.code) === key(v.code) || x.variants.some(y => key(y.code) === key(v.code))))) {
        e[k] = `Mã ${v.code} đã có món khác dùng`
      }
      seen.add(key(v.name))
      if (v.code.trim()) codes.add(key(v.code))
    })
  } else if (!isVnd(item.price)) {
    e.price = 'Giá phải là số đồng nguyên không âm'
  }

  const names = new Set<string>()
  const minBase = item.hasSizes ? Math.min(...item.variants.filter(v => !v.archivedAt).map(v => v.price)) : item.price
  let removable = 0
  item.components.forEach(c => {
    const k = `component:${c.id}`
    if (!c.name.trim()) e[k] = 'Nhập tên thành phần'
    else if (names.has(key(c.name))) e[k] = `Thành phần ${c.name} bị trùng`
    else if (!isVnd(c.removalDiscount)) e[k] = 'Tiền giảm phải là số đồng nguyên không âm'
    else if (!c.removable && c.removalDiscount > 0) e[k] = 'Thành phần chính không được bỏ nên không có tiền giảm'
    names.add(key(c.name))
    if (c.removable) removable += c.removalDiscount
  })
  if (Number.isFinite(minBase) && removable > minBase * (1 - menu.settings.minPriceRatio)) {
    e.components = `Bỏ hết thành phần sẽ giảm ${removable.toLocaleString('vi-VN')}đ, quá ${Math.round((1 - menu.settings.minPriceRatio) * 100)}% giá thấp nhất: khi gọi món app sẽ chặn`
  }
  return e
}

export function validateCategory(menu: Menu, c: Category): FieldErrors {
  const e: FieldErrors = {}
  if (!c.name.trim()) e.name = 'Nhập tên nhóm'
  else if (menu.categories.some(x => x.id !== c.id && x.parentId === c.parentId && key(x.name) === key(c.name))) e.name = 'Tên nhóm bị trùng'
  if (!/^#[0-9a-fA-F]{6}$/.test(c.color)) e.color = 'Chọn màu'
  if (c.parentId) {
    const parent = menu.categories.find(x => x.id === c.parentId)
    if (!parent || parent.id === c.id) e.parentId = 'Nhóm cha không hợp lệ'
    else if (parent.parentId) e.parentId = 'Chỉ có 2 cấp: nhóm lớn và nhóm con'
    else if (menu.categories.some(x => x.parentId === c.id)) e.parentId = 'Nhóm này đang có nhóm con nên không làm nhóm con được'
  }
  return e
}

/** Why a category cannot be deleted, or null. */
export function categoryDeleteBlock(menu: Menu, id: string): string | null {
  if (menu.categories.some(c => c.parentId === id)) return 'Nhóm còn nhóm con: chuyển hoặc xoá nhóm con trước'
  if (menu.items.some(i => i.categoryId === id)) return 'Nhóm còn món: chuyển món sang nhóm khác hoặc ẩn nhóm'
  return null
}

export function validateGroup(menu: Menu, g: ModifierGroup): FieldErrors {
  const e: FieldErrors = {}
  if (!g.name.trim()) e.name = 'Nhập tên nhóm tuỳ chọn'
  else if (menu.groups.some(x => x.id !== g.id && key(x.name) === key(g.name))) e.name = 'Tên nhóm bị trùng'
  if (!Number.isInteger(g.minSelect) || g.minSelect < 0) e.minSelect = 'Số chọn ít nhất phải từ 0'
  if (g.maxSelect != null && (!Number.isInteger(g.maxSelect) || g.maxSelect < Math.max(g.minSelect, 1))) {
    e.maxSelect = 'Số chọn nhiều nhất phải ≥ số chọn ít nhất và ≥ 1'
  }
  if (g.options.length < g.minSelect) e.options = `Cần ít nhất ${g.minSelect} lựa chọn`
  const names = new Set<string>()
  g.options.forEach(o => {
    const k = `option:${o.id}`
    if (!o.name.trim()) e[k] = 'Nhập tên lựa chọn'
    else if (names.has(key(o.name))) e[k] = `Lựa chọn ${o.name} bị trùng`
    else if (!isVnd(o.priceDelta)) e[k] = 'Giá cộng thêm phải là số đồng nguyên không âm'
    else if (!Number.isInteger(o.maxQty) || o.maxQty < 1) e[k] = 'Số lượng tối đa phải từ 1'
    else if (g.minSelect > 0 && o.isDefault) e[k] = 'Nhóm bắt buộc không chọn sẵn, để phục vụ hỏi khách'
    names.add(key(o.name))
  })
  return e
}
