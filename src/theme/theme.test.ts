import { describe, expect, it } from 'vitest'
import { contrast, CUSTOM, defaultTheme, PRESETS, themeCss, themeFrom, tokens, type Palette, type Theme } from './theme'

const paletteReads = (p: Palette) => {
  expect(contrast(p.text, p.base)).toBeGreaterThanOrEqual(4.5)
  expect(contrast(p.text, p.soft)).toBeGreaterThanOrEqual(4.5)
  expect(contrast(p.muted, p.base)).toBeGreaterThanOrEqual(4.5)
  expect(contrast(p.muted, p.soft)).toBeGreaterThanOrEqual(4.5)
  expect(contrast(p.accent, p.base)).toBeGreaterThanOrEqual(3)
  expect(contrast(p.accentInk, p.accent)).toBeGreaterThanOrEqual(4.5)
  expect(contrast(p.slate, p.base)).toBeGreaterThanOrEqual(4.5)
  for (const [fg, bg] of [[p.danger, p.dangerBg], [p.warn, p.warnBg], [p.ok, p.okBg], [p.danger, p.base], [p.warn, p.base]])
    expect(contrast(fg, bg)).toBeGreaterThanOrEqual(4.5)
}

const reads = (t: Theme) => {
  const k = tokens(t)
  expect(k.page.base).toBe(k.bg)
  expect(k.card.base).toBe(k.surface)
  paletteReads(k.page)
  expect(contrast(k.page.accent, k.bg)).toBeGreaterThanOrEqual(4.5)
  paletteReads(k.card)
  expect(contrast(k.barInk, k.bar)).toBeGreaterThanOrEqual(4.5)
  expect(contrast(k.barMuted, k.bar)).toBeGreaterThanOrEqual(4.5)
  expect(contrast(k.barAccent, k.bar)).toBeGreaterThanOrEqual(3)
}

describe('theme', () => {
  it('the default theme adds no CSS (the app keeps its own look)', () => {
    expect(themeCss(defaultTheme())).toBe('')
  })

  it.each(PRESETS.map(p => [p.name, p] as const))('preset %s reads everywhere', (_, p) => reads(p))

  it('any hand-picked colours still read (page, cards, accent, bar)', () => {
    const colours = ['#ffffff', '#000000', '#777777', '#808080', '#ffff00', '#00ffff', '#ff0000', '#19c37d', '#2e4460', '#f5f5dc', '#5a5a5a', '#0000ff', '#9aa0a6']
    for (const bg of colours) for (const accent of colours) for (const card of [undefined, '#ffffff', '#2e4460', '#888888', '#fff3c4']) for (const bar of ['#ffffff', '#1b2438', '#888888'])
      reads({ preset: CUSTOM, accent, bg, bar, card })
  })

  it('a navy page with white cards: light text on the page, dark text in the cards', () => {
    const t: Theme = { preset: 'navy-trang', accent: '#0a84ff', bg: '#2e4460', bar: '#1b2438', card: '#ffffff' }
    const k = tokens(t)
    expect(k.surface).toBe('#ffffff')
    expect(contrast(k.page.text, '#ffffff')).toBeLessThan(2)
    expect(contrast(k.card.text, '#000000')).toBeLessThan(3)
    const css = themeCss(t)
    expect(css).toContain(':where(.menu-app.floor-app, .menu-app.auth-app, .approval-layer) :where(input, select')
    expect(css).toContain('.table-tile')
    expect(css).toContain(`color: ${k.card.text};`)
  })

  it('a dark background gets dark cards and light text', () => {
    const k = tokens({ preset: 'navy', accent: '#19c37d', bg: '#2e4460', bar: '#1b2438' })
    expect(k.dark).toBe(true)
    expect(contrast(k.surface, '#000000')).toBeLessThan(contrast(k.card.text, '#000000'))
    expect(themeCss({ preset: 'navy', accent: '#19c37d', bg: '#2e4460', bar: '#1b2438' })).toContain('color-scheme: dark')
  })

  it('cards like the page (both light) keep the page colour as their soft colour, like the default look', () => {
    const k = tokens({ preset: 'xanh-la', accent: '#12a150', bg: '#eaf5ee', bar: '#ffffff' })
    expect(k.card.soft).toBe(k.bg)
  })
})

describe('themeFrom', () => {
  it('keeps a well-formed theme in lower-case #rrggbb and drops anything else', () => {
    expect(themeFrom({ preset: 'tuy-chinh', accent: '#ABC', bg: '#2E4460', bar: '#000000' })).toEqual({ preset: 'tuy-chinh', accent: '#aabbcc', bg: '#2e4460', bar: '#000000' })
    expect(themeFrom({ preset: 'navy-trang', accent: '#0a84ff', bg: '#2e4460', bar: '#1b2438', card: '#FFF' })?.card).toBe('#ffffff')
    expect(themeFrom({ preset: 'navy', accent: '#0a84ff', bg: '#2e4460', bar: '#1b2438', card: 'white' })).not.toHaveProperty('card')
    expect(themeFrom(null)).toBeNull()
    expect(themeFrom({ preset: 'x', accent: 'red', bg: '#fff', bar: '#fff' })).toBeNull()
    expect(themeFrom({ preset: 'DROP TABLE', accent: '#fff', bg: '#fff', bar: '#fff' })).toBeNull()
  })
})
