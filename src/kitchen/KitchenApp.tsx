// Kitchen display (Bếp nướng, Bếp lẩu, Bar, or Tất cả khu): dark, big, readable from 2 metres, no scrolling.
// One ticket = one Gửi bếp × one station × one order × one delivery table. Tap a dish to move it
// Chờ làm → Đang làm → Xong; tap the ticket head (or "Xong phiếu") to bump; "Phiếu đã xong" to recall.
// HUỶ and SỬA stay on top until "Đã biết", each with its own sound. Keypad: 1–9 select, Enter bump, 0 recall.
// Route: #/bep  #/bep/<station code | all>

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { MenuRepo } from '../menu/repo'
import type { Menu } from '../menu/types'
import { UserChip } from '../auth/chrome'
import { useAuth } from '../auth/context'
import { canOpen } from '../auth/guards'
import { errText, go, useLive, useNow, useRoute } from '../floor/hooks'
import { activeTickets, allergyText, buildTickets, clock, doneTickets, lineParts, tableTitle, type Ticket } from '../floor/logic'
import type { FloorRepo } from '../floor/repo'
import { play, soundReady, unlockSound, type SoundKind } from '../floor/sound'
import type { FloorState, Line, LineStatus, Notice } from '../floor/types'
import './kitchen.css'

interface Prefs {
  columns: number
  rows: number
  font: 'l' | 'xl' | 'xxl'
  contrast: boolean
}
const PREFS_KEY = 'bmd-kds-prefs'
function loadPrefs(): Prefs {
  const d: Prefs = { columns: 4, rows: 2, font: 'xl', contrast: false }
  try {
    return { ...d, ...(JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as Partial<Prefs>) }
  } catch {
    return d
  }
}

const NEXT: Partial<Record<LineStatus, LineStatus>> = { new: 'cooking', cooking: 'ready', ready: 'cooking' }

export function KitchenApp(props: { floorRepo: FloorRepo; menuRepo: MenuRepo }) {
  const { session } = useAuth()
  const { floorRepo: repo } = props
  const [toast, setToast] = useState<string | null>(null)
  const onError = useCallback((m: string) => setToast(m), [])
  const { floor, menu } = useLive(repo, props.menuRepo, onError)
  const now = useNow(1000, floor?.clockOffset ?? 0)
  const route = useRoute()
  const [prefs, setPrefsState] = useState(loadPrefs)
  const [page, setPage] = useState(0)
  const [showDone, setShowDone] = useState(false)
  const [selected, setSelected] = useState(0)
  const [sound, setSound] = useState(soundReady)
  const [undo, setUndo] = useState<{ key: string; label: string; at: number } | null>(null)
  const lastBumped = useRef<string | null>(null)

  const setPrefs = (p: Partial<Prefs>) =>
    setPrefsState(prev => {
      const n = { ...prev, ...p }
      try {
        localStorage.setItem(PREFS_KEY, JSON.stringify(n))
      } catch {
        /* per-device convenience only */
      }
      return n
    })
  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 5000)
    return () => clearTimeout(t)
  }, [toast])
  useEffect(() => {
    if (!undo) return
    const t = setTimeout(() => setUndo(null), 5000)
    return () => clearTimeout(t)
  }, [undo])

  const stations = useMemo(() => (menu?.stations ?? []).filter(s => s.kind !== 'none'), [menu])
  const code = route[1] ?? ''
  const station = code === 'all' ? 'all' : stations.find(s => s.code === code)?.id ?? null
  const tickets = useMemo(() => (floor && menu && station ? activeTickets(floor, menu, station, now) : []), [floor, menu, station, now])
  const perPage = prefs.columns * prefs.rows
  const pages = Math.max(1, Math.ceil(tickets.length / perPage))
  const pageNo = Math.min(page, pages - 1)
  const visible = tickets.slice(pageNo * perPage, pageNo * perPage + perPage)

  useAlerts(floor, menu, station, now)

  // tickets grow with their dishes; when some run past the bottom of the screen, say so (never hide dish lines)
  const gridRef = useRef<HTMLElement | null>(null)
  const [below, setBelow] = useState(0)
  const measureBelow = useCallback(() => {
    const g = gridRef.current
    if (!g) return setBelow(0)
    const bottom = g.getBoundingClientRect().bottom
    setBelow(Array.from(g.querySelectorAll('.ticket')).filter(el => el.getBoundingClientRect().bottom > bottom + 2).length)
  }, [])
  useLayoutEffect(measureBelow)
  useEffect(() => {
    window.addEventListener('resize', measureBelow)
    return () => window.removeEventListener('resize', measureBelow)
  }, [measureBelow])

  const fail = (e: unknown) => onError(errText(e))
  const bump = (t: Ticket) =>
    repo.bumpTicket(t.key).then(() => {
      lastBumped.current = t.key
      setUndo({ key: t.key, label: tableTitle(t.label), at: Date.now() })
    }, fail)
  const recall = (key: string) => repo.recallTicket(key).then(() => setUndo(null), fail)

  // keypad: 1–9 select by position, Enter bumps the selected ticket, 0 recalls the last bumped one
  useEffect(() => {
    const f = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT' || (e.target as HTMLElement)?.tagName === 'SELECT') return
      if (/^[1-9]$/.test(e.key)) setSelected(Number(e.key) - 1)
      else if (e.key === 'Enter' && visible[selected]) void bump(visible[selected])
      else if (e.key === '0' && lastBumped.current) void recall(lastBumped.current)
      else if (e.key === 'PageDown' || e.key === '+') setPage(p => Math.min(p + 1, pages - 1))
      else if (e.key === 'PageUp' || e.key === '-') setPage(p => Math.max(p - 1, 0))
    }
    window.addEventListener('keydown', f)
    return () => window.removeEventListener('keydown', f)
  })

  const startShift = async () => {
    const ok = await unlockSound()
    setSound(ok)
    if (ok) play('new')
    try {
      await (navigator as Navigator & { wakeLock?: { request: (t: 'screen') => Promise<unknown> } }).wakeLock?.request('screen')
    } catch {
      /* wake lock unavailable: keep the screen on in the device settings */
    }
  }

  if (!floor || !menu) return <div className="kds loading">Đang tải…</div>

  if (!station) {
    const all = buildTickets(floor, now)
    return (
      <div className={`kds kds-pick font-${prefs.font}`}>
        <h1>Chọn khu chế biến cho máy này</h1>
        <div className="kds-stations">
          {stations.map(s => {
            const ts = activeTickets(floor, menu, s.id, now)
            return (
              <button key={s.id} type="button" className="kds-station" onClick={() => go(`bep/${s.code}`)}>
                <b>{s.name}</b>
                <span>
                  {ts.length} phiếu{ts.some(t => t.heat === 'late') ? ` (${ts.filter(t => t.heat === 'late').length} trễ)` : ''}
                </span>
              </button>
            )
          })}
          <button type="button" className="kds-station" onClick={() => go('bep/all')}>
            <b>Tất cả khu</b>
            <span>{all.filter(t => !t.done).length} phiếu</span>
          </button>
        </div>
        <div className="kds-pick-foot">
          {canOpen(session.role, ['ban']) && <a href="#/ban">← Về sơ đồ bàn</a>}
          <UserChip dark />
        </div>
      </div>
    )
  }

  const stationName = station === 'all' ? 'Tất cả khu' : stations.find(s => s.id === station)?.name
  const done = showDone ? doneTickets(floor, station, now) : []

  return (
    <div className={`kds font-${prefs.font}${prefs.contrast ? ' high-contrast' : ''}`} style={{ ['--cols' as string]: prefs.columns, ['--rows' as string]: prefs.rows }}>
      <header className="kds-bar">
        {canOpen(session.role, ['ban']) && (
          <a className="kds-btn kds-home" href="#/ban">
            🍽️ Sơ đồ bàn
          </a>
        )}
        <a className="kds-station-name" href="#/bep" title="Đổi khu">
          {stationName}
        </a>
        {station === 'all' && (
          <span className="kds-load">
            {stations.map(s => {
              const ts = activeTickets(floor, menu, s.id, now)
              const late = ts.filter(t => t.heat === 'late').length
              return (
                <span key={s.id}>
                  {s.name.replace('Bếp ', '')} {ts.length}
                  {late ? <b className="late-text"> ({late} trễ)</b> : ''}
                </span>
              )
            })}
          </span>
        )}
        <span className="kds-count">{tickets.length} phiếu chờ</span>
        {!sound ? (
          <button type="button" className="kds-btn kds-start" onClick={startShift}>
            <span className="muted-icon" aria-label="Chưa bật âm thanh">🔇</span> Bắt đầu ca – bật âm thanh
          </button>
        ) : (
          <button type="button" className="kds-btn" onClick={() => play('void')}>
            🔊 Thử tiếng
          </button>
        )}
        <button type="button" className={'kds-btn' + (showDone ? ' is-on' : '')} onClick={() => setShowDone(v => !v)}>
          Phiếu đã xong
        </button>
        <select aria-label="Số cột" value={prefs.columns} onChange={e => setPrefs({ columns: Number(e.target.value) })}>
          {[2, 3, 4, 5, 6].map(n => (
            <option key={n} value={n}>
              {n} cột
            </option>
          ))}
        </select>
        <select aria-label="Cỡ chữ" value={prefs.font} onChange={e => setPrefs({ font: e.target.value as Prefs['font'] })}>
          <option value="l">Chữ lớn</option>
          <option value="xl">Rất lớn</option>
          <option value="xxl">Cực lớn</option>
        </select>
        <label className="kds-check">
          <input type="checkbox" checked={prefs.contrast} onChange={e => setPrefs({ contrast: e.target.checked })} /> Tương phản cao
        </label>
        <UserChip dark />
        <span className="kds-clock">{clock(now.toISOString())}</span>
      </header>

      {showDone ? (
        <section className="kds-done">
          <h2>Phiếu đã xong (2 giờ gần nhất)</h2>
          {done.length === 0 && <p>Chưa có phiếu nào.</p>}
          <ul>
            {done.map(t => (
              <li key={t.key}>
                <b>{tableTitle(t.label).toUpperCase()}</b> · Lượt {t.round} · gửi {clock(t.sentAt)} · xong {clock(t.doneAt)} ·{' '}
                {t.lines.map(l => `${l.qty} ${l.shortName}`).join(', ')}
                <button type="button" className="kds-btn" onClick={() => recall(t.key)}>
                  Gọi lại
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : (
        <main className="kds-grid" ref={gridRef} onScroll={measureBelow}>
          {visible.length === 0 && <p className="kds-empty">Không có phiếu chờ</p>}
          {/* masonry: ticket i goes to column i % cols, so the order still reads left to right and each ticket is as tall as its dishes */}
          {visible.length > 0 &&
            Array.from({ length: prefs.columns }, (_, c) => (
              <div key={c} className="kds-col">
                {visible.map((t, i) =>
                  i % prefs.columns !== c ? null : (
                    <TicketCard
                      key={t.key}
                      t={t}
                      n={i + 1}
                      selected={i === selected}
                      menu={menu}
                      showStation={station === 'all'}
                      onBump={() => bump(t)}
                      onLine={(l: Line) => NEXT[l.status] && repo.setLineStatus([l.id], NEXT[l.status]!).catch(fail)}
                      onAck={(n: Notice) => repo.ackNotice(n.id).catch(fail)}
                      onDecide={(n: Notice, ok: boolean) => repo.decideModify(n.id, ok).catch(fail)}
                    />
                  ),
                )}
              </div>
            ))}
          {below > 0 && (
            <button type="button" className="kds-more" onClick={() => gridRef.current?.scrollBy({ top: gridRef.current.clientHeight * 0.8, behavior: 'smooth' })}>
              ▼ Còn {below} phiếu chưa thấy hết – cuộn xuống
            </button>
          )}
        </main>
      )}
      {!showDone && pages > 1 && (
        <nav className="kds-pages">
          <button type="button" className="kds-btn" disabled={pageNo === 0} onClick={() => setPage(pageNo - 1)}>
            ◂ Trang trước
          </button>
          <span>
            Trang {pageNo + 1}/{pages}
          </span>
          <button type="button" className="kds-btn kds-next" disabled={pageNo >= pages - 1} onClick={() => setPage(pageNo + 1)}>
            Trang sau (còn {tickets.length - (pageNo + 1) * perPage} phiếu) ▸
          </button>
        </nav>
      )}
      {undo && (
        <div className="kds-undo" role="status">
          Đã xong phiếu {undo.label}
          <button type="button" className="kds-btn" onClick={() => recall(undo.key)}>
            Hoàn tác
          </button>
        </div>
      )}
      {toast && (
        <div className="kds-toast" role="alert" onClick={() => setToast(null)}>
          {toast}
        </div>
      )}
    </div>
  )
}

function TicketCard(props: {
  t: Ticket
  n: number
  selected: boolean
  menu: Menu
  showStation: boolean
  onBump: () => void
  onLine: (l: Line) => void
  onAck: (n: Notice) => void
  onDecide: (n: Notice, ok: boolean) => void
}) {
  const { t } = props
  const mins = Math.floor(t.elapsedMs / 60_000)
  const secs = Math.floor((t.elapsedMs % 60_000) / 1000)
  const chase = t.notices.filter(n => n.kind === 'chase')
  const blocking = t.notices.some(n => n.kind === 'void' || n.kind === 'modify')
  return (
    <article className={`ticket heat-${t.heat}${props.selected ? ' is-selected' : ''}${t.rush || chase.length ? ' is-urgent' : ''}${t.takeaway ? ' is-takeaway' : ''}`} aria-label={`Phiếu ${tableTitle(t.label)}`}>
      <button type="button" className="ticket-head" onClick={props.onBump} disabled={blocking} title={blocking ? 'Bấm Đã biết HUỶ / SỬA trước' : 'Chạm để xong cả phiếu'}>
        <span className="ticket-pos">{props.n}</span>
        <span className="ticket-table">{t.takeaway ? `MANG VỀ ${t.label}` : tableTitle(t.label).toUpperCase()}</span>
        <span className="ticket-timer">
          {mins}:{String(secs).padStart(2, '0')}
        </span>
      </button>
      <div className="ticket-sub">
        {t.groupLabel && <span className="ticket-group">{t.groupLabel}</span>}
        {t.positionLabel && <span>{t.positionLabel}</span>}
        <span>
          {t.round > 1 ? `Lượt ${t.round} · ` : ''}PV {t.sentBy} · {clock(t.sentAt)}
          {t.guests ? ` · ${t.guests} khách` : ''}
        </span>
        {props.showStation && <span>{props.menu.stations.find(s => s.id === t.stationId)?.name}</span>}
      </div>
      <div className="ticket-flags">
        {t.rush && <span className="flag flag-rush">GẤP · {t.rushReason}</span>}
        {chase.map(n => (
          <span key={n.id} className="flag flag-chase">
            {n.text} – {clock(n.createdAt)}
            <button type="button" className="kds-btn" onClick={() => props.onAck(n)}>
              Đã nhận
            </button>
          </span>
        ))}
        {t.recalled && <span className="flag flag-recall">GỌI LẠI</span>}
        {t.movedFrom && <span className="flag flag-move">CHUYỂN TỪ {t.movedFrom}</span>}
      </div>
      {(t.order.allergy || t.order.note) && (
        <div className={'ticket-note' + (t.order.allergy ? ' is-allergy' : '')}>
          {t.order.allergy ? <b>{allergyText(t.order.note)}</b> : <span>{t.order.note}</span>}
        </div>
      )}
      <ul className="ticket-lines">
        {t.lines.map(l => {
          const p = lineParts(l)
          const voidN = t.notices.find(n => n.kind === 'void' && n.lineId === l.id)
          const modN = t.notices.find(n => n.kind === 'modify' && n.lineId === l.id)
          return (
            <li key={l.id} className={`tl tl-${l.status}${voidN ? ' has-void' : ''}${modN ? ' has-modify' : ''}`}>
              {voidN && (
                <div className="notice notice-void">
                  <b className="notice-badge">HUỶ</b> {voidN.text.replace(/^HUỶ /, '')}
                  <button type="button" className="kds-btn" onClick={() => props.onAck(voidN)}>
                    Đã biết
                  </button>
                </div>
              )}
              {modN && (
                <div className="notice notice-modify">
                  <b className="notice-badge">SỬA</b>
                  <span className="notice-old">
                    Cũ: <s>{modN.before}</s>
                  </span>
                  <span className="notice-new">
                    Mới: <b>{modN.text}</b>
                  </span>
                  {modN.status === 'pending' ? (
                    <span className="btn-pair">
                      <button type="button" className="kds-btn" onClick={() => props.onDecide(modN, true)}>
                        Nhận sửa
                      </button>
                      <button type="button" className="kds-btn" onClick={() => props.onDecide(modN, false)}>
                        Không kịp
                      </button>
                    </span>
                  ) : (
                    <button type="button" className="kds-btn" onClick={() => props.onAck(modN)}>
                      Đã biết
                    </button>
                  )}
                </div>
              )}
              <button type="button" className="tl-main" disabled={l.status === 'void' || l.status === 'served'} onClick={() => props.onLine(l)}>
                <span className="tl-qty">{l.qty}</span>
                <span className="tl-body">
                  <span className="tl-name">
                    {l.shortName}
                    {l.variantName && <span className="tl-size"> – {l.variantName}</span>}
                  </span>
                  {p.options.length > 0 && <span className="tl-opt">{p.options.join(' · ')}</span>}
                  {p.removals.map(r => (
                    <span key={r} className="tl-removal">
                      {r}
                    </span>
                  ))}
                  {p.addons.length > 0 && <span className="tl-addon">{p.addons.join(' · ')}</span>}
                  {l.note && <span className="tl-note">✎ {l.note}</span>}
                </span>
                <span className={`tl-state st-${l.status}`}>{STATE_TEXT[l.status]}</span>
              </button>
            </li>
          )
        })}
      </ul>
      <button type="button" className="ticket-bump" onClick={props.onBump} disabled={blocking}>
        Xong phiếu
      </button>
    </article>
  )
}

const STATE_TEXT: Record<LineStatus, string> = { new: 'Chờ làm', cooking: 'Đang làm', ready: 'Xong', served: 'Đã bưng', void: 'HUỶ' }

/** Sounds by event: new ticket, HUỶ, SỬA (repeat each minute until Đã biết), GIỤC, late (once per ticket), table moved. */
function useAlerts(floor: FloorState | null, menu: Menu | null, station: string | null, now: Date) {
  const seen = useRef<{ tickets: Set<string>; notices: Set<string>; late: Set<string>; moved: Set<string> } | null>(null)
  const lastRepeat = useRef(0)
  useEffect(() => {
    if (!floor || !menu || !station) return
    const ts = activeTickets(floor, menu, station, now)
    const notices = ts.flatMap(t => t.notices)
    const cur = {
      tickets: new Set(ts.map(t => t.key)),
      notices: new Set(notices.map(n => n.id)),
      late: new Set(ts.filter(t => t.heat === 'late').map(t => t.key)),
      moved: new Set(ts.filter(t => t.movedFrom).map(t => t.key + t.movedFrom)),
    }
    const prev = seen.current
    seen.current = cur
    if (!prev) return
    const fresh = (a: Set<string>, b: Set<string>) => [...a].filter(x => !b.has(x))
    const newNotices = notices.filter(n => fresh(cur.notices, prev.notices).includes(n.id))
    const kinds: SoundKind[] = []
    if (newNotices.some(n => n.kind === 'void')) kinds.push('void')
    if (newNotices.some(n => n.kind === 'modify')) kinds.push('modify')
    if (newNotices.some(n => n.kind === 'chase')) kinds.push('chase')
    if (fresh(cur.tickets, prev.tickets).length) kinds.push('new')
    if (fresh(cur.late, prev.late).length) kinds.push('late')
    if (fresh(cur.moved, prev.moved).length) kinds.push('move')
    // unacknowledged HUỶ / SỬA ring again every minute
    if (!kinds.length && Date.now() - lastRepeat.current > 60_000) {
      const old = notices.filter(n => n.kind === 'void' || n.kind === 'modify').filter(n => now.getTime() - new Date(n.createdAt).getTime() > 60_000)
      if (old.length) {
        kinds.push(old.some(n => n.kind === 'void') ? 'void' : 'modify')
        lastRepeat.current = Date.now()
      }
    }
    kinds.forEach((k, i) => setTimeout(() => play(k), i * 1300))
  }, [floor, menu, station, now])
}
