// #/cai-dat/mau-in (settings.edit): what bills, pre-bills and shift reports say and how big each part prints — shop
// name and header lines, titles, the total label, the thank-you line, extra lines — for the whole shop, with a live
// preview. The base text size and paper stay per device (Cài đặt → Máy in).

import { useEffect, useMemo, useState } from 'react'
import { useAuth } from '../auth/context'
import { roleCan } from '../auth/permissions'
import { usePrintSettings } from '../cashier/paper'
import { printBlocks } from '../cashier/print'
import { ReceiptPreview } from '../cashier/screens/ui'
import { DEFAULT_TEMPLATE, LINE_SIZES, TEXT_MAX, receiptTemplate, type LineSize, type ReceiptTemplate, type StylePart, type TextPart } from '../cashier/template'
import '../cashier/cashier.css'
import { checkReceiptSettings } from '../floor/engine'
import { errText } from '../floor/hooks'
import type { FloorRepo } from '../floor/repo'
import type { FloorState, ReceiptSettings } from '../floor/types'
import { Field, Section, Switch } from '../menu/ui'
import { sampleReceipt } from './sampleReceipt'

function savedSettings(floor: FloorState): ReceiptSettings {
  const s = floor.shop
  return { name: s.name, address: s.address, phone: s.phone, taxCode: s.taxCode, footer: s.footer, template: receiptTemplate(s.receiptTemplate) }
}

/** Cỡ chữ (Thường / Vừa / To) and In đậm for one part. */
function StyleRow(props: { value: StylePart; onChange: (v: StylePart) => void; disabled: boolean }) {
  const v = props.value
  return (
    <div className="tpl-style">
      <div className="chip-row" role="group" aria-label="Cỡ chữ">
        {LINE_SIZES.map(z => (
          <button
            key={z.v}
            type="button"
            className={'chip chip-sm' + (v.size === z.v ? ' is-on' : '')}
            aria-pressed={v.size === z.v}
            disabled={props.disabled}
            onClick={() => props.onChange({ ...v, size: z.v as LineSize })}
          >
            {z.label}
          </button>
        ))}
      </div>
      <Switch checked={v.bold} disabled={props.disabled} onChange={bold => props.onChange({ ...v, bold })} label="Đậm" />
    </div>
  )
}

/** A part whose words the shop writes: text (several lines when `lines`), then its size and weight. */
function TextRow(props: { label: string; hint?: string; value: TextPart; onChange: (v: TextPart) => void; lines?: boolean; disabled: boolean; placeholder?: string }) {
  const v = props.value
  return (
    <div className="tpl-part">
      <Field label={props.label} hint={props.hint} wide>
        {props.lines ? (
          <textarea rows={2} maxLength={TEXT_MAX} value={v.text} disabled={props.disabled} placeholder={props.placeholder} onChange={e => props.onChange({ ...v, text: e.target.value })} />
        ) : (
          <input maxLength={TEXT_MAX} value={v.text} disabled={props.disabled} placeholder={props.placeholder} onChange={e => props.onChange({ ...v, text: e.target.value })} />
        )}
      </Field>
      <StyleRow value={v} disabled={props.disabled} onChange={st => props.onChange({ ...v, ...st })} />
    </div>
  )
}

export function ReceiptTemplateSettings(props: { floor: FloorState; repo: FloorRepo; onError: (m: string) => void; onInfo: (m: string) => void }) {
  const { session } = useAuth()
  const canEdit = roleCan(session.role, 'settings.edit')
  const saved = savedSettings(props.floor)
  const savedKey = JSON.stringify(saved)
  const [p, setP] = useState<ReceiptSettings>(saved)
  const [kind, setKind] = useState<'bill' | 'prebill'>('bill')
  const [busy, setBusy] = useState(false)
  const print = usePrintSettings()
  // another device saved: show what is stored now
  useEffect(() => setP(JSON.parse(savedKey) as ReceiptSettings), [savedKey])

  const dirty = JSON.stringify(p) !== savedKey
  let problem = ''
  try {
    checkReceiptSettings(p)
  } catch (e) {
    problem = errText(e)
  }
  const t = p.template
  const setT = <K extends keyof ReceiptTemplate>(k: K, v: ReceiptTemplate[K]) => setP({ ...p, template: { ...t, [k]: v } })
  const shop = useMemo(
    () => ({ ...props.floor.shop, name: p.name, address: p.address, phone: p.phone, taxCode: p.taxCode, footer: p.footer, receiptTemplate: p.template }),
    [props.floor.shop, p],
  )
  // eslint-disable-next-line react-hooks/exhaustive-deps -- laid out for this device's paper and base size
  const blocks = useMemo(() => sampleReceipt(shop, kind, new Date().toISOString()), [shop, kind, print])
  const off = !canEdit

  const save = () => {
    setBusy(true)
    props.repo
      .saveReceipt(p)
      .then(() => props.onInfo('Đã lưu mẫu in'), e => props.onError(errText(e)))
      .finally(() => setBusy(false))
  }

  return (
    <section className="screen print-settings tpl-settings">
      <h1>Mẫu in hoá đơn</h1>
      <p className="muted">
        Chữ và cỡ chữ từng phần trên hoá đơn, phiếu tạm tính và báo cáo ca — dùng chung cho mọi máy của quán. Khổ giấy và cỡ chữ gốc chỉnh riêng từng máy ở{' '}
        <a href="#/cai-dat/may-in">Cài đặt → Máy in</a>.
      </p>
      {!canEdit && <p className="field-error block">Chỉ người có quyền Sửa cài đặt mới lưu được.</p>}

      <div className="print-settings-cols">
        <div>
          <Section title="Đầu bill">
            <div className="tpl-part">
              <Field label="Tên quán" wide>
                <input maxLength={60} value={p.name} disabled={off} onChange={e => setP({ ...p, name: e.target.value })} />
              </Field>
              <StyleRow value={t.shopName} disabled={off} onChange={v => setT('shopName', v)} />
            </div>
            <div className="tpl-part">
              <div className="form-grid">
                <Field label="Địa chỉ" wide>
                  <input maxLength={TEXT_MAX} value={p.address} disabled={off} onChange={e => setP({ ...p, address: e.target.value })} />
                </Field>
                <Field label="Điện thoại">
                  <input maxLength={40} inputMode="tel" value={p.phone} disabled={off} onChange={e => setP({ ...p, phone: e.target.value })} />
                </Field>
                <Field label="Mã số thuế" hint="Bỏ trống thì không in">
                  <input maxLength={20} value={p.taxCode} disabled={off} onChange={e => setP({ ...p, taxCode: e.target.value })} />
                </Field>
              </div>
              <StyleRow value={t.shopInfo} disabled={off} onChange={v => setT('shopInfo', v)} />
            </div>
            <TextRow label="Dòng thêm dưới đầu bill" hint="Ví dụ giờ mở cửa, fanpage. Bỏ trống thì không in." lines value={t.headerNote} disabled={off} onChange={v => setT('headerNote', v)} placeholder="Mở cửa 10:00 – 22:00" />
          </Section>

          <Section title="Tiêu đề">
            <TextRow label="Tiêu đề hoá đơn" value={t.billTitle} disabled={off} onChange={v => setT('billTitle', v)} />
            <TextRow label="Tiêu đề phiếu tạm tính" value={t.prebillTitle} disabled={off} onChange={v => setT('prebillTitle', v)} />
            <TextRow label="Dòng dưới tiêu đề phiếu tạm tính" value={t.prebillNote} disabled={off} onChange={v => setT('prebillNote', v)} />
          </Section>

          <Section title="Thông tin và món">
            <div className="tpl-part">
              <span className="field-label">Số hoá đơn, bàn, giờ vào/ra</span>
              <StyleRow value={t.details} disabled={off} onChange={v => setT('details', v)} />
              <Switch checked={t.showStaff} disabled={off} onChange={v => setT('showStaff', v)} label="In tên thu ngân và phục vụ" />
            </div>
            <div className="tpl-part">
              <span className="field-label">Danh sách món</span>
              <StyleRow value={t.items} disabled={off} onChange={v => setT('items', v)} />
            </div>
            <TextRow label="Chữ dòng tổng tiền" value={t.totalLabel} disabled={off} onChange={v => setT('totalLabel', v)} placeholder="TỔNG CỘNG" />
            <TextRow label="Chữ trên mã QR chuyển khoản" value={t.qrTitle} disabled={off} onChange={v => setT('qrTitle', v)} />
          </Section>

          <Section title="Cuối bill">
            <div className="tpl-part">
              <Field label="Lời cảm ơn" wide>
                <textarea rows={2} maxLength={TEXT_MAX} value={p.footer} disabled={off} onChange={e => setP({ ...p, footer: e.target.value })} />
              </Field>
              <StyleRow value={t.footer} disabled={off} onChange={v => setT('footer', v)} />
            </div>
            <TextRow label="Lời nhắc trên phiếu tạm tính" lines value={t.prebillFooter} disabled={off} onChange={v => setT('prebillFooter', v)} />
            <TextRow label="Dòng thêm cuối bill" hint="Ví dụ Wi-Fi, số điện thoại đặt bàn. Bỏ trống thì không in." lines value={t.footerNote} disabled={off} onChange={v => setT('footerNote', v)} placeholder={'Wi-Fi: BoMyDen\nMật khẩu: …'} />
          </Section>

          {problem && dirty && <p className="field-error block">{problem}</p>}
          <div className="pay-settings-actions">
            <button type="button" className="btn" disabled={off || JSON.stringify(t) === JSON.stringify(DEFAULT_TEMPLATE)} onClick={() => setP({ ...p, template: DEFAULT_TEMPLATE })}>
              Mẫu mặc định
            </button>
            <button type="button" className="btn" disabled={!dirty || busy} onClick={() => setP(saved)}>
              Huỷ thay đổi
            </button>
            <button type="button" className="btn btn-primary" disabled={off || !dirty || !!problem || busy} onClick={save}>
              {busy ? 'Đang lưu…' : 'Lưu mẫu in'}
            </button>
          </div>
        </div>

        <section aria-label="Xem trước mẫu in" className="tpl-preview">
          <div className="chip-row" role="group" aria-label="Loại phiếu xem trước">
            <button type="button" className={'chip chip-sm' + (kind === 'bill' ? ' is-on' : '')} aria-pressed={kind === 'bill'} onClick={() => setKind('bill')}>
              Hoá đơn
            </button>
            <button type="button" className={'chip chip-sm' + (kind === 'prebill' ? ' is-on' : '')} aria-pressed={kind === 'prebill'} onClick={() => setKind('prebill')}>
              Phiếu tạm tính
            </button>
            <button type="button" className="btn btn-small" onClick={() => printBlocks(blocks, 'In thử mẫu').catch(e => props.onError(errText(e)))}>
              🖨 In thử
            </button>
          </div>
          <p className="muted small">
            Máy này: khổ {print.paper}mm{print.bold ? ', đang in đậm toàn bộ' : ''}.
          </p>
          <ReceiptPreview blocks={blocks} title="Xem trước mẫu in" picker={false} />
        </section>
      </div>
    </section>
  )
}
