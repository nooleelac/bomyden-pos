// Receipt blocks → a print-ready HTML page for an 80mm thermal printer, printed with window.print from a hidden
// iframe (the browser's print dialog; pick the receipt printer once and tick "Background graphics" off).
// 48 monospace characters fill the 72mm printable width: font-size 2.5mm × 0.6 advance × 48 = 72mm.

import QRCode from 'qrcode'
import type { Block } from './receipt'

/** QR code as an inline SVG (no network, prints sharp at any size). */
export function qrSvg(payload: string, label = 'Mã VietQR'): string {
  const qr = QRCode.create(payload, { errorCorrectionLevel: 'M' })
  const n = qr.modules.size
  const q = 4 // quiet zone
  let d = ''
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.modules.get(r, c)) d += `M${c + q} ${r + q}h1v1h-1z`
  const size = n + 2 * q
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges" role="img" aria-label="${label}"><rect width="${size}" height="${size}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

export const RECEIPT_CSS = `
@page { size: 80mm auto; margin: 0; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: #fff; color: #000; }
body { width: 80mm; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.r {
  width: 72mm; margin: 0 auto; padding: 2mm 0 8mm;
  font-family: 'Liberation Mono', 'Noto Sans Mono', Consolas, 'Courier New', 'DejaVu Sans Mono', monospace;
  font-size: 2.5mm; line-height: 1.3; font-variant-ligatures: none;
}
.l { white-space: pre; overflow: hidden; min-height: 1.3em; }
.b { font-weight: 700; }
.big { font-size: 5mm; line-height: 1.25; font-weight: 700; }
.qr { display: flex; justify-content: center; padding: 1.5mm 0; }
.qr svg { width: 36mm; height: 36mm; }
@media screen {
  body { width: auto; }
  .r { width: calc(48ch + 32px); padding: 16px; font-size: 13px; }
  .big { font-size: 26px; }
  .qr svg { width: 168px; height: 168px; }
}
`

export function receiptBody(blocks: Block[]): string {
  return blocks
    .map(b =>
      b.kind === 'qr'
        ? `<div class="qr">${qrSvg(b.payload)}</div>`
        : `<div class="l${b.bold ? ' b' : ''}${b.big ? ' big' : ''}">${esc(b.text.normalize('NFC'))}</div>`,
    )
    .join('\n')
}

export function receiptHtml(blocks: Block[], title = 'Hoá đơn'): string {
  return `<!doctype html><html lang="vi"><head><meta charset="utf-8"><title>${esc(title)}</title><style>${RECEIPT_CSS}</style></head><body><div class="r">${receiptBody(blocks)}</div></body></html>`
}

/** Print through a hidden iframe so the app screen stays as it is. Resolves once the dialog is done (or after 60 s). */
export function printHtml(html: string): Promise<void> {
  return new Promise(resolve => {
    const f = document.createElement('iframe')
    f.setAttribute('aria-hidden', 'true')
    f.tabIndex = -1
    Object.assign(f.style, { position: 'fixed', right: '0', bottom: '0', width: '0', height: '0', border: '0', opacity: '0', pointerEvents: 'none' })
    let done = false
    const finish = () => {
      if (done) return
      done = true
      setTimeout(() => f.remove(), 500)
      resolve()
    }
    f.onload = () => {
      const w = f.contentWindow
      if (!w) return finish()
      w.addEventListener('afterprint', finish)
      // let fonts and the QR svg lay out before the dialog opens
      setTimeout(() => {
        try {
          w.focus()
          w.print()
        } finally {
          setTimeout(finish, 60_000)
        }
      }, 50)
    }
    f.srcdoc = html
    document.body.appendChild(f)
  })
}

export function printBlocks(blocks: Block[], title?: string): Promise<void> {
  return printHtml(receiptHtml(blocks, title))
}
