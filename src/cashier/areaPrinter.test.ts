import { describe, expect, it } from 'vitest'
import { seedMenu } from '../menu/seed'
import { sampleEvening } from '../floor/seed'
import { areaPrinterFor } from './print'
import type { NetworkTarget } from './paper'

const P: NetworkTarget = { kind: 'network', agentId: 'ag-out', agentName: 'Cầu nối ngoài trời', host: '192.168.1.200', port: 9100, name: 'XP-Q80W' }

describe('areaPrinterFor', () => {
  const base = sampleEvening(seedMenu())
  const dineIn = base.orders.find(o => o.status === 'open' && o.tableId)!
  const areaId = base.tables.find(t => t.id === dineIn.tableId)!.areaId

  it('uses the printer of the area the order sits in', () => {
    const s = { ...base, areas: base.areas.map(a => (a.id === areaId ? { ...a, printer: P } : a)) }
    expect(areaPrinterFor(s, dineIn.id)).toEqual(P)
  })

  it('falls back to the device printer when the area has none, or the order has no table', () => {
    expect(areaPrinterFor(base, dineIn.id)).toBeNull()
    const s = { ...base, areas: base.areas.map(a => ({ ...a, printer: P })) }
    const away = { ...dineIn, id: 'takeaway-1', kind: 'takeaway' as const, tableId: null, tables: [] }
    expect(areaPrinterFor({ ...s, orders: [...s.orders, away] }, away.id)).toBeNull()
    expect(areaPrinterFor(s, 'no-such-order')).toBeNull()
  })
})
