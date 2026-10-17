// Top-bar pieces shared by every screen: the three work screens plus Cài đặt, who is signed in (Đổi người), and the
// "← Cài đặt" strip on screens opened from Cài đặt.

import { useAuth } from './context'
import { SCREEN_LABEL, canOpen, homeRoute,isSettingsScreen, navFor, screenOf } from './guards'
import { ROLE_LABEL } from './types'
import { useRoute } from '../floor/hooks'

/** Shop name at the top left: tapping it always goes home (Sơ đồ bàn; the kitchen screen for kitchen accounts). */
export function Brand() {
  const { session } = useAuth()
  return (
    <a className="brand" href={'#/' + (canOpen(session.role, 'floor') ? 'ban' : homeRoute(session.role))} title="Về trang chủ">
      Bò Mỹ Đen
    </a>
  )
}

export function NavLinks() {
  const { session } = useAuth()
  const here = screenOf(useRoute())
  const links = navFor(session.role)
  const current = isSettingsScreen(here) ? 'settings' : here
  return (
    <nav className="top-links" aria-label="Màn hình">
      {links.map(l => (
        <a key={l.href} href={l.href} title={l.label} aria-current={l.screen === current ? 'page' : undefined}>
          <span aria-hidden>{l.icon}</span>
          <span className="top-link-label">{l.label}</span>
        </a>
      ))}
    </nav>
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
