// #/cai-dat/thanh-toan (settings.edit): which payment methods the cashier takes (tiền mặt, chuyển khoản with the
// shop's bank account for VietQR, thẻ), one VAT % for the dishes sent from now on, and whether bills print VAT.

import { useEffect, useState } from 'react'
import { useAuth } from '../auth/context'
import { roleCan } from '../auth/permissions'
import { paymentSettings } from '../cashier/config'
import { checkPaymentSettings } from '../floor/engine'
import { errText } from '../floor/hooks'
import type { FloorRepo } from '../floor/repo'
import type { FloorState, PaymentSettings as Settings } from '../floor/types'
import { METHOD_LABEL, type PayMethod } from '../lib/billing'
import { Field, Section, Switch } from '../menu/ui'

/** NAPAS BINs of the banks shops use most (for VietQR). */
const BANKS: { bin: string; name: string }[] = [
  { bin: '970436', name: 'Vietcombank' },
  { bin: '970415', name: 'VietinBank' },
  { bin: '970418', name: 'BIDV' },
  { bin: '970405', name: 'Agribank' },
  { bin: '970407', name: 'Techcombank' },
  { bin: '970422', name: 'MB Bank' },
  { bin: '970416', name: 'ACB' },
  { bin: '970432', name: 'VPBank' },
  { bin: '970403', name: 'Sacombank' },
  { bin: '970423', name: 'TPBank' },
  { bin: '970441', name: 'VIB' },
  { bin: '970437', name: 'HDBank' },
  { bin: '970443', name: 'SHB' },
  { bin: '970426', name: 'MSB' },
  { bin: '970448', name: 'OCB' },
  { bin: '970440', name: 'SeABank' },
  { bin: '970431', name: 'Eximbank' },
  { bin: '970449', name: 'LPBank' },
]

const METHOD_HINT: Record<PayMethod, string> = {
  cash: 'Nhận tiền khách đưa, tính tiền thối',
  bank: 'Hiện mã VietQR đúng số tiền và nội dung',
  card: 'Cà thẻ trên máy POS của ngân hàng',
}

/** Rates the law uses most; any whole % can be typed. */
const VAT_PRESETS = [0, 5, 8, 10]

export function PaymentSettings(props: { floor: FloorState; repo: FloorRepo; onError: (m: string) => void; onInfo: (m: string) => void }) {
  const { session } = useAuth()
  const canEdit = roleCan(session.role, 'settings.edit')
  const saved = paymentSettings(props.floor.shop)
  const [p, setP] = useState<Settings>(saved)
  const [busy, setBusy] = useState(false)
  const savedKey = JSON.stringify(saved)
  // another device saved: show what is stored now
  useEffect(() => setP(JSON.parse(savedKey) as Settings), [savedKey])

  const dirty = JSON.stringify(p) !== savedKey
  let problem = ''
  try {
    checkPaymentSettings(p)
  } catch (e) {
    problem = errText(e)
  }
  const bankKnown = BANKS.some(b => b.bin === p.bankBin)
  const setMethod = (m: PayMethod, on: boolean) => setP({ ...p, payMethods: { ...p.payMethods, [m]: on } })
  const save = () => {
    setBusy(true)
    props.repo
      .saveShop(p)
      .then(() => props.onInfo('Đã lưu cài đặt thanh toán'), e => props.onError(errText(e)))
      .finally(() => setBusy(false))
  }

  return (
    <section className="screen pay-settings">
      <h1>Cài đặt thanh toán</h1>
      {!canEdit && <p className="field-error block">Chỉ người có quyền Sửa cài đặt mới lưu được.</p>}

      <Section title="Phương thức thanh toán">
        <p className="muted small">Thu ngân chỉ thấy các cách trả đang bật. Bật ít nhất một cách.</p>
        <ul className="pay-methods">
          {(['cash', 'bank', 'card'] as PayMethod[]).map(m => (
            <li key={m}>
              <Switch
                checked={p.payMethods[m]}
                disabled={!canEdit}
                onChange={v => setMethod(m, v)}
                label={
                  <span>
                    <b>{m === 'bank' ? 'Ngân hàng (chuyển khoản)' : METHOD_LABEL[m]}</b>
                    <span className="muted small block">{METHOD_HINT[m]}</span>
                  </span>
                }
              />
            </li>
          ))}
        </ul>
      </Section>

      {p.payMethods.bank && (
        <Section title="Tài khoản nhận chuyển khoản">
          <p className="muted small">In lên mã VietQR của phiếu tạm tính và màn thu ngân. Kiểm tra kỹ số tài khoản trước khi lưu.</p>
          <div className="form-grid">
            <Field label="Ngân hàng">
              <select
                value={bankKnown ? p.bankBin : ''}
                disabled={!canEdit}
                onChange={e => {
                  const b = BANKS.find(x => x.bin === e.target.value)
                  setP(b ? { ...p, bankBin: b.bin, bankName: b.name } : { ...p, bankBin: '', bankName: '' })
                }}
              >
                <option value="">Ngân hàng khác…</option>
                {BANKS.map(b => (
                  <option key={b.bin} value={b.bin}>
                    {b.name}
                  </option>
                ))}
              </select>
            </Field>
            {!bankKnown && (
              <>
                <Field label="Tên ngân hàng">
                  <input value={p.bankName} disabled={!canEdit} onChange={e => setP({ ...p, bankName: e.target.value })} />
                </Field>
                <Field label="Mã ngân hàng (BIN)" hint="6 chữ số theo NAPAS, ví dụ 970436">
                  <input inputMode="numeric" maxLength={6} value={p.bankBin} disabled={!canEdit} onChange={e => setP({ ...p, bankBin: e.target.value.replace(/\D/g, '') })} />
                </Field>
              </>
            )}
            <Field label="Số tài khoản">
              <input inputMode="numeric" value={p.bankAccount} disabled={!canEdit} onChange={e => setP({ ...p, bankAccount: e.target.value })} />
            </Field>
            <Field label="Chủ tài khoản" hint="Viết hoa, không dấu">
              <input value={p.bankAccountName} disabled={!canEdit} onChange={e => setP({ ...p, bankAccountName: e.target.value })} />
            </Field>
          </div>
        </Section>
      )}

      <Section title="Thuế">
        <fieldset className="pick-group">
          <legend className="field-label">Mức thuế GTGT</legend>
          <div className="chip-row">
            <button type="button" className={'chip' + (p.vatRate === null ? ' is-on' : '')} disabled={!canEdit} onClick={() => setP({ ...p, vatRate: null })}>
              Theo nhóm món
            </button>
            {VAT_PRESETS.map(r => (
              <button key={r} type="button" className={'chip' + (p.vatRate === r ? ' is-on' : '')} disabled={!canEdit} onClick={() => setP({ ...p, vatRate: r })}>
                {r}%
              </button>
            ))}
          </div>
        </fieldset>
        <div className="form-grid">
          <Field
            label="Hoặc nhập mức khác"
            hint={p.vatRate === null ? 'Theo nhóm món: món ăn, đồ uống 8%; bia, rượu 10%' : 'Áp dụng cho mọi món gửi bếp từ lúc lưu; món đã gửi giữ mức cũ'}
          >
            <span className="input-unit">
              <input
                type="number"
                inputMode="numeric"
                min={0}
                max={100}
                step={1}
                placeholder="—"
                disabled={!canEdit}
                value={p.vatRate ?? ''}
                onChange={e => setP({ ...p, vatRate: e.target.value === '' ? null : Number(e.target.value) })}
              />
              <span>%</span>
            </span>
          </Field>
        </div>
        <Switch
          checked={p.showVat}
          disabled={!canEdit}
          onChange={v => setP({ ...p, showVat: v })}
          label={
            <span>
              <b>Hiển thị thuế trên hoá đơn</b>
              <span className="muted small block">
                {p.showVat ? 'Hoá đơn và phiếu tạm tính in dòng thuế GTGT' : 'Không in dòng thuế (thuế cộng thêm vào giá vẫn in để tổng khớp)'}
              </span>
            </span>
          }
        />
      </Section>

      {problem && dirty && <p className="field-error block">{problem}</p>}
      <div className="pay-settings-actions">
        <button type="button" className="btn" disabled={!dirty || busy} onClick={() => setP(saved)}>
          Huỷ thay đổi
        </button>
        <button type="button" className="btn btn-primary" disabled={!canEdit || !dirty || !!problem || busy} onClick={save}>
          {busy ? 'Đang lưu…' : 'Lưu cài đặt'}
        </button>
      </div>
    </section>
  )
}
