// Direct printing (Bluetooth, WiFi/LAN): the receipt drawn as a 1-bit picture at the printer's own resolution
// (8 dots/mm: 384 dots across 48mm on 58mm paper, 576 across 72mm on 80mm) and sent as ESC/POS raster commands.
// A picture prints Vietnamese the same on every printer (their built-in fonts lack the accents) and comes out sharp:
// black or white per dot, no browser scaling or grey smoothing.

import QRCode from 'qrcode'
import { printSpec, type PrintSettings } from './paper'
import type { Block } from './receipt'

export const DOTS_PER_MM = 8

/** 1 bit per dot, rows of `widthBytes` bytes, most significant bit = leftmost dot, 1 = black. */
export interface Raster {
  widthBytes: number
  height: number
  bits: Uint8Array
}

/** Rows per GS v 0 command: some printers drop larger images. */
const BAND = 128

/** ESC @, the picture in bands (GS v 0), blank paper, then a cut (printers without a cutter ignore it). */
export function encodeRaster(r: Raster, opts: { feedMm: number; cut?: boolean }): Uint8Array {
  const out: number[] = [0x1b, 0x40]
  for (let y = 0; y < r.height; y += BAND) {
    const h = Math.min(BAND, r.height - y)
    out.push(0x1d, 0x76, 0x30, 0x00, r.widthBytes & 0xff, r.widthBytes >> 8, h & 0xff, h >> 8)
    const band = r.bits.subarray(y * r.widthBytes, (y + h) * r.widthBytes)
    for (let i = 0; i < band.length; i++) out.push(band[i])
  }
  // ESC J n feeds n dots (at most 255 at a time)
  let feed = Math.round(opts.feedMm * DOTS_PER_MM)
  while (feed > 0) {
    const n = Math.min(255, feed)
    out.push(0x1b, 0x4a, n)
    feed -= n
  }
  if (opts.cut !== false) out.push(0x1d, 0x56, 0x42, 0x00)
  return Uint8Array.from(out)
}

/** Grey/colour pixels (RGBA) to 1-bit: darker than `threshold` prints black. */
export function threshold(rgba: Uint8ClampedArray, width: number, height: number, level = 160): Raster {
  const widthBytes = Math.ceil(width / 8)
  const bits = new Uint8Array(widthBytes * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      const a = rgba[i + 3] / 255
      const lum = 255 - a * (255 - (0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2]))
      if (lum < level) bits[y * widthBytes + (x >> 3)] |= 0x80 >> (x & 7)
    }
  }
  return { widthBytes, height, bits }
}

const FONT = '"Noto Sans Mono", "Roboto Mono", "Liberation Mono", Consolas, "DejaVu Sans Mono", "Courier New", monospace'

/**
 * Draws the blocks on a canvas the width of the printable area: every character in its own cell of the monospace
 * grid (so columns line up whatever font the device has), QR codes with whole-dot modules. Browser only.
 */
export function renderRaster(blocks: Block[], settings: PrintSettings): Raster {
  const spec = printSpec(settings)
  const width = spec.printMm * DOTS_PER_MM
  const cell = width / spec.cols
  const base = cell / 0.6
  const pad = Math.round(2 * DOTS_PER_MM)

  type Row = { h: number; draw: (ctx: CanvasRenderingContext2D, y: number) => void }
  const rows: Row[] = blocks.map((b): Row => {
    if (b.kind === 'qr') {
      const qr = QRCode.create(b.payload, { errorCorrectionLevel: 'M' })
      const n = qr.modules.size
      const m = Math.max(2, Math.floor((36 * DOTS_PER_MM) / (n + 8)))
      const side = m * (n + 8)
      return {
        h: side + 2 * DOTS_PER_MM,
        draw: (ctx, y) => {
          const x0 = Math.round((width - side) / 2) + 4 * m
          const y0 = y + DOTS_PER_MM + 4 * m
          for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.modules.get(r, c)) ctx.fillRect(x0 + c * m, y0 + r * m, m, m)
        },
      }
    }
    const size = b.size ?? (b.big ? 2 : 1)
    const bold = settings.bold || b.bold || (b.big && b.bold !== false)
    const px = base * size
    return {
      h: Math.ceil(px * (size > 1 ? 1.2 : 1.3)),
      draw: (ctx, y) => {
        ctx.font = `${bold ? 700 : 400} ${px}px ${FONT}`
        const step = cell * size
        ;[...b.text.normalize('NFC')].forEach((ch, i) => {
          if (ch !== ' ') ctx.fillText(ch, i * step + (step - ctx.measureText(ch).width) / 2, y + px * (size > 1 ? 0.95 : 1.0))
        })
      },
    }
  })

  const height = pad + rows.reduce((s, r) => s + r.h, 0)
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, width, height)
  ctx.fillStyle = '#000'
  ctx.textBaseline = 'alphabetic'
  let y = pad
  for (const r of rows) {
    r.draw(ctx, y)
    y += r.h
  }
  return threshold(ctx.getImageData(0, 0, width, height).data, width, height)
}

/** The ESC/POS bytes for these blocks with this device's paper, size, bold and blank paper. */
export function escposReceipt(blocks: Block[], settings: PrintSettings): Uint8Array {
  return encodeRaster(renderRaster(blocks, settings), { feedMm: settings.feedMm })
}
