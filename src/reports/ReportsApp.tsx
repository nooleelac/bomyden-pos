// ☰ → Quản lý. Routes (hash):
//   #/hoa-don          bills paid in a date range: search, filter by payment method, totals per day, CSV
//   #/hoa-don/<billId> one bill: dishes, discount, VAT, payments, prints (reprint stays on Thu ngân)
//   #/doanh-thu        revenue of a date range against the range before: per day, per hour, per payment method,
//                      dishes, cashiers, CSV
// Bills come from FloorRepo.billHistory (the floor state only keeps the last hours).

import { useEffect, useMemo, useState } from 'react'
import '../menu/menu.css'
import '../floor/floor.css'
import './reports.css'
import { TopBar } from '../auth/chrome'
import { useAuth } from '../auth/context'
import { canOpen } from '../auth/guards'
import { roleCan } from '../auth/permissions'
import { METHOD_LABEL, formatVnd, type PayMethod } from '../lib/billing'
import { errText, useLive, useNow, useRoute } from '../floor/hooks'
import { clock } from '../floor/logic'
import type { FloorRepo } from '../floor/repo'
import type { Bill, BillHistory, FloorState } from '../floor/types'
import type { MenuRepo } from '../menu/repo'
import { billSummary, receiptTableTitle } from '../cashier/bill'
import {
  PRESET_LABEL,
  addDays,
  businessDay,
  dayLabel,
  dayRange,
  filterBills,
  methodsOf,
  presetDays,
  revenue,
  shortVnd,
  weekday,
  type Preset,
  type Revenue,
} from './report'

const METHODS: PayMethod[] = ['cash', 'bank', 'card']
const METHOD_SHORT: Record<PayMethod, string> = { cash: 'TM', bank: 'CK', card: 'Thẻ' }

interface Range {
  preset: Preset | 'custom'
  fromDay: string
  toDay: string
}

export function ReportsApp(props: { floorRepo: FloorRepo; menuRepo: MenuRepo }) {
  const { floorRepo, menuRepo } = props
  const [error, setError] = useState('')
  const { floor } = useLive(floorRepo, menuRepo, setError)
  const route = useRoute()
  const dayStart = floor?.settings.businessDayStart ?? '06:00'
  const now = useNow(60_000, floor?.clockOffset ?? 0)
  const [range, setRange] = useState<Range | null>(null)
  const r = range ?? { preset: 'today' as const, ...presetDays('today', now, dayStart) }

  if (!floor) return <div className="menu-app loading">Đang tải…</div>
  const page = route[0] === 'doanh-thu' ? 'revenue' : route[1] ? 'bill' : 'bills'
  return (
    <div className="menu-app floor-app reports-app">
      <TopBar />
      {floor.sample && <div className="sample-banner">Dữ liệu mẫu: hoá đơn và số tiền chỉ là ví dụ.</div>}
      <main className="reports-main">
        {page !== 'bill' && (
          <div className="reports-tabs" role="tablist">
            <a href="#/hoa-don" role="tab" aria-selected={page === 'bills'} className={page === 'bills' ? 'is-on' : ''}>
              🧾 Hoá đơn
            </a>
            <a href="#/doanh-thu" role="tab" aria-selected={page === 'revenue'} className={page === 'revenue' ? 'is-on' : ''}>
              📈 Doanh thu
            </a>
          </div>
        )}
        {page !== 'bill' && <RangePicker range={r} now={now} dayStart={dayStart} onChange={setRange} />}
        {error && <p className="field-error block">{error}</p>}
        {page === 'bills' && <BillsPage repo={floorRepo} floor={floor} range={r} dayStart={dayStart} onError={setError} />}
        {page === 'bill' && <BillDetail repo={floorRepo} floor={floor} billId={route[1]} range={r} dayStart={dayStart} onError={setError} />}
        {page === 'revenue' && <RevenuePage repo={floorRepo} floor={floor} range={r} dayStart={dayStart} onError={setError} />}
      </main>
    </div>
  )
}

/** Loads the bills of a range again whenever a bill is paid or printed on any device. */
function useHistory(repo: FloorRepo, floor: FloorState, fromDay: string, toDay: string, dayStart: string, onError: (m: string) => void) {
  const [h, setH] = useState<{ key: string; data: BillHistory } | null>(null)
  const { from, to } = dayRange(fromDay, toDay, dayStart)
  const key = `${from}|${to}`
  const pulse = floor.bills.map(b => `${b.id}:${b.printCount}`).join(',')
  useEffect(() => {
    let live = true
    repo.billHistory(from, to).then(
      data => live && setH({ key, data }),
      e => live && onError(errText(e)),
    )
    return () => {
      live = false
    }
  }, [repo, from, to, key, pulse, onError])
  return h?.key === key ? h.data : null
}

function RangePicker(props: { range: Range; now: Date; dayStart: string; onChange: (r: Range) => void }) {
  const { range, now, dayStart } = props
  const today = businessDay(now, dayStart)
  return (
    <section className="range-picker" aria-label="Khoảng thời gian">
      <div className="chip-row">
        {(Object.keys(PRESET_LABEL) as Preset[]).map(p => (
          <button key={p} type="button" className={'chip' + (range.preset === p ? ' is-on' : '')} onClick={() => props.onChange({ preset: p, ...presetDays(p, now, dayStart) })}>
            {PRESET_LABEL[p]}
          </button>
        ))}
      </div>
      <div className="range-dates">
        <label className="field">
          <span className="field-label">Từ ngày</span>
          <input
            type="date"
            value={range.fromDay}
            max={today}
            onChange={e => e.target.value && props.onChange({ preset: 'custom', fromDay: e.target.value, toDay: e.target.value > range.toDay ? e.target.value : range.toDay })}
          />
        </label>
        <label className="field">
          <span className="field-label">Đến ngày</span>
          <input
            type="date"
            value={range.toDay}
            max={today}
            onChange={e => e.target.value && props.onChange({ preset: 'custom', fromDay: e.target.value < range.fromDay ? e.target.value : range.fromDay, toDay: e.target.value })}
          />
        </label>
      </div>
    </section>
  )
}

// ---------------------------------------------------------------- Hoá đơn

function BillsPage(props: { repo: FloorRepo; floor: FloorState; range: Range; dayStart: string; onError: (m: string) => void }) {
  const { range, dayStart } = props
  const h = useHistory(props.repo, props.floor, range.fromDay, range.toDay, dayStart, props.onError)
  const [text, setText] = useState('')
  const [method, setMethod] = useState<PayMethod | ''>('')
  const shown = useMemo(() => (h ? filterBills(h.bills, { text, method }).reverse() : []), [h, text, method])
  const days = useMemo(() => {
    const out: { day: string; bills: Bill[]; total: number }[] = []
    for (const b of shown) {
      const day = businessDay(b.paidAt, dayStart)
      let g = out[out.length - 1]
      if (!g || g.day !== day) out.push((g = { day, bills: [], total: 0 }))
      g.bills.push(b)
      g.total += b.total
    }
    return out
  }, [shown, dayStart])
  const total = shown.reduce((t, b) => t + b.total, 0)
  const discount = shown.reduce((t, b) => t + b.discount, 0)

  return (
    <>
      <section className="card bills-tools">
        <input type="search" placeholder="Tìm số hoá đơn, bàn, thu ngân…" aria-label="Tìm hoá đơn" value={text} onChange={e => setText(e.target.value)} />
        <div className="chip-row">
          <button type="button" className={'chip' + (method === '' ? ' is-on' : '')} onClick={() => setMethod('')}>
            Tất cả
          </button>
          {METHODS.map(m => (
            <button key={m} type="button" className={'chip' + (method === m ? ' is-on' : '')} onClick={() => setMethod(m)}>
              {METHOD_LABEL[m]}
            </button>
          ))}
        </div>
      </section>

      {!h ? (
        <p className="empty">Đang tải hoá đơn…</p>
      ) : (
        <>
          <section className="bills-sum">
            <span>
              <b>{shown.length}</b> hoá đơn
            </span>
            <span>
              Tổng thu <b>{formatVnd(total)}</b>
            </span>
            {discount > 0 && <span className="muted">giảm giá {formatVnd(discount)}</span>}
            <button type="button" className="btn btn-small" disabled={!shown.length} onClick={() => downloadCsv(`hoa-don_${range.fromDay}_${range.toDay}.csv`, billsCsv(shown, h))}>
              ⬇ Xuất CSV
            </button>
          </section>
          {!shown.length && <p className="empty">Không có hoá đơn nào trong khoảng này.</p>}
          {days.map(g => (
            <section key={g.day} className="card bill-day">
              <div className="card-head">
                <h2>
                  {weekday(g.day)} {dayLabel(g.day, true)}
                </h2>
                <span className="muted small">
                  {g.bills.length} hoá đơn · <b className="money-text">{formatVnd(g.total)}</b>
                </span>
              </div>
              <ul className="pay-list">
                {g.bills.map(b => (
                  <li key={b.id}>
                    <a href={`#/hoa-don/${b.id}`} className="pay-pick">
                      <span>
                        <b>{billSummary(b)}</b>
                        <span className="muted small block">
                          {clock(b.paidAt)} · {b.cashier || '—'} · {methodsOf(b).map(m => METHOD_SHORT[m]).join(' + ')}
                        </span>
                      </span>
                      <span className="pay-pick-side">
                        <b className="money-text">{formatVnd(b.total)}</b>
                        <span className="bill-badges">
                          {b.discount > 0 && <span className="badge badge-draft">giảm {formatVnd(b.discount)}</span>}
                          {b.printCount > 1 && <span className="badge">in {b.printCount} lần</span>}
                          {b.printCount === 0 && <span className="badge badge-req">chưa in</span>}
                        </span>
                      </span>
                    </a>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </>
      )}
    </>
  )
}

function BillDetail(props: { repo: FloorRepo; floor: FloorState; billId: string; range: Range; dayStart: string; onError: (m: string) => void }) {
  const { floor, billId } = props
  const { session } = useAuth()
  const live = floor.bills.find(b => b.id === billId)
  // a bill from the list is in the chosen range; one opened from a link is looked up on its own day (today first)
  const day = live ? businessDay(live.paidAt, props.dayStart) : null
  const h = useHistory(props.repo, floor, day ?? props.range.fromDay, day ?? props.range.toDay, props.dayStart, props.onError)
  const bill = h?.bills.find(b => b.id === billId) ?? live
  if (!bill) return h ? <p className="empty">Không tìm thấy hoá đơn. <a href="#/hoa-don">← Danh sách hoá đơn</a></p> : <p className="empty">Đang tải…</p>
  const lines = h?.lines.filter(l => l.orderId === bill.orderId) ?? []
  const change = bill.payments.reduce((s, p) => s + (p.tendered && p.tendered > p.amount ? p.tendered - p.amount : 0), 0)
  const canReprint = !!live && canOpen(session.role, ['thu-ngan'])
  const remove = () => {
    if (!confirm(`Xoá vĩnh viễn hoá đơn ${bill.billNo} (${formatVnd(bill.total)}) cùng đơn, món và các lần thu tiền? Doanh thu và báo cáo ca sẽ không còn hoá đơn này. Không khôi phục được.`)) return
    props.repo.adminDelete('order', bill.orderId).then(
      () => (location.hash = '#/hoa-don'),
      e => props.onError(errText(e)),
    )
  }

  return (
    <div className="bill-detail">
      <a className="link" href="#/hoa-don">
        ← Danh sách hoá đơn
      </a>
      <section className="card">
        <div className="card-head">
          <h1>
            {bill.billNo} · {receiptTableTitle(bill.tableLabel)}
          </h1>
          <b className="detail-total">{formatVnd(bill.total)}</b>
        </div>
        <p className="muted small">
          Thu lúc {clock(bill.paidAt)} {dayLabel(businessDay(bill.paidAt, props.dayStart), true)} · thu ngân {bill.cashier || '—'}
        </p>

        <h2 className="detail-h">Món</h2>
        {lines.length ? (
          <ul className="bill-items">
            {lines.map((l, i) => (
              <li key={i} className="bill-item">
                <span>
                  {l.qty} × {l.name}
                  {l.variantName && <span className="muted"> ({l.variantName})</span>}
                </span>
                <span>{formatVnd(l.amount)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted small">Chưa tải được chi tiết món của hoá đơn này.</p>
        )}

        <dl className="bill-sums">
          <div>
            <dt>Tiền hàng</dt>
            <dd>{formatVnd(bill.subtotal)}</dd>
          </div>
          {bill.discount > 0 && (
            <div>
              <dt>Giảm giá{bill.discountReason && <span className="muted small"> · {bill.discountReason}</span>}</dt>
              <dd>−{formatVnd(bill.discount)}</dd>
            </div>
          )}
          {bill.serviceCharge > 0 && (
            <div>
              <dt>Phí phục vụ</dt>
              <dd>{formatVnd(bill.serviceCharge)}</dd>
            </div>
          )}
          {bill.vatAdded > 0 && (
            <div>
              <dt>VAT cộng thêm</dt>
              <dd>{formatVnd(bill.vatAdded)}</dd>
            </div>
          )}
          {bill.rounding !== 0 && (
            <div>
              <dt>Làm tròn</dt>
              <dd>{formatVnd(bill.rounding)}</dd>
            </div>
          )}
          <div className="bill-total">
            <dt>Tổng thu</dt>
            <dd>{formatVnd(bill.total)}</dd>
          </div>
          {bill.vatTotal > 0 && (
            <div className="muted small">
              <dt>Trong đó VAT</dt>
              <dd>{formatVnd(bill.vatTotal)}</dd>
            </div>
          )}
        </dl>

        <h2 className="detail-h">Thanh toán</h2>
        <ul className="bill-items">
          {bill.payments.map(p => (
            <li key={p.id} className="bill-item">
              <span>
                <span className={`dot m-${p.method}`} aria-hidden /> {METHOD_LABEL[p.method]}
                {p.ref && <span className="muted small"> · {p.ref}</span>}
                {p.tendered != null && <span className="muted small block">khách đưa {formatVnd(p.tendered)}</span>}
              </span>
              <span>{formatVnd(p.amount)}</span>
            </li>
          ))}
        </ul>
        {change > 0 && <p className="muted">Tiền thối {formatVnd(change)}</p>}
        <p className="muted small">{bill.printCount ? `Đã in ${bill.printCount} lần${bill.lastPrintBy ? `, lần cuối: ${bill.lastPrintBy}` : ''}.` : 'Chưa in.'}</p>
        {canReprint ? (
          <a className="btn btn-primary" href={`#/thu-ngan/hd/${bill.id}`}>
            🖨 Xem bản in / In lại
          </a>
        ) : (
          <p className="muted small">In lại hoá đơn ở Thu ngân (hoá đơn của ca đang mở và 4 giờ gần nhất).</p>
        )}
        {roleCan(session.role, 'admin.delete') && (
          <div className="btn-row">
            <button type="button" className="btn btn-danger" onClick={remove}>
              Xoá vĩnh viễn hoá đơn
            </button>
          </div>
        )}
      </section>
    </div>
  )
}

// ---------------------------------------------------------------- Doanh thu

function RevenuePage(props: { repo: FloorRepo; floor: FloorState; range: Range; dayStart: string; onError: (m: string) => void }) {
  const { range, dayStart } = props
  const days = Math.round((Date.parse(range.toDay) - Date.parse(range.fromDay)) / 86_400_000) + 1
  const prevFrom = addDays(range.fromDay, -days)
  const prevTo = addDays(range.fromDay, -1)
  const h = useHistory(props.repo, props.floor, range.fromDay, range.toDay, dayStart, props.onError)
  const ph = useHistory(props.repo, props.floor, prevFrom, prevTo, dayStart, props.onError)
  const rev = useMemo(() => (h ? revenue(h, range.fromDay, range.toDay, dayStart) : null), [h, range.fromDay, range.toDay, dayStart])
  const prev = useMemo(() => (ph ? revenue(ph, prevFrom, prevTo, dayStart) : null), [ph, prevFrom, prevTo, dayStart])
  const [allItems, setAllItems] = useState(false)
  if (!rev) return <p className="empty">Đang tính doanh thu…</p>
  const prevName = days === 1 ? 'hôm trước' : `${days} ngày trước đó`

  return (
    <>
      <section className="kpi-grid">
        <Kpi label="Doanh thu" value={formatVnd(rev.sales)} now={rev.sales} before={prev?.sales} prevName={prevName} big />
        <Kpi label="Số hoá đơn" value={String(rev.bills)} now={rev.bills} before={prev?.bills} prevName={prevName} />
        <Kpi label="Trung bình / hoá đơn" value={formatVnd(rev.average)} now={rev.average} before={prev?.average} prevName={prevName} />
        <Kpi label="Giảm giá" value={formatVnd(rev.discount)} />
      </section>

      <section className="card">
        <div className="card-head">
          <h2>Chi tiết</h2>
          <button type="button" className="btn btn-small" disabled={!rev.bills} onClick={() => downloadCsv(`doanh-thu_${range.fromDay}_${range.toDay}.csv`, revenueCsv(rev))}>
            ⬇ Xuất CSV
          </button>
        </div>
        <dl className="bill-sums">
          <div>
            <dt>Tiền hàng</dt>
            <dd>{formatVnd(rev.subtotal)}</dd>
          </div>
          <div>
            <dt>Giảm giá</dt>
            <dd>−{formatVnd(rev.discount)}</dd>
          </div>
          {rev.serviceCharge > 0 && (
            <div>
              <dt>Phí phục vụ</dt>
              <dd>{formatVnd(rev.serviceCharge)}</dd>
            </div>
          )}
          {rev.rounding !== 0 && (
            <div>
              <dt>Làm tròn</dt>
              <dd>{formatVnd(rev.rounding)}</dd>
            </div>
          )}
          <div className="bill-total">
            <dt>Doanh thu</dt>
            <dd>{formatVnd(rev.sales)}</dd>
          </div>
          <div className="muted small">
            <dt>Trong đó VAT</dt>
            <dd>{formatVnd(rev.vatTotal)}</dd>
          </div>
        </dl>
      </section>

      <div className="reports-cols">
        <section className="card">
          <h2>Theo cách trả</h2>
          <MethodBar rev={rev} />
        </section>
        {rev.byDay.length > 1 && (
          <section className="card">
            <h2>Theo ngày</h2>
            <Bars rows={rev.byDay.map(d => ({ key: d.day, label: `${weekday(d.day)} ${dayLabel(d.day)}`, value: d.sales, note: `${d.bills} HĐ` }))} />
          </section>
        )}
        <section className="card">
          <h2>Theo giờ thu tiền</h2>
          <HourChart byHour={rev.byHour} />
        </section>
        <section className="card">
          <div className="card-head">
            <h2>Món bán chạy</h2>
            <span className="muted small">theo tiền hàng</span>
          </div>
          {!rev.items.length && <p className="empty">Chưa có món.</p>}
          <table className="rank-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Món</th>
                <th>SL</th>
                <th>Tiền hàng</th>
              </tr>
            </thead>
            <tbody>
              {(allItems ? rev.items : rev.items.slice(0, 10)).map((it, i) => (
                <tr key={it.name}>
                  <td className="muted">{i + 1}</td>
                  <td>{it.name}</td>
                  <td>{it.qty}</td>
                  <td>{formatVnd(it.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {rev.items.length > 10 && (
            <button type="button" className="link" onClick={() => setAllItems(a => !a)}>
              {allItems ? 'Thu gọn' : `Xem tất cả ${rev.items.length} món`}
            </button>
          )}
        </section>
        <section className="card">
          <h2>Theo thu ngân</h2>
          {!rev.byCashier.length && <p className="empty">Chưa có hoá đơn.</p>}
          <Bars rows={rev.byCashier.map(c => ({ key: c.name, label: c.name, value: c.sales, note: `${c.bills} HĐ` }))} />
        </section>
      </div>
    </>
  )
}

function Kpi(props: { label: string; value: string; now?: number; before?: number; prevName?: string; big?: boolean }) {
  const { now, before } = props
  const pct = now != null && before ? Math.round(((now - before) / before) * 100) : null
  return (
    <div className={'kpi' + (props.big ? ' kpi-big' : '')}>
      <span className="kpi-label">{props.label}</span>
      <b className="kpi-value">{props.value}</b>
      {pct != null && (
        <span className={'kpi-delta ' + (pct > 0 ? 'is-up' : pct < 0 ? 'is-down' : '')}>
          {pct > 0 ? '▲' : pct < 0 ? '▼' : '='} {Math.abs(pct)}% <span className="muted">so với {props.prevName}</span>
        </span>
      )}
      {before === 0 && now != null && now > 0 && <span className="kpi-delta muted">{props.prevName}: chưa có</span>}
    </div>
  )
}

function Bars(props: { rows: { key: string; label: string; value: number; note?: string }[] }) {
  const max = Math.max(1, ...props.rows.map(r => r.value))
  return (
    <ul className="bars">
      {props.rows.map(r => (
        <li key={r.key}>
          <span className="bars-label">{r.label}</span>
          <span className="bars-track">
            <span className="bars-fill" style={{ width: `${(r.value / max) * 100}%` }} />
          </span>
          <span className="bars-value">
            {formatVnd(r.value)}
            {r.note && <span className="muted small block">{r.note}</span>}
          </span>
        </li>
      ))}
    </ul>
  )
}

function MethodBar(props: { rev: Revenue }) {
  const { byMethod } = props.rev
  const total = METHODS.reduce((t, m) => t + byMethod[m], 0)
  if (!total) return <p className="empty">Chưa có tiền thu.</p>
  return (
    <>
      <div className="method-bar" role="img" aria-label={METHODS.map(m => `${METHOD_LABEL[m]} ${Math.round((byMethod[m] / total) * 100)}%`).join(', ')}>
        {METHODS.filter(m => byMethod[m] > 0).map(m => (
          <span key={m} className={`m-${m}`} style={{ flexGrow: byMethod[m] }} />
        ))}
      </div>
      <ul className="method-list">
        {METHODS.map(m => (
          <li key={m}>
            <span>
              <span className={`dot m-${m}`} aria-hidden /> {METHOD_LABEL[m]}
            </span>
            <span className="muted">{Math.round((byMethod[m] / total) * 100)}%</span>
            <b>{formatVnd(byMethod[m])}</b>
          </li>
        ))}
      </ul>
    </>
  )
}

function HourChart(props: { byHour: number[] }) {
  // the hours the shop works, at least 10:00–23:00
  const used = props.byHour.map((v, i) => (v > 0 ? i : -1)).filter(i => i >= 0)
  const first = Math.min(10, ...used)
  const last = Math.max(23, ...used)
  const hours = Array.from({ length: last - first + 1 }, (_, i) => first + i)
  const max = Math.max(1, ...props.byHour)
  const peak = props.byHour.indexOf(max)
  if (!used.length) return <p className="empty">Chưa có tiền thu.</p>
  return (
    <>
      <p className="muted small">
        Đông nhất {peak}h–{peak + 1}h · <b>{shortVnd(max)}</b>
      </p>
      <div className="hour-chart">
        {hours.map(hr => (
          <div key={hr} className="hour-col" title={`${hr}:00–${hr + 1}:00 · ${formatVnd(props.byHour[hr])}`}>
            <span className="hour-track">
              <span className={'hour-fill' + (hr === peak ? ' is-peak' : '')} style={{ height: `${(props.byHour[hr] / max) * 100}%` }} />
            </span>
            <span className="hour-lbl">{hr % 2 === 0 ? hr : ''}</span>
          </div>
        ))}
      </div>
    </>
  )
}

// ---------------------------------------------------------------- CSV (Excel opens it with the BOM)

const cell = (v: string | number) => (typeof v === 'number' ? String(v) : `"${v.replace(/"/g, '""')}"`)
const csv = (rows: (string | number)[][]) => '﻿' + rows.map(r => r.map(cell).join(',')).join('\r\n')

function billsCsv(bills: Bill[], h: BillHistory): string {
  const dishes = (orderId: string) =>
    h.lines
      .filter(l => l.orderId === orderId)
      .map(l => `${l.qty} ${l.name}${l.variantName ? ` (${l.variantName})` : ''}`)
      .join('; ')
  return csv([
    ['Số HĐ', 'Bàn', 'Ngày giờ', 'Thu ngân', 'Tiền hàng', 'Giảm giá', 'Phí phục vụ', 'Làm tròn', 'Tổng thu', 'VAT', 'Tiền mặt', 'Chuyển khoản', 'Thẻ', 'Món'],
    ...bills.map(b => {
      const by = (m: PayMethod) => b.payments.filter(p => p.method === m).reduce((t, p) => t + p.amount, 0)
      const d = new Date(b.paidAt)
      return [
        b.billNo, b.tableLabel, `${d.toLocaleDateString('vi-VN')} ${clock(b.paidAt)}`, b.cashier, b.subtotal, b.discount, b.serviceCharge, b.rounding, b.total,
        b.vatTotal, by('cash'), by('bank'), by('card'), dishes(b.orderId),
      ]
    }),
  ])
}

function revenueCsv(rev: Revenue): string {
  return csv([
    ['Ngày', 'Số hoá đơn', 'Doanh thu'],
    ...rev.byDay.map(d => [dayLabel(d.day, true), d.bills, d.sales]),
    ['Tổng', rev.bills, rev.sales],
    [],
    ['Món', 'Số lượng', 'Tiền hàng'],
    ...rev.items.map(i => [i.name, i.qty, i.amount]),
  ])
}

function downloadCsv(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
