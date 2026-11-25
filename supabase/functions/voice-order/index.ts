// voice-order: staff speak an order, the browser turns it into text, this function turns the text into order lines.
//   POST /voice-order/parse  { text }  →  { lines, unmatched }    (core.ts: prompt, schema, id checks)
//   POST /voice-order/stt    audio     →  { text }               (not yet: FPT.AI fallback for phones without speech input)
// Called with supabase.functions.invoke from a signed-in device: the device JWT is checked by the platform
// (verify_jwt stays on), and the PIN session in x-staff-session must resolve to a staff member (my_staff_id, 0006).
// Secrets: ANTHROPIC_API_KEY (supabase secrets set ANTHROPIC_API_KEY=...).

import Anthropic from '@anthropic-ai/sdk'
import { createClient } from 'npm:@supabase/supabase-js@2.45.4'
import { compactMenu, parseOrder, VoiceParseError, type MenuIndex, type MenuLike } from './core.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!
const anthropic = new Anthropic({ apiKey: Deno.env.get('ANTHROPIC_API_KEY'), maxRetries: 1, timeout: 20_000 })

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-staff-session',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: CORS })

type Row = Record<string, unknown>
const s = (v: unknown) => (v == null ? '' : String(v))
const sn = (v: unknown) => (v == null ? null : String(v))
const nn = (v: unknown) => (v == null ? null : Number(v))

/** get_menu_state rows (0016) → the shape core.ts reads; the same field mapping as menuFromRows in src/menu/supabaseRepo.ts. */
function menuFromState(d: Record<string, Row[]>): MenuLike {
  const opts = d.options ?? []
  return {
    categories: (d.categories ?? []).map(r => ({ id: s(r.id), parentId: sn(r.parent_id), visible: r.visible !== false })),
    groups: (d.groups ?? []).map(g => ({
      id: s(g.id), name: s(g.name), kind: g.kind === 'addon' ? 'addon' : 'choice', minSelect: Number(g.min_select), maxSelect: nn(g.max_select),
      options: opts.filter(o => o.group_id === g.id).map(o => ({ id: s(o.id), name: s(o.name), maxQty: Number(o.max_qty), soldOutUntil: sn(o.sold_out_until) })),
    })),
    items: (d.items ?? []).map(r => ({
      id: s(r.id), categoryId: s(r.category_id), name: s(r.name), shortName: s(r.short_name), code: s(r.code), unit: s(r.unit), status: s(r.status),
      keywords: (r.keywords as string[] | null) ?? [], price: Number(r.price), hasSizes: r.has_sizes === true, soldOutUntil: sn(r.sold_out_until),
      variants: (d.variants ?? []).filter(v => v.item_id === r.id)
        .map(v => ({ id: s(v.id), name: s(v.name), price: Number(v.price), soldOutUntil: sn(v.sold_out_until), archivedAt: sn(v.archived_at) })),
      components: (d.components ?? []).filter(c => c.item_id === r.id).map(c => ({ id: s(c.id), name: s(c.name), removable: c.removable === true })),
      groups: (d.links ?? []).filter(l => l.item_id === r.id).map(l => ({ groupId: s(l.group_id), minOverride: nn(l.min_override), maxOverride: nn(l.max_override) })),
      optionOverrides: (d.overrides ?? []).filter(o => o.item_id === r.id).map(o => ({ optionId: s(o.option_id), hidden: o.hidden === true })),
    })),
  }
}

// The menu changes rarely (sold-out marks a few times an evening): keep it for 30 s per function instance.
let menuCache: { at: number; text: string; index: MenuIndex } | null = null

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return json({ error: 'method' }, 405)
  const route = new URL(req.url).pathname.split('/').pop()

  const db = createClient(SUPABASE_URL, ANON_KEY, {
    auth: { persistSession: false },
    global: { headers: { Authorization: req.headers.get('Authorization') ?? '', 'x-staff-session': req.headers.get('x-staff-session') ?? '' } },
  })
  const { data: staffId, error: staffErr } = await db.rpc('my_staff_id')
  // the anon key alone may not even call my_staff_id: not signed in either way
  if (staffErr) console.error('my_staff_id', staffErr.message)
  if (staffErr || !staffId) return json({ error: 'Cần đăng nhập nhân viên' }, 401)

  if (route === 'stt') return json({ error: 'Chưa hỗ trợ nhận giọng trên máy chủ' }, 501)
  if (route !== 'parse') return json({ error: 'not found' }, 404)

  const body = await req.json().catch(() => null) as { text?: unknown } | null
  const text = typeof body?.text === 'string' ? body.text.trim() : ''
  if (!text) return json({ error: 'Không có nội dung' }, 400)

  if (!menuCache || Date.now() - menuCache.at > 30_000) {
    const { data, error } = await db.rpc('get_menu_state')
    if (error || !data) return json({ error: error?.message ?? 'menu' }, 500)
    menuCache = { at: Date.now(), ...compactMenu(menuFromState(data as Record<string, Row[]>)) }
  }

  const started = Date.now()
  try {
    const out = await parseOrder(anthropic, menuCache.text, menuCache.index, text)
    console.log('voice-order', JSON.stringify({ staffId, ms: Date.now() - started, lines: out.lines.length, unmatched: out.unmatched.length, usage: out.usage }))
    return json({ lines: out.lines, unmatched: out.unmatched })
  } catch (e) {
    if (e instanceof VoiceParseError) return json({ error: e.message, code: e.code }, 422)
    if (e instanceof Anthropic.RateLimitError) return json({ error: 'AI đang quá tải, thử lại sau ít giây' }, 503)
    if (e instanceof Anthropic.APIError) {
      console.error('anthropic', e.status, e.message)
      return json({ error: 'AI không phản hồi, thử lại' }, 502)
    }
    console.error('voice-order', (e as Error).message)
    return json({ error: 'Lỗi máy chủ' }, 500)
  }
})
