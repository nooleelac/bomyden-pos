// Waiter / cashier shell: floor map, order screen, area setup (the "Chờ bưng" bar is hidden: Đã bưng is marked
// on the order screen). Routes (hash): #/don (đơn đang mở)  #/ban  #/ban/don/<orderId>  #/ban/caidat

import { useCallback, useEffect, useState } from 'react'
import { SettingsBack, TopBar } from '../auth/chrome'
import { useAuth } from '../auth/context'
import type { MenuRepo } from '../menu/repo'
import '../menu/menu.css'
import './floor.css'
import { errText, useLive, useNow, useOnline, useRoute } from './hooks'
import type { FloorRepo } from './repo'
import { unlockSound } from './sound'
import { FloorMap } from './screens/FloorMap'
import { OrdersPage } from './screens/OrdersPage'
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

  if (!floor || !menu) return <div className="menu-app loading">Đang tải sơ đồ bàn…</div>
  const page = route[0] === 'don' ? 'orders' : route[1] === 'don' && route[2] ? 'order' : route[1] === 'caidat' ? 'setup' : 'map'

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
      {page === 'orders' && <OrdersPage floor={floor} now={now} role={role} />}
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
