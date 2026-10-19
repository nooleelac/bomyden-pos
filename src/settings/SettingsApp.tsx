// #/cai-dat: one card per setup screen the signed-in role may open (Ca, Thực đơn, Bàn, Thanh toán, Nhân viên).
// The top bar itself only carries the three work screens (Sơ đồ bàn, Bếp, Thu ngân).
// #/cai-dat/thanh-toan: payment methods, bank account, VAT (PaymentSettings).

import { useCallback, useContext, useEffect, useState } from 'react'
import { SettingsBack, TopBar } from '../auth/chrome'
import { useAuth } from '../auth/context'
import { settingsFor } from '../auth/guards'
import { ReposContext, useRoute, useSource } from '../floor/hooks'
import type { FloorRepo } from '../floor/repo'
import type { FloorState } from '../floor/types'
import '../menu/menu.css'
import '../floor/floor.css'
import '../auth/auth.css'
import { PaymentSettings } from './PaymentSettings'
import './settings.css'

export function SettingsApp() {
  const { session } = useAuth()
  const route = useRoute()
  const repos = useContext(ReposContext)
  if (route[1] === 'thanh-toan' && repos) return <PaymentPage repo={repos.floor} />
  const items = settingsFor(session.role)
  return (
    <div className="menu-app floor-app">
      <TopBar />
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

function PaymentPage(props: { repo: FloorRepo }) {
  const [toast, setToast] = useState<{ text: string; ok?: boolean } | null>(null)
  const onError = useCallback((m: string) => setToast({ text: m }), [])
  const onInfo = useCallback((m: string) => setToast({ text: m, ok: true }), [])
  const floor = useSource<FloorState>(props.repo, onError)
  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), toast.ok ? 2500 : 5000)
    return () => clearTimeout(t)
  }, [toast])
  return (
    <div className="menu-app floor-app">
      <TopBar />
      <SettingsBack />
      <main className="settings-main">{floor ? <PaymentSettings floor={floor} repo={props.repo} onError={onError} onInfo={onInfo} /> : <p className="muted">Đang tải…</p>}</main>
      {toast && (
        <div className={'toast' + (toast.ok ? ' toast-ok' : '')} role={toast.ok ? 'status' : 'alert'} onClick={() => setToast(null)}>
          {toast.text}
        </div>
      )}
    </div>
  )
}
