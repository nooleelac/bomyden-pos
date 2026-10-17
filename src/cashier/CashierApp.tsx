// Cashier (thu ngân) shell. Routes (hash):
//   #/thu-ngan              open orders to settle, bills already paid (in lại), shift status
//   #/thu-ngan/<orderId>    payment screen: bill with VAT by rate, discount, split payment, VietQR, change
//   #/thu-ngan/hd/<billId>  receipt of a paid bill (print / reprint)
//   #/ca                    open or close the cashier shift, count the cash, 80mm shift report

import { useCallback, useEffect, useState } from 'react'
import '../menu/menu.css'
import '../floor/floor.css'
import './cashier.css'
import { NavLinks, UserChip } from '../auth/chrome'
import { useAuth } from '../auth/context'
import type { MenuRepo } from '../menu/repo'
import { useLive, useNow, useOnline, useRoute } from '../floor/hooks'
import type { FloorRepo } from '../floor/repo'
import { BillPage } from './screens/BillPage'
import { OrderList } from './screens/OrderList'
import { PayScreen } from './screens/PayScreen'
import { ShiftScreen } from './screens/ShiftScreen'

export function CashierApp(props: { floorRepo: FloorRepo; menuRepo: MenuRepo }) {
  const { floorRepo, menuRepo } = props
  const [toast, setToast] = useState<{ text: string; ok?: boolean } | null>(null)
  const onError = useCallback((m: string) => setToast({ text: m }), [])
  const onInfo = useCallback((m: string) => setToast({ text: m, ok: true }), [])
  const { floor } = useLive(floorRepo, menuRepo, onError)
  const { session } = useAuth()
  const role = session.role
  const now = useNow(15000, floor?.clockOffset ?? 0)
  const route = useRoute()
  const online = useOnline()

  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), toast.ok ? 2500 : 5000)
    return () => clearTimeout(t)
  }, [toast])

  if (!floor) return <div className="menu-app loading">Đang tải…</div>
  const page = route[0] === 'ca' ? 'shift' : route[1] === 'hd' && route[2] ? 'bill' : route[1] ? 'pay' : 'list'
  const name = session.name

  return (
    <div className="menu-app floor-app cashier-app">
      <header className="topbar">
        <b className="brand">Bò Mỹ Đen</b>
        <NavLinks />
        <UserChip />
      </header>
      {!online && <div className="offline-bar">Mất kết nối: chưa thu tiền được, dữ liệu có thể chưa mới nhất</div>}
      {floor.shop.sample && <div className="sample-banner">Dữ liệu mẫu: giá, tên quán, địa chỉ và tài khoản nhận tiền chỉ là ví dụ.</div>}
      {page === 'list' && <OrderList floor={floor} now={now} />}
      {page === 'pay' && <PayScreen key={route[1]} floor={floor} repo={floorRepo} role={role} me={name} orderId={route[1]} now={now} onError={onError} onInfo={onInfo} />}
      {page === 'bill' && <BillPage key={route[2]} floor={floor} repo={floorRepo} billId={route[2]} me={name} onError={onError} />}
      {page === 'shift' && <ShiftScreen floor={floor} repo={floorRepo} me={name} now={now} onError={onError} onInfo={onInfo} />}
      {toast && (
        <div className={'toast' + (toast.ok ? ' toast-ok' : '')} role={toast.ok ? 'status' : 'alert'} onClick={() => setToast(null)}>
          {toast.text}
        </div>
      )}
    </div>
  )
}
