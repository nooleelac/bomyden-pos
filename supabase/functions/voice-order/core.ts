// voice-order core: a spoken order (already turned into text) → order lines that point at real menu ids.
// Pure code with no Deno or Supabase calls, so the Edge Function (index.ts) and the Vitest eval
// (voice-eval.test.ts, run against src/menu/seed.ts) use exactly the same prompt, schema and checks.
// The client still runs every line through picker.ts (validateLine / quoteLine) before it reaches the cart.

import type Anthropic from '@anthropic-ai/sdk'

export const MODEL = 'claude-haiku-5-5'

// ---------------------------------------------------------------- the menu, as much of it as the prompt needs

/** The parts of src/menu/types.ts Menu read here; a real Menu fits this shape as it is. */
export interface MenuLike {
  categories: { id: string; parentId: string | null; visible: boolean }[]
  groups: {
    id: string
    name: string
    kind: 'choice' | 'addon'
    minSelect: number
    maxSelect: number | null
    options: { id: string; name: string; maxQty: number; soldOutUntil: string | null }[]
  }[]
  items: {
    id: string
    categoryId: string
    name: string
    shortName: string
    code: string
    unit: string
    status: string
    keywords: string[]
    price: number
    hasSizes: boolean
    soldOutUntil: string | null
    variants: { id: string; name: string; price: number; soldOutUntil: string | null; archivedAt: string | null }[]
    components: { id: string; name: string; removable: boolean }[]
    groups: { groupId: string; minOverride: number | null; maxOverride: number | null }[]
    optionOverrides: { optionId: string; hidden: boolean }[]
  }[]
}

const soldOut = (until: string | null, now: Date) => until != null && (until === 'infinity' || new Date(until).getTime() > now.getTime())

function categoryVisible(menu: MenuLike, id: string | null | undefined, depth = 0): boolean {
  const c = menu.categories.find(x => x.id === id)
  if (!c || !c.visible || depth > 3) return false
  return c.parentId ? categoryVisible(menu, c.parentId, depth + 1) : true
}

/** What may be ordered from this menu: ids, and per item which variant / option / component ids belong to it. */
export interface MenuIndex {
  items: Map<string, { variants: Set<string>; options: Map<string, number>; removals: Set<string> }>
}

/** Items on the order screen (as isListed in src/menu/picker.ts): active, in a visible category, sizes set up. */
function listedItems(menu: MenuLike) {
  return menu.items.filter(it =>
    it.status === 'active' && categoryVisible(menu, it.categoryId) && (!it.hasSizes || it.variants.some(v => !v.archivedAt)))
}

function itemGroups(menu: MenuLike, it: MenuLike['items'][number]) {
  return it.groups.flatMap(link => {
    const g = menu.groups.find(x => x.id === link.groupId)
    if (!g) return []
    const hidden = new Set(it.optionOverrides.filter(o => o.hidden).map(o => o.optionId))
    return [{ g, min: link.minOverride ?? g.minSelect, max: link.maxOverride ?? g.maxSelect, options: g.options.filter(o => !hidden.has(o.id)) }]
  })
}

/**
 * The menu as short text lines for the system prompt, plus the index the answer is checked against.
 * Sold-out things stay in the list, marked, so "2 steak" is still recognised and the screen can say why it can't be added.
 */
export function compactMenu(menu: MenuLike, now = new Date()): { text: string; index: MenuIndex } {
  const index: MenuIndex = { items: new Map() }
  const out: string[] = []
  for (const it of listedItems(menu)) {
    const names = [...new Set([it.shortName, ...it.keywords].map(s => s.trim()).filter(s => s && s.toLowerCase() !== it.name.toLowerCase()))]
    const head = `[${it.id}] ${it.name}` + (it.code ? ` (mã ${it.code})` : '') + (names.length ? ` — còn gọi: ${names.join(', ')}` : '') +
      ` — đơn vị ${it.unit || 'phần'}` + (it.hasSizes ? '' : ` — ${it.price}đ`) + (soldOut(it.soldOutUntil, now) ? ' — HẾT MÓN' : '')
    out.push(head)
    const entry = { variants: new Set<string>(), options: new Map<string, number>(), removals: new Set<string>() }
    if (it.hasSizes) {
      const vs = it.variants.filter(v => !v.archivedAt)
      vs.forEach(v => entry.variants.add(v.id))
      out.push('  size (bắt buộc chọn 1): ' + vs.map(v => `${v.id}=${v.name} ${v.price}đ${soldOut(v.soldOutUntil, now) ? ' HẾT' : ''}`).join(' | '))
    }
    for (const { g, min, max, options } of itemGroups(menu, it)) {
      const rule = g.kind === 'choice'
        ? `chọn ${min > 0 ? `ít nhất ${min}` : 'tuỳ ý'}${max != null ? `, tối đa ${max}` : ''}`
        : `món thêm, mỗi phần tối đa theo số trong ngoặc`
      out.push(`  ${g.id} "${g.name}" (${rule}): ` + options.map(o => {
        entry.options.set(o.id, g.kind === 'choice' ? 1 : Math.max(1, o.maxQty))
        return `${o.id}=${o.name}${g.kind === 'addon' ? ` (≤${o.maxQty})` : ''}${soldOut(o.soldOutUntil, now) ? ' HẾT' : ''}`
      }).join(' | '))
    }
    const removable = it.components.filter(c => c.removable)
    if (removable.length) {
      removable.forEach(c => entry.removals.add(c.id))
      out.push('  bỏ được ("không …"): ' + removable.map(c => `${c.id}=${c.name}`).join(' | '))
    }
    index.items.set(it.id, entry)
  }
  return { text: out.join('\n'), index }
}

// ---------------------------------------------------------------- prompt and answer shape

export const RULES = `Bạn là nhân viên ghi order của một nhà hàng bò ở Việt Nam. Bạn nhận một câu gọi món tiếng Việt đã được máy nhận giọng nói chuyển thành chữ, và đổi nó thành các dòng món theo đúng MENU bên dưới.

Cách làm:
- Chỉ dùng id có trong MENU (itemId trong [ ], variantId, optionId, id thành phần bỏ được). Tuyệt đối không bịa id.
- Chữ đến từ máy nghe nên có thể sai chính tả, thiếu dấu hoặc nghe nhầm âm gần giống ("bít tết" = steak, "tai gơ" = Tiger, "cô ca" = Coca-Cola, "mi đi um" = Medium). Hãy khớp theo tên, tên gọi khác, mã món và cách đọc gần giống.
- Chữ "chín" (độ chín) rất hay bị máy nghe thành "chính" hoặc số "9". Nếu món có lựa chọn chứa chữ "chín" (ví dụ "Trứng chín") thì "trứng chính", "trứng 9", "9 quả trứng", "trứng chín" đều là chọn lựa chọn "Trứng chín", KHÔNG phải thêm 9 quả trứng. Tương tự "chín vừa"/"chính vừa", "chín kỹ"/"chính kỹ". Con số đứng sát tên lựa chọn mà vượt giới hạn món thêm thì gần như chắc là nghe nhầm chữ "chín".
- Số lượng: "hai", "2", "một cặp" = 2; "chục" = 10. Không nói số lượng thì là 1. Đơn vị nói ra ("ly", "lon", "đĩa", "phần", "nồi", "cái", "suất") không làm đổi món.
- Một món có lựa chọn khác nhau thì tách thành nhiều dòng: "3 steak, 2 medium 1 well done" = 2 dòng (qty 2 Medium, qty 1 Well done).
- Size: "200", "hai trăm gam", "size nhỏ/lớn nhất" → variantId tương ứng. Món có size mà không nói size thì variantId = null.
- Lựa chọn và món thêm: đưa vào options với qty là số lượng cho MỖI phần (lựa chọn kiểu "chọn" luôn qty 1). "thêm 2 trứng" = option trứng qty 2. Nhóm bắt buộc mà khách không nói thì để trống, KHÔNG tự chọn hộ.
- "không trứng", "bỏ salad", "khỏi bánh mì" → removalIds (chỉ khi thành phần đó nằm trong danh sách "bỏ được" của món).
- Yêu cầu không có sẵn trong menu nhưng gắn với một món ("ít cay", "ra trước", "cắt nhỏ", "mang về") → note của món đó, ngắn gọn, tối đa 60 ký tự.
- Người nói sửa lại ("à không", "đổi thành", "thôi bỏ") thì chỉ giữ ý cuối cùng.
- Bỏ qua lời không phải gọi món: số bàn, lời chào, "cho anh", "em ơi", "vậy thôi".
- heard: trích đúng đoạn chữ mà bạn dựa vào cho dòng đó.
- Phần nào nghe được là gọi món nhưng không khớp được món nào trong MENU, hoặc không chắc là món nào, thì đưa đoạn chữ đó vào unmatched. Đừng đoán bừa.
- Món ghi HẾT vẫn trả về bình thường; màn hình sẽ báo hết.`

export const ORDER_SCHEMA = {
  type: 'object',
  properties: {
    lines: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          itemId: { type: 'string' },
          variantId: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          qty: { type: 'integer' },
          options: {
            type: 'array',
            items: {
              type: 'object',
              properties: { optionId: { type: 'string' }, qty: { type: 'integer' } },
              required: ['optionId', 'qty'],
              additionalProperties: false,
            },
          },
          removalIds: { type: 'array', items: { type: 'string' } },
          note: { type: 'string' },
          heard: { type: 'string' },
        },
        required: ['itemId', 'variantId', 'qty', 'options', 'removalIds', 'note', 'heard'],
        additionalProperties: false,
      },
    },
    unmatched: { type: 'array', items: { type: 'string' } },
  },
  required: ['lines', 'unmatched'],
  additionalProperties: false,
} as const

export interface VoiceLine {
  itemId: string
  variantId: string | null
  qty: number
  options: { optionId: string; qty: number }[]
  removalIds: string[]
  note: string
  heard: string
}

export interface VoiceResult {
  lines: VoiceLine[]
  unmatched: string[]
}

// ---------------------------------------------------------------- checking the answer

const int = (v: unknown, lo: number, hi: number, dflt: number) => {
  const n = Math.round(Number(v))
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt
}
const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')

/**
 * Keeps only ids that belong to the menu and to that item; a line for an unknown item goes to unmatched.
 * Quantities are clamped (1–99 portions, add-ons up to their maxQty), notes cut to 60 characters as in ItemPicker.
 */
export function normalize(raw: unknown, index: MenuIndex): VoiceResult {
  const r = (raw ?? {}) as { lines?: unknown; unmatched?: unknown }
  const unmatched = (Array.isArray(r.unmatched) ? r.unmatched : []).map(str).filter(Boolean)
  const lines: VoiceLine[] = []
  for (const l of Array.isArray(r.lines) ? r.lines : []) {
    const x = (l ?? {}) as Record<string, unknown>
    const entry = index.items.get(str(x.itemId))
    if (!entry) {
      const heard = str(x.heard)
      if (heard) unmatched.push(heard)
      continue
    }
    const variantId = entry.variants.has(str(x.variantId)) ? str(x.variantId) : null
    const options: VoiceLine['options'] = []
    for (const o of Array.isArray(x.options) ? x.options : []) {
      const id = str((o as Record<string, unknown>)?.optionId)
      const max = entry.options.get(id)
      if (max == null || options.some(p => p.optionId === id)) continue
      options.push({ optionId: id, qty: int((o as Record<string, unknown>).qty, 1, max, 1) })
    }
    const removalIds = [...new Set((Array.isArray(x.removalIds) ? x.removalIds : []).map(str).filter(id => entry.removals.has(id)))]
    lines.push({ itemId: str(x.itemId), variantId, qty: int(x.qty, 1, 99, 1), options, removalIds, note: str(x.note).slice(0, 60), heard: str(x.heard) })
  }
  return { lines, unmatched }
}

// ---------------------------------------------------------------- the call

export class VoiceParseError extends Error {
  readonly code: 'refusal' | 'too_long' | 'bad_output'
  constructor(code: VoiceParseError['code'], message: string) {
    super(message)
    this.code = code
  }
}

export interface ParseOutcome extends VoiceResult {
  usage: { input: number; output: number; cacheRead: number }
}

/** One Messages call. `menuText` comes from compactMenu; it sits in a cached system block, so repeat calls are cheaper. */
export async function parseOrder(
  client: Anthropic, menuText: string, index: MenuIndex, transcript: string, opts: { thinking?: boolean } = {},
): Promise<ParseOutcome> {
  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 4096,
    ...(opts.thinking === false ? { thinking: { type: 'disabled' as const } } : {}),
    system: [
      { type: 'text', text: RULES },
      { type: 'text', text: 'MENU:\n' + menuText, cache_control: { type: 'ephemeral' } },
    ],
    messages: [{ role: 'user', content: `Câu gọi món: «${transcript.slice(0, 1000)}»` }],
    output_config: { effort: 'low', format: { type: 'json_schema', schema: ORDER_SCHEMA as unknown as Record<string, unknown> } },
  })
  if (res.stop_reason === 'refusal') throw new VoiceParseError('refusal', 'AI từ chối xử lý câu này')
  if (res.stop_reason === 'max_tokens') throw new VoiceParseError('too_long', 'Câu gọi món quá dài, hãy nói từng phần')
  const text = res.content.flatMap(b => (b.type === 'text' ? [b.text] : [])).join('')
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new VoiceParseError('bad_output', 'AI trả về dữ liệu không đọc được')
  }
  return {
    ...normalize(raw, index),
    usage: { input: res.usage.input_tokens, output: res.usage.output_tokens, cacheRead: res.usage.cache_read_input_tokens ?? 0 },
  }
}
