// Tự xác nhận chuyển khoản (Pay2S, migration 0030): which reported transfer pays which transfer row of the pay screen.
// A row's memo is "BMD3F9A2C BAN5B" (payMemo); banks keep it but may add their own words, cut spaces or change case,
// so the first word, letters and digits only, is looked for in the memo the bank reports.

import type { BankTxn } from '../floor/types'

export const isBankRef = (ref?: string | null) => !!ref && ref.startsWith('p2s:')

const squash = (s: string) => s.toUpperCase().replace(/[^0-9A-Z]/g, '')

/** "BMD3F9A2CA BAN5B" → "BMD3F9A2CA": the order code and the share letter. */
export const memoKey = (memo: string) => squash(memo.split(' ')[0] ?? '')

/** Transfers whose memo names this row (oldest first), not taken by another row. */
export function transfersFor(list: BankTxn[], memo: string, taken: ReadonlySet<string>): BankTxn[] {
  const key = memoKey(memo)
  if (key.length < 9) return []
  return list.filter(t => !taken.has(t.id) && squash(t.content).includes(key))
}

/** The transfer that pays this row: its memo and at least the amount. */
export function matchTransfer(list: BankTxn[], memo: string, amount: number, taken: ReadonlySet<string>): BankTxn | undefined {
  return amount > 0 ? transfersFor(list, memo, taken).find(t => t.amount >= amount) : undefined
}

/** Money in of the last `minutes` that names no open row: the guest changed the memo, or paid from a wallet. Newest first. */
export function looseTransfers(list: BankTxn[], taken: ReadonlySet<string>, now: Date, minutes = 60): BankTxn[] {
  const since = now.getTime() - minutes * 60_000
  return list.filter(t => !taken.has(t.id) && Date.parse(t.receivedAt) >= since).sort((a, b) => b.receivedAt.localeCompare(a.receivedAt))
}

/**
 * Rows of the pay screen after the bank's news: an unconfirmed transfer row whose money arrived is confirmed with the
 * transfer as its ref; a row tied to a transfer that is gone (used on another device) is unconfirmed. Same array when
 * nothing changes. `confirmed` lists the transfers just taken, for a message.
 */
export function applyTransfers<R extends { method: string; amount: number; confirmed?: boolean; ref?: string }>(
  rows: R[],
  list: BankTxn[],
  memoOf: (r: R) => string,
): { rows: R[]; confirmed: BankTxn[] } {
  const live = new Set(list.map(t => t.id))
  const taken = new Set(rows.filter(r => isBankRef(r.ref) && live.has(r.ref!)).map(r => r.ref!))
  const confirmed: BankTxn[] = []
  let changed = false
  const next = rows.map(r => {
    if (r.method !== 'bank') return r
    if (isBankRef(r.ref) && !live.has(r.ref!)) {
      changed = true
      return { ...r, confirmed: false, ref: '' }
    }
    if (r.confirmed) return r
    const t = matchTransfer(list, memoOf(r), r.amount, taken)
    if (!t) return r
    taken.add(t.id)
    confirmed.push(t)
    changed = true
    return { ...r, confirmed: true, ref: t.id }
  })
  return { rows: changed ? next : rows, confirmed }
}
