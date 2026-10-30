// #/cai-dat/dat-hang: nhận đơn giao hàng từ web for this branch (0027) and the shop's own price table, which only gives
// the guest an estimate: staff enter the real fee from Grab, Be or Xanh SM on each order. The distance needs the
// branch's position, set under Mã QR gọi món.

import { useState } from 'react'
import { useAuth } from '../auth/context'
import { roleCan } from '../auth/permissions'
import { errText } from '../floor/hooks'
import type { FloorRepo } from '../floor/repo'
import type { FloorState } from '../floor/types'
import { DEFAULT_SHIP, shipRulesProblem, type ShipRules } from '../lib/ship'
import { Section, Switch } from '../menu/ui'

const PAGE = 'https://dathang.bomyden.vn'

const FIELDS: { key: keyof ShipRules; label: string; step: number }[] = [
  { key: 'baseKm', label: 'Số km đầu', step: 0.5 },
  { key: 'baseFee', label: 'Giá số km đầu (đồng)', step: 1000 },
  { key: 'perKm', label: 'Mỗi km tiếp theo (đồng)', step: 1000 },
  { key: 'maxKm', label: 'Giao xa nhất (km)', step: 1 },
]

export function OnlineSettings(props: { floor: FloorState; repo: FloorRepo; onError: (m: string) => void; onInfo: (m: string) => void }) {
  const { floor, repo } = props
  const canEdit = roleCan(useAuth().session.role, 'settings.edit')
  const savedShip = floor.settings.onlineShip ?? DEFAULT_SHIP
  const savedOn = floor.settings.onlineOrder !== false
  const [on, setOn] = useState(savedOn)
  const [ship, setShip] = useState(savedShip)
  const [saving, setSaving] = useState(false)
  const dirty = on !== savedOn || JSON.stringify(ship) !== JSON.stringify(savedShip)
  const hasPos = floor.settings.guestGeo?.lat != null && floor.settings.guestGeo.lng != null
  const save = () => {
    const bad = shipRulesProblem(ship)
    if (bad) return props.onError(bad)
    setSaving(true)
    repo
      .setOnlineSettings({ on, ship })
      .then(() => props.onInfo(on ? 'Đã lưu: đang nhận đơn online' : 'Đã lưu: tắt nhận đơn online'), e => props.onError(errText(e)))
      .finally(() => setSaving(false))
  }
  const copy = () => navigator.clipboard?.writeText(PAGE).then(() => props.onInfo('Đã chép link đặt hàng'), () => props.onError('Không chép được'))

  return (
    <>
      <h1>Đặt hàng online</h1>
      <Section
        title="Nhận đơn giao hàng"
        aside={
          canEdit && (
            <button type="button" className="btn btn-primary btn-small" disabled={!dirty || saving} onClick={save}>
              {saving ? 'Đang lưu…' : 'Lưu'}
            </button>
          )
        }
      >
        <Switch checked={on} disabled={!canEdit} label={on ? 'Đang bật: chi nhánh này hiện trên trang đặt hàng' : 'Đang tắt: khách không đặt được ở chi nhánh này'} onChange={setOn} />
        <p className="muted small">
          Link cho khách: <b>{PAGE}</b>{' '}
          <button type="button" className="link small" onClick={copy}>
            Chép link
          </button>
        </p>
        <p className="muted small">Đơn hiện ở Sơ đồ bàn → 🛵 Đơn online. Nhân viên báo phí ship, khách đồng ý rồi mới gửi bếp thành đơn mang về.</p>
        {!hasPos && (
          <p className="warn">
            Chưa có vị trí chi nhánh nên chưa tính được khoảng cách: vào <a href="#/cai-dat/ma-qr">Mã QR gọi món</a> lấy vị trí quán.
          </p>
        )}
      </Section>
      <Section title="Bảng giá ship tạm tính">
        <p className="muted small">Chỉ để khách ước lượng trước khi đặt. Đây là số mẫu, hãy sửa cho gần giá Grab, Be, Xanh SM ở khu vực của quán.</p>
        <div className="form-grid">
          {FIELDS.map(f => (
            <label key={f.key} className="field">
              <span className="field-label">{f.label}</span>
              <input
                type="number"
                inputMode="decimal"
                min={0}
                step={f.step}
                disabled={!canEdit}
                value={ship[f.key]}
                onChange={e => setShip(s => ({ ...s, [f.key]: Number(e.target.value) }))}
              />
            </label>
          ))}
        </div>
      </Section>
    </>
  )
}
