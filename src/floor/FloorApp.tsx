// Waiter / cashier shell: floor map, order screen, area setup, and the "Chờ bưng" list that rings when
// the kitchen marks dishes Xong. Routes (hash): #/ban  #/ban/don/<orderId>  #/ban/caidat

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { SettingsBack, TopBar } from '../auth/chrome'
import { useAuth } from '../auth/context'
import type { MenuRepo } from '../menu/repo'
import '../menu/menu.css'
import './floor.css'
import { errText, useLive, useNow, useOnline, useRoute } from './hooks'
import { clock, formatDuration, readyToServe, tableTitle } from './logic'
import type { FloorRepo } from './repo'
import { play, unlockSound } from './sound'
import { FloorMap } from './screens/FloorMap'
import { OrderView } from './screens/OrderView'
import { SetupScreen } from './screens/SetupScreen'

export function FloorApp(props: { floorRepo: FloorRepo; menuRepo: MenuRepo }) {
  const { floorRepo, menuRepo } = props
  const [toast, setToast] = useState<{ text: string; ok?: boolean } | null>(null)
  const onError = useCallback((m: string) => setToast({ text: m }), [])
  const onInfo = useCallback((m: string) => setToast({ text: m, ok: true }), [])
  const { floor, menu } = useLive(floorRepo, menuRepo, onError)
  const { session } = useAuth()
  const role = session.role
  const me = session.name
  const now = useNow(5000, floor?.clockOffset ?? 0)
  const route = useRoute()
  const online = useOnline()
  const [readyOpen, setReadyOpen] = useState(false)
  const seenReady = useRef<Set<string> | null>(null)

  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), toast.ok ? 2500 : 5000)
    return () => clearTimeout(t)
  }, [toast])
  // Browsers need one tap before playing sound.
  useEffect(() => {
    const f = () => void unlockSound()
    window.addEventListener('pointerdown', f, { once: true })
    return () => window.removeEventListener('pointerdown', f)
  }, [])

  const ready = useMemo(() => (floor ? readyToServe(floor, now) : []), [floor, now])
  useEffect(() => {
    const ids = new Set(ready.map(r => r.line.id))
    if (seenReady.current && [...ids].some(id => !seenReady.current!.has(id))) play('ready')
    seenReady.current = ids
  }, [ready])

  if (!floor || !menu) return <div className="menu-app loading">Đang tải sơ đồ bàn…</div>
  const page = route[1] === 'don' && route[2] ? 'order' : route[1] === 'caidat' ? 'setup' : 'map'

  return (
    <div className="menu-app floor-app">
      <TopBar />
      <SettingsBack />
      {!online && <div className="offline-bar">Mất kết nối, dữ liệu có thể chưa mới nhất</div>}
      {floor.sample && (
        <div className="sample-banner">
          Dữ liệu mẫu (giá chỉ là ví dụ). Mở thêm một tab #/bep để xem bếp nhận món.{' '}
          {floorRepo.reset && (
            <button type="button" className="link small" onClick={() => confirm('Xoá mọi đơn và quay về dữ liệu mẫu?') && floorRepo.reset!().catch(e => onError(errText(e)))}>
              Làm lại dữ liệu mẫu
            </button>
          )}
        </div>
      )}
      {ready.length > 0 && (
        <section className={'ready-bar' + (readyOpen ? ' is-open' : '')} aria-label="Món chờ bưng">
          <button type="button" className="ready-toggle" onClick={() => setReadyOpen(o => !o)}>
            🔔 Chờ bưng <b>{ready.reduce((n, r) => n + r.line.qty, 0)}</b> · lâu nhất {tableTitle(ready[0].label)} {formatDuration(ready[0].waitMs)}
            <span aria-hidden>{readyOpen ? '▴' : '▾'}</span>
          </button>
          {readyOpen && (
            <ul>
              {ready.map(r => (
                <li key={r.line.id}>
                  <a href={`#/ban/don/${r.order.id}`}>
                    <b>{tableTitle(r.label)}</b>: {r.line.qty} {r.line.name}
                    {r.line.variantName && ` ${r.line.variantName}`} xong {clock(r.line.readyAt)}
                    <span className={r.waitMs > 120_000 ? 'late-text' : 'muted'}> · chờ {formatDuration(r.waitMs)}</span>
                  </a>
                  <button type="button" className="btn btn-small btn-primary" onClick={() => floorRepo.setLineStatus([r.line.id], 'served').catch(e => onError(errText(e)))}>
                    Đã bưng
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
      {page === 'map' && <FloorMap floor={floor} repo={floorRepo} now={now} role={role} me={me} online={online} onError={onError} />}
      {page === 'order' && <OrderView key={route[2]} floor={floor} menu={menu} repo={floorRepo} now={now} role={role} me={me} orderId={route[2]} onError={onError} onInfo={onInfo} />}
      {page === 'setup' && (
        <main>
          <SetupScreen floor={floor} repo={floorRepo} role={role} onError={onError} />
        </main>
      )}
      {toast && (
        <div className={'toast' + (toast.ok ? ' toast-ok' : '')} role={toast.ok ? 'status' : 'alert'} onClick={() => setToast(null)}>
          {toast.text}
        </div>
      )}
    </div>
  )
}
