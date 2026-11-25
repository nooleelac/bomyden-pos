// #/kiem-soat (☰ → Quản lý → Kiểm soát thất thoát): what may hide money, from the audit log of a date range.
//   * totals: huỷ món (and how much after the pre-bill or once cooked), huỷ đơn, giảm giá, in lại, két lệch, xoá
//   * per person, so one name standing out is easy to see
//   * "Cần xem": the entries worth a question (huỷ sau tạm tính / đã làm xong / không ai duyệt, giảm giá, két lệch,
//     xoá đơn hoặc ca, đổi quyền, sửa món sang giá thấp hơn)
//   * the log itself for the range, filtered by kind (Nhật ký in Nhân viên keeps the newest 200 of everything)
// The owner gets the same "Cần xem" entries as push notifications (migration 0029).

import { useEffect, useMemo, useState } from 'react'
import { useAuth } from '../auth/context'
import type { AuditEntry } from '../auth/types'
import { formatVnd } from '../lib/billing'
import { errText } from '../floor/hooks'
import { clock } from '../floor/logic'
import { businessDay, dayLabel, dayRange } from './report'
import { ACTIONS, LABEL, control, flagOf, moneyOf, num, yes, type Action } from './control'

const LIMIT = 1000

function describe(a: AuditEntry): string {
  const d = a.detail
  const parts: string[] = []
  const vnd = (n: unknown) => formatVnd(num(n))
  switch (a.action) {
    case 'void_item':
      parts.push(`${d.qty ?? ''} ${d.name ?? ''}`.trim())
      if (d.table) parts.push(String(d.table))
      break
    case 'void_order':
      parts.push(`${d.name ?? 'Đơn'} · ${d.lines ?? 0} món`)
      break
    case 'discount':
      parts.push(`HĐ ${d.bill ?? ''}`)
      break
    case 'reprint':
      parts.push(`HĐ ${d.bill ?? ''} · lần ${d.print ?? ''}`)
      break
    case 'close_shift':
      parts.push(`đếm ${vnd(d.counted)} · dự kiến ${vnd(d.expected)}`)
      if (yes(d.blind)) parts.push('đếm kín')
      break
    case 'delete':
      parts.push(String(d.name ?? d.kind ?? ''))
      break
    case 'modify_item':
      parts.push(`${d.before ?? ''} → ${d.after ?? ''}`)
      if (d.table) parts.push(String(d.table))
      break
    case 'bank_manual':
      parts.push(`HĐ ${d.bill ?? ''}`)
      if (d.name) parts.push(String(d.name))
      break
    case 'bank_link':
      parts.push(`HĐ ${d.bill ?? ''} · tiền về ${vnd(d.received)}`)
      if (d.remitter) parts.push(String(d.remitter))
      if (d.content) parts.push(`nội dung “${d.content}”`)
      break
    case 'permissions': {
      const list = (v: unknown) => (Array.isArray(v) ? v.join(', ') : '')
      parts.push(`${d.role ?? ''}${list(d.added) ? ` · thêm ${list(d.added)}` : ''}${list(d.removed) ? ` · bỏ ${list(d.removed)}` : ''}`)
      break
    }
  }
  if (d.reason) parts.push(`“${d.reason}”`)
  if (d.note) parts.push(`“${d.note}”`)
  return parts.filter(Boolean).join(' · ')
}

const signedVnd = (n: number) => (n > 0 ? '+' : n < 0 ? '−' : '') + formatVnd(Math.abs(n))

export function ControlPage(props: { fromDay: string; toDay: string; dayStart: string }) {
  const { repo } = useAuth()
  const { from, to } = dayRange(props.fromDay, props.toDay, props.dayStart)
  const [data, setData] = useState<{ key: string; list: AuditEntry[] } | null>(null)
  const [error, setError] = useState('')
  const [kind, setKind] = useState<Action | 'flag'>('flag')
  const key = `${from}|${to}`
  useEffect(() => {
    let live = true
    const load = () =>
      repo.audit(LIMIT, { from, to, actions: [...ACTIONS] }).then(
        list => live && (setData({ key, list }), setError('')),
        e => live && setError(errText(e)),
      )
    load()
    const off = repo.subscribe(load)
    return () => {
      live = false
      off()
    }
  }, [repo, from, to, key])
  const list = data?.key === key ? data.list : null
  const c = useMemo(() => (list ? control(list) : null), [list])
  if (error) return <p className="field-error block">{error}</p>
  if (!list || !c) return <p className="empty">Đang tải nhật ký…</p>
  const shown = kind === 'flag' ? c.flagged : list.filter(a => a.action === kind)
  const multiDay = props.fromDay !== props.toDay

  return (
    <>
      <section className="kpi-grid">
        <div className="kpi kpi-big">
          <span className="kpi-label">Tiền món bị huỷ</span>
          <b className="kpi-value">{formatVnd(c.voidAmount)}</b>
          <span className="kpi-delta muted">
            {c.voids} lần{c.lateAmount > 0 && <> · <b className="ctl-warn">{formatVnd(c.lateAmount)}</b> sau tạm tính hoặc đã làm xong</>}
          </span>
        </div>
        <div className="kpi">
          <span className="kpi-label">Giảm giá</span>
          <b className="kpi-value">{formatVnd(c.discountAmount)}</b>
          <span className="kpi-delta muted">{c.discounts} hoá đơn</span>
        </div>
        <div className="kpi">
          <span className="kpi-label">Két lệch</span>
          <b className={'kpi-value' + (c.shiftDiff < 0 ? ' ctl-warn' : '')}>{c.shiftsOff ? signedVnd(c.shiftDiff) : 'Khớp'}</b>
          <span className="kpi-delta muted">{c.shiftsOff} ca lệch</span>
        </div>
        <div className="kpi">
          <span className="kpi-label">Chuyển khoản xác nhận tay</span>
          <b className={'kpi-value' + (c.bankHand ? ' ctl-warn' : '')}>{formatVnd(c.bankHandAmount)}</b>
          <span className="kpi-delta muted">{c.bankHand} khoản ngân hàng không tự báo</span>
        </div>
        <div className="kpi">
          <span className="kpi-label">In lại · Huỷ đơn · Xoá</span>
          <b className="kpi-value">
            {c.reprints} · {c.orders} · {c.deletes}
          </b>
          <span className="kpi-delta muted">huỷ đơn {formatVnd(c.orderAmount)}</span>
        </div>
      </section>

      <section className="card">
        <div className="card-head">
          <h2>Theo nhân viên</h2>
          <span className="muted small">người làm, không phải người duyệt</span>
        </div>
        {!c.people.length ? (
          <p className="empty">Không có huỷ món, giảm giá, in lại hay két lệch trong khoảng này.</p>
        ) : (
          <div className="audit-wrap">
            <table className="audit ctl-people">
              <thead>
                <tr>
                  <th>Nhân viên</th>
                  <th>Huỷ món</th>
                  <th>Sau tạm tính / đã làm</th>
                  <th>Giảm giá</th>
                  <th>In lại</th>
                  <th>Két lệch</th>
                  <th>CK tay</th>
                  <th>Cần xem</th>
                </tr>
              </thead>
              <tbody>
                {c.people.map(p => (
                  <tr key={p.name}>
                    <td>
                      <b>{p.name}</b>
                    </td>
                    <td>{p.voids ? `${p.voids} · ${formatVnd(p.voidAmount)}` : '—'}</td>
                    <td className={p.voidsLate ? 'ctl-warn' : ''}>{p.voidsLate || '—'}</td>
                    <td>{p.discounts ? `${p.discounts} · ${formatVnd(p.discountAmount)}` : '—'}</td>
                    <td>{p.reprints || '—'}</td>
                    <td className={p.shiftDiff < 0 ? 'ctl-warn' : ''}>{p.shiftDiff ? signedVnd(p.shiftDiff) : '—'}</td>
                    <td className={p.bankHand ? 'ctl-warn' : ''}>{p.bankHand || '—'}</td>
                    <td className={p.flags ? 'ctl-warn' : ''}>{p.flags || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card">
        <div className="card-head">
          <h2>Nhật ký</h2>
          {list.length >= LIMIT && <span className="muted small">chỉ hiện {LIMIT} dòng mới nhất: chọn khoảng ngắn hơn</span>}
        </div>
        <div className="chip-row ctl-kinds">
          <button type="button" className={'chip' + (kind === 'flag' ? ' is-on' : '')} onClick={() => setKind('flag')}>
            ⚠️ Cần xem ({c.flagged.length})
          </button>
          {ACTIONS.map(a => {
            const n = list.filter(x => x.action === a).length
            return (
              <button key={a} type="button" className={'chip' + (kind === a ? ' is-on' : '')} disabled={!n} onClick={() => setKind(a)}>
                {LABEL[a]} ({n})
              </button>
            )
          })}
        </div>
        {!shown.length ? (
          <p className="empty">{kind === 'flag' ? 'Không có gì cần xem trong khoảng này. 👍' : 'Không có.'}</p>
        ) : (
          <div className="audit-wrap">
            <table className="audit">
              <thead>
                <tr>
                  <th>Lúc</th>
                  <th>Việc</th>
                  <th>Người</th>
                  <th>Duyệt</th>
                  <th>Số tiền</th>
                  <th>Chi tiết</th>
                </tr>
              </thead>
              <tbody>
                {shown.map(a => {
                  const flag = flagOf(a)
                  const money = moneyOf(a)
                  return (
                    <tr key={a.id} className={flag ? 'is-warn' : ''}>
                      <td>
                        {multiDay && <span className="muted">{dayLabel(businessDay(a.at, props.dayStart))} </span>}
                        {clock(a.at)}
                      </td>
                      <td>
                        {LABEL[a.action as Action] ?? a.action}
                        {flag && <span className="muted small block">{flag}</span>}
                      </td>
                      <td>{a.staff || '—'}</td>
                      <td>{a.approvedBy || '—'}</td>
                      <td>{money ? (a.action === 'close_shift' || a.action === 'modify_item' ? signedVnd(money) : formatVnd(money)) : ''}</td>
                      <td>{describe(a)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <p className="muted small">
        Khi bật Tự xác nhận chuyển khoản (Cài đặt → Thanh toán), mỗi khoản chuyển khoản thu ngân bấm tay đều hiện ở đây. Chưa bật thì cuối ngày nên đối chiếu số chuyển khoản ở Doanh thu với sao kê từng tài khoản.
      </p>
    </>
  )
}
