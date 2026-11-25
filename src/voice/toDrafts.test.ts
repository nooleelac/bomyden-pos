import { describe, expect, it } from 'vitest'
import { seedMenu } from '../menu/seed'
import { toDrafts, type VoiceLine } from './toDrafts'

const now = new Date('2026-11-04T12:00:00Z')
const line = (x: Partial<VoiceLine> & Pick<VoiceLine, 'itemId'>): VoiceLine => ({
  variantId: null, qty: 1, options: [], removalIds: [], note: '', heard: '', ...x,
})
const run = (lines: VoiceLine[], unmatched: string[] = [], menu = seedMenu()) => toDrafts(menu, { lines, unmatched }, now)

describe('toDrafts', () => {
  it('takes an item without sizes as it is', () => {
    const { drafts } = run([line({ itemId: 'i-coca', qty: 2, heard: '2 coca' })])
    expect(drafts).toHaveLength(1)
    expect(drafts[0].state).toEqual({ itemId: 'i-coca', variantId: null, qty: 2, options: {}, removals: [], note: '' })
    expect(drafts[0].quote).toMatchObject({ unit: 20000, total: 40000, canAdd: true })
    expect(drafts[0].heard).toBe('2 coca')
  })

  it('builds a steak with size, doneness, sauce, add-on and a removal', () => {
    const { drafts } = run([line({
      itemId: 'i-steak', variantId: 'v-300',
      options: [{ optionId: 'o-mr', qty: 1 }, { optionId: 'o-mushroom', qty: 1 }, { optionId: 'o-bread', qty: 2 }],
      removalIds: ['k-egg'],
    })])
    const d = drafts[0]
    // Sốt nấm replaces the default Sốt tiêu đen
    expect(d.state.options).toEqual({ 'o-mr': 1, 'o-mushroom': 1, 'o-bread': 2 })
    expect(d.state.removals).toEqual(['k-egg'])
    expect(d.quote.canAdd).toBe(true)
    expect(d.quote.unit).toBe(279000 + 2 * 5000 - 3000)
    expect(d.summary).toBe('300g · Medium rare · Sốt nấm · + Thêm bánh mì x2 · Không trứng ốp la −3.000đ')
  })

  it('keeps the default sauce when none was said', () => {
    const { drafts } = run([line({ itemId: 'i-steak', variantId: 'v-200', options: [{ optionId: 'o-m', qty: 1 }] })])
    expect(drafts[0].state.options).toEqual({ 'o-pepper': 1, 'o-m': 1 })
  })

  it('leaves a missing size or doneness for the waiter, flagged', () => {
    const { drafts } = run([line({ itemId: 'i-steak' })])
    expect(drafts[0].quote.canAdd).toBe(false)
    expect(drafts[0].quote.issues.map(i => i.message)).toEqual(expect.arrayContaining(['Chọn size', 'Chọn Độ chín']))
  })

  it('caps add-ons at their limit and choices at 1', () => {
    const { drafts } = run([line({
      itemId: 'i-steak', variantId: 'v-200', options: [{ optionId: 'o-m', qty: 4 }, { optionId: 'o-egg', qty: 9 }],
    })])
    expect(drafts[0].state.options).toMatchObject({ 'o-m': 1, 'o-egg': 3 })
  })

  it('drops ids that are not part of the item', () => {
    const { drafts } = run([line({
      itemId: 'i-ribeye', variantId: 'v-300', options: [{ optionId: 'o-egg', qty: 1 }, { optionId: 'o-rare', qty: 1 }], removalIds: ['k-egg', 'k-rb-steak'],
    })])
    expect(drafts[0].state).toMatchObject({ variantId: null, options: { 'o-pepper': 1, 'o-rare': 1 }, removals: [] })
  })

  it('sends items that are not on the order screen to unmatched', () => {
    const { drafts, unmatched } = run([line({ itemId: 'i-draft', heard: 'bò cuộn nấm' }), line({ itemId: 'i-nope' })], ['pepsi'])
    expect(drafts).toEqual([])
    expect(unmatched).toEqual(['pepsi', 'bò cuộn nấm', 'i-nope'])
  })

  it('keeps a sold-out item but blocks it', () => {
    const menu = seedMenu()
    menu.items.find(i => i.id === 'i-tiger')!.soldOutUntil = 'infinity'
    const { drafts } = run([line({ itemId: 'i-tiger', qty: 3 })], [], menu)
    expect(drafts[0].quote.canAdd).toBe(false)
    expect(drafts[0].quote.issues[0].message).toBe('Hết món: Bia Tiger lon')
  })

  it('cuts a long note and clamps the quantity', () => {
    const { drafts } = run([line({ itemId: 'i-hotpot', qty: 250, note: '  ' + 'ít cay '.repeat(20) })])
    expect(drafts[0].state.note).toHaveLength(60)
    expect(drafts[0].state.qty).toBe(99)
  })
})
