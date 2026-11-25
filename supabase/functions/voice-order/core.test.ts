import { describe, expect, it } from 'vitest'
import { seedMenu } from '../../../src/menu/seed'
import { compactMenu, normalize } from './core'

describe('compactMenu', () => {
  const { text, index } = compactMenu(seedMenu())

  it('lists what is on the order screen, not drafts', () => {
    expect(text).toContain('[i-steak] Steak bò nướng (mã 101)')
    expect(text).toContain('bít tết')
    expect(text).not.toContain('i-draft')
    expect(index.items.has('i-draft')).toBe(false)
  })

  it('shows sizes, groups and removable parts with their ids', () => {
    expect(text).toContain('v-300=300g 279000đ')
    expect(text).toContain('g-doneness "Độ chín" (chọn ít nhất 1, tối đa 1)')
    expect(text).toContain('o-egg=Thêm trứng ốp la (≤3)')
    expect(text).toContain('k-egg=Trứng ốp la')
    expect(text).not.toContain('k-steak=')  // the main part cannot be left out
  })

  it('marks sold-out items instead of hiding them', () => {
    const m = seedMenu()
    m.items.find(i => i.id === 'i-coca')!.soldOutUntil = 'infinity'
    expect(compactMenu(m).text).toMatch(/\[i-coca\].*HẾT MÓN/)
  })
})

describe('normalize', () => {
  const { index } = compactMenu(seedMenu())

  it('keeps known ids and drops ids from other items or nowhere', () => {
    const r = normalize({
      lines: [{
        itemId: 'i-steak', variantId: 'v-rb-250', qty: 2,
        options: [{ optionId: 'o-m', qty: 1 }, { optionId: 'o-nope', qty: 1 }, { optionId: 'o-egg', qty: 9 }],
        removalIds: ['k-egg', 'k-steak', 'k-egg'], note: 'x'.repeat(80), heard: '2 steak',
      }],
      unmatched: [],
    }, index)
    expect(r.lines).toEqual([{
      itemId: 'i-steak', variantId: null, qty: 2, options: [{ optionId: 'o-m', qty: 1 }, { optionId: 'o-egg', qty: 3 }],
      removalIds: ['k-egg'], note: 'x'.repeat(60), heard: '2 steak',
    }])
  })

  it('sends a line for an unknown item to unmatched', () => {
    const r = normalize({ lines: [{ itemId: 'i-pepsi', variantId: null, qty: 1, options: [], removalIds: [], note: '', heard: 'pepsi' }], unmatched: ['mì xào'] }, index)
    expect(r.lines).toEqual([])
    expect(r.unmatched).toEqual(['mì xào', 'pepsi'])
  })

  it('clamps quantities and survives junk', () => {
    expect(normalize({ lines: [{ itemId: 'i-coca', qty: 500 }] }, index).lines[0].qty).toBe(99)
    expect(normalize({ lines: [{ itemId: 'i-coca', qty: 0 }] }, index).lines[0].qty).toBe(1)
    expect(normalize(null, index)).toEqual({ lines: [], unmatched: [] })
  })
})
