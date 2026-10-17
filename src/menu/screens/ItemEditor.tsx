// Manager: one dish — profile, sizes, components with removal discount, option groups / add-ons, tax and fees.

import { useState } from 'react'
import { minusVnd, vnd } from '../picker'
import { newId } from '../repo'
import { ITEM_STATUS_LABEL, UNITS, type Component, type Menu, type MenuItem, type Variant } from '../types'
import { NAME_MAX, SHORT_NAME_MAX, validateItem } from '../validate'
import { Field, MoneyInput, Section, Switch } from '../ui'

export function ItemEditor(props: {
  menu: Menu
  value: MenuItem
  onSave: (item: MenuItem) => Promise<void>
  onDelete: (id: string) => Promise<void>
  onClose: () => void
}) {
  const { menu } = props
  const [it, setIt] = useState<MenuItem>(props.value)
  const [tried, setTried] = useState(false)
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState<string | null>(null)
  const all = validateItem(menu, it)
  const e = tried ? all : {}
  const isNew = !menu.items.some(x => x.id === it.id)
  const cat = menu.categories.find(c => c.id === it.categoryId)
  const set = (patch: Partial<MenuItem>) => {
    setSaved(null)
    setIt(prev => ({ ...prev, ...patch }))
  }

  const live = it.variants.filter(v => !v.archivedAt).sort((a, b) => a.sort - b.sort)
  const setVariant = (id: string, patch: Partial<Variant>) => set({ variants: it.variants.map(v => (v.id === id ? { ...v, ...patch } : v)) })
  const removeVariant = (id: string) =>
    // Sizes already saved are archived (they may be on old bills); new ones just disappear.
    set({ variants: props.value.variants.some(v => v.id === id) ? it.variants.map(v => (v.id === id ? { ...v, archivedAt: new Date().toISOString() } : v)) : it.variants.filter(v => v.id !== id) })
  const addVariant = () =>
    set({ variants: [...it.variants, { id: newId(), name: '', code: it.code ? `${it.code}-` : '', price: 0, sort: live.length + 1, soldOutUntil: null, archivedAt: null }] })

  const comps = [...it.components].sort((a, b) => a.sort - b.sort)
  const setComp = (id: string, patch: Partial<Component>) => set({ components: it.components.map(c => (c.id === id ? { ...c, ...patch } : c)) })
  const addComp = () =>
    set({ components: [...it.components, { id: newId(), name: '', kitchenName: '', qty: 1, unit: '', removable: true, removalDiscount: 0, addonOptionId: null, sort: comps.length + 1, soldOutUntil: null }] })

  const addonOptions = menu.groups.filter(g => g.kind === 'addon' && it.groups.some(l => l.groupId === g.id)).flatMap(g => g.options)
  const toggleGroup = (groupId: string, on: boolean) =>
    set({ groups: on ? [...it.groups, { groupId, sort: it.groups.length + 1, minOverride: null, maxOverride: null }] : it.groups.filter(l => l.groupId !== groupId) })

  const save = async (patch: Partial<MenuItem> = {}) => {
    setTried(true)
    const next = { ...it, ...patch }
    if (Object.keys(validateItem(menu, next)).length) return
    setBusy(true)
    try {
      await props.onSave({ ...next, name: next.name.trim(), shortName: next.shortName.trim().toUpperCase(), code: next.code.trim() })
      setIt(next)
      setSaved('Đã lưu')
    } catch (err) {
      setSaved('Chưa lưu được: ' + (err instanceof Error ? err.message : String(err)))
    } finally {
      setBusy(false)
    }
  }

  const station = menu.stations.find(s => s.id === (it.stationId ?? cat?.defaultStationId))
  const vat = menu.vatGroups.find(g => g.code === (it.vatGroup ?? cat?.vatGroup))
  const errCount = Object.keys(all).length

  return (
    <div className="screen editor">
      <div className="screen-head">
        <button type="button" className="link" onClick={props.onClose}>
          ← Danh sách món
        </button>
        <span className={`badge badge-${it.status}`}>{ITEM_STATUS_LABEL[it.status]}</span>
      </div>
      <h1>{it.name || 'Món mới'}</h1>

      <Section title="Hồ sơ món">
        <div className="form-grid">
          <Field label={`Tên đầy đủ (in hoá đơn) ${it.name.trim().length}/${NAME_MAX}`} error={e.name} wide>
            <input value={it.name} onChange={x => set({ name: x.target.value })} placeholder="Steak bò nướng" />
          </Field>
          <Field label={`Tên ngắn (in phiếu bếp) ${it.shortName.trim().length}/${SHORT_NAME_MAX}`} error={e.shortName}>
            <input value={it.shortName} className="upper" onChange={x => set({ shortName: x.target.value.toUpperCase() })} placeholder="STEAK BÒ" />
          </Field>
          <Field label="Mã món" error={e.code} hint="Không trùng, dùng để gõ tìm nhanh">
            <input value={it.code} onChange={x => set({ code: x.target.value })} placeholder="101" />
          </Field>
          <Field label="Nhóm món" error={e.categoryId}>
            <select value={it.categoryId} onChange={x => set({ categoryId: x.target.value })}>
              {menu.categories.filter(c => !c.parentId).sort((a, b) => a.sort - b.sort).flatMap(c => [
                <option key={c.id} value={c.id}>{c.name}</option>,
                ...menu.categories.filter(k => k.parentId === c.id).sort((a, b) => a.sort - b.sort).map(k => (
                  <option key={k.id} value={k.id}>{`${c.name} › ${k.name}`}</option>
                )),
              ])}
            </select>
          </Field>
          <Field label="Đơn vị tính" error={e.unit}>
            <select value={it.unit} onChange={x => set({ unit: x.target.value })}>
              {UNITS.map(u => <option key={u}>{u}</option>)}
            </select>
          </Field>
          <Field label="Khu chế biến" error={e.stationId}>
            <select value={it.stationId ?? ''} onChange={x => set({ stationId: x.target.value || null })}>
              <option value="">Theo nhóm ({menu.stations.find(s => s.id === cat?.defaultStationId)?.name ?? 'chưa có'})</option>
              {menu.stations.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </Field>
          <Field label="Thời gian làm chuẩn (phút)" error={e.prepMinutes}>
            <input type="number" inputMode="numeric" min={1} max={240} value={it.prepMinutes ?? ''} onChange={x => set({ prepMinutes: x.target.value === '' ? null : Number(x.target.value) })} />
          </Field>
          <Field label="Mô tả cho nhân viên" wide>
            <textarea rows={2} value={it.description} onChange={x => set({ description: x.target.value })} placeholder="Gồm 1 miếng steak, 1 trứng ốp la, 1 đĩa salad" />
          </Field>
          <Field label="Từ khoá tìm thêm (cách nhau bằng dấu phẩy)" wide>
            <input value={it.keywords.join(', ')} onChange={x => set({ keywords: x.target.value.split(',').map(k => k.trimStart()).filter((k, i, a) => k || i === a.length - 1) })} placeholder="bít tết" />
          </Field>
        </div>
      </Section>

      <Section title="Giá và size" error={e.sizes} aside={<Switch label="Món có size" checked={it.hasSizes} onChange={v => set({ hasSizes: v })} />}>
        {!it.hasSizes ? (
          <Field label="Giá bán" error={e.price}>
            <MoneyInput value={it.price} onChange={v => set({ price: v })} ariaLabel="Giá bán" />
          </Field>
        ) : (
          <>
            <p className="muted small">Mỗi size một giá. Không có size mặc định: phục vụ luôn phải chọn size.</p>
            <ul className="rows">
              {live.map(v => (
                <li key={v.id} className={'edit-row' + (e[`size:${v.id}`] ? ' has-error' : '')}>
                  <input aria-label="Tên size" className="w-name" value={v.name} placeholder="300g" onChange={x => setVariant(v.id, { name: x.target.value })} />
                  <MoneyInput ariaLabel={`Giá size ${v.name}`} value={v.price} onChange={p => setVariant(v.id, { price: p })} />
                  <input aria-label="Mã size" className="w-code" value={v.code} placeholder="101-300" onChange={x => setVariant(v.id, { code: x.target.value })} />
                  <button type="button" className="icon-btn" aria-label={`Bỏ size ${v.name}`} onClick={() => removeVariant(v.id)}>
                    ✕
                  </button>
                  {e[`size:${v.id}`] && <span className="field-error row-error">{e[`size:${v.id}`]}</span>}
                </li>
              ))}
            </ul>
            <button type="button" className="btn" onClick={addVariant}>
              + Thêm size
            </button>
          </>
        )}
      </Section>

      <Section title="Thành phần" error={e.components}>
        <p className="muted small">Khách được bỏ thì giảm tiền theo mức ở đây; phục vụ không tự gõ số khác. Thành phần chính không bỏ được.</p>
        <ul className="rows">
          {comps.map(c => (
            <li key={c.id} className={'edit-row comp-row' + (e[`component:${c.id}`] ? ' has-error' : '')}>
              <input aria-label="Tên thành phần" className="w-name" value={c.name} placeholder="Trứng ốp la" onChange={x => setComp(c.id, { name: x.target.value })} />
              <input aria-label="Tên in bếp" className="w-code upper" value={c.kitchenName} placeholder="TRỨNG" onChange={x => setComp(c.id, { kitchenName: x.target.value.toUpperCase() })} />
              <select aria-label="Loại thành phần" value={c.removable ? 'removable' : 'main'} onChange={x => setComp(c.id, x.target.value === 'main' ? { removable: false, removalDiscount: 0 } : { removable: true })}>
                <option value="main">Chính (không bỏ)</option>
                <option value="removable">Được bỏ</option>
              </select>
              {c.removable ? (
                <MoneyInput ariaLabel={`Giảm khi bỏ ${c.name}`} value={c.removalDiscount} onChange={v => setComp(c.id, { removalDiscount: v })} />
              ) : (
                <span className="muted small">🔒 không bỏ</span>
              )}
              {c.removable && addonOptions.length > 0 && (
                <select aria-label="Món thêm tương ứng" value={c.addonOptionId ?? ''} onChange={x => setComp(c.id, { addonOptionId: x.target.value || null })}>
                  <option value="">Món thêm trùng: không có</option>
                  {addonOptions.map(o => <option key={o.id} value={o.id}>Trùng với: {o.name}</option>)}
                </select>
              )}
              <button type="button" className="icon-btn" aria-label={`Bỏ thành phần ${c.name}`} onClick={() => set({ components: it.components.filter(x => x.id !== c.id) })}>
                ✕
              </button>
              <span className="comp-preview muted small">
                {c.removable ? `Khi gọi: “Không ${(c.name || '…').toLowerCase()}” ${c.removalDiscount ? minusVnd(c.removalDiscount) : '0đ'}` : 'Thành phần chính'}
              </span>
              {e[`component:${c.id}`] && <span className="field-error row-error">{e[`component:${c.id}`]}</span>}
            </li>
          ))}
        </ul>
        <button type="button" className="btn" onClick={addComp}>
          + Thêm thành phần
        </button>
      </Section>

      <Section title="Tuỳ chọn và món thêm">
        <p className="muted small">Nhóm dùng chung cho nhiều món; sửa nhóm ở tab Tuỳ chọn.</p>
        <ul className="rows">
          {[...menu.groups].sort((a, b) => a.sort - b.sort).map(g => (
            <li key={g.id} className="check-row">
              <Switch
                checked={it.groups.some(l => l.groupId === g.id)}
                onChange={v => toggleGroup(g.id, v)}
                label={
                  <span>
                    <b>{g.name}</b>{' '}
                    <span className="muted small">
                      {g.kind === 'addon' ? 'món thêm tính tiền' : g.minSelect > 0 ? `bắt buộc, chọn ${g.minSelect}${g.maxSelect !== g.minSelect ? `–${g.maxSelect ?? '∞'}` : ''}` : `không bắt buộc, tối đa ${g.maxSelect ?? '∞'}`}
                      {' · '}
                      {g.options.map(o => (o.priceDelta ? `${o.name} +${vnd(o.priceDelta)}` : o.name)).join(', ')}
                    </span>
                  </span>
                }
              />
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Thuế và phí">
        <div className="form-grid">
          <Field label="Thuế VAT" hint={`Đang áp dụng: ${vat ? `${vat.rate}%` : '—'}. Mức thuế do kế toán xác nhận.`}>
            <select value={it.vatGroup ?? ''} onChange={x => set({ vatGroup: x.target.value || null })}>
              <option value="">Theo nhóm món ({menu.vatGroups.find(g => g.code === cat?.vatGroup)?.name})</option>
              {menu.vatGroups.map(g => <option key={g.code} value={g.code}>{g.name} ({g.rate}%)</option>)}
            </select>
          </Field>
          <Field label="Giá bán">
            <select value={it.priceIncludesVat == null ? '' : String(it.priceIncludesVat)} onChange={x => set({ priceIncludesVat: x.target.value === '' ? null : x.target.value === 'true' })}>
              <option value="">Theo cài đặt quán ({menu.settings.pricesIncludeVat ? 'đã gồm VAT' : 'chưa gồm VAT'})</option>
              <option value="true">Đã gồm VAT</option>
              <option value="false">Chưa gồm VAT</option>
            </select>
          </Field>
          <Switch label="Tính phí phục vụ" checked={it.serviceCharge} onChange={v => set({ serviceCharge: v })} />
          <Switch label="Được giảm giá hoá đơn" checked={it.discountable} onChange={v => set({ discountable: v })} />
        </div>
        <p className="muted small">Gửi về: {station?.name ?? 'chưa chọn khu'}.</p>
      </Section>

      <div className="save-bar">
        {it.status === 'draft' && !isNew && (
          <button type="button" className="btn btn-danger" disabled={busy} onClick={() => props.onDelete(it.id)}>
            Xoá nháp
          </button>
        )}
        {it.status !== 'active' ? (
          <button type="button" className="btn" disabled={busy} onClick={() => save({ status: 'active' })}>
            Mở bán
          </button>
        ) : (
          <button type="button" className="btn" disabled={busy} onClick={() => save({ status: 'archived' })}>
            Ngừng kinh doanh
          </button>
        )}
        <button type="button" className="btn btn-primary btn-grow" disabled={busy} onClick={() => save()}>
          {tried && errCount ? `Còn ${errCount} lỗi` : saved ?? 'Lưu món'}
        </button>
      </div>
    </div>
  )
}
