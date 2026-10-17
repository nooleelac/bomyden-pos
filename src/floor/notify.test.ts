import { describe, expect, it } from 'vitest'
import { seedMenu } from '../menu/seed'
import { floorEvents } from './notify'
import { sampleEvening } from './seed'

describe('bell events', () => {
  const s = sampleEvening(seedMenu())
  const latest = [...s.orders.map(o => o.openedAt), ...s.lines.map(l => l.sentAt), ...s.bills.map(b => b.paidAt)].sort().reverse()[0]
  const now = new Date(new Date(latest).getTime() + 60_000)

  it('lists what staff did, newest first, one gửi bếp per send', () => {
    const ev = floorEvents(s, now)
    expect(ev.length).toBeGreaterThan(0)
    expect(ev.map(e => e.at)).toEqual([...ev.map(e => e.at)].sort().reverse())
    const sends = ev.filter(e => e.kind === 'send')
    expect(new Set(sends.map(e => e.id)).size).toBe(sends.length)
    if (s.bills.length) expect(ev.some(e => e.kind === 'paid' && e.href.startsWith('#/thu-ngan/hd/'))).toBe(true)
  })
  it('forgets events older than the window', () => {
    expect(floorEvents(s, new Date(now.getTime() + 13 * 3600_000))).toEqual([])
  })
})
