// Menu module shell: tabs by the signed-in person's permissions (menu admin with menu.edit), live reload, sample-data banner.
// Routes (hash): #/order  #/categories  #/items  #/items/<id>  #/groups  #/stations  #/soldout

import { useCallback, useEffect, useState } from 'react'
import { SettingsBack, TopBar } from '../auth/chrome'
import { menuTabsFor } from '../auth/guards'
import { roleCan } from '../auth/permissions'
import type { Role } from '../floor/types'
import '../floor/floor.css'
import { blankItem, type MenuRepo } from './repo'
import type { Menu, MenuItem } from './types'
import { CategoriesScreen } from './screens/CategoriesScreen'
import { GroupsScreen } from './screens/GroupsScreen'
import { ItemEditor } from './screens/ItemEditor'
import { ItemsScreen } from './screens/ItemsScreen'
import { OrderScreen } from './screens/OrderScreen'
import { SoldOutScreen } from './screens/SoldOutScreen'
import { StationsScreen } from './screens/StationsScreen'
import './menu.css'

type Tab = 'order' | 'categories' | 'items' | 'groups' | 'stations' | 'soldout'
const TABS: { id: Tab; label: string }[] = [
  { id: 'order', label: 'Gọi món' },
  { id: 'categories', label: 'Nhóm món' },
  { id: 'items', label: 'Món' },
  { id: 'groups', label: 'Tuỳ chọn' },
  { id: 'stations', label: 'Khu bếp' },
  { id: 'soldout', label: 'Hết món' },
]

function readHash(): { tab: Tab; itemId: string | null } {
  const [, tab, id] = location.hash.replace(/^#\/?/, '/').split('/')
  const t = (TABS.find(x => x.id === tab)?.id ?? 'order') as Tab
  return { tab: t, itemId: t === 'items' && id ? decodeURIComponent(id) : null }
}

export function MenuApp(props: { repo: MenuRepo; role: Role }) {
  const { repo, role } = props
  const [menu, setMenu] = useState<Menu | null>(null)
  const [route, setRoute] = useState(readHash)
  const [now, setNow] = useState(() => new Date())
  const [toast, setToast] = useState<string | null>(null)
  const [newItem, setNewItem] = useState<MenuItem | null>(null)

  const reload = useCallback(() => {
    repo.load().then(m => {
      setMenu(m)
      setNow(new Date())
    }, e => setToast(String(e)))
  }, [repo])
  useEffect(() => {
    reload()
    return repo.subscribe(reload)
  }, [repo, reload])
  useEffect(() => {
    const onHash = () => setRoute(readHash())
    window.addEventListener('hashchange', onHash)
    const tick = setInterval(() => setNow(new Date()), 30_000) // "Hết hôm nay" ends on its own
    return () => {
      window.removeEventListener('hashchange', onHash)
      clearInterval(tick)
    }
  }, [])
  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 5000)
    return () => clearTimeout(t)
  }, [toast])

  const go = (path: string) => {
    location.hash = '#/' + path
  }
  const onError = (m: string) => setToast(m)
  const allowed = menuTabsFor(role)
  const purge = roleCan(role, 'admin.delete')
  const tabs = TABS.filter(t => allowed.includes(t.id))
  const tab = tabs.some(t => t.id === route.tab) ? route.tab : (tabs[0]?.id ?? 'soldout')

  if (!menu) return <div className="menu-app loading">Đang tải thực đơn…</div>

  const editing = tab === 'items' && route.itemId ? (menu.items.find(i => i.id === route.itemId) ?? (newItem?.id === route.itemId ? newItem : null)) : null

  return (
    <div className="menu-app floor-app">
      <TopBar />
      <SettingsBack />
      {menu.sample && <div className="sample-banner">Dữ liệu mẫu: tên món là ví dụ, giá chỉ là ví dụ, chưa phải giá thật của quán.</div>}
      <nav className="tabs" aria-label="Thực đơn">
        {tabs.map(t => (
          <a key={t.id} href={`#/${t.id}`} className={'tab' + (t.id === tab ? ' is-on' : '')} aria-current={t.id === tab ? 'page' : undefined}>
            {t.label}
          </a>
        ))}
      </nav>
      <main>
        {/* kept mounted so lines being picked survive a look at another tab */}
        {tabs.some(t => t.id === 'order') && (
          <div hidden={tab !== 'order'}>
            <OrderScreen menu={menu} now={now} />
          </div>
        )}
        {tab === 'categories' && <CategoriesScreen menu={menu} repo={repo} purge={purge} onError={onError} />}
        {tab === 'items' && !route.itemId && (
          <ItemsScreen
            menu={menu}
            repo={repo}
            onError={onError}
            onOpen={i => {
              if (!menu.items.some(x => x.id === i.id)) setNewItem(i)
              go(`items/${encodeURIComponent(i.id)}`)
            }}
          />
        )}
        {tab === 'items' && route.itemId && (
          <ItemEditor
            key={route.itemId}
            menu={menu}
            value={editing ?? blankItem(menu, menu.categories[0]?.id ?? '')}
            onSave={i => repo.saveItem(i)}
            onDelete={id => repo.deleteItem(id).then(() => go('items'), e => onError(String(e)))}
            onPurge={purge ? id => repo.adminDelete('item', id).then(() => go('items'), e => onError(e instanceof Error ? e.message : String(e))) : undefined}
            onClose={() => go('items')}
          />
        )}
        {tab === 'groups' && <GroupsScreen menu={menu} repo={repo} purge={purge} onError={onError} />}
        {tab === 'stations' && <StationsScreen menu={menu} repo={repo} onError={onError} />}
        {tab === 'soldout' && <SoldOutScreen menu={menu} repo={repo} now={now} canEdit={roleCan(role, 'menu.soldout')} onError={onError} />}
      </main>
      {toast && (
        <div className="toast" role="alert" onClick={() => setToast(null)}>
          {toast}
        </div>
      )}
    </div>
  )
}
