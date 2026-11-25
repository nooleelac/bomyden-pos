import { describe, expect, it } from 'vitest'
import type { BankTxn } from '../floor/types'
import { memoCode } from '../floor/engine'
import { applyTransfers, looseTransfers, matchTransfer, memoKey } from './transfers'

const tx = (id: string, amount: number, content: string, at = '2026-11-25T12:00:00Z'): BankTxn => ({
  id: 'p2s:' + id, amount, content, code: memoCode(content), remitter: '', gateway: 'ACB', account: '1', receivedAt: at,
})

describe('tự xác nhận chuyển khoản', () => {
  it('reads the order code the way bank_txns_in does', () => {
    expect(memoCode('MBVCB.123 bmd 3f9a2c BAN5B')).toBe('3F9A2C')
    expect(memoCode('chuyen tien')).toBeNull()
    expect(memoKey('BMD3F9A2CA BAN5B')).toBe('BMD3F9A2CA')
  })

  it('matches the memo even when the bank drops spaces or adds words, and needs the whole amount', () => {
    const list = [tx('1', 200_000, 'IBFT bmd3f9a2c ban5b nguyen van a')]
    expect(matchTransfer(list, 'BMD3F9A2C BAN5B', 200_000, new Set())?.id).toBe('p2s:1')
    expect(matchTransfer(list, 'BMD3F9A2C BAN5B', 250_000, new Set())).toBeUndefined()
    expect(matchTransfer(list, 'BMD999999 BAN1', 1_000, new Set())).toBeUndefined()
    expect(matchTransfer(list, 'BMD3F9A2C BAN5B', 200_000, new Set(['p2s:1']))).toBeUndefined()
  })

  it('confirms each row with its own transfer and unconfirms one whose transfer was used elsewhere', () => {
    const memo = (r: { part?: string }) => `BMD3F9A2C${r.part ?? ''} BAN5B`
    const rows = [
      { method: 'bank', amount: 100_000, confirmed: false, ref: '', part: 'A' },
      { method: 'bank', amount: 100_000, confirmed: false, ref: '', part: 'B' },
      { method: 'cash', amount: 50_000, confirmed: false, ref: '' },
    ]
    const list = [tx('a', 100_000, 'BMD3F9A2CA BAN5B'), tx('b', 100_000, 'BMD3F9A2CB BAN5B')]
    const r = applyTransfers(rows, list, memo)
    expect(r.rows.map(x => x.ref)).toEqual(['p2s:a', 'p2s:b', ''])
    expect(r.confirmed).toHaveLength(2)
    expect(applyTransfers(r.rows, list, memo).rows).toBe(r.rows) // nothing new: same array
    const gone = applyTransfers(r.rows, list.slice(1), memo).rows
    expect(gone[0]).toMatchObject({ confirmed: false, ref: '' })
    expect(gone[1]).toMatchObject({ confirmed: true, ref: 'p2s:b' })
  })

  it('lists recent money that no row took, newest first', () => {
    const now = new Date('2026-11-25T12:30:00Z')
    const list = [tx('old', 1, 'x', '2026-11-25T10:00:00Z'), tx('1', 2, 'y', '2026-11-25T12:00:00Z'), tx('2', 3, 'z', '2026-11-25T12:20:00Z')]
    expect(looseTransfers(list, new Set(['p2s:1']), now).map(t => t.id)).toEqual(['p2s:2'])
  })
})
