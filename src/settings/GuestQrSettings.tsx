// #/cai-dat/ma-qr: one QR sticker per table for khách tự gọi món (0023). Opening the page gives every table without a
// token one (tables.edit); In tất cả prints A4 sheets of stickers; Đổi mã replaces one table's token, so a photo of
// the old sticker stops working. settings.edit turns guest ordering on or off for the branch.

import { useEffect, useMemo, useRef, useState } from 'react'
import { useAuth } from '../auth/context'
import { roleCan } from '../auth/permissions'
import { qrSvg } from '../cashier/print'
import { errText } from '../floor/hooks'
import type { FloorRepo } from '../floor/repo'
import type { FloorState, Table } from '../floor/types'
import { Section, Switch } from '../menu/ui'

/** The link a table's QR opens: this app's address with #/goi/<token>. */
function guestLink(token: string): string {
  return `${location.origin}${location.pathname}#/goi/${token}`
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** A4 sheets, 3 × 4 stickers each (about 6 × 7 cm), printed from a hidden frame. */
function printStickers(shop: string, tables: Table[]) {
  const cards = tables
    .map(t => `<div class="c"><b class="s">${esc(shop)}</b>${qrSvg(guestLink(t.qrToken!), `Mã QR bàn ${esc(t.name)}`)}<b class="t">Bàn ${esc(t.name)}</b><span>Quét mã để xem thực đơn và gọi món</span></div>`)
    .join('')
  const html = `<!doctype html><html lang="vi"><head><meta charset="utf-8"><title>Mã QR gọi món</title><style>
@page { size: A4; margin: 10mm; }
* { box-sizing: border-box; }
body { margin: 0; font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; color: #000; }
.g { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6mm; }
.c { border: 0.4mm dashed #999; border-radius: 3mm; padding: 4mm; text-align: center; break-inside: avoid; display: flex; flex-direction: column; align-items: center; gap: 1.5mm; }
.c svg { width: 42mm; height: 42mm; }
.s { font-size: 3.6mm; }
.t { font-size: 7mm; }
.c span { font-size: 3mm; }
</style></head><body><div class="g">${cards}</div></body></html>`
  const frame = document.createElement('iframe')
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0'
  document.body.appendChild(frame)
  const doc = frame.contentDocument!
  doc.open()
  doc.write(html)
  doc.close()
  setTimeout(() => {
    frame.contentWindow?.focus()
    frame.contentWindow?.print()
    setTimeout(() => frame.remove(), 60_000)
  }, 300)
}

export function GuestQrSettings(props: { floor: FloorState; repo: FloorRepo; onError: (m: string) => void; onInfo: (m: string) => void }) {
  const { floor, repo } = props
  const { session } = useAuth()
  const canTables = roleCan(session.role, 'tables.edit')
  const canSettings = roleCan(session.role, 'settings.edit')
  const on = floor.settings.guestOrder !== false
  const tables = useMemo(
    () =>
      floor.tables
        .filter(t => t.active && !t.temporary)
        .sort((a, b) => (floor.areas.find(x => x.id === a.areaId)?.sort ?? 0) - (floor.areas.find(x => x.id === b.areaId)?.sort ?? 0) || a.sort - b.sort),
    [floor.tables, floor.areas],
  )
  const missing = tables.filter(t => !t.qrToken).length
  const [busy, setBusy] = useState(false)
  const asked = useRef(false)
  const fail = (e: unknown) => props.onError(errText(e))

  // the first visit gives every table its token
  useEffect(() => {
    if (!missing || !canTables || asked.current) return
    asked.current = true
    repo.tableQrTokens(null).catch(fail)
  })

  const renew = (t: Table) => {
    if (!confirm(`Đổi mã QR bàn ${t.name}? Tem đang dán sẽ không dùng được nữa, phải in tem mới.`)) return
    setBusy(true)
    repo
      .tableQrTokens(t.id)
      .then(() => props.onInfo(`Đã đổi mã bàn ${t.name}: in lại tem bàn này`), fail)
      .finally(() => setBusy(false))
  }
  const ready = tables.filter(t => t.qrToken)
  const copy = (t: Table) =>
    navigator.clipboard?.writeText(guestLink(t.qrToken!)).then(() => props.onInfo(`Đã chép link bàn ${t.name}`), () => props.onError('Không chép được: giữ vào link để chép'))

  return (
    <>
      <h1>Mã QR gọi món</h1>
      <Section title="Khách tự gọi món">
        <Switch
          checked={on}
          disabled={!canSettings}
          label={on ? 'Đang bật: khách quét mã trên bàn để xem thực đơn và gửi món' : 'Đang tắt: quét mã chỉ thấy lời mời gọi nhân viên'}
          onChange={v => repo.setGuestOrder(v).then(() => props.onInfo(v ? 'Đã bật gọi món qua QR' : 'Đã tắt gọi món qua QR'), fail)}
        />
        <p className="muted small">
          Món khách gửi hiện ở Sơ đồ bàn (🙋) và chuông thông báo. Chỉ khi nhân viên bấm <b>Nhận &amp; gửi bếp</b> món mới vào bếp, giá theo thực đơn lúc nhận.
        </p>
      </Section>

      <Section
        title={`Tem dán bàn (${ready.length}/${tables.length})`}
        aside={
          <button type="button" className="btn btn-primary btn-small" disabled={!ready.length} onClick={() => printStickers(floor.shop.name, ready)}>
            🖨 In tất cả
          </button>
        }
      >
        {missing > 0 && <p className="warn">{canTables ? `Đang tạo mã cho ${missing} bàn…` : `${missing} bàn chưa có mã: cần người có quyền Sửa khu vực và bàn mở trang này.`}</p>}
        <p className="muted small">In ra giấy A4 (12 tem một trang), cắt theo đường viền, dán lên bàn. Bàn tạm không có tem.</p>
        <ul className="qr-grid">
          {ready.map(t => (
            <li key={t.id} className="qr-card">
              <div className="qr-img" dangerouslySetInnerHTML={{ __html: qrSvg(guestLink(t.qrToken!), `Mã QR bàn ${t.name}`) }} />
              <b>Bàn {t.name}</b>
              <span className="muted small">{floor.areas.find(a => a.id === t.areaId)?.name}</span>
              <div className="btn-pair">
                <button type="button" className="btn btn-small" onClick={() => printStickers(floor.shop.name, [t])}>
                  In
                </button>
                <a className="btn btn-small" href={guestLink(t.qrToken!)} target="_blank" rel="noreferrer">
                  Mở thử
                </a>
                <button type="button" className="btn btn-small" onClick={() => copy(t)}>
                  Chép link
                </button>
                {canTables && (
                  <button type="button" className="btn btn-small btn-danger" disabled={busy} onClick={() => renew(t)}>
                    Đổi mã
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      </Section>
    </>
  )
}
