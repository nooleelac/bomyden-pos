// #/cai-dat: one card per setup screen the signed-in role may open (Ca, Thực đơn, Bàn, Nhân viên). The top bar
// itself only carries the three work screens (Sơ đồ bàn, Bếp, Thu ngân).

import { Brand, NavLinks, UserChip } from '../auth/chrome'
import { useAuth } from '../auth/context'
import { settingsFor } from '../auth/guards'
import '../menu/menu.css'
import '../floor/floor.css'
import './settings.css'

export function SettingsApp() {
  const { session } = useAuth()
  const items = settingsFor(session.role)
  return (
    <div className="menu-app floor-app">
      <header className="topbar">
        <Brand />
        <NavLinks />
        <UserChip />
      </header>
      <main className="settings-main">
        <h1>Cài đặt</h1>
        <div className="settings-grid">
          {items.map(i => (
            <a key={i.href} href={i.href} className="settings-card">
              <span className="settings-icon" aria-hidden>
                {i.icon}
              </span>
              <span>
                <b>{i.label}</b>
                <span className="muted small block">{i.hint}</span>
              </span>
            </a>
          ))}
        </div>
      </main>
    </div>
  )
}
