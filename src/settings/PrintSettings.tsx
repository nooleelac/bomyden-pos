// #/cai-dat/may-in: this device's receipt printer — how it connects (PrinterConnect), paper width, text size, bold, blank paper after the bill — with a
// live preview and a test print. Saved in this browser as soon as it changes (paper.ts); every receipt follows it.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { SettingsBack, TopBar } from '../auth/chrome'
import { SAMPLE_SHOP } from '../cashier/config'
import { DEFAULT_PRINT, FEED_MAX, PAPERS, TEXT_SIZES, printSpec, setPrintSettings, usePrintSettings, type PrintSettings } from '../cashier/paper'
import { printBlocks } from '../cashier/print'
import { bigCols, center, cols, type Block } from '../cashier/receipt'
import { ReceiptPreview } from '../cashier/screens/ui'
import '../cashier/cashier.css'
import { errText, useSource } from '../floor/hooks'
import type { FloorRepo } from '../floor/repo'
import type { FloorState, ShopProfile } from '../floor/types'
import { Section, Switch } from '../menu/ui'
import { PrinterConnect } from './PrinterConnect'
import { sampleReceipt } from './sampleReceipt'

/** Ruler that fills one line (shows whether a full line fits the paper), then a sample bill with a QR. */
function testPrintBlocks(shop: ShopProfile, s: PrintSettings, at: string): Block[] {
  const n = cols()
  const ruler = Array.from({ length: n }, (_, i) => String((i + 1) % 10)).join('')
  const head: Block[] = [
    ...center('IN THỬ', bigCols()).map(text => ({ kind: 'text' as const, text, big: true, bold: true })),
    ...center(`Khổ ${s.paper}mm · ${n} ký tự/dòng`).map(text => ({ kind: 'text' as const, text })),
    { kind: 'text', text: ruler },
    { kind: 'text', text: '' },
  ]
  return [...head, ...sampleReceipt(shop, 'bill', at)]
}

export function PrintSettingsPage(props: { repo: FloorRepo }) {
  const [toast, setToast] = useState<{ text: string; ok?: boolean } | null>(null)
  const onError = useCallback((m: string) => setToast({ text: m }), [])
  const onInfo = useCallback((m: string) => setToast({ text: m, ok: true }), [])
  const [printing, setPrinting] = useState(false)
  const floor = useSource<FloorState>(props.repo, onError)
  const s = usePrintSettings()
  const spec = printSpec(s)
  const shop = floor?.shop ?? SAMPLE_SHOP
  const blocks = useMemo(() => testPrintBlocks(shop, s, new Date().toISOString()), [shop, s])
  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 5000)
    return () => clearTimeout(t)
  }, [toast])
  // the printer itself stays: Khôi phục mặc định is about paper and text
  const isDefault = JSON.stringify({ ...s, target: DEFAULT_PRINT.target }) === JSON.stringify(DEFAULT_PRINT)
  const testPrint = () => {
    setPrinting(true)
    printBlocks(blocks, 'In thử')
      .then(() => s.target.kind !== 'dialog' && onInfo('Đã gửi lệnh in thử'), e => onError(errText(e)))
      .finally(() => setPrinting(false))
  }

  return (
    <div className="menu-app floor-app">
      <TopBar />
      <SettingsBack />
      <main className="settings-main">
        <section className="screen print-settings">
          <h1>Cài đặt máy in</h1>
          <p className="muted">Lưu riêng trên máy này (mỗi quầy một máy in). Đổi xong là áp dụng ngay cho hoá đơn, phiếu tạm tính và báo cáo ca.</p>

          <div className="print-settings-cols">
            <div>
              <PrinterConnect onError={onError} onInfo={onInfo} />

              <Section title="Giấy và chữ">
                <fieldset className="pick-group">
                  <legend className="field-label">Khổ giấy</legend>
                  <div className="chip-row">
                    {PAPERS.map(p => (
                      <button key={p} type="button" className={'chip' + (s.paper === p ? ' is-on' : '')} aria-pressed={s.paper === p} onClick={() => setPrintSettings({ paper: p })}>
                        {p}mm
                      </button>
                    ))}
                  </div>
                  <span className="field-hint">Đúng bằng cuộn giấy trong máy in. Chọn sai khổ, máy in sẽ thu nhỏ bill làm chữ bé và mờ.</span>
                </fieldset>

                <fieldset className="pick-group">
                  <legend className="field-label">Cỡ chữ</legend>
                  <div className="chip-row">
                    {TEXT_SIZES.map(z => (
                      <button key={z.id} type="button" className={'chip' + (s.size === z.id ? ' is-on' : '')} aria-pressed={s.size === z.id} onClick={() => setPrintSettings({ size: z.id })}>
                        {z.label} · {printSpec({ ...s, size: z.id }).cols} ký tự/dòng
                      </button>
                    ))}
                  </div>
                  <span className="field-hint">Chữ càng lớn, mỗi dòng càng ít chữ; tên món dài sẽ xuống dòng.</span>
                </fieldset>

                <Switch checked={s.bold} onChange={bold => setPrintSettings({ bold })} label="In đậm toàn bộ chữ (rõ hơn trên giấy in nhiệt)" />

                <label className="field">
                  <span className="field-label">Khoảng trống cuối bill</span>
                  <span className="input-unit">
                    <input
                      type="number"
                      inputMode="numeric"
                      min={0}
                      max={FEED_MAX}
                      value={s.feedMm}
                      onChange={e => setPrintSettings({ feedMm: Number(e.target.value) })}
                    />
                    <span>mm</span>
                  </span>
                  <span className="field-hint">Giấy trắng sau dòng cuối để xé không mất chữ (0–{FEED_MAX}mm).</span>
                </label>
              </Section>

              <div className="pay-settings-actions">
                <button type="button" className="btn" disabled={isDefault} onClick={() => setPrintSettings({ ...DEFAULT_PRINT, target: s.target })}>
                  Khôi phục mặc định
                </button>
                <button type="button" className="btn btn-primary" disabled={printing} onClick={testPrint}>
                  {printing ? 'Đang in…' : '🖨 In thử'}
                </button>
              </div>

              <p className="muted small">Muốn đổi chữ hoặc cỡ chữ từng phần trên bill (tên quán, tiêu đề, lời cảm ơn…)? Vào <a href="#/cai-dat/mau-in">Cài đặt → Mẫu in</a>.</p>

              {s.target.kind === 'dialog' && (
              <Section title="Hộp thoại in của trình duyệt">
                <ol className="print-steps">
                  <li>
                    <b>Máy in đích</b>: chọn máy in nhiệt (không chọn “Lưu dưới dạng PDF”).
                  </li>
                  <li>
                    <b>Khổ giấy</b> (Cài đặt khác → Khổ giấy): {spec.mm}mm, đúng cuộn giấy.
                  </li>
                  <li>
                    <b>Lề</b>: Không. <b>Tỉ lệ</b>: Mặc định / 100% — không chọn “Vừa với trang”.
                  </li>
                  <li>Bỏ chọn <b>Đầu trang và chân trang</b>.</li>
                </ol>
                <p className="muted small">
                  Vẫn mờ? Mở Windows → Máy in → Tuỳ chọn in (Printing Preferences) của máy in nhiệt, tăng <b>độ đậm</b> (Density / Darkness) và chọn đúng khổ giấy.
                  Giấy in nhiệt cũ hoặc để nơi nóng cũng in nhạt.
                </p>
              </Section>
              )}
            </div>

            <section aria-label="Xem trước bản in thử">
              <h2 className="sub-h">Xem trước</h2>
              <ReceiptPreview blocks={blocks} title="In thử" picker={false} />
            </section>
          </div>
        </section>
      </main>
      {toast && (
        <div className={'toast' + (toast.ok ? ' toast-ok' : '')} role={toast.ok ? 'status' : 'alert'} onClick={() => setToast(null)}>
          {toast.text}
        </div>
      )}
    </div>
  )
}
