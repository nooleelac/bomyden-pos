import type { SupabaseClient } from '@supabase/supabase-js'
import { Suspense, lazy, useEffect, useState } from 'react'
import { AuthGate } from './auth/AuthGate'
import { SwipeBack } from './auth/SwipeBack'
import { ErrorBoundary } from './ErrorBoundary'
import { useAuth } from './auth/context'
import { createMemoryAuthRepo, type MemoryAuthRepo } from './auth/memoryRepo'
import type { AuthRepo } from './auth/repo'
import type { GuestRepo } from './guest/repo'
import type { OnlineRepo } from './online/repo'
import { staffFetch } from './auth/token'
import { FloorApp } from './floor/FloorApp'
import { peekSource, ReposContext, session, useRoute } from './floor/hooks'
import { createMemoryFloorRepo, type FloorRepo } from './floor/repo'
import { sampleBillHistory, sampleEvening } from './floor/seed'
import type { BillHistory } from './floor/types'
import { setPushClient } from './push/push'
import { setPrintClient } from './cashier/printers/network'
import { createMemoryMenuRepo, type MenuRepo } from './menu/repo'
import { seedMenu } from './menu/seed'
import type { Menu } from './menu/types'

// Sample data by default. VITE_MENU_SOURCE=supabase / VITE_FLOOR_SOURCE=supabase / VITE_AUTH_SOURCE=supabase (plus the
// Supabase URL and key) use the database; supabase-js is then loaded on demand so the sample build stays small.
// Any database source signs staff in through the database too (the RPCs know who is calling from the PIN session).
// In sample mode the floor and the staff list are shared between the tabs of this browser (BroadcastChannel +
// localStorage); each tab signs in on its own, so one tab can be the waiter (#/ban), another the kitchen (#/bep)
// and another the cashier (#/thu-ngan, #/ca).
const env = import.meta.env
const hasDb = !!env.VITE_SUPABASE_URL && !!env.VITE_SUPABASE_ANON_KEY
const menuFromDb = env.VITE_MENU_SOURCE === 'supabase' && hasDb
const floorFromDb = env.VITE_FLOOR_SOURCE === 'supabase' && hasDb
const authFromDb = (env.VITE_AUTH_SOURCE === 'supabase' || menuFromDb || floorFromDb) && hasDb

// screens only some roles open load on demand
const StaffApp = lazy(() => import('./auth/StaffApp').then(m => ({ default: m.StaffApp })))
const KitchenApp = lazy(() => import('./kitchen/KitchenApp').then(m => ({ default: m.KitchenApp })))
const ReportsApp = lazy(() => import('./reports/ReportsApp').then(m => ({ default: m.ReportsApp })))
const CashierApp = lazy(() => import('./cashier/CashierApp').then(m => ({ default: m.CashierApp })))
const MenuApp = lazy(() => import('./menu/MenuApp').then(m => ({ default: m.MenuApp })))
const SettingsApp = lazy(() => import('./settings/SettingsApp').then(m => ({ default: m.SettingsApp })))
const GuestApp = lazy(() => import('./guest/GuestApp').then(m => ({ default: m.GuestApp })))
const OnlineApp = lazy(() => import('./online/OnlineApp').then(m => ({ default: m.OnlineApp })))

interface Repos {
  menu: MenuRepo
  floor: FloorRepo
  auth: AuthRepo
}

async function connect(): Promise<Repos> {
  let db: SupabaseClient | null = null
  if (authFromDb) {
    const { createClient } = await import('@supabase/supabase-js')
    // the device is the Supabase user; the person signed in with a PIN rides on every request (x-staff-session)
    db = createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY, { global: { fetch: staffFetch } })
    setPushClient(db)
    setPrintClient(db, env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY)
  }
  const sampleAuth = authFromDb ? null : createMemoryAuthRepo({ sync: { storageKey: 'bmd-auth-v1', sessionKey: 'bmd-auth-session', channel: 'bmd-auth' } })
  const auth = sampleAuth ?? (await import('./auth/supabaseRepo')).createSupabaseAuthRepo(db!)
  const menu = menuFromDb ? (await import('./menu/supabaseRepo')).createSupabaseMenuRepo(db!) : createMemoryMenuRepo()
  const floor = floorFromDb ? (await import('./floor/supabaseRepo')).createSupabaseFloorRepo(db!, { menu: () => peekSource<Menu>(menu), actor: () => session.actor }) : sampleFloorRepo(menu, sampleAuth)
  return { menu, floor, auth }
}

function sampleFloorRepo(menu: MenuRepo, auth: MemoryAuthRepo | null): FloorRepo {
  // The sample evening is priced from the sample menu (prices are examples only).
  const evening = () => sampleEvening(seedMenu())
  let history: BillHistory | undefined
  return createMemoryFloorRepo({
    menu: () => menu.load(),
    actor: () => session.actor,
    // manager approvals of the sample floor are checked by the sample staff list (database approvals by the RPCs)
    approve: auth ? (token, need) => auth.consumeApproval(token, need) : undefined,
    initial: evening(),
    history: () => (history ??= sampleBillHistory(seedMenu())),
    sync: { channel: 'bmd-floor', storageKey: 'bmd-floor-v2', reset: evening },
  })
}

// Khách quét mã QR (#/goi/<token>): no device, no PIN. The database answers the anon RPCs of 0023 only; sample data
// goes into this browser's sample floor, so a waiter tab sees the request.
async function connectGuest(): Promise<GuestRepo> {
  const { createMemoryGuestRepo, createSupabaseGuestRepo } = await import('./guest/repo')
  if (floorFromDb) {
    const { createClient } = await import('@supabase/supabase-js')
    return createSupabaseGuestRepo(createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } }))
  }
  const menu = createMemoryMenuRepo()
  return createMemoryGuestRepo(sampleFloorRepo(menu, null), menu)
}

function Guest(props: { token: string }) {
  const [repo, setRepo] = useState<GuestRepo | null>(null)
  useEffect(() => {
    connectGuest().then(setRepo)
  }, [])
  if (!repo) return <p style={{ padding: 16 }}>Đang mở thực đơn…</p>
  return (
    <Suspense fallback={<p style={{ padding: 16 }}>Đang mở thực đơn…</p>}>
      <ErrorBoundary>
        <GuestApp repo={repo} token={props.token} />
      </ErrorBoundary>
    </Suspense>
  )
}

// Đặt hàng online (dathang.bomyden.vn, or #/dat-hang on any address): no device, no PIN, the anon RPCs of 0027 only.
async function connectOnline(): Promise<OnlineRepo> {
  const { createMemoryOnlineRepo, createSupabaseOnlineRepo } = await import('./online/repo')
  if (floorFromDb) {
    const { createClient } = await import('@supabase/supabase-js')
    return createSupabaseOnlineRepo(createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } }))
  }
  const menu = createMemoryMenuRepo()
  return createMemoryOnlineRepo(sampleFloorRepo(menu, null), menu)
}

function Online() {
  const [repo, setRepo] = useState<OnlineRepo | null>(null)
  useEffect(() => {
    connectOnline().then(setRepo)
  }, [])
  if (!repo) return <p style={{ padding: 16 }}>Đang mở thực đơn…</p>
  return (
    <Suspense fallback={<p style={{ padding: 16 }}>Đang mở thực đơn…</p>}>
      <ErrorBoundary>
        <OnlineApp repo={repo} />
      </ErrorBoundary>
    </Suspense>
  )
}

function Screens(props: { repos: Repos }) {
  const { repos } = props
  const route = useRoute()
  const { session: me } = useAuth()
  const top = route[0] ?? ''
  if (top === 'bep') return <KitchenApp floorRepo={repos.floor} menuRepo={repos.menu} />
  if (top === 'nhan-vien') return <StaffApp />
  if (top === 'cai-dat') return <SettingsApp />
  if (top === 'hoa-don' || top === 'doanh-thu') return <ReportsApp floorRepo={repos.floor} menuRepo={repos.menu} />
  if (top === 'thu-ngan' || top === 'ca') return <CashierApp floorRepo={repos.floor} menuRepo={repos.menu} />
  if (top === '' || top === 'ban' || top === 'don') return <FloorApp floorRepo={repos.floor} menuRepo={repos.menu} />
  return <MenuApp repo={repos.menu} role={me.role} />
}

function App() {
  const route = useRoute()
  if (location.hostname.startsWith('dathang.') || route[0] === 'dat-hang') return <Online />
  return route[0] === 'goi' ? <Guest token={route[1] ?? ''} /> : <StaffSide />
}

function StaffSide() {
  const [repos, setRepos] = useState<Repos | null>(null)
  useEffect(() => {
    connect().then(setRepos)
  }, [])
  if (!repos) return <p style={{ padding: 16 }}>Đang kết nối…</p>
  return (
    <AuthGate repo={repos.auth}>
      <ReposContext.Provider value={repos}>
        <Suspense fallback={<p style={{ padding: 16 }}>Đang tải…</p>}>
          <ErrorBoundary>
            <Screens repos={repos} />
          </ErrorBoundary>
          <SwipeBack />
        </Suspense>
      </ReposContext.Provider>
    </AuthGate>
  )
}

export default App
