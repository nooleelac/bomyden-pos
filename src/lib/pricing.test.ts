import { describe, expect, it } from 'vitest'
import { allocate, billTotals, linePrice, roundTotal, unitPrice, type TaxedLine } from './pricing'

const STEAK_300G = 279000

describe('line price', () => {
  it('spec example: 2 steaks 300g split into two lines, 565.000đ', () => {
    const mediumRare = { kind: 'option' as const, amount: 0 }
    const blackPepper = { kind: 'option' as const, amount: 0 }
    const line1 = { basePrice: STEAK_300G, qty: 1, modifiers: [mediumRare, blackPepper, { kind: 'addon' as const, amount: 10000 }] }
    const line2 = { basePrice: STEAK_300G, qty: 1, modifiers: [mediumRare, blackPepper, { kind: 'removal' as const, amount: 3000 }] }
    expect(linePrice(line1)).toBe(289000)
    expect(linePrice(line2)).toBe(276000)
    expect(linePrice(line1) + linePrice(line2)).toBe(565000)
    const bill = billTotals([
      { price: unitPrice(line1), qty: 1, vatRate: 8 },
      { price: unitPrice(line2), qty: 1, vatRate: 8 },
    ])
    expect(bill).toMatchObject({ subtotal: 565000, discount: 0, rounding: 0, total: 565000, vatTotal: 41852 })
  })

  it('counts add-ons per portion and removals per portion', () => {
    // Steak 300g x2, each with one extra fried egg (8.000đ): +16.000đ on the line.
    expect(linePrice({ basePrice: STEAK_300G, qty: 2, modifiers: [{ kind: 'addon', amount: 8000, qty: 1 }] })).toBe(574000)
    // 3 portions without egg: −9.000đ in total.
    expect(linePrice({ basePrice: 189000, qty: 3, modifiers: [{ kind: 'removal', amount: 3000 }] })).toBe(558000)
    // Two extra eggs on each of 2 portions.
    expect(linePrice({ basePrice: 100000, qty: 2, modifiers: [{ kind: 'addon', amount: 8000, qty: 2 }] })).toBe(232000)
  })

  it('never goes below 0', () => {
    expect(unitPrice({ basePrice: 10000, modifiers: [{ kind: 'removal', amount: 15000 }] })).toBe(0)
    expect(linePrice({ basePrice: 10000, qty: 3, modifiers: [{ kind: 'removal', amount: 15000 }] })).toBe(0)
  })

  it('rejects fractional or negative money and bad quantities', () => {
    expect(() => unitPrice({ basePrice: 1000.5 })).toThrow(RangeError)
    expect(() => unitPrice({ basePrice: 1000, modifiers: [{ kind: 'addon', amount: -1 }] })).toThrow(RangeError)
    expect(() => linePrice({ basePrice: 1000, qty: 0 })).toThrow(RangeError)
  })
})

describe('bill totals', () => {
  it('VAT included, 10% discount, round down: 436.000đ, of which VAT 8% 32.296đ', () => {
    const lines: TaxedLine[] = [
      { price: 186000, qty: 1, vatRate: 8 }, // Steak 200g, no egg
      { price: 259000, qty: 1, vatRate: 8 },
      { price: 20000, qty: 2, vatRate: 8 },
    ]
    const b = billTotals(lines, { discount: { kind: 'percent', value: 10 } })
    expect(b).toMatchObject({ subtotal: 485000, discount: 48500, rounding: -500, total: 436000, vatAdded: 0, vatTotal: 32296 })
    expect(b.vat).toEqual([{ vatRate: 8, priceIncludesVat: true, base: 403704, vat: 32296 }])
  })

  it('VAT excluded with 5% service charge: 1.077.300đ rounds to 1.077.000đ', () => {
    const lines: TaxedLine[] = [{ price: 500000, qty: 2, vatRate: 8, priceIncludesVat: false }]
    const b = billTotals(lines, { discount: { kind: 'percent', value: 5 }, serviceChargePct: 5 })
    expect(b).toMatchObject({ subtotal: 1000000, discount: 50000, serviceCharge: 47500, vatAdded: 79800, rounding: -300, total: 1077000 })
  })

  it('splits VAT by rate on a merged bill (food 8%, beer 10%)', () => {
    const lines: TaxedLine[] = [
      { price: 399000, qty: 1, vatRate: 8 },
      { price: 159000, qty: 2, vatRate: 8 },
      { price: 189000, qty: 1, vatRate: 8 },
      { price: 186000, qty: 1, vatRate: 8 },
      { price: 25000, qty: 10, vatRate: 10 },
      { price: 99000, qty: 1, vatRate: 8, void: true },
    ]
    const b = billTotals(lines, { discount: { kind: 'percent', value: 5 } })
    expect(b).toMatchObject({ subtotal: 1342000, discount: 67100, rounding: -900, total: 1274000, vatTotal: 98366 })
    expect(b.vat).toEqual([
      { vatRate: 8, priceIncludesVat: true, base: 959878, vat: 76790 },
      { vatRate: 10, priceIncludesVat: true, base: 215756, vat: 21576 },
    ])
    expect(b.vat.reduce((s, g) => s + g.base + g.vat, 0)).toBe(b.total)
  })

  it('keeps non-discountable lines (beer) out of a % discount', () => {
    const lines: TaxedLine[] = [
      { price: 1000000, qty: 1, vatRate: 8 },
      { price: 25000, qty: 8, vatRate: 10, discountable: false },
    ]
    const b = billTotals(lines, { discount: { kind: 'percent', value: 10 } })
    expect(b).toMatchObject({ subtotal: 1200000, discountBase: 1000000, discount: 100000, total: 1100000 })
    expect(billTotals(lines, { discount: { kind: 'amount', value: 5000000 } }).discount).toBe(1000000)
  })

  it('matches the merged-group bill paid in the SQL test (steak 200g + 4 beers, 10% off)', () => {
    const lines: TaxedLine[] = [
      { price: 199000, qty: 1, vatRate: 8 },
      { price: 25000, qty: 4, vatRate: 10 },
    ]
    const b = billTotals(lines, { discount: { kind: 'amount', value: 29900 } })
    expect(b).toMatchObject({ subtotal: 299000, rounding: -100, total: 269000, vatTotal: 21441 })
    expect(b.vat).toEqual([
      { vatRate: 8, priceIncludesVat: true, base: 165771, vat: 13262 },
      { vatRate: 10, priceIncludesVat: true, base: 81788, vat: 8179 },
    ])
  })

  it('keeps the rounding apart when a VAT-excluded line is on the bill', () => {
    const lines: TaxedLine[] = [
      { price: 300, qty: 1, vatRate: 8 },
      { price: 100000, qty: 1, vatRate: 10, priceIncludesVat: false },
    ]
    const b = billTotals(lines)
    expect(b).toMatchObject({ vatAdded: 10000, rounding: -300, total: 110000 })
    expect(b.vat).toEqual([
      { vatRate: 8, priceIncludesVat: true, base: 278, vat: 22 },
      { vatRate: 10, priceIncludesVat: false, base: 100000, vat: 10000 },
    ])
  })

  it('rounds the grand total once, down by default or to the nearest 1.000đ', () => {
    expect(roundTotal(436500)).toBe(436000)
    expect(roundTotal(436500, 'nearest')).toBe(437000)
    expect(roundTotal(436400, 'nearest')).toBe(436000)
    const lines: TaxedLine[] = [{ price: 436500, qty: 1, vatRate: 8 }]
    expect(billTotals(lines, { roundingMode: 'nearest' })).toMatchObject({ rounding: 500, total: 437000 })
    expect(billTotals([], {})).toMatchObject({ subtotal: 0, total: 0, vat: [] })
  })

  it('allocates exactly, largest remainder first', () => {
    expect(allocate(-900, [1037400, 237500])).toEqual([-732, -168])
    expect(allocate(10, [1, 1, 1])).toEqual([4, 3, 3])
    expect(allocate(5, [0, 0])).toEqual([0, 0])
  })
})
