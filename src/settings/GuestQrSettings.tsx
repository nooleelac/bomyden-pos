// #/cai-dat/ma-qr: one QR sticker per table for khách tự gọi món (0023). Opening the page gives every table without a
// token one (tables.edit); tick tables (or whole areas) and print just those, or In tất cả, on A4 sheets of stickers; Đổi mã replaces one table's token, so a photo of
// the old sticker stops working. settings.edit turns guest ordering on or off for the branch and edits the quick picks
// a guest taps on Gọi phục vụ / Gọi thanh toán (0025), and the geofence: only guests within a radius of the shop (by the
// size of the place) may order or call (0026).

import { useEffect, useMemo, useRef, useState } from 'react'
import { useAuth } from '../auth/context'
import { roleCan } from '../auth/permissions'
import { qrSvg } from '../cashier/print'
import { checkCallChips, checkGuestGeo } from '../floor/engine'
import { parseLatLng, RADIUS_MAX, RADIUS_MIN, RADIUS_PRESETS } from '../lib/geo'
import { errText } from '../floor/hooks'
import type { FloorRepo } from '../floor/repo'
import { CALL_CHIP_LEN, CALL_CHIP_MAX, callChips, DEFAULT_CALL_CHIPS, type CallChips, type FloorState, type Table } from '../floor/types'
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
  // Chọn bàn để in: ticked tables, printed in floor order
  const [picked, setPicked] = useState<Set<string>>(() => new Set())
  const chosen = ready.filter(t => picked.has(t.id))
  const toggle = (ids: string[], on: boolean) =>
    setPicked(prev => {
      const next = new Set(prev)
      for (const id of ids) if (on) next.add(id); else next.delete(id)
      return next
    })
  const areas = [...floor.areas].sort((a, b) => a.sort - b.sort).map(a => ({ ...a, ids: ready.filter(t => t.areaId === a.id).map(t => t.id) })).filter(a => a.ids.length)
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

      <GeoSection floor={floor} repo={repo} canEdit={canSettings} onError={props.onError} onInfo={props.onInfo} />

      <CallChipsSection floor={floor} repo={repo} canEdit={canSettings} onError={props.onError} onInfo={props.onInfo} />

      <Section
        title={`Tem dán bàn (${ready.length}/${tables.length})`}
        aside={
          <button type="button" className="btn btn-primary btn-small" disabled={!ready.length} onClick={() => printStickers(floor.shop.name, chosen.length ? chosen : ready)}>
            {chosen.length ? `🖨 In ${chosen.length} bàn đã chọn` : '🖨 In tất cả'}
          </button>
        }
      >
        {missing > 0 && <p className="warn">{canTables ? `Đang tạo mã cho ${missing} bàn…` : `${missing} bàn chưa có mã: cần người có quyền Sửa khu vực và bàn mở trang này.`}</p>}
        <p className="muted small">In ra giấy A4 (12 tem một trang), cắt theo đường viền, dán lên bàn. Bàn tạm không có tem.</p>
        {ready.length > 0 && (
          <div className="chip-row qr-pick" role="group" aria-label="Chọn bàn để in">
            <span className="muted small">Chọn bàn để in:</span>
            {areas.map(a => {
              const all = a.ids.every(id => picked.has(id))
              return (
                <button key={a.id} type="button" className={'chip' + (all ? ' is-on' : '')} aria-pressed={all} onClick={() => toggle(a.ids, !all)}>
                  {a.name} ({a.ids.length})
                </button>
              )
            })}
            <button type="button" className="chip" onClick={() => toggle(ready.map(t => t.id), true)}>
              Chọn tất cả
            </button>
            {chosen.length > 0 && (
              <button type="button" className="chip" onClick={() => setPicked(new Set())}>
                Bỏ chọn ({chosen.length})
              </button>
            )}
          </div>
        )}
        <ul className="qr-grid">
          {ready.map(t => (
            <li key={t.id} className={'qr-card' + (picked.has(t.id) ? ' is-picked' : '')}>
              <label className="qr-check">
                <input type="checkbox" checked={picked.has(t.id)} onChange={e => toggle([t.id], e.target.checked)} />
                <span>Chọn in</span>
              </label>
              <div className="qr-img" onClick={() => toggle([t.id], !picked.has(t.id))} dangerouslySetInnerHTML={{ __html: qrSvg(guestLink(t.qrToken!), `Mã QR bàn ${t.name}`) }} />
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

const CHIP_LISTS: { kind: keyof CallChips; title: string; hint: string; placeholder: string }[] = [
  { kind: 'service', title: '🙋 Gọi phục vụ', hint: 'Khách chạm để báo cần gì (chọn được nhiều câu)', placeholder: 'VD: Thêm khăn giấy' },
  { kind: 'bill', title: '🧾 Gọi thanh toán', hint: 'Khách chạm để báo cách trả tiền (chọn một)', placeholder: 'VD: Ví MoMo' },
]

/** Câu gợi ý khi khách gọi: add, rename, reorder, remove, back to the defaults; saved for the branch in one go. */
function CallChipsSection(props: { floor: FloorState; repo: FloorRepo; canEdit: boolean; onError: (m: string) => void; onInfo: (m: string) => void }) {
  const saved = callChips(props.floor.settings.guestCallChips)
  const [draft, setDraft] = useState<CallChips>(saved)
  const [adding, setAdding] = useState<Record<keyof CallChips, string>>({ service: '', bill: '' })
  const [saving, setSaving] = useState(false)
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved)
  const setList = (kind: keyof CallChips, f: (l: string[]) => string[]) => setDraft(d => ({ ...d, [kind]: f(d[kind]) }))
  const add = (kind: keyof CallChips) => {
    const x = adding[kind].trim().replace(/\s+/g, ' ')
    if (!x) return
    if (draft[kind].some(y => y.toLowerCase() === x.toLowerCase())) return props.onError(`Đã có câu "${x}"`)
    if (draft[kind].length >= CALL_CHIP_MAX) return props.onError(`Tối đa ${CALL_CHIP_MAX} câu gợi ý`)
    setList(kind, l => [...l, x])
    setAdding(a => ({ ...a, [kind]: '' }))
  }
  const move = (kind: keyof CallChips, i: number, by: -1 | 1) =>
    setList(kind, l => {
      const j = i + by
      if (j < 0 || j >= l.length) return l
      const n = [...l]
      ;[n[i], n[j]] = [n[j], n[i]]
      return n
    })
  const save = () => {
    let v: CallChips
    try {
      v = checkCallChips(draft)
    } catch (e) {
      return props.onError(errText(e))
    }
    setDraft(v)
    setSaving(true)
    props.repo
      .setGuestCallChips(v)
      .then(() => props.onInfo('Đã lưu câu gợi ý'), e => props.onError(errText(e)))
      .finally(() => setSaving(false))
  }

  return (
    <Section
      title="Câu gợi ý khi khách gọi"
      aside={
        props.canEdit && (
          <button type="button" className="btn btn-primary btn-small" disabled={!dirty || saving} onClick={save}>
            {saving ? 'Đang lưu…' : 'Lưu'}
          </button>
        )
      }
    >
      <p className="muted small">Hiện thành nút bấm nhanh trên điện thoại khách. Khách vẫn ghi chú thêm được. Xoá hết thì khách chỉ thấy ô ghi chú.</p>
      {CHIP_LISTS.map(({ kind, title, hint, placeholder }) => (
        <fieldset key={kind} className="pick-group chip-edit">
          <legend>
            {title} <span className="muted small">· {hint}</span>
          </legend>
          {draft[kind].length === 0 && <p className="muted small">Chưa có câu gợi ý nào.</p>}
          <ul className="rows">
            {draft[kind].map((x, i) => (
              <li key={i} className="chip-edit-row">
                <input
                  aria-label={`Câu gợi ý ${i + 1}`}
                  maxLength={CALL_CHIP_LEN}
                  value={x}
                  disabled={!props.canEdit}
                  onChange={e => setList(kind, l => l.map((y, k) => (k === i ? e.target.value : y)))}
                />
                {props.canEdit && (
                  <>
                    <button type="button" className="icon-btn" aria-label="Lên" disabled={i === 0} onClick={() => move(kind, i, -1)}>
                      ↑
                    </button>
                    <button type="button" className="icon-btn" aria-label="Xuống" disabled={i === draft[kind].length - 1} onClick={() => move(kind, i, 1)}>
                      ↓
                    </button>
                    <button type="button" className="icon-btn" aria-label={`Xoá "${x}"`} onClick={() => setList(kind, l => l.filter((_, k) => k !== i))}>
                      ✕
                    </button>
                  </>
                )}
              </li>
            ))}
          </ul>
          {props.canEdit && (
            <div className="chip-edit-add">
              <input
                maxLength={CALL_CHIP_LEN}
                placeholder={placeholder}
                value={adding[kind]}
                onChange={e => setAdding(a => ({ ...a, [kind]: e.target.value }))}
                onKeyDown={e => e.key === 'Enter' && (e.preventDefault(), add(kind))}
              />
              <button type="button" className="btn btn-small" disabled={!adding[kind].trim() || draft[kind].length >= CALL_CHIP_MAX} onClick={() => add(kind)}>
                + Thêm
              </button>
              <button type="button" className="link small" onClick={() => setList(kind, () => [...DEFAULT_CALL_CHIPS[kind]])}>
                Về mặc định
              </button>
            </div>
          )}
        </fieldset>
      ))}
      {!props.canEdit && <p className="muted small">Cần quyền Cài đặt đăng nhập và quán để sửa.</p>}
    </Section>
  )
}

const fmt = (n: number) => n.toFixed(6)

/** Chống phá: the shop's position (this device's GPS, or pasted from Google Maps) and the radius by the size of the place. */
function GeoSection(props: { floor: FloorState; repo: FloorRepo; canEdit: boolean; onError: (m: string) => void; onInfo: (m: string) => void }) {
  const saved = props.floor.settings.guestGeo ?? { lat: null, lng: null, radius: null }
  const [lat, setLat] = useState(saved.lat)
  const [lng, setLng] = useState(saved.lng)
  const [on, setOn] = useState(saved.radius != null)
  const [radius, setRadius] = useState(saved.radius ?? 100)
  const [paste, setPaste] = useState('')
  const [locating, setLocating] = useState(false)
  const [saving, setSaving] = useState(false)
  const next = { lat, lng, radius: on ? radius : null }
  const dirty = JSON.stringify(next) !== JSON.stringify({ lat: saved.lat, lng: saved.lng, radius: saved.radius })
  const hasPos = lat != null && lng != null

  const here = () => {
    if (!navigator.geolocation) return props.onError('Máy này không lấy được vị trí')
    setLocating(true)
    navigator.geolocation.getCurrentPosition(
      p => {
        setLat(Number(fmt(p.coords.latitude)))
        setLng(Number(fmt(p.coords.longitude)))
        setLocating(false)
        props.onInfo(`Đã lấy vị trí máy này (sai số khoảng ${Math.round(p.coords.accuracy)} m)`)
      },
      e => {
        setLocating(false)
        props.onError(e.code === e.PERMISSION_DENIED ? 'Trình duyệt đang chặn vị trí: cho phép vị trí cho trang này rồi thử lại' : 'Chưa lấy được vị trí, thử lại hoặc dán toạ độ')
      },
      { enableHighAccuracy: true, timeout: 20_000, maximumAge: 0 },
    )
  }
  const applyPaste = () => {
    const v = parseLatLng(paste)
    if (!v) return props.onError('Không đọc được toạ độ: dán dạng 10.776900, 106.700900')
    setLat(v.lat)
    setLng(v.lng)
    setPaste('')
  }
  const save = () => {
    let v
    try {
      v = checkGuestGeo(next)
    } catch (e) {
      return props.onError(errText(e))
    }
    setSaving(true)
    props.repo
      .setGuestGeo(v)
      .then(() => props.onInfo(v.radius != null ? `Đã bật: chỉ khách trong ${v.radius} m gọi được` : 'Đã lưu: không giới hạn khoảng cách'), e => props.onError(errText(e)))
      .finally(() => setSaving(false))
  }
  const off = !props.canEdit

  return (
    <Section
      title="Chống phá: chỉ khách ở quán"
      aside={
        props.canEdit && (
          <button type="button" className="btn btn-primary btn-small" disabled={!dirty || saving} onClick={save}>
            {saving ? 'Đang lưu…' : 'Lưu'}
          </button>
        )
      }
    >
      <Switch
        checked={on}
        disabled={off}
        label={on ? `Đang bật: khách phải bật GPS và ở trong ${radius} m mới gọi được` : 'Đang tắt: ai có mã QR cũng gọi được'}
        onChange={setOn}
      />
      <p className="muted small">
        Khách quét mã là trang hỏi vị trí ngay; ở xa quán thì không xem được thực đơn và không gửi được món, gọi phục vụ hay thanh toán. Máy chủ kiểm tra lại mỗi lần gửi.
      </p>

      <fieldset className="pick-group">
        <legend>Vị trí quán</legend>
        {hasPos ? (
          <p>
            <b>
              {fmt(lat!)}, {fmt(lng!)}
            </b>{' '}
            <a className="small" href={`https://www.google.com/maps?q=${lat},${lng}`} target="_blank" rel="noreferrer">
              Xem trên bản đồ ›
            </a>
          </p>
        ) : (
          <p className="warn">Chưa có vị trí quán: đứng trong quán và bấm Lấy vị trí máy này.</p>
        )}
        {props.canEdit && (
          <div className="chip-edit-add">
            <button type="button" className="btn btn-small" disabled={locating} onClick={here}>
              {locating ? 'Đang lấy vị trí…' : '📍 Lấy vị trí máy này'}
            </button>
            <input placeholder="Hoặc dán toạ độ từ Google Maps" value={paste} onChange={e => setPaste(e.target.value)} onKeyDown={e => e.key === 'Enter' && (e.preventDefault(), applyPaste())} />
            <button type="button" className="btn btn-small" disabled={!paste.trim()} onClick={applyPaste}>
              Dùng
            </button>
          </div>
        )}
      </fieldset>

      <fieldset className="pick-group">
        <legend>Bán kính theo quy mô quán</legend>
        <div className="chip-row">
          {RADIUS_PRESETS.map(x => (
            <button key={x.radius} type="button" className={'chip' + (radius === x.radius ? ' is-on' : '')} aria-pressed={radius === x.radius} disabled={off} onClick={() => setRadius(x.radius)}>
              {x.label} · {x.hint}
            </button>
          ))}
        </div>
        <label className="field">
          <span className="field-label">Hoặc nhập số mét ({RADIUS_MIN}–{RADIUS_MAX})</span>
          <input type="number" inputMode="numeric" min={RADIUS_MIN} max={RADIUS_MAX} value={radius || ''} disabled={off} onChange={e => setRadius(Math.round(Number(e.target.value) || 0))} />
        </label>
        <p className="muted small">GPS trong nhà thường lệch 30–80 m, nên app cộng thêm sai số của điện thoại (tối đa 150 m). Quán nhỏ trong phố nên chọn 50–100 m.</p>
      </fieldset>
      {off && <p className="muted small">Cần quyền Cài đặt đăng nhập và quán để sửa.</p>}
    </Section>
  )
}
