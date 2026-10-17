// App frame shared by every screen (laid out like the Sapo FnB app the staff know): a white top bar with ☰ (drawer
// with who is signed in, the Cài đặt screens and Đổi người), the shop name in the middle (tap = home) and the bell
// (what staff did on any device: gửi bếp, món xong, thu tiền…); a tab bar at the bottom with the work screens; the
// "← Cài đặt" strip on screens opened from Cài đặt.

import { useContext, useEffect, useMemo, useRef, useState } from 'react'
import { useAuth } from './context'
import { SCREEN_LABEL, canOpen, homeRoute, isSettingsScreen, navFor, screenOf, settingsFor } from './guards'
import { ROLE_LABEL } from './types'
import { ReposContext, useNow, useRoute, useSource } from '../floor/hooks'
import { clock } from '../floor/logic'
import { EVENT_ICON, floorEvents, type FloorEvent } from '../floor/notify'
import type { FloorRepo } from '../floor/repo'
import type { FloorState } from '../floor/types'

/** Top bar + bottom tab bar + drawer. */
export function TopBar() {
  const [open, setOpen] = useState(false)
  const route = useRoute()
  const path = route.join('/')
  const repos = useContext(ReposContext)
  // the drawer closes on any navigation
  useEffect(() => setOpen(false), [path])
  // a table's order screen has its own header (← Chi tiết hoá đơn ⋮) and bottom bar, like Sapo
  if (route[0] === 'ban' && route[1] === 'don') return null
  return (
    <>
      <header className="topbar">
        <button type="button" className="topbar-menu" aria-label="Mở menu" onClick={() => setOpen(true)}>
          <span aria-hidden>☰</span>
        </button>
        <Brand />
        {repos ? <Bell repo={repos.floor} /> : <span className="bell-spacer" />}
      </header>
      <BottomNav />
      {open && <Drawer onClose={() => setOpen(false)} />}
    </>
  )
}

/** Shop name: tapping it always goes home (Bàn; the kitchen screen for kitchen accounts). */
export function Brand() {
  const { session } = useAuth()
  return (
    <a className="brand" href={'#/' + (canOpen(session.role, 'floor') ? 'ban' : homeRoute(session.role))} title="Về trang chủ">
      Bò Mỹ Đen
    </a>
  )
}

const SEEN_KEY = 'bmd-bell-seen'
const readSeen = () => {
  try {
    return localStorage.getItem(SEEN_KEY) ?? ''
  } catch {
    return ''
  }
}
const eventText = (e: FloorEvent) => (e.by ? `${e.by} ${e.text}` : e.text.charAt(0).toUpperCase() + e.text.slice(1))

/** 🔔 with the number of new events; tap for the list. A new event by someone else pops up for a few seconds. */
function Bell(props: { repo: FloorRepo }) {
  const { session } = useAuth()
  const floor = useSource<FloorState>(props.repo)
  const now = useNow(30_000, floor?.clockOffset ?? 0)
  const events = useMemo(() => (floor ? floorEvents(floor, now) : []), [floor, now])
  const [seen, setSeen] = useState(readSeen)
  const [open, setOpen] = useState(false)
  const [pop, setPop] = useState<FloorEvent | null>(null)
  const known = useRef<Set<string> | null>(null)

  useEffect(() => {
    if (!floor) return
    if (known.current) {
      const fresh = events.find(e => !known.current!.has(e.id) && e.by !== session.name)
      if (fresh) setPop(fresh)
    }
    known.current = new Set(events.map(e => e.id))
  }, [floor, events, session.name])
  useEffect(() => {
    if (!pop) return
    const t = setTimeout(() => setPop(null), 4500)
    return () => clearTimeout(t)
  }, [pop])

  const unread = events.filter(e => e.at > seen).length
  const toggle = () => {
    if (!open) {
      const at = events[0]?.at ?? ''
      setSeen(at)
      try {
        localStorage.setItem(SEEN_KEY, at)
      } catch {
        /* per-device only */
      }
    }
    setOpen(o => !o)
  }

  return (
    <div className="bell">
      <button type="button" className="bell-btn" aria-label={`Thông báo${unread ? `: ${unread} mới` : ''}`} aria-expanded={open} onClick={toggle}>
        <span aria-hidden>🔔</span>
        {unread > 0 && <span className="bell-count">{unread > 99 ? '99+' : unread}</span>}
      </button>
      {open && (
        <>
          <div className="bell-backdrop" onClick={() => setOpen(false)} />
          <section className="bell-panel" aria-label="Thông báo">
            <h2>Thông báo</h2>
            {events.length === 0 && <p className="muted small">Chưa có thông báo trong 12 giờ qua.</p>}
            <ul>
              {events.map(e => (
                <li key={e.id} className={e.at > seen ? 'is-new' : ''}>
                  <a href={e.href} onClick={() => setOpen(false)}>
                    <span className="bell-icon" aria-hidden>
                      {EVENT_ICON[e.kind]}
                    </span>
                    <span className="bell-text">{eventText(e)}</span>
                    <span className="bell-time">{clock(e.at)}</span>
                  </a>
                </li>
              ))}
            </ul>
          </section>
        </>
      )}
      {pop && !open && (
        <a className="bell-pop" href={pop.href} role="status" onClick={() => setPop(null)}>
          <span aria-hidden>{EVENT_ICON[pop.kind]}</span> {eventText(pop)}
        </a>
      )}
    </div>
  )
}

/** Tab bar at the bottom. Hidden on a table's order screen (it has its own bottom bar) and when there is one screen. */
export function BottomNav() {
  const { session } = useAuth()
  const route = useRoute()
  const here = screenOf(route)
  const links = navFor(session.role)
  if ((route[0] === 'ban' && route[1] === 'don') || links.length < 2) return null
  return (
    <nav className="bottom-nav" aria-label="Màn hình">
      {links.map(l => (
        <a key={l.href} href={l.href} aria-current={l.screen === here ? 'page' : undefined}>
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
          {navFor(session.role).map(l => (
            <a key={l.href} href={l.href}>
              <span aria-hidden>{l.icon}</span> {l.label}
            </a>
          ))}
          {items.length > 0 && (
            <a href="#/cai-dat" className="drawer-section">
              ⚙️ Cài đặt
            </a>
          )}
          {items.map(i => (
            <a key={i.href} href={i.href} className="drawer-sub">
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
