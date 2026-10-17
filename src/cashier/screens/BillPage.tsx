// #/thu-ngan/hd/<billId>: the receipt of a paid bill as it prints. The first print is the original; every later
// one carries "IN LẠI – lần n" with time and who printed it, so a reprint can never be used to collect twice.

import { useMemo, useState } from 'react'
import { METHOD_LABEL, formatVnd } from '../../lib/billing'
import { errText, go } from '../../floor/hooks'
import type { FloorRepo } from '../../floor/repo'
import type { FloorState } from '../../floor/types'
import { billData, receiptTableTitle } from '../bill'
import { printBlocks } from '../print'
import { receiptBlocks } from '../receipt'
import { ReceiptPreview } from './ui'

export function BillPage(props: { floor: FloorState; repo: FloorRepo; billId: string; me: string; onError: (m: string) => void }) {
  const { floor, repo } = props
  const bill = floor.bills.find(b => b.id === props.billId)
  const [busy, setBusy] = useState(false)
  // preview what the next print looks like
  const blocks = useMemo(
    () => (bill ? receiptBlocks(billData(floor, bill, { count: bill.printCount + 1, at: new Date().toISOString(), by: props.me })) : []),
    [floor, bill, props.me],
  )
  if (!bill) return <p className="empty">Không tìm thấy hoá đơn. <a href="#/thu-ngan">Về thu ngân</a></p>
  const change = bill.payments.reduce((s, p) => s + (p.tendered && p.tendered > p.amount ? p.tendered - p.amount : 0), 0)
  const hasLines = floor.lines.some(l => l.orderId === bill.orderId)

  const print = async () => {
    setBusy(true)
    try {
      const count = await repo.printBill(bill.id)
      await printBlocks(receiptBlocks(billData(floor, bill, { count, at: new Date().toISOString(), by: props.me })), bill.billNo)
    } catch (e) {
      props.onError(errText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="cashier-main bill-page">
      <div className="cashier-cols">
        <section className="card">
          <button type="button" className="link" onClick={() => go('thu-ngan')}>
            ← Thu ngân
          </button>
          <h1>
            {bill.billNo} · {receiptTableTitle(bill.tableLabel)}
          </h1>
          <p className="paid-total">
            Đã thu <b>{formatVnd(bill.total)}</b>
          </p>
          <ul className="rows">
            {bill.payments.map(p => (
              <li key={p.id} className="picked-line">
                <span>
                  {METHOD_LABEL[p.method]}
                  {p.ref && <span className="muted small"> · {p.ref}</span>}
                  {p.tendered != null && <span className="muted small block">khách đưa {formatVnd(p.tendered)}</span>}
                </span>
                <b>{formatVnd(p.amount)}</b>
              </li>
            ))}
          </ul>
          {change > 0 && (
            <p className="change-big">
              Tiền thối <b>{formatVnd(change)}</b>
            </p>
          )}
          {!hasLines && <p className="warn-text">Chi tiết món của hoá đơn cũ chưa tải được: bản in chỉ có tổng tiền.</p>}
          <div className="btn-row">
            <button type="button" className="btn btn-primary btn-big" disabled={busy} onClick={print}>
              🖨 {bill.printCount ? `In lại (lần ${bill.printCount + 1})` : 'In hoá đơn'}
            </button>
            <a className="btn" href="#/thu-ngan">
              Xong
            </a>
          </div>
          <p className="muted small">
            {bill.printCount ? `Đã in ${bill.printCount} lần${bill.lastPrintBy ? `, lần cuối: ${bill.lastPrintBy}` : ''}.` : 'Chưa in.'} Máy in: chọn máy in nhiệt 80mm trong hộp thoại in, lề “Không”.
          </p>
        </section>
        <section aria-label="Xem trước hoá đơn 80mm">
          <ReceiptPreview blocks={blocks} title={`Hoá đơn ${bill.billNo}`} />
        </section>
      </div>
    </main>
  )
}
