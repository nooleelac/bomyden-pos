// Cài đặt → Giao diện: the colours of the staff screens (Sơ đồ bàn, Bếp, Thu ngân, Cài đặt, sign-in), one set per
// branch (branches.theme, 0035): every device of the branch takes it from my_branch() when someone signs in and on
// any change (realtime), and keeps the last one in localStorage so the next start and the sign-in screen are already
// in the branch's colours. Guest pages (QR gọi món, đặt hàng online) keep the default look.
//
// A theme is three colours the manager picks (màu chính, nền, thanh trên); every other token (chữ, chữ phụ, đường kẻ,
// thẻ, nền nhạt của cảnh báo…) is worked out from them so text always reads: body text ≥ 4.5:1 on the background and
// on cards, the accent ≥ 3:1 on cards (it is used for links and bold labels), text on accent buttons ≥ 4.5:1.
// The default theme injects nothing: the app looks exactly as menu.css draws it.

export type Hex = string

export interface Theme {
  /** a preset id, or 'tuy-chinh' once a colour was changed by hand */
  preset: string
  accent: Hex
  bg: Hex
  bar: Hex
  /** cards: tables, orders, kitchen tickets, settings boxes, buttons, inputs; missing = worked out from `bg` */
  card?: Hex
}

export interface Preset extends Theme {
  name: string
}

export const DEFAULT_PRESET = 'sang'
export const CUSTOM = 'tuy-chinh'

export const PRESETS: Preset[] = [
  { preset: 'sang', name: 'Sáng (mặc định)', accent: '#0a84ff', bg: '#eaeffc', bar: '#ffffff' },
  { preset: 'navy-trang', name: 'Navy, thẻ trắng', accent: '#0a84ff', bg: '#2e4460', bar: '#1b2438', card: '#ffffff' },
  { preset: 'navy', name: 'Tối navy', accent: '#19c37d', bg: '#2e4460', bar: '#1b2438' },
  { preset: 'xanh-la', name: 'Sáng xanh lá', accent: '#12a150', bg: '#eaf5ee', bar: '#ffffff' },
  { preset: 'nau-do', name: 'Nâu đỏ', accent: '#b3261e', bg: '#f6eee8', bar: '#3b2321' },
  { preset: 'dem', name: 'Đêm (đen)', accent: '#ff9f0a', bg: '#17191d', bar: '#0d0e10' },
]

export const defaultTheme = (): Theme => {
  const { preset, accent, bg, bar } = PRESETS[0]
  return { preset, accent, bg, bar }
}

export const isDefault = (t: Theme): boolean => t.preset === DEFAULT_PRESET

// ---------- colour maths (sRGB, WCAG 2 contrast) ----------

type RGB = [number, number, number]

export function parseHex(h: string): RGB | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(h.trim())
  if (!m) return null
  const s = m[1].length === 3 ? m[1].replace(/./g, c => c + c) : m[1]
  return [0, 2, 4].map(i => parseInt(s.slice(i, i + 2), 16)) as RGB
}

const toHex = (c: RGB): Hex => '#' + c.map(v => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('')

const rgb = (h: Hex): RGB => parseHex(h) ?? [0, 0, 0]

/** a·(1−t) + b·t */
export const mix = (a: Hex, b: Hex, t: number): Hex => {
  const x = rgb(a)
  const y = rgb(b)
  return toHex([0, 1, 2].map(i => x[i] + (y[i] - x[i]) * t) as RGB)
}

export function luminance(h: Hex): number {
  const [r, g, b] = rgb(h).map(v => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

export function contrast(a: Hex, b: Hex): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p)
  return (x + 0.05) / (y + 0.05)
}

export const isDark = (h: Hex): boolean => luminance(h) < 0.18

const WHITE = '#ffffff'
const BLACK = '#000000'

/** `fg` moved towards black or white (whichever side is away from every bg) until it reaches `ratio` on all of them. */
export function readable(fg: Hex, bgs: Hex[], ratio: number): Hex {
  const ok = (c: Hex) => bgs.every(b => contrast(c, b) >= ratio)
  if (ok(fg)) return fg
  const towards = bgs.some(isDark) && !bgs.every(isDark) ? null : isDark(bgs[0]) ? WHITE : BLACK
  const poles = towards ? [towards] : [WHITE, BLACK]
  let best = fg
  let bestScore = -1
  for (const pole of poles) {
    for (let t = 0.05; t <= 1.0001; t += 0.05) {
      const c = mix(fg, pole, t)
      if (ok(c)) return c
      const score = Math.min(...bgs.map(b => contrast(c, b)))
      if (score > bestScore) [best, bestScore] = [c, score]
    }
  }
  return best
}

/** White or near-black text, whichever reads better on `bg`. */
export const inkOn = (bg: Hex): Hex => (contrast(WHITE, bg) >= contrast('#111111', bg) ? WHITE : '#111111')

// ---------- theme → CSS variables ----------

/**
 * The colours of whatever sits on one background: the page itself, or a card. Text on the page and text in the cards
 * are worked out apart, so a navy page can have white cards (light headings on the page, dark text in the cards).
 */
export interface Palette {
  /** the background itself (after moving a mid-tone one until its text reads) */
  base: Hex
  /** a slightly different background inside it: chips, icon wells, hover rows, the "−" button */
  soft: Hex
  text: Hex
  muted: Hex
  line: Hex
  accent: Hex
  accentInk: Hex
  accentSoft: Hex
  slate: Hex
  danger: Hex
  dangerBg: Hex
  warn: Hex
  warnBg: Hex
  ok: Hex
  okBg: Hex
}

export interface Tokens {
  dark: boolean
  bg: Hex
  surface: Hex
  /** text and colours straight on the page background */
  page: Palette
  /** text and colours inside cards (tables, orders, tickets, boxes, buttons, inputs) */
  card: Palette
  bar: Hex
  barInk: Hex
  barMuted: Hex
  barAccent: Hex
  barLine: Hex
  /** the picked accent was darkened / lightened so it reads on the cards */
  accentAdjusted: boolean
  /** the picked background / card colour was moved so its text reads */
  bgAdjusted: boolean
  cardAdjusted: boolean
}

const LIGHT_TEXT = '#eef2f8'
const DARK_TEXT = '#2a3a5c'

/** `c` and the text colour for it; a mid-tone colour is moved away from that text until the text reads (4.5:1). */
function settle(c: Hex): [Hex, Hex] {
  const ink = contrast(LIGHT_TEXT, c) >= contrast(DARK_TEXT, c) ? LIGHT_TEXT : DARK_TEXT
  // 5.5 rather than 4.5: room for the soft colours inside it (chips, hover rows), which lean towards the text
  return [contrast(ink, c) < 5.5 ? readable(c, [ink], 5.5) : c, ink]
}

function palette(c: Hex, picked: Hex, soft?: Hex, linkRatio = 3): Palette {
  const [base, ink] = settle(c)
  const dark = isDark(base)
  let text = readable(ink, soft ? [base, soft] : [base], 7)
  // a given soft colour (the page) that the text cannot read on: work one out from the base instead
  if (soft && contrast(text, soft) < 4.5) {
    text = readable(ink, [base], 7)
    soft = undefined
  }
  soft ??= mix(base, text, dark ? 0.1 : 0.06)
  const muted = readable(mix(text, base, 0.45), [base, soft], 4.5)
  const line = mix(text, base, dark ? 0.78 : 0.84)
  // button text on the accent: whichever reads better; a mid-tone accent is moved (away from the background, so it
  // still reads as a link on it) until that text reaches 4.5:1
  let accent = readable(picked, [base], linkRatio)
  let accentInk = inkOn(accent)
  if (contrast(accentInk, accent) < 4.5) {
    accentInk = dark ? '#111111' : WHITE
    accent = readable(accent, [accentInk, base], 4.5)
  }
  // the selected tab / new-row tint: a touch of the accent, no more than the text still reads on
  let tint = dark ? 0.22 : 0.12
  while (tint > 0.02 && contrast(text, mix(base, accent, tint)) < 5) tint -= 0.02
  const accentSoft = mix(base, accent, tint)
  const slate = readable(mix(text, base, 0.25), [base, accentSoft], 4.5)
  const status = (s: Hex) => {
    const fg = readable(s, [base], 4.5)
    const bg = mix(base, s, dark ? 0.2 : 0.1)
    return [readable(fg, [bg], 4.5), bg] as const
  }
  const [danger, dangerBg] = status('#e5383b')
  const [warn, warnBg] = status('#b25e00')
  const [ok, okBg] = status('#1b7a43')
  return { base, soft, text, muted, line, accent, accentInk, accentSoft, slate, danger, dangerBg, warn, warnBg, ok, okBg }
}

const hexOr = (h: string | undefined, d: Hex): Hex => (h && parseHex(h) ? toHex(rgb(h)) : d)

export function tokens(t: Theme): Tokens {
  const picked = hexOr(t.accent, '#0a84ff')
  const pickedBg = hexOr(t.bg, '#eaeffc')
  const bg = settle(pickedBg)[0]
  const dark = isDark(bg)
  // cards: picked, or a step lighter than a dark background, near-white on a light one
  const pickedCard = t.card ? hexOr(t.card, '#ffffff') : dark ? mix(bg, WHITE, 0.07) : mix(bg, WHITE, 0.85)
  const surface = settle(pickedCard)[0]
  // on the page the accent is mostly small link text (cards carry the buttons): 4.5:1 there
  const page = palette(bg, picked, undefined, 4.5)
  // cards on a background of the same kind (both light or both dark) use the page as their "soft" colour, like the
  // default look (chips and icon wells in the page's pale blue)
  const card = palette(surface, picked, isDark(surface) === dark && contrast(bg, surface) < 3 ? bg : undefined)
  const [bar, barInk] = settle(hexOr(t.bar, surface))
  const barMuted = readable(mix(barInk, bar, 0.35), [bar], 4.5)
  const barAccent = contrast(card.accent, bar) >= 3 ? card.accent : readable(picked, [bar], 3)
  const barLine = mix(barInk, bar, 0.85)
  return {
    dark, bg, surface, page, card, bar, barInk, barMuted, barAccent, barLine,
    accentAdjusted: card.accent !== picked,
    bgAdjusted: bg !== pickedBg,
    cardAdjusted: !!t.card && surface !== pickedCard,
  }
}

/**
 * Everything drawn on the card colour (background: var(--surface) / var(--k-card) / var(--st-free) in the app's CSS).
 * Each of them gets the card palette, so text and the small colours inside it read on the card, whatever the page is.
 */
const CARDS = [
  'input', 'select', 'textarea', '.card', '.btn', '.icon-btn', '.tabs', '.save-bar', '.mic-btn', '.cat-rail', '.item-card', '.cart-bar', '.sheet',
  '.pin-key', '.auth-card', '.user-switch', '.audit-wrap', '.pay-row', '.bottom-nav', '.drawer', '.settings-back', '.floor-counts', '.area-rail',
  '.chip-sm', '.order-head', '.order-card', '.bell-panel', '.push-link', '.detail-head', '.detail-strip', '.bill-detail', '.qty-stepper button',
  '.detail-foot', '.btn-save', '.delivery-card', '.table-tile', '.reports-tabs', '.kpi', '.settings-card', '.bank-card', '.branch-card',
  '.feed-copy code', '.theme-preset', '.theme-tile', '.guest-calls', '.online-branch',
]
const KDS_CARDS = ['.ticket', '.kds-bar', '.kds-btn', '.kds-station']

const ROOTS = ['.menu-app.floor-app', '.menu-app.auth-app', '.approval-layer']
const KDS = '.floor-app .kds:not(.high-contrast)'

const vars = (p: Palette): string[][] => [
  ['--text', p.text], ['--muted', p.muted], ['--line', p.line],
  ['--accent', p.accent], ['--accent-ink', p.accentInk], ['--accent-soft', p.accentSoft],
  ['--on', p.accent], ['--on-ink', p.accentInk], ['--slate', p.slate], ['--slate-ink', inkOn(p.slate)],
  ['--danger', p.danger], ['--danger-bg', p.dangerBg], ['--warn', p.warn], ['--warn-bg', p.warnBg],
  ['--ok', p.ok], ['--ok-bg', p.okBg], ['--ok-fg', p.ok], ['--ok-line', mix(p.okBg, p.ok, 0.3)], ['--soft', p.soft],
]
const kdsVars = (p: Palette): string[][] => [
  ['--k-line', p.line], ['--k-text', p.text], ['--k-muted', p.muted], ['--k-soft', p.line],
  ['--k-note-bg', p.warnBg], ['--k-red-bg', p.dangerBg], ['--k-addon', readable('#0b7285', [p.base], 4.5)],
]

/** The CSS for a theme: staff app roots, the approval prompt and the kitchen display. Empty for the default theme. */
export function themeCss(t: Theme): string {
  if (isDefault(t)) return ''
  const k = tokens(t)
  const block = (sels: string[], v: string[][]) => `${sels.join(',\n')} {\n${v.map(([n, x]) => `  ${n}: ${x};`).join('\n')}\n}`
  const page = [
    ['color-scheme', k.dark ? 'dark' : 'light'],
    ['--bg', k.bg], ['--surface', k.surface], ['--st-free', k.surface], ['--st-closed', k.card.line],
    ['--bar', k.bar], ['--bar-ink', k.barInk], ['--bar-muted', k.barMuted], ['--bar-accent', k.barAccent], ['--bar-line', k.barLine],
    ...vars(k.page),
  ]
  // inside a card "--bg" is the card's own soft colour (chips, icon wells, hover rows sit on it)
  const card = [['color', k.card.text], ['--bg', k.card.soft], ...vars(k.card)]
  // the card rules weigh nothing (:where), so a card's own colour rules still win (a busy table tile keeps its
  // white text) while its text no longer inherits the page's
  const where = (outer: string[], inner: string[]) => [`:where(${outer.join(', ')}) :where(${inner.join(', ')})`]
  return [
    block(ROOTS, page),
    block(where(ROOTS, CARDS), card),
    // plain links inside a sentence: the accent of where they sit (the browser's own link blue / purple can be
    // unreadable on a dark page); any class that colours a link still wins
    block(where(ROOTS, ['a']), [['color', 'var(--accent)']]),
    block([KDS], [['--k-bg', k.bg], ['--k-card', k.surface], ...kdsVars(k.page)]),
    block(where([KDS], KDS_CARDS), [['color', k.card.text], ['--k-bg', k.card.soft], ...kdsVars(k.card)]),
    // buttons that are cards (table tiles, PIN keys…): the app's ".menu-app button { color: inherit }" would hand
    // them the page's text; same weight, later, so it wins, while ".table-tile.st-occupied" and the like still win
    // links that are cards (Cài đặt cards: "color: inherit") likewise; Thu ngân's "a.btn" inherits the shift strip's
    // colour on purpose in the default look, but here the strip is on the page and the button on a card
    block(
      [
        ...['.menu-app', '.approval-layer'].flatMap(r => [`${r} button:where(${CARDS.join(', ')})`, `${r} a:where(${CARDS.join(', ')})`]),
        '.menu-app.cashier-app a.btn',
      ],
      [['color', 'var(--text)']],
    ),
    block([`.kds button:where(${KDS_CARDS.join(', ')})`], [['color', 'var(--k-text)']]),
    `body:has(.floor-app), body:has(.auth-app) { background: ${k.bg}; }`,
  ].join('\n')
}

// ---------- the branch's theme, cached on this device ----------

const KEY = 'bmd-theme'
const STYLE_ID = 'bmd-theme'

/** A stored / received theme in its canonical shape (lower-case #rrggbb, like the server's check, 0035); null = not one. */
export function themeFrom(v: unknown): Theme | null {
  if (!v || typeof v !== 'object') return null
  const t = v as Record<string, unknown>
  const hex = (x: unknown) => (typeof x === 'string' && parseHex(x) ? toHex(rgb(x)) : null)
  const [accent, bg, bar] = [hex(t.accent), hex(t.bg), hex(t.bar)]
  const preset = typeof t.preset === 'string' && /^[a-z-]{1,20}$/.test(t.preset) ? t.preset : null
  if (!(accent && bg && bar && preset)) return null
  // card (0035, added later): optional; a bad value is dropped (cards then follow the background)
  const card = hex(t.card)
  return card ? { preset, accent, bg, bar, card } : { preset, accent, bg, bar }
}

export const same = (a: Theme, b: Theme): boolean => a.preset === b.preset && a.accent === b.accent && a.bg === b.bg && a.bar === b.bar && a.card === b.card

/** The last theme this device saw (the branch's, from my_branch); the default when none. */
export function loadTheme(): Theme {
  try {
    return themeFrom(JSON.parse(localStorage.getItem(KEY) ?? 'null')) ?? defaultTheme()
  } catch {
    return defaultTheme()
  }
}

/** Puts the theme on the page (a <style> at the end of <head>, after the app's own CSS). */
export function applyTheme(t: Theme): void {
  if (typeof document === 'undefined') return
  let el = document.getElementById(STYLE_ID) as HTMLStyleElement | null
  const css = themeCss(t)
  const meta = document.querySelector('meta[name="theme-color"]')
  if (meta) {
    if (!meta.hasAttribute('data-default')) meta.setAttribute('data-default', meta.getAttribute('content') ?? '')
    meta.setAttribute('content', css ? tokens(t).bar : meta.getAttribute('data-default') ?? '')
  }
  if (!css) {
    el?.remove()
    return
  }
  if (!el) {
    el = document.createElement('style')
    el.id = STYLE_ID
  }
  // always last, so equal-specificity rules of lazily loaded CSS do not win
  document.head.appendChild(el)
  el.textContent = css
}

const listeners = new Set<(t: Theme) => void>()

/**
 * Shows `t` on this device and remembers it (the branch's theme as the server last said, or as just saved on
 * Cài đặt → Giao diện), so the next start and the sign-in screen are already in it.
 */
export function keepTheme(t: Theme): void {
  const was = loadTheme()
  try {
    if (isDefault(t)) localStorage.removeItem(KEY)
    else localStorage.setItem(KEY, JSON.stringify(themeFrom(t)))
  } catch {
    // private mode / storage full: the theme still applies until the page reloads
  }
  applyTheme(t)
  if (!same(was, t)) listeners.forEach(f => f(t))
}

export function onThemeChange(f: (t: Theme) => void): () => void {
  listeners.add(f)
  return () => listeners.delete(f)
}

/** At start-up: the saved theme, and the same theme in every tab of this browser. */
export function initTheme(): void {
  applyTheme(loadTheme())
  if (typeof window === 'undefined') return
  window.addEventListener('storage', e => {
    if (e.key !== KEY && e.key !== null) return
    const t = loadTheme()
    applyTheme(t)
    listeners.forEach(f => f(t))
  })
}
