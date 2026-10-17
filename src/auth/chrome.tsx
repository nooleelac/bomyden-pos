// Top-bar pieces shared by every screen: links the signed-in role may open, and who is signed in (Đổi người).

import { useAuth } from './context'
import { navFor, screenOf } from './guards'
import { ROLE_LABEL } from './types'
import { useRoute } from '../floor/hooks'

export function NavLinks() {
  const { session } = useAuth()
  const here = screenOf(useRoute())
  const links = navFor(session.role)
  return (
    <nav className="top-links" aria-label="Màn hình">
      {links.map(l => (
        <a key={l.href} href={l.href} aria-current={l.screen === here || (here === 'menu-admin' && l.screen === 'menu-order') || (here === 'menu-soldout' && l.screen === 'menu-order') ? 'page' : undefined}>
          {l.label}
        </a>
      ))}
    </nav>
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
