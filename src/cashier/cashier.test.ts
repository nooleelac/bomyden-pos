import { describe, expect, it } from 'vitest'
import { changeDue, formatMoney, quickCash, settle, splitEven } from '../lib/billing'
import { billTotals, vatRateOn } from '../lib/pricing'
import { seedMenu } from '../menu/seed'
import * as E from '../floor/engine'
import { sampleEvening, seedFloor } from '../floor/seed'
import { tableState } from '../floor/logic'
import type { Actor, FloorState, SendLineInput } from '../floor/types'
import { billData, orderCode, payMemo, prebillData, receiptTableTitle, vietQr } from './bill'
import { BIG_WIDTH, WIDTH, blocksText, center, itemLines, receiptBlocks, row, shiftReportBlocks, textWidth, wrap, type Block, type ReceiptData } from './receipt'
import { countedTotal, shiftSummary } from './shift'
import { SAMPLE_SHOP } from './config'
import { receiptHtml } from './print'

// ---------------------------------------------------------------- split payment, change

describe('split payment', () => {
  it('spec example: 1.274.000đ = 500.000 transfer + 300.000 card + 474.000 cash (guest hands 500.000, change 26.000)', () => {
    const s = settle(1274000, [
      { method: 'bank', amount: 500000, confirmed: true },
      { method: 'card', amount: 300000, confirmed: true },
      { method: 'cash', amount: 474000, tendered: 500000 },
    ])
    expect(s).toMatchObject({ paid: 1274000, remaining: 0, received: 1300000, change: 26000, canSettle: true, problems: [] })
    expect(s.payments).toEqual([
      { method: 'bank', amount: 500000 },
      { method: 'card', amount: 300000 },
      { method: 'cash', amount: 474000, tendered: 500000 },
    ])
    expect(s.payments.reduce((n, p) => n + p.amount, 0)).toBe(1274000)
  })

  it('does not close while short, even by 1.000đ, and says how much is left', () => {
    const s = settle(436000, [{ method: 'cash', amount: 435000 }])
    expect(s).toMatchObject({ canSettle: false, remaining: 1000 })
    expect(s.problems).toContain('Còn phải thu 1.000đ')
  })

  it('counts cash handed over below its amount only as far as it goes', () => {
    const s = settle(436000, [{ method: 'cash', amount: 436000, tendered: 400000 }])
    expect(s).toMatchObject({ paid: 400000, remaining: 36000, change: 0, canSettle: false })
    expect(s.payments).toEqual([{ method: 'cash', amount: 400000 }])
  })

  it('needs transfer and card confirmed, and caps them at the total (only cash gives change)', () => {
    expect(settle(300000, [{ method: 'bank', amount: 300000 }])).toMatchObject({ canSettle: false, problems: ['Chờ xác nhận tiền chuyển khoản', 'Còn phải thu 300.000đ'] })
    const over = settle(300000, [{ method: 'card', amount: 350000, confirmed: true }])
    expect(over.canSettle).toBe(false)
    expect(over.problems).toContain('Chuyển khoản và thẻ không được vượt số phải thu')
    const twoCash = settle(300000, [{ method: 'cash', amount: 300000 }, { method: 'cash', amount: 50000 }])
    expect(twoCash.canSettle).toBe(false)
    expect(twoCash.problems[0]).toMatch(/^Thu thừa 50.000đ/)
  })

  it('skips rows without an amount and maps each payment back to its row', () => {
    const s = settle(200000, [{ method: 'cash', amount: 0 }, { method: 'bank', amount: 200000, confirmed: true }])
    expect(s.canSettle).toBe(false)
    expect(s.from).toEqual([1])
    expect(settle(0, [])).toMatchObject({ canSettle: true })
  })

  it('change and quick cash buttons', () => {
    expect(changeDue(474000, 500000)).toBe(26000)
    expect(changeDue(474000, 470000)).toBe(0)
    expect(quickCash(436000)).toEqual([440000, 450000, 500000])
    expect(quickCash(474000, 4)).toEqual([480000, 500000, 600000, 1000000])
    expect(quickCash(500000)).toEqual([600000, 1000000])
    expect(quickCash(0)).toEqual([])
  })

  it('splits evenly with shares rounded to 1.000đ, the last one takes the rest', () => {
    expect(splitEven(1274000, 3)).toEqual([425000, 425000, 424000])
    expect(splitEven(1200000, 4)).toEqual([300000, 300000, 300000, 300000])
    expect(splitEven(269000, 1)).toEqual([269000])
    expect(splitEven(2500, 3)).toEqual([1000, 1000, 500])
    expect(splitEven(2500, 4)).toEqual([625, 625, 625, 625]) // rounding would leave nothing for the last: exact shares
    for (const [t, n] of [[1274000, 7], [99000, 4], [436000, 6]]) expect(splitEven(t, n).reduce((a, b) => a + b, 0)).toBe(t)
    expect(() => splitEven(1000, 0)).toThrow(RangeError)
  })
})

describe('VAT by date', () => {
  it('food 8% until 31/12/2026 and 10% from 1/1/2027 (Vietnam time); beer 10%', () => {
    expect(vatRateOn('food', new Date('2026-12-31T16:59:00Z'))).toBe(8) // 23:59 on 31/12 in Vietnam
    expect(vatRateOn('food', new Date('2026-12-31T17:00:00Z'))).toBe(10) // 00:00 on 1/1/2027
    expect(vatRateOn('alcohol', new Date('2026-10-17T12:00:00Z'))).toBe(10)
    expect(vatRateOn('unknown', new Date())).toBeNull()
  })
})

// ---------------------------------------------------------------- engine: pay path, shifts

const menu = seedMenu()
const T0 = new Date('2026-10-17T12:00:00Z')
let n = 0
const at = (minutes: number, role: Actor['role'] = 'waiter'): E.Ctx => ({
  now: new Date(T0.getTime() + minutes * 60_000),
  actor: { name: { kitchen: 'Bếp', manager: 'Quản lý Hà', owner: 'Chủ quán', cashier: 'Lan', waiter: 'Hùng' }[role], role },
  menu,
  newId: () => `id-${++n}`,
})
const waiter = at(0)
const cashier = at(5, 'cashier')
const steak200NoEgg: SendLineInput = { menu_item_id: 'i-steak', variant_id: 'v-200', qty: 1, options: [{ option_id: 'o-m' }], removals: ['k-egg'] }
const beer = (qty: number): SendLineInput => ({ menu_item_id: 'i-tiger', qty, options: [], removals: [] })

function table9(): { s: FloorState; id: string } {
  let s = seedFloor()
  const r = E.openTable(s, { tableId: 't-9', guestCount: 4 }, waiter)
  s = E.sendLines(r.state, r.orderId, [steak200NoEgg, beer(4)], 'b1', {}, waiter).state
  return { s, id: r.orderId }
}

describe('thanh toán (sample engine, same rules as pay_order)', () => {
  it('snapshots VAT at send: steak 8%, beer 10% and not discountable', () => {
    const { s, id } = table9()
    expect(s.lines.filter(l => l.orderId === id).map(l => [l.name, l.price, l.vatRate, l.discountable])).toEqual([
      ['Steak bò nướng', 196000, 8, true],
      ['Bia Tiger lon', 25000, 10, false],
    ])
    const q = E.quoteBill(s, id)
    expect(q).toMatchObject({ subtotal: 296000, total: 296000 })
    expect(q.vat.map(v => v.vatRate)).toEqual([8, 10])
    expect(q.vat.reduce((t, v) => t + v.base + v.vat, 0)).toBe(296000)
  })

  it('needs an open shift, then closes the order with a bill split over cash + transfer', () => {
    const t = table9()
    const id = t.id
    let s = t.s
    const pay = { payments: [{ method: 'bank' as const, amount: 200000 }, { method: 'cash' as const, amount: 96000, tendered: 100000 }] }
    expect(() => E.payOrder(s, id, pay, cashier)).toThrow('Chưa mở ca')
    s = E.openShift(s, { openingFloat: 1500000 }, cashier).state
    expect(() => E.openShift(s, { openingFloat: 0 }, cashier)).toThrow('đang có ca mở')
    expect(() => E.payOrder(s, id, pay, waiter)).toThrow('Chưa có quyền: Thu tiền')
    const r = E.payOrder(s, id, pay, cashier)
    const bill = r.state.bills.find(b => b.id === r.billId)!
    expect(bill).toMatchObject({ billNo: 'HD000001', tableLabel: '9', subtotal: 296000, total: 296000, cashier: 'Lan', printCount: 0 })
    expect(bill.payments.map(p => [p.method, p.amount, p.tendered])).toEqual([['bank', 200000, null], ['cash', 96000, 100000]])
    expect(r.state.orders.find(o => o.id === id)).toMatchObject({ status: 'paid', payingAt: null })
    expect(tableState(r.state, r.state.tables.find(t => t.id === 't-9')!)).toBe('free')
  })

  it('refuses short, over and non-cash overpayment', () => {
    const t = table9()
    const id = t.id
    let s = t.s
    s = E.openShift(s, { openingFloat: 0 }, cashier).state
    expect(() => E.payOrder(s, id, { payments: [{ method: 'cash', amount: 295000 }] }, cashier)).toThrow('Tổng thanh toán 295000 khác số phải trả 296000')
    expect(() => E.payOrder(s, id, { payments: [{ method: 'card', amount: 300000 }] }, cashier)).toThrow('không được vượt')
    expect(() => E.payOrder(s, id, { payments: [{ method: 'card', amount: 296000, tendered: 300000 }] }, cashier)).toThrow('Tiền khách đưa chỉ ghi cho tiền mặt')
    expect(() => E.payOrder(s, id, { payments: [{ method: 'cash', amount: 296000, tendered: 200000 }] }, cashier)).toThrow('không nhỏ hơn số thu')
  })

  it('bill discount: reason and manager PIN; % only on discountable lines; total rounded down', () => {
    const t = table9()
    const id = t.id
    let s = t.s
    s = E.openShift(s, { openingFloat: 0 }, cashier).state
    const d = { kind: 'percent' as const, value: 10 }
    const q = E.quoteBill(s, id, d)
    expect(q).toMatchObject({ discountBase: 196000, discount: 19600, rounding: -400, total: 276000 })
    const pay = { discount: d, payments: [{ method: 'cash' as const, amount: 276000 }] }
    expect(() => E.payOrder(s, id, pay, cashier)).toThrow('Chọn lý do giảm giá')
    expect(() => E.payOrder(s, id, { ...pay, discountReason: 'Khách quen' }, cashier)).toThrow('cần quản lý nhập mã PIN')
    // approval token (verify_manager_pin) bound to this order and at most the approved amount
    const approveUpTo = (max: number): E.Ctx['approve'] => (t, need) => (t === 'tok' && need.action === 'discount' && need.orderId === id && (need.amount ?? 0) <= max ? 'Quản lý Hà' : null)
    expect(() => E.payOrder(s, id, { ...pay, discountReason: 'Khách quen', approval: 'tok' }, { ...cashier, approve: approveUpTo(10000) })).toThrow('Mã duyệt')
    const r = E.payOrder(s, id, { ...pay, discountReason: 'Khách quen', approval: 'tok' }, { ...cashier, approve: approveUpTo(19600) })
    expect(r.state.bills[0]).toMatchObject({ discount: 19600, discountReason: 'Khách quen', rounding: -400, total: 276000, vatTotal: 22126 })
    // same VAT split as calc_bill in supabase/tests/0005_cashier_test.sql
    expect(r.state.bills[0].vatLines).toEqual([
      { vatRate: 8, priceIncludesVat: true, base: 163097, vat: 13048 },
      { vatRate: 10, priceIncludesVat: true, base: 90777, vat: 9078 },
    ])
    // the manager applies it without a PIN
    const m = E.payOrder(s, id, { ...pay, discountReason: 'Chủ quán mời' }, at(5, 'manager'))
    expect(m.state.bills[0].discount).toBe(19600)
  })

  it('counts receipt prints so the 2nd one says IN LẠI', () => {
    const t = table9()
    const id = t.id
    let s = t.s
    s = E.openShift(s, { openingFloat: 0 }, cashier).state
    const r = E.payOrder(s, id, { payments: [{ method: 'cash', amount: 296000 }] }, cashier)
    const p1 = E.printBill(r.state, r.billId, cashier)
    const p2 = E.printBill(p1.state, r.billId, at(30, 'cashier'))
    expect([p1.count, p2.count]).toEqual([1, 2])
    expect(p2.state.bills[0]).toMatchObject({ printCount: 2, lastPrintBy: 'Lan' })
  })

  it('shift: totals by method, expected cash = float + cash, difference needs a note', () => {
    const t = table9()
    const id = t.id
    let s = t.s
    const o = E.openShift(s, { openingFloat: 1500000 }, cashier)
    s = o.state
    s = E.payOrder(s, id, { payments: [{ method: 'bank', amount: 200000 }, { method: 'cash', amount: 96000, tendered: 500000 }] }, cashier).state
    const sh = s.shifts[0]
    const sum = shiftSummary(sh, s.bills)
    expect(sum).toMatchObject({ bills: 1, sales: 296000, byMethod: { cash: 96000, bank: 200000, card: 0 }, cashTendered: 500000, changeGiven: 404000, expectedCash: 1596000 })
    const short = { '500000': 3, '50000': 1, '20000': 2 } // 1.590.000
    expect(countedTotal(short)).toBe(1590000)
    expect(() => E.closeShift(s, { shiftId: sh.id, countedDetail: short }, cashier)).toThrow('Két lệch')
    expect(() => E.closeShift(s, { shiftId: sh.id, countedDetail: { '300000': 1 } }, cashier)).toThrow('Mệnh giá không hợp lệ')
    const closed = E.closeShift(s, { shiftId: sh.id, countedDetail: short, note: 'Thối nhầm bàn 9' }, at(60, 'cashier'))
    expect(closed.shifts[0]).toMatchObject({ countedCash: 1590000, expectedCash: 1596000, closedBy: 'Lan', note: 'Thối nhầm bàn 9' })
    expect(() => E.closeShift(closed, { shiftId: sh.id, countedDetail: short, note: 'x' }, cashier)).toThrow('Ca đã chốt')
  })

  it('shift summary of the two bills in the SQL test equals shift_summary there', () => {
    const base = { orderId: 'o', tableLabel: '9', discountReason: '', serviceCharge: 0, vatAdded: 0, vatLines: [], cashier: 'Lan', paidAt: T0.toISOString(), shiftId: 'sh1', printCount: 0, lastPrintAt: null, lastPrintBy: '' }
    const pay = (method: 'cash' | 'bank' | 'card', amount: number, tendered: number | null = null) => ({ id: method, method, amount, tendered, ref: '', receivedBy: 'Lan', receivedAt: T0.toISOString() })
    const bills = [
      { ...base, id: 'b9', billNo: 'HD000001', subtotal: 296000, discount: 19600, rounding: -400, total: 276000, vatTotal: 22126, payments: [pay('bank', 200000), pay('cash', 76000, 100000)] },
      { ...base, id: 'b10', billNo: 'HD000002', subtotal: 409000, discount: 0, rounding: 0, total: 409000, vatTotal: 31138, payments: [pay('cash', 409000)] },
      { ...base, id: 'other', billNo: 'HD000003', subtotal: 1, discount: 0, rounding: 0, total: 1, vatTotal: 0, shiftId: 'sh0', payments: [pay('cash', 1)] },
    ]
    expect(shiftSummary({ id: 'sh1', openingFloat: 1500000 }, bills)).toEqual({
      bills: 2, subtotal: 705000, discount: 19600, serviceCharge: 0, rounding: -400, sales: 685000, vatTotal: 53264,
      byMethod: { cash: 485000, bank: 200000, card: 0 }, cashTendered: 509000, changeGiven: 24000, openingFloat: 1500000, expectedCash: 1985000,
    })
  })

  it('refuses to close a shift while an order is on a payment screen', () => {
    const t = table9()
    const id = t.id
    let s = t.s
    s = E.openShift(s, { openingFloat: 0 }, cashier).state
    s = E.beginPayment(s, id, cashier)
    expect(() => E.closeShift(s, { shiftId: s.shifts[0].id, countedDetail: {} }, cashier)).toThrow('Còn đơn đang thanh toán')
  })

  it('the sample evening has an open shift and one paid bill', () => {
    const s = sampleEvening(menu, T0)
    expect(s.shifts.filter(x => !x.closedAt)).toHaveLength(1)
    expect(s.bills).toHaveLength(1)
    expect(s.bills[0]).toMatchObject({ total: 400000, printCount: 1 })
  })
})

// ---------------------------------------------------------------- receipt layout

const texts = (bs: Block[]) => bs.filter((b): b is Extract<Block, { kind: 'text' }> => b.kind === 'text')

function expectFits(bs: Block[]) {
  for (const b of texts(bs)) expect(textWidth(b.text), JSON.stringify(b.text)).toBeLessThanOrEqual(b.big ? BIG_WIDTH : WIDTH)
}

describe('receipt line layout (48 characters)', () => {
  it('right-aligns amounts at column 48 and wraps long text', () => {
    expect(row('Tạm tính', '1.342.000')).toEqual(['Tạm tính' + ' '.repeat(48 - 8 - 9) + '1.342.000'])
    const long = row('Ba chỉ bò Mỹ nướng sốt tiêu đen đặc biệt của nhà hàng Bò Mỹ Đen', '1.149.000')
    expect(long.length).toBe(2)
    expect(long.every(l => textWidth(l) <= WIDTH)).toBe(true)
    expect(long[1].endsWith('1.149.000')).toBe(true)
    expect(long[1].startsWith('  ')).toBe(true) // continuation indent
    expect(textWidth(long[1])).toBe(48)
    expect(wrap('x'.repeat(100))).toEqual(['x'.repeat(48), 'x'.repeat(48), 'x'.repeat(4)])
    expect(center('HOÁ ĐƠN')).toEqual([' '.repeat(20) + 'HOÁ ĐƠN'])
  })

  it('counts Vietnamese letters as one column even when typed with combining marks', () => {
    const decomposed = 'Tiền mặt'.normalize('NFD')
    expect(decomposed.length).toBeGreaterThan(8)
    expect(textWidth(decomposed)).toBe(8)
    expect(textWidth(row(decomposed, '474.000')[0])).toBe(48)
  })

  it('prints size, options, removed components and add-ons with their price per portion', () => {
    const out = itemLines({
      name: 'Steak bò nướng', variant: '300g', qty: 2, unitPrice: 284000,
      mods: [
        { kind: 'option', name: 'Medium', qty: 1, unitDelta: 0 },
        { kind: 'removal', name: 'Trứng ốp la', qty: 1, unitDelta: -3000 },
        { kind: 'addon', name: 'Thêm trứng', qty: 1, unitDelta: 8000 },
      ],
    })
    expect(out).toEqual([
      'Steak bò nướng (300g)' + ' '.repeat(48 - 21 - 7) + '279.000',
      '  Medium',
      '  Không trứng ốp la' + ' '.repeat(48 - 19 - 6) + '-3.000',
      '  + Thêm trứng' + ' '.repeat(48 - 14 - 6) + '+8.000',
      '  2 x 284.000' + ' '.repeat(48 - 13 - 7) + '568.000',
    ])
    expect(itemLines({ name: 'Coca-Cola', variant: '', qty: 1, unitPrice: 20000, mods: [] })).toEqual(['Coca-Cola' + ' '.repeat(48 - 9 - 6) + '20.000'])
  })

  const shop = { ...SAMPLE_SHOP, address: '12 Đường Mẫu, Quận 1, TP. Hồ Chí Minh', phone: '0900 000 000' }
  const totals = billTotals(
    [
      { price: 399000, qty: 1, vatRate: 8 },
      { price: 159000, qty: 2, vatRate: 8 },
      { price: 189000, qty: 1, vatRate: 8 },
      { price: 186000, qty: 1, vatRate: 8 },
      { price: 25000, qty: 10, vatRate: 10 },
    ],
    { discount: { kind: 'percent', value: 5 } },
  )
  const data: ReceiptData = {
    kind: 'bill', shop, billNo: 'HD000124', tableLabel: 'Bàn 3 + 4 (gộp)', guestCount: 8, openedAt: '2026-10-17T11:05:00Z', at: '2026-10-17T13:40:00Z',
    cashier: 'Lan', waiter: 'Hùng',
    groups: [
      { label: 'Bàn 3', items: [{ name: 'Lẩu bò nhúng giấm', variant: '', qty: 1, unitPrice: 399000, mods: [] }, { name: 'Bò nướng tảng', variant: '', qty: 2, unitPrice: 159000, mods: [] }] },
      {
        label: 'Bàn 4',
        items: [
          { name: 'Steak bò nướng', variant: '200g', qty: 1, unitPrice: 189000, mods: [] },
          { name: 'Steak bò nướng', variant: '200g', qty: 1, unitPrice: 186000, mods: [{ kind: 'removal', name: 'Trứng ốp la', qty: 1, unitDelta: -3000 }] },
          { name: 'Bia Tiger lon', variant: '', qty: 10, unitPrice: 25000, mods: [] },
        ],
      },
    ],
    subtotal: totals.subtotal, discount: totals.discount, discountLabel: 'Giảm giá 5% (KM hoá đơn từ 1 triệu)', serviceCharge: 0, rounding: totals.rounding,
    total: totals.total, vat: totals.vat,
    payments: [{ method: 'bank', amount: 500000 }, { method: 'card', amount: 300000, ref: '4321' }, { method: 'cash', amount: 474000, tendered: 500000 }],
  }

  it('lays out the merged-table bill from the spec: groups, VAT per rate, discount, payments and change', () => {
    const bs = receiptBlocks(data)
    expectFits(bs)
    const txt = blocksText(bs)
    const lines = txt.split('\n')
    const has = (s: string) => expect(lines.some(l => l.trimEnd() === s || l === s), s).toBe(true)
    expect(lines[0].trim()).toBe('BÒ MỸ ĐEN')
    expect(txt).toContain('HOÁ ĐƠN THANH TOÁN')
    has('Số HĐ: HD000124' + ' '.repeat(48 - 15 - 16) + 'Ngày: 17/10/2026')
    has('Bàn 3 + 4 (gộp)' + ' '.repeat(48 - 15 - 8) + 'Khách: 8')
    has('Giờ vào: 18:05' + ' '.repeat(48 - 14 - 13) + 'Giờ ra: 20:40')
    has('[Bàn 3]')
    has('  Cộng Bàn 3' + ' '.repeat(48 - 12 - 7) + '717.000')
    has('  Cộng Bàn 4' + ' '.repeat(48 - 12 - 7) + '625.000')
    has('Tạm tính' + ' '.repeat(48 - 8 - 9) + '1.342.000')
    has('Giảm giá 5% (KM hoá đơn từ 1 triệu)' + ' '.repeat(48 - 35 - 7) + '-67.100')
    has('Làm tròn' + ' '.repeat(48 - 8 - 4) + '-900')
    const big = texts(bs).filter(b => b.big)
    expect(big.map(b => b.text)).toContain('TỔNG CỘNG' + ' '.repeat(24 - 9 - 10) + '1.274.000đ')
    has('Giá đã gồm thuế GTGT. Trong đó:')
    has('  Thuế GTGT 8% (trên 959.878)' + ' '.repeat(48 - 29 - 6) + '76.790')
    has('  Thuế GTGT 10% (trên 215.756)' + ' '.repeat(48 - 30 - 6) + '21.576')
    has('Chuyển khoản' + ' '.repeat(48 - 12 - 7) + '500.000')
    has('Thẻ (4321)' + ' '.repeat(48 - 10 - 7) + '300.000')
    has('Tiền mặt' + ' '.repeat(48 - 8 - 7) + '474.000')
    has('  Khách đưa' + ' '.repeat(48 - 11 - 7) + '500.000')
    has('  Tiền thối' + ' '.repeat(48 - 11 - 6) + '26.000')
    expect(bs.some(b => b.kind === 'qr')).toBe(false) // paid: no QR
    expect(txt).not.toContain('IN LẠI')
  })

  it('marks reprints with the count, time and who printed', () => {
    const txt = blocksText(receiptBlocks({ ...data, reprint: { count: 2, at: '2026-10-17T14:01:00Z', by: 'Lan' } }))
    expect(txt).toContain('*** IN LẠI – lần 2 ***')
    expect(txt).toContain('21:01 17/10/2026 · Lan')
  })

  it('pre-bill: title, print number, CÒN PHẢI TRẢ after money taken before, VietQR with amount and memo', () => {
    const bs = receiptBlocks({ ...data, kind: 'prebill', billNo: undefined, printNo: 2, payments: [{ method: 'bank', amount: 500000 }], qr: { payload: '000201...', amount: 774000, memo: 'BMD3F9A2C BAN3' } })
    expectFits(bs)
    const txt = blocksText(bs)
    expect(texts(bs).find(b => b.big && b.text.includes('PHIẾU TẠM TÍNH'))).toBeTruthy()
    expect(txt).toContain('CHƯA THANH TOÁN')
    expect(txt).toContain('Lần in: 2')
    expect(texts(bs).some(b => b.big && b.text === 'CÒN PHẢI TRẢ    774.000đ')).toBe(true)
    expect(txt).toContain('Đã thu trước:')
    expect(bs.filter(b => b.kind === 'qr')).toEqual([{ kind: 'qr', payload: '000201...' }])
    expect(txt).toContain('Số tiền: 774.000đ')
    expect(txt).toContain('Nội dung: BMD3F9A2C BAN3')
    expect(txt).toContain('(Thông tin quán và tài khoản là mẫu)')
  })

  it('VAT-excluded lines add a VAT line above the total', () => {
    const t = billTotals([{ price: 500000, qty: 2, vatRate: 8, priceIncludesVat: false }], { serviceChargePct: 5 })
    const bs = receiptBlocks({ ...data, groups: [], subtotal: t.subtotal, discount: 0, serviceCharge: t.serviceCharge, serviceChargePct: 5, rounding: t.rounding, total: t.total, vat: t.vat, payments: [] })
    const txt = blocksText(bs)
    expect(txt).toContain('Phí phục vụ 5%' + ' '.repeat(48 - 14 - 6) + '50.000')
    expect(txt).toContain('Thuế GTGT 8% (trên 1.050.000)' + ' '.repeat(48 - 29 - 6) + '84.000')
    expect(txt).not.toContain('Trong đó')
  })

  it('renders print HTML for an 80mm page with one div per line', () => {
    const html = receiptHtml(receiptBlocks({ ...data, kind: 'prebill', qr: { payload: '00020101021238570010A000000727', amount: 1000, memo: 'X' } }))
    expect(html).toContain('@page { size: 80mm auto; margin: 0; }')
    expect(html).toContain('<svg')
    expect(html).not.toContain('<script')
    expect(html.match(/<div class="l/g)!.length).toBeGreaterThan(40)
  })

  it('shift report fits 48 columns and shows expected vs counted', () => {
    const summary = {
      bills: 12, subtotal: 8540000, discount: 120000, serviceCharge: 0, rounding: -2300, sales: 8417700, vatTotal: 640000,
      byMethod: { cash: 3100000, bank: 4517700, card: 800000 }, cashTendered: 3600000, changeGiven: 500000, openingFloat: 2000000, expectedCash: 5100000,
    }
    const bs = shiftReportBlocks({ shop, register: 'Quầy 1', openedBy: 'Lan', openedAt: '2026-10-17T10:00:00Z', closedBy: 'Lan', closedAt: '2026-10-17T16:00:00Z', summary, countedDetail: { '500000': 10, '20000': 3 }, countedCash: 5060000, note: 'Thiếu 40.000' })
    expectFits(bs)
    const txt = blocksText(bs)
    expect(txt).toContain('BÁO CÁO CHỐT CA')
    expect(txt).toContain('  = Dự kiến trong két' + ' '.repeat(48 - 21 - 9) + '5.100.000')
    expect(txt).toContain('    500.000 x 10' + ' '.repeat(48 - 16 - 9) + '5.000.000')
    expect(txt).toContain('  Chênh lệch (thiếu)' + ' '.repeat(48 - 20 - 7) + '-40.000')
    expect(txt).toContain('  Chuyển khoản' + ' '.repeat(48 - 14 - 9) + '4.517.700')
  })
})

describe('receipt data from the floor', () => {
  it('builds the bill of the sample evening and a pre-bill with a VietQR for the amount due', () => {
    const s = sampleEvening(menu, T0)
    const bill = s.bills[0]
    const d = billData(s, bill)
    expect(d.tableLabel).toBe('Bàn 11')
    expect(d.groups[0].items.map(i => [i.name, i.qty, i.unitPrice])).toEqual([
      ['Steak bò nướng', 1, 196000],
      ['Bò nướng lá lốt', 1, 129000],
      ['Bia Tiger lon', 3, 25000],
    ])
    expectFits(receiptBlocks(d))
    const o9 = s.orders.find(o => o.tableId === 't-9' && o.status === 'open')!
    const pre = prebillData(s, o9, E.quoteBill(s, o9.id), { at: T0.toISOString(), printNo: 2 })
    expect(pre.qr?.amount).toBe(E.quoteBill(s, o9.id).total)
    expect(pre.qr?.memo).toBe(payMemo(s, o9))
    expect(pre.qr?.payload).toContain(`54${String(pre.qr!.amount).length.toString().padStart(2, '0')}${pre.qr!.amount}`)
  })

  it('transfer memo: ASCII, short, one letter per share', () => {
    const s = sampleEvening(menu, T0)
    const o5b = s.orders.find(o => o.positionLabel === '2 khách áo xanh')!
    const memo = payMemo(s, o5b, 'B')
    expect(memo).toMatch(/^BMD[0-9A-Z]{6}B BAN5B$/)
    expect(memo.length).toBeLessThanOrEqual(25)
    expect(orderCode('3f9a2c10-0000-4000-8000-000000000000')).toBe('3F9A2C')
    expect(receiptTableTitle('nhóm gộp 3+4+5')).toBe('Bàn 3 + 4 + 5 (gộp)')
    expect(receiptTableTitle('MV-02')).toBe('MV-02')
    expect(formatMoney(-1274000)).toBe('-1.274.000')
  })
})

describe('cài đặt thanh toán trên hoá đơn', () => {
  const vat = [{ vatRate: 8, priceIncludesVat: true, base: 403704, vat: 32296 }]
  const data: ReceiptData = {
    kind: 'bill', shop: SAMPLE_SHOP, billNo: 'HD000001', tableLabel: 'Bàn 1', openedAt: '2026-10-17T12:00:00Z', at: '2026-10-17T13:00:00Z',
    groups: [], subtotal: 436000, discount: 0, serviceCharge: 0, rounding: 0, total: 436000, vat,
  }
  it('prints VAT lines unless the shop hides them', () => {
    expect(blocksText(receiptBlocks(data))).toContain('Thuế GTGT 8%')
    expect(blocksText(receiptBlocks({ ...data, shop: { ...SAMPLE_SHOP, showVat: false } }))).not.toContain('Thuế')
  })
  it('keeps VAT added on top (the total needs it), without the rate', () => {
    const added = { ...data, total: 470880, vat: [{ vatRate: 8, priceIncludesVat: false, base: 436000, vat: 34880 }], shop: { ...SAMPLE_SHOP, showVat: false } }
    const txt = blocksText(receiptBlocks(added))
    expect(txt).toContain('Thuế')
    expect(txt).not.toContain('GTGT')
  })
  it('no VietQR when the shop takes no transfers', () => {
    expect(vietQr(SAMPLE_SHOP, 1000, 'X')).not.toBeNull()
    expect(vietQr({ ...SAMPLE_SHOP, payMethods: { cash: true, bank: false, card: true } }, 1000, 'X')).toBeNull()
  })
})
