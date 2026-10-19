// #/ca: mở ca (tiền đầu ca), totals of the open shift by payment method, count the cash by note,
// expected vs counted, difference, chốt ca and the 80mm shift report (also reprint for closed shifts).

import { useMemo, useState } from 'react'
import { useAuth } from '../../auth/context'
import { roleCan } from '../../auth/permissions'
import { METHOD_LABEL, formatMoney, formatVnd, type PayMethod } from '../../lib/billing'
import { DEFAULT_REGISTER } from '../../floor/engine'
import { errText } from '../../floor/hooks'
import { clock, isOpen } from '../../floor/logic'
import type { FloorRepo } from '../../floor/repo'
import type { FloorState, Shift } from '../../floor/types'
import { fmtDate, shiftReportBlocks } from '../receipt'
import { printBlocks } from '../print'
import { DENOMINATIONS, countedTotal, openShiftOf, shiftSummary } from '../shift'
import { MoneyInput, ReceiptPreview } from './ui'

export function ShiftScreen(props: { floor: FloorState; repo: FloorRepo; me: string; now: Date; onError: (m: string) => void; onInfo: (m: string) => void }) {
  const { floor, repo } = props
  const shift = openShiftOf(floor.shifts, DEFAULT_REGISTER)
  const closed = floor.shifts.filter(s => s.closedAt).sort((a, b) => (b.closedAt ?? '').localeCompare(a.closedAt ?? ''))
  const [viewing, setViewing] = useState<string | null>(null)
  const shown = viewing ? floor.shifts.find(s => s.id === viewing) ?? null : null
  const purge = roleCan(useAuth().session.role, 'admin.delete')
  const remove = (s: Shift) => {
    if (!confirm(`Xoá vĩnh viễn ca ${s.register} · ${s.openedBy} · ${fmtDate(s.openedAt)} ${clock(s.openedAt)}? Hoá đơn trong ca vẫn giữ (không thuộc ca nào). Không khôi phục được.`)) return
    repo.adminDelete('shift', s.id).then(() => (setViewing(null), props.onInfo('Đã xoá ca')), e => props.onError(errText(e)))
  }
  return (
    <main className="cashier-main shift-screen">
      {shown ? (
        <ClosedShift floor={floor} shift={shown} onBack={() => setViewing(null)} onDelete={purge ? () => remove(shown) : undefined} onError={props.onError} />
      ) : shift ? (
        <CloseShift key={shift.id} floor={floor} repo={repo} shift={shift} me={props.me} onError={props.onError} onInfo={props.onInfo} />
      ) : (
        <OpenShift floor={floor} repo={repo} last={closed[0] ?? null} onError={props.onError} onInfo={props.onInfo} />
      )}
      {closed.length > 0 && !shown && (
        <section className="card">
          <h2>Ca đã chốt</h2>
          <ul className="pay-list">
            {closed.slice(0, 10).map(s => {
              const diff = (s.countedCash ?? 0) - (s.expectedCash ?? 0)
              return (
                <li key={s.id}>
                  <button type="button" className="pay-pick" onClick={() => setViewing(s.id)}>
                    <span>
                      <b>
                        {s.register} · {s.openedBy} · {fmtDate(s.openedAt)} {clock(s.openedAt)}–{clock(s.closedAt)}
                      </b>
                      <span className="muted small block">
                        Đếm {formatVnd(s.countedCash ?? 0)} · dự kiến {formatVnd(s.expectedCash ?? 0)}
                      </span>
                    </span>
                    <span className={'diff ' + (diff === 0 ? 'is-zero' : diff > 0 ? 'is-over' : 'is-short')}>{diff === 0 ? 'Khớp' : (diff > 0 ? '+' : '') + formatMoney(diff)}</span>
                  </button>
                </li>
              )
            })}
          </ul>
        </section>
      )}
    </main>
  )
}

function OpenShift(props: { floor: FloorState; repo: FloorRepo; last: Shift | null; onError: (m: string) => void; onInfo: (m: string) => void }) {
  const suggested = props.last?.countedCash ?? null
  const [float, setFloat] = useState<number | null>(suggested)
  const [busy, setBusy] = useState(false)
  const open = async () => {
    if (float == null) return
    setBusy(true)
    try {
      await props.repo.openShift({ openingFloat: float, register: DEFAULT_REGISTER })
      props.onInfo('Đã mở ca')
    } catch (e) {
      props.onError(errText(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="card open-shift">
      <h1>Mở ca · {DEFAULT_REGISTER}</h1>
      <p className="muted">Đếm tiền lẻ có sẵn trong két và nhập số tiền đầu ca. Phải mở ca mới thu tiền được.</p>
      <label className="field">
        <span className="field-label">Tiền đầu ca</span>
        <MoneyInput label="Tiền đầu ca" value={float} onChange={setFloat} autoFocus />
      </label>
      <div className="quick-cash">
        {suggested != null && (
          <button type="button" className="chip chip-sm" onClick={() => setFloat(suggested)}>
            Ca trước để lại {formatMoney(suggested)}
          </button>
        )}
        {[0, 1000000, 2000000, 3000000].map(v => (
          <button key={v} type="button" className={'chip chip-sm' + (float === v ? ' is-on' : '')} onClick={() => setFloat(v)}>
            {formatMoney(v)}
          </button>
        ))}
      </div>
      <button type="button" className="btn btn-primary btn-big" disabled={float == null || busy} onClick={open}>
        Mở ca với {float == null ? '…' : formatVnd(float)}
      </button>
    </section>
  )
}

function CloseShift(props: { floor: FloorState; repo: FloorRepo; shift: Shift; me: string; onError: (m: string) => void; onInfo: (m: string) => void }) {
  const { floor, shift } = props
  const [count, setCount] = useState<Record<string, number>>({})
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const sum = useMemo(() => shiftSummary(shift, floor.bills), [shift, floor.bills])
  const counted = countedTotal(count)
  const touched = Object.values(count).some(n => n > 0)
  const diff = counted - sum.expectedCash
  const openOrders = floor.orders.filter(o => isOpen(o) && floor.lines.some(l => l.orderId === o.id && l.status !== 'void')).length
  const paying = floor.orders.filter(o => isOpen(o) && o.payingAt).length
  const report = (draft: boolean) =>
    shiftReportBlocks({
      shop: floor.shop, register: shift.register, openedBy: shift.openedBy, openedAt: shift.openedAt,
      closedBy: draft ? null : props.me, closedAt: draft ? null : new Date().toISOString(),
      summary: sum, countedDetail: count, countedCash: touched ? counted : null, note, openOrders, draft,
    })
  const preview = report(true)
  const set = (v: number, n: number) => setCount(c => ({ ...c, [String(v)]: Math.max(0, Math.min(9999, n)) }))
  const close = async () => {
    if (diff !== 0 && !note.trim()) return props.onError('Két lệch so với dự kiến: ghi lý do')
    if (!confirm(`Chốt ca với ${formatVnd(counted)} tiền mặt đếm được${diff ? ` (lệch ${diff > 0 ? '+' : ''}${formatMoney(diff)})` : ''}?`)) return
    setBusy(true)
    try {
      const blocks = report(false)
      await props.repo.closeShift({ shiftId: shift.id, countedDetail: count, note })
      props.onInfo('Đã chốt ca')
      await printBlocks(blocks, 'Báo cáo chốt ca')
    } catch (e) {
      props.onError(errText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="cashier-cols shift-cols">
      <section className="card">
        <div className="card-head">
          <h1>Chốt ca · {shift.register}</h1>
          <span className="muted small">
            {shift.openedBy} mở lúc {clock(shift.openedAt)} {fmtDate(shift.openedAt)}
          </span>
        </div>
        <dl className="bill-sums shift-sums">
          <div>
            <dt>Số hoá đơn</dt>
            <dd>{sum.bills}</dd>
          </div>
          <div>
            <dt>Tiền hàng</dt>
            <dd>{formatMoney(sum.subtotal)}</dd>
          </div>
          {sum.discount > 0 && (
            <div>
              <dt>Giảm giá hoá đơn</dt>
              <dd>{formatMoney(-sum.discount)}</dd>
            </div>
          )}
          {sum.rounding !== 0 && (
            <div>
              <dt>Làm tròn</dt>
              <dd>{formatMoney(sum.rounding)}</dd>
            </div>
          )}
          <div className="bill-total">
            <dt>Doanh thu</dt>
            <dd>{formatVnd(sum.sales)}</dd>
          </div>
        </dl>
        <h2 className="sub-h">Theo cách trả</h2>
        <table className="method-table">
          <tbody>
            {(['cash', 'bank', 'card'] as PayMethod[]).map(m => (
              <tr key={m}>
                <th>{METHOD_LABEL[m]}</th>
                <td>{formatMoney(sum.byMethod[m])}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <h2 className="sub-h">Tiền mặt trong két</h2>
        <table className="method-table">
          <tbody>
            <tr>
              <th>Tiền đầu ca</th>
              <td>{formatMoney(sum.openingFloat)}</td>
            </tr>
            <tr>
              <th>+ Thu tiền mặt</th>
              <td>{formatMoney(sum.byMethod.cash)}</td>
            </tr>
            <tr className="strong">
              <th>= Dự kiến</th>
              <td>{formatMoney(sum.expectedCash)}</td>
            </tr>
          </tbody>
        </table>

        <h2 className="sub-h">Đếm tiền theo mệnh giá</h2>
        <ul className="denoms">
          {DENOMINATIONS.map(v => {
            const n = count[String(v)] ?? 0
            return (
              <li key={v}>
                <span className="denom">{formatMoney(v)}</span>
                <span className="stepper">
                  <button type="button" className="icon-btn" aria-label={`Bớt tờ ${formatMoney(v)}`} disabled={!n} onClick={() => set(v, n - 1)}>
                    −
                  </button>
                  <input type="number" inputMode="numeric" min={0} aria-label={`Số tờ ${formatMoney(v)}`} value={n || ''} placeholder="0" onChange={e => set(v, Number(e.target.value) || 0)} />
                  <button type="button" className="icon-btn" aria-label={`Thêm tờ ${formatMoney(v)}`} onClick={() => set(v, n + 1)}>
                    +
                  </button>
                </span>
                <span className="denom-sum">{n ? formatMoney(v * n) : ''}</span>
              </li>
            )
          })}
        </ul>
        <div className={'count-result ' + (!touched ? '' : diff === 0 ? 'is-zero' : diff > 0 ? 'is-over' : 'is-short')}>
          <span>
            Đếm được <b>{formatVnd(counted)}</b>
          </span>
          <span>
            Chênh lệch <b>{touched ? (diff === 0 ? 'Khớp' : `${diff > 0 ? '+' : ''}${formatMoney(diff)}${diff > 0 ? ' (thừa)' : ' (thiếu)'}`) : '—'}</b>
          </span>
        </div>
        <label className="field">
          <span className="field-label">Ghi chú {diff !== 0 && touched ? '(bắt buộc khi két lệch)' : ''}</span>
          <textarea rows={2} maxLength={200} value={note} onChange={e => setNote(e.target.value)} placeholder="VD: thối nhầm bàn 7, đã báo quản lý" />
        </label>
        {openOrders > 0 && <p className="warn-text">Còn {openOrders} đơn chưa thanh toán (ca sau thu tiếp được).</p>}
        {paying > 0 && <p className="field-error block">Còn {paying} đơn đang thanh toán: thu xong hoặc huỷ trước khi chốt ca.</p>}
        <div className="btn-row">
          <button type="button" className="btn" onClick={() => printBlocks(preview, 'Báo cáo ca (tạm)').catch(e => props.onError(errText(e)))}>
            🖨 In báo cáo tạm
          </button>
          <button type="button" className="btn btn-primary btn-grow" disabled={busy || paying > 0} onClick={close}>
            <span>{formatVnd(counted)}</span>
            <b>Chốt ca &amp; in báo cáo</b>
          </button>
        </div>
      </section>
      <section aria-label="Báo cáo ca 80mm">
        <ReceiptPreview blocks={preview} title="Báo cáo ca" />
      </section>
    </div>
  )
}

function ClosedShift(props: { floor: FloorState; shift: Shift; onBack: () => void; onDelete?: () => void; onError: (m: string) => void }) {
  const { floor, shift } = props
  const blocks = shiftReportBlocks({
    shop: floor.shop, register: shift.register, openedBy: shift.openedBy, openedAt: shift.openedAt, closedBy: shift.closedBy, closedAt: shift.closedAt,
    summary: { ...shiftSummary(shift, floor.bills), expectedCash: shift.expectedCash ?? shiftSummary(shift, floor.bills).expectedCash },
    countedDetail: shift.countedDetail, countedCash: shift.countedCash, note: shift.note,
  })
  return (
    <div className="cashier-cols shift-cols">
      <section className="card">
        <button type="button" className="link" onClick={props.onBack}>
          ← Ca
        </button>
        <h1>Báo cáo ca đã chốt</h1>
        <p className="muted">
          {shift.register} · {shift.openedBy} · {fmtDate(shift.openedAt)} {clock(shift.openedAt)}–{clock(shift.closedAt)}
        </p>
        <button type="button" className="btn btn-primary btn-big" onClick={() => printBlocks(blocks, 'Báo cáo chốt ca').catch(e => props.onError(errText(e)))}>
          🖨 In lại báo cáo
        </button>
        {props.onDelete && (
          <div className="btn-row">
            <button type="button" className="btn btn-danger" onClick={props.onDelete}>
              Xoá vĩnh viễn ca
            </button>
          </div>
        )}
      </section>
      <section aria-label="Báo cáo ca 80mm">
        <ReceiptPreview blocks={blocks} title="Báo cáo ca" />
      </section>
    </div>
  )
}
