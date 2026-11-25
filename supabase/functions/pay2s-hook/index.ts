// pay2s-hook: Pay2S posts here every balance change of the linked bank accounts (migration 0030).
//   * Authorization: Bearer <token>; the token is made in Cài đặt → Thanh toán → Tự xác nhận chuyển khoản
//     (bank_feed_setup) and pasted into Pay2S → Webhook. Any other caller gets 401.
//   * Body: { "transactions": [ { id, gateway, transactionDate, accountNumber, content, transferType, transferAmount, extraData… } ] }
//     bank_txns_in keeps the money in (IN), once per transaction id, with the order code found in the memo.
//   * Pay2S counts a delivery only when it gets 2xx with { "success": true }, and retries otherwise.
// Deployed without JWT verification: Pay2S sends its own token, not a Supabase one.

import { createClient } from 'npm:@supabase/supabase-js@2.45.4'

const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } })

/** Same time whatever the input, so the token cannot be guessed a letter at a time. */
function same(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a)
  const y = new TextEncoder().encode(b)
  let d = x.length ^ y.length
  for (let i = 0; i < Math.max(x.length, y.length); i++) d |= (x[i] ?? 0) ^ (y[i] ?? 0)
  return d === 0
}

const reply = (status: number, body: Record<string, unknown>) => Response.json(body, { status })

Deno.serve(async req => {
  if (req.method !== 'POST') return reply(405, { success: false, message: 'POST only' })
  const { data: cfg, error } = await db.from('bank_feed_config').select('enabled, token').eq('id', 1).single()
  if (error || !cfg) return reply(500, { success: false, message: 'config' })
  const token = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '').trim()
  if (!cfg.token || !same(token, cfg.token)) return reply(401, { success: false, message: 'unauthorized' })

  let body: { transactions?: unknown } | null = null
  try {
    body = await req.json()
  } catch {
    return reply(400, { success: false, message: 'json' })
  }
  const txns = Array.isArray(body?.transactions) ? body!.transactions : []
  // kept even while the feed is off: turning it on later shows nothing old as "new", but the history is there
  const { data, error: e2 } = await db.rpc('bank_txns_in', { p_txns: txns })
  if (e2) {
    console.error('bank_txns_in', e2.message)
    return reply(500, { success: false, message: 'db' })
  }
  return reply(200, { success: true, saved: data ?? 0 })
})
