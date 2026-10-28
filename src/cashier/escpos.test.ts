import { describe, expect, it } from 'vitest'
import { encodeRaster, threshold } from './escpos'
import { DEFAULT_PRINT, getPrintSettings, setPrintSettings } from './paper'

describe('ESC/POS raster', () => {
  it('turns dark pixels into set bits, leftmost dot first', () => {
    // 10×1: black, white, black, then white…, last pixel black
    const px = new Uint8ClampedArray(10 * 4).fill(255)
    for (const x of [0, 2, 9]) px.set([0, 0, 0, 255], x * 4)
    const r = threshold(px, 10, 1)
    expect(r.widthBytes).toBe(2)
    expect([...r.bits]).toEqual([0b10100000, 0b01000000])
    // transparent counts as paper
    expect([...threshold(new Uint8ClampedArray(8 * 4), 8, 1).bits]).toEqual([0])
  })

  it('initialises, sends the picture in bands of 128 rows, feeds and cuts', () => {
    const r = { widthBytes: 48, height: 300, bits: new Uint8Array(48 * 300).fill(0xaa) }
    const out = encodeRaster(r, { feedMm: 40 })
    expect([...out.slice(0, 2)]).toEqual([0x1b, 0x40])
    const heads: number[] = []
    for (let i = 0; i < out.length - 8; i++) if (out[i] === 0x1d && out[i + 1] === 0x76 && out[i + 2] === 0x30) heads.push(out[i + 6] | (out[i + 7] << 8))
    expect(heads).toEqual([128, 128, 44])
    expect([...out.slice(2, 10)]).toEqual([0x1d, 0x76, 0x30, 0, 48, 0, 128, 0])
    // 40mm = 320 dots: ESC J 255 + ESC J 65, then the cut
    expect([...out.slice(-10)]).toEqual([0x1b, 0x4a, 255, 0x1b, 0x4a, 65, 0x1d, 0x56, 0x42, 0x00])
    expect(out.length).toBe(2 + 3 * 8 + 48 * 300 + 6 + 4)
  })
})

describe('printer of this device', () => {
  it('keeps a valid Bluetooth or WiFi printer and drops anything else', () => {
    try {
      setPrintSettings({ target: { kind: 'network', agentId: 'a1', agentName: 'Quầy', host: '192.168.1.50', port: 9100, name: 'Máy in bếp' } })
      expect(getPrintSettings().target).toMatchObject({ kind: 'network', host: '192.168.1.50', port: 9100 })
      setPrintSettings({ target: { kind: 'bluetooth', id: 'abc==', name: '' } })
      expect(getPrintSettings().target).toEqual({ kind: 'bluetooth', id: 'abc==', name: 'Máy in Bluetooth' })
      setPrintSettings({ target: { kind: 'network', agentId: 'a1', host: '' } as never })
      expect(getPrintSettings().target).toEqual({ kind: 'dialog' })
    } finally {
      setPrintSettings(DEFAULT_PRINT)
    }
  })
})
