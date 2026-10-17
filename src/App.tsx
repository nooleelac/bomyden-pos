import type { SupabaseClient } from '@supabase/supabase-js'
import { Suspense, lazy, useEffect, useState } from 'react'
import { AuthGate } from './auth/AuthGate'
import { useAuth } from './auth/context'
import { createMemoryAuthRepo, type MemoryAuthRepo } from './auth/memoryRepo'
import type { AuthRepo } from './auth/repo'
import { staffFetch } from './auth/token'
import { CashierApp } from './cashier/CashierApp'
import { FloorApp } from './floor/FloorApp'
import { session, useRoute } from './floor/hooks'
import { createMemoryFloorRepo, type FloorRepo } from './floor/repo'
import { sampleEvening } from './floor/seed'
import { MenuApp } from './menu/MenuApp'
import { SettingsApp } from './settings/SettingsApp'
import { createMemoryMenuRepo, type MenuRepo } from './menu/repo'
import { seedMenu } from './menu/seed'

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
  }
  const sampleAuth = authFromDb ? null : createMemoryAuthRepo({ sync: { storageKey: 'bmd-auth-v1', sessionKey: 'bmd-auth-session', channel: 'bmd-auth' } })
  const auth = sampleAuth ?? (await import('./auth/supabaseRepo')).createSupabaseAuthRepo(db!)
  const menu = menuFromDb ? (await import('./menu/supabaseRepo')).createSupabaseMenuRepo(db!) : createMemoryMenuRepo()
  const floor = floorFromDb ? (await import('./floor/supabaseRepo')).createSupabaseFloorRepo(db!) : sampleFloorRepo(menu, sampleAuth)
  return { menu, floor, auth }
}

function sampleFloorRepo(menu: MenuRepo, auth: MemoryAuthRepo | null): FloorRepo {
  // The sample evening is priced from the sample menu (prices are examples only).
  const evening = () => sampleEvening(seedMenu())
  return createMemoryFloorRepo({
    menu: () => menu.load(),
    actor: () => session.actor,
    // manager approvals of the sample floor are checked by the sample staff list (database approvals by the RPCs)
    approve: auth ? (token, need) => auth.consumeApproval(token, need) : undefined,
    initial: evening(),
    sync: { channel: 'bmd-floor', storageKey: 'bmd-floor-v2', reset: evening },
  })
}

function Screens(props: { repos: Repos }) {
  const { repos } = props
  const route = useRoute()
  const { session: me } = useAuth()
  const top = route[0] ?? ''
  if (top === 'bep') return <KitchenApp floorRepo={repos.floor} menuRepo={repos.menu} />
  if (top === 'nhan-vien') return <StaffApp />
  if (top === 'cai-dat') return <SettingsApp />
  if (top === 'thu-ngan' || top === 'ca') return <CashierApp floorRepo={repos.floor} menuRepo={repos.menu} />
  if (top === '' || top === 'ban') return <FloorApp floorRepo={repos.floor} menuRepo={repos.menu} />
  return <MenuApp repo={repos.menu} role={me.role} />
}

function App() {
  const [repos, setRepos] = useState<Repos | null>(null)
  useEffect(() => {
    connect().then(setRepos)
  }, [])
  if (!repos) return <p style={{ padding: 16 }}>Đang kết nối…</p>
  return (
    <AuthGate repo={repos.auth}>
      <Suspense fallback={<p style={{ padding: 16 }}>Đang tải…</p>}>
        <Screens repos={repos} />
      </Suspense>
    </AuthGate>
  )
}

export default App
