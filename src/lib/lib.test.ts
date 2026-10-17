import { describe, expect, it } from 'vitest'
import { discountAmount, suggestNext, summarize } from './billing'
import { asciiNote, crc16ccitt, vietQrPayload } from './vietqr'

const lines = [
  { price: 139000, qty: 2 },
  { price: 25000, qty: 1 },
  { price: 99000, qty: 1, void: true },
]

describe('billing', () => {
  it('ignores voided lines', () => {
    expect(summarize(lines, null, []).subtotal).toBe(303000)
  })

  it('settles a split cash + transfer bill and computes change', () => {
    const s = summarize(lines, null, [
      { method: 'cash', amount: 200000, tendered: 500000 },
      { method: 'bank', amount: 103000 },
    ])
    expect(s).toMatchObject({ total: 303000, remaining: 0, change: 300000, canSettle: true })
  })

  it('blocks settling when short or overpaid', () => {
    expect(summarize(lines, null, [{ method: 'cash', amount: 300000 }]).canSettle).toBe(false)
    expect(summarize(lines, null, [{ method: 'card', amount: 400000 }]).remaining).toBe(-97000)
  })

  it('caps discounts at the subtotal', () => {
    expect(discountAmount(303000, { kind: 'percent', value: 10 })).toBe(30300)
    expect(discountAmount(303000, { kind: 'percent', value: 150 })).toBe(303000)
    expect(discountAmount(100000, { kind: 'amount', value: 250000 })).toBe(100000)
  })

  it('pre-fills the remaining amount for the next payment row', () => {
    expect(suggestNext(303000, [{ method: 'cash', amount: 200000 }])).toBe(103000)
  })
})

describe('vietqr', () => {
  it('computes CRC-16/CCITT-FALSE', () => {
    expect(crc16ccitt('123456789')).toBe('29B1')
  })

  it('strips Vietnamese marks from the transfer note', () => {
    expect(asciiNote('Bò Mỹ Đen bàn 7')).toBe('Bo My Den ban 7')
  })

  it('builds a payload with amount and note and a valid checksum', () => {
    const p = vietQrPayload({ bankBin: '970436', account: '0123456789', amount: 103000, note: 'BMD HD000042' })
    expect(p.startsWith('000201010212')).toBe(true)
    expect(p).toContain('0006970436')
    expect(p).toContain('5406103000')
    expect(p).toContain('0812BMD HD000042')
    expect(p.slice(-4)).toBe(crc16ccitt(p.slice(0, -4)))
  })
})
