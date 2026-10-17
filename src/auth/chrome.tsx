// App frame shared by every screen (laid out like the Sapo FnB app the staff know): a white top bar with ☰ (drawer
// with who is signed in, the Cài đặt screens and Đổi người), the shop name in the middle (tap = home) and who is
// signed in; a tab bar at the bottom with the work screens; the "← Cài đặt" strip on screens opened from Cài đặt.

import { useEffect, useState } from 'react'
import { useAuth } from './context'
import { SCREEN_LABEL, canOpen, homeRoute, isSettingsScreen, navFor, screenOf, settingsFor } from './guards'
import { ROLE_LABEL } from './types'
import { useRoute } from '../floor/hooks'

/** Top bar + bottom tab bar + drawer. */
export function TopBar() {
  const [open, setOpen] = useState(false)
  const path = useRoute().join('/')
  // the drawer closes on any navigation
  useEffect(() => setOpen(false), [path])
  return (
    <>
      <header className="topbar">
        <button type="button" className="topbar-menu" aria-label="Mở menu" onClick={() => setOpen(true)}>
          <span aria-hidden>☰</span>
        </button>
        <Brand />
        <UserChip />
      </header>
      <BottomNav />
      {open && <Drawer onClose={() => setOpen(false)} />}
    </>
  )
}

/** Shop name: tapping it always goes home (Sơ đồ bàn; the kitchen screen for kitchen accounts). */
export function Brand() {
  const { session } = useAuth()
  return (
    <a className="brand" href={'#/' + (canOpen(session.role, 'floor') ? 'ban' : homeRoute(session.role))} title="Về trang chủ">
      Bò Mỹ Đen
    </a>
  )
}

/** Tab bar at the bottom. Hidden on a table's order screen, which has its own bottom bar (Thành tiền, Gửi bếp). */
export function BottomNav() {
  const { session } = useAuth()
  const route = useRoute()
  const here = screenOf(route)
  if (route[0] === 'ban' && route[1] === 'don') return null
  const current = isSettingsScreen(here) ? 'settings' : here
  return (
    <nav className="bottom-nav" aria-label="Màn hình">
      {navFor(session.role).map(l => (
        <a key={l.href} href={l.href} aria-current={l.screen === current ? 'page' : undefined}>
          <span className="bottom-nav-icon" aria-hidden>
            {l.icon}
          </span>
          <span>{l.label}</span>
        </a>
      ))}
    </nav>
  )
}

function Drawer(props: { onClose: () => void }) {
  const { session, signOut } = useAuth()
  const items = settingsFor(session.role)
  return (
    <div className="drawer-backdrop" onClick={props.onClose}>
      <aside className="drawer" aria-label="Menu" onClick={e => e.stopPropagation()}>
        <div className="drawer-head">
          <b className="drawer-shop">BÒ MỸ ĐEN</b>
          <div className="drawer-user">
            <span className="drawer-avatar" aria-hidden>
              {session.name.trim().slice(0, 2).toUpperCase()}
            </span>
            <span>
              <b>{session.name}</b>
              <span className="block muted">{ROLE_LABEL[session.role]}</span>
            </span>
          </div>
        </div>
        <nav className="drawer-list">
          {navFor(session.role)
            .filter(l => l.screen !== 'settings')
            .map(l => (
              <a key={l.href} href={l.href}>
                <span aria-hidden>{l.icon}</span> {l.label}
              </a>
            ))}
          {items.length > 0 && <p className="drawer-section">Cài đặt</p>}
          {items.map(i => (
            <a key={i.href} href={i.href}>
              <span aria-hidden>{i.icon}</span> {i.label}
            </a>
          ))}
        </nav>
        <button type="button" className="drawer-signout" onClick={signOut}>
          ⏻ Đổi người (đăng xuất)
        </button>
      </aside>
    </div>
  )
}

/** Below the top bar on Ca, Thực đơn, Bàn and Nhân viên: the way back to the Cài đặt cards. */
export function SettingsBack() {
  const here = screenOf(useRoute())
  if (!isSettingsScreen(here) || here === 'settings') return null
  return (
    <div className="settings-back">
      <a href="#/cai-dat">← Cài đặt</a>
      <span className="muted">/</span>
      <b>{here === 'menu-admin' ? 'Thực đơn' : SCREEN_LABEL[here]}</b>
    </div>
  )
}

export function UserChip(props: { dark?: boolean }) {
  const { session, signOut } = useAuth()
  return (
    <div className={'user-chip' + (props.dark ? ' is-dark' : '')}>
      <span className="user-name">
        <b>{session.name}</b> <span className="user-role">{ROLE_LABEL[session.role]}</span>
      </span>
      <button type="button" className="user-switch" onClick={signOut} title="Đăng xuất và cho người khác đăng nhập">
        Đổi người
      </button>
    </div>
  )
}
