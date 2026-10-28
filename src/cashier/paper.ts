// How this device prints receipts (Cài đặt → Máy in): which printer (browser print dialog, Bluetooth, WiFi/LAN through
// the shop's bridge), paper width, text size, bold, blank paper after the last line.
// Kept in this browser: each till has its own printer. Printing an 80mm layout on a 58mm printer makes the driver
// shrink it to ~70%, so the text comes out tiny and blurred.

import { useSyncExternalStore } from 'react'

export type Paper = 58 | 80
export const PAPERS: Paper[] = [80, 58]

export type TextSize = 's' | 'm' | 'l'
export const TEXT_SIZES: { id: TextSize; label: string }[] = [
  { id: 's', label: 'Nhỏ' },
  { id: 'm', label: 'Vừa' },
  { id: 'l', label: 'Lớn' },
]

/**
 * Where receipts go. dialog: the browser's print dialog (printers installed on the device). bluetooth: straight to a
 * Bluetooth printer this browser was allowed to use (printers/bluetooth.ts). network: a WiFi/LAN printer reached by the
 * bridge app on a shop computer (printers/network.ts, migration 0018).
 */
export type PrintTarget =
  | { kind: 'dialog' }
  | { kind: 'bluetooth'; id: string; name: string }
  | { kind: 'network'; agentId: string; agentName: string; host: string; port: number; name: string }

export interface PrintSettings {
  target: PrintTarget
  paper: Paper
  size: TextSize
  /** Every line bold: thin strokes come out faint and broken on thermal paper. */
  bold: boolean
  /** Blank paper after the last line, so the tear bar does not cut it. */
  feedMm: number
}

export const DEFAULT_PRINT: PrintSettings = { target: { kind: 'dialog' }, paper: 80, size: 's', bold: true, feedMm: 8 }
export const FEED_MAX = 30

const KEY = 'bmd-print'
/** Before Cài đặt → Máy in only the paper was kept ('58' / '80'); 58mm printed one size up. */
const OLD_KEY = 'bmd-receipt-paper'

const str = (v: unknown, max = 100) => (typeof v === 'string' ? v.slice(0, max) : '')

function cleanTarget(v: unknown): PrintTarget {
  const t = (typeof v === 'object' && v ? v : {}) as Record<string, unknown>
  if (t.kind === 'bluetooth' && str(t.id)) return { kind: 'bluetooth', id: str(t.id), name: str(t.name) || 'Máy in Bluetooth' }
  if (t.kind === 'network' && str(t.agentId) && str(t.host)) {
    const port = Number(t.port)
    return { kind: 'network', agentId: str(t.agentId), agentName: str(t.agentName), host: str(t.host), port: Number.isInteger(port) && port > 0 && port < 65536 ? port : 9100, name: str(t.name) || str(t.host) }
  }
  return { kind: 'dialog' }
}

function clean(v: Partial<PrintSettings>): PrintSettings {
  return {
    target: cleanTarget(v.target),
    paper: v.paper === 58 ? 58 : 80,
    size: v.size === 'm' || v.size === 'l' ? v.size : 's',
    bold: v.bold ?? DEFAULT_PRINT.bold,
    feedMm: Math.max(0, Math.min(FEED_MAX, Math.round(Number(v.feedMm ?? DEFAULT_PRINT.feedMm)) || 0)),
  }
}

function load(): PrintSettings {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) return clean(JSON.parse(raw))
    if (localStorage.getItem(OLD_KEY) === '58') return { ...DEFAULT_PRINT, paper: 58, size: 'm' }
  } catch {
    // no storage or bad JSON: defaults
  }
  return DEFAULT_PRINT
}

let current: PrintSettings = load()
const subs = new Set<() => void>()

export const getPrintSettings = (): PrintSettings => current

export function setPrintSettings(patch: Partial<PrintSettings>) {
  current = clean({ ...current, ...patch })
  try {
    localStorage.setItem(KEY, JSON.stringify(current))
  } catch {
    // private window: the choice lasts until reload
  }
  subs.forEach(f => f())
}

function subscribe(f: () => void) {
  subs.add(f)
  return () => subs.delete(f)
}

/** Current settings; re-renders the component when they change (lay the receipt out again). */
export const usePrintSettings = (): PrintSettings => useSyncExternalStore(subscribe, getPrintSettings)

/** Characters per line by paper and text size: 48 / 42 / 36 on 80mm (Font A is 48), 32 / 28 / 24 on 58mm. */
const COLS: Record<Paper, Record<TextSize, number>> = { 80: { s: 48, m: 42, l: 36 }, 58: { s: 32, m: 28, l: 24 } }

/**
 * Page width, printable width, characters per line and font size (mm). The monospace grid fills the printable width:
 * font × 0.6 advance × cols = printable width (72mm on 80mm paper, 48mm on 58mm).
 */
export function printSpec(s: PrintSettings = current) {
  const printMm = s.paper === 58 ? 48 : 72
  const cols = COLS[s.paper][s.size]
  return { mm: s.paper, printMm, cols, fontMm: Math.round((printMm / cols / 0.6) * 100) / 100, bold: s.bold, feedMm: s.feedMm }
}
