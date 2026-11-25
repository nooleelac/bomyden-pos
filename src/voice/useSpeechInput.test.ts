import { describe, expect, it } from 'vitest'
import { joinResults } from './useSpeechInput'

describe('joinResults', () => {
  it('joins separate results (Chrome, continuous)', () => {
    expect(joinResults(['hai steak 300 medium', ' ba lon tiger '])).toBe('hai steak 300 medium ba lon tiger')
  })

  it('keeps only the longest when each result repeats the one before (Safari on iPhone)', () => {
    expect(joinResults(['hai steak', 'hai steak 300', 'hai steak 300 medium không trứng'])).toBe('hai steak 300 medium không trứng')
  })

  it('drops a result sent twice and a shorter repeat', () => {
    expect(joinResults(['hai coca', 'hai coca', 'Hai'])).toBe('hai coca')
    expect(joinResults(['hai coca', 'ba tiger', 'hai coca'])).toBe('hai coca ba tiger')
  })

  it('ignores empty results', () => {
    expect(joinResults(['', '  ', 'một lẩu'])).toBe('một lẩu')
  })
})
