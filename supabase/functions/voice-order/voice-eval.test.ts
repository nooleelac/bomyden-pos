// Accuracy check of the voice-order prompt against the sample menu, with real Claude calls (costs a little money).
// Off in `npm test`. Run it with:  VOICE_EVAL=1 ANTHROPIC_API_KEY=... npx vitest run voice-eval
// Prints each sentence that failed and the score; passes at ≥ 90 %.

import Anthropic from '@anthropic-ai/sdk'
import { describe, expect, it } from 'vitest'
import { seedMenu } from '../../../src/menu/seed'
import { compactMenu, parseOrder, type VoiceLine } from './core'
import samples from './samples.json'

interface Expect {
  itemId: string
  qty: number
  variantId?: string | null
  /** "o-egg:2" = add-on with 2 per portion; plain id = qty 1 */
  options?: string[]
  removalIds?: string[]
  /** true = the line must carry a note */
  note?: boolean
}
interface Sample { say: string; expect: Expect[]; unmatched?: boolean }

const optKey = (o: { optionId: string; qty: number }) => (o.qty === 1 ? o.optionId : `${o.optionId}:${o.qty}`)
const sameSet = (a: string[], b: string[]) => a.length === b.length && [...a].sort().join() === [...b].sort().join()

function lineMatches(e: Expect, l: VoiceLine): boolean {
  if (e.itemId !== l.itemId || e.qty !== l.qty) return false
  if (e.variantId !== undefined && e.variantId !== l.variantId) return false
  if (e.options && !sameSet(e.options, l.options.map(optKey))) return false
  if (e.removalIds && !sameSet(e.removalIds, l.removalIds)) return false
  if (e.note && !l.note) return false
  return true
}

/** Every expected line matches a different returned line, and nothing extra came back. */
export function grade(s: Sample, got: { lines: VoiceLine[]; unmatched: string[] }): string | null {
  if (got.lines.length !== s.expect.length) return `${got.lines.length} dòng, cần ${s.expect.length}`
  const left = [...got.lines]
  for (const e of s.expect) {
    const i = left.findIndex(l => lineMatches(e, l))
    if (i < 0) return `thiếu ${JSON.stringify(e)}`
    left.splice(i, 1)
  }
  if (s.unmatched && !got.unmatched.length) return 'cần báo phần không hiểu (unmatched)'
  return null
}

describe.skipIf(!process.env.VOICE_EVAL)('voice-order eval (Claude, sample menu)', () => {
  it('understands ≥ 90 % of the sample sentences', async () => {
    const client = new Anthropic()
    // as on the live menu: "Trứng chín" sits in Độ chín next to the beef doneness (up to 2 per portion)
    const menu = seedMenu()
    const doneness = menu.groups.find(g => g.id === 'g-doneness')!
    doneness.maxSelect = 2
    doneness.options.push({ ...doneness.options[0], id: 'o-egg-done', name: 'Trứng chín', kitchenName: 'TRỨNG CHÍN', sort: 6 })
    const { text, index } = compactMenu(menu)
    // VOICE_THINKING=off tries the call without thinking; VOICE_SERIAL=1 sends one sentence at a time (real latency)
    const thinking = process.env.VOICE_THINKING !== 'off'
    const one = async (s: Sample) => {
      const t = Date.now()
      try {
        const got = await parseOrder(client, text, index, s.say, { thinking })
        return { s, got, fail: grade(s, got), ms: Date.now() - t }
      } catch (e) {
        return { s, got: null, fail: 'lỗi: ' + (e as Error).message, ms: Date.now() - t }
      }
    }
    const list = samples as Sample[]
    const results: Awaited<ReturnType<typeof one>>[] = []
    if (process.env.VOICE_SERIAL) for (const s of list) results.push(await one(s))
    else results.push(...(await Promise.all(list.map(one))))
    const failed = results.filter(r => r.fail)
    for (const r of failed) console.log(`✗ «${r.s.say}» — ${r.fail}\n   nhận: ${JSON.stringify(r.got)}`)
    const ms = results.map(r => r.ms).sort((a, b) => a - b)
    const score = (results.length - failed.length) / results.length
    console.log(`[suy nghĩ ${thinking ? 'bật' : 'tắt'}${process.env.VOICE_SERIAL ? ', từng câu' : ''}] Đúng ${results.length - failed.length}/${results.length} (${Math.round(score * 100)} %), thời gian giữa ${ms[ms.length >> 1]} ms, chậm nhất ${ms[ms.length - 1]} ms`)
    expect(score).toBeGreaterThanOrEqual(0.9)
  }, 300_000)
})
