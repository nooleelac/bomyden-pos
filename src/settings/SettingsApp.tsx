// #/cai-dat: one card per setup screen the signed-in role may open (Ca, Thực đơn, Bàn, Thanh toán, Nhân viên).
// The top bar itself only carries the three work screens (Sơ đồ bàn, Bếp, Thu ngân).
// #/cai-dat/thanh-toan: payment methods, bank account, VAT (PaymentSettings).
// #/cai-dat/may-in: this device's receipt printer (PrintSettings).
// #/cai-dat/mau-in: the shop's receipt words and sizes (ReceiptTemplateSettings).
// #/cai-dat/ma-qr: QR stickers per table for khách tự gọi món (GuestQrSettings).
// #/cai-dat/chi-nhanh: the owner's branches; #/cai-dat/gio-lam: this branch's opening hours (BranchSettings).

import { useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import { SettingsBack, TopBar } from '../auth/chrome'
import { useAuth } from '../auth/context'
import { settingsFor } from '../auth/guards'
import { ReposContext, useRoute, useSource } from '../floor/hooks'
import type { FloorRepo } from '../floor/repo'
import type { FloorState } from '../floor/types'
import '../menu/menu.css'
import '../floor/floor.css'
import '../auth/auth.css'
import { BranchesPage, OpeningHoursPage } from './BranchSettings'
import { GuestQrSettings } from './GuestQrSettings'
import { PaymentSettings } from './PaymentSettings'
import { PrintSettingsPage } from './PrintSettings'
import { ReceiptTemplateSettings } from './ReceiptTemplateSettings'
import './settings.css'

export function SettingsApp() {
  const { session } = useAuth()
  const route = useRoute()
  const repos = useContext(ReposContext)
  if (route[1] === 'thanh-toan' && repos) return <PaymentPage repo={repos.floor} />
  if (route[1] === 'may-in' && repos) return <PrintSettingsPage repo={repos.floor} />
  if (route[1] === 'mau-in' && repos)
    return (
      <PaymentPage repo={repos.floor}>
        {(floor, onError, onInfo) => <ReceiptTemplateSettings floor={floor} repo={repos.floor} onError={onError} onInfo={onInfo} />}
      </PaymentPage>
    )
  if (route[1] === 'ma-qr' && repos)
    return (
      <PaymentPage repo={repos.floor}>
        {(floor, onError, onInfo) => <GuestQrSettings floor={floor} repo={repos.floor} onError={onError} onInfo={onInfo} />}
      </PaymentPage>
    )
  if (route[1] === 'chi-nhanh') return <ToastPage>{(onError, onInfo) => <BranchesPage onError={onError} onInfo={onInfo} />}</ToastPage>
  if (route[1] === 'gio-lam') return <ToastPage>{(onError, onInfo) => <OpeningHoursPage onError={onError} onInfo={onInfo} />}</ToastPage>
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

/** A settings page with a toast. */
function ToastPage(props: { children: (onError: (m: string) => void, onInfo: (m: string) => void) => ReactNode }) {
  const [toast, setToast] = useState<{ text: string; ok?: boolean } | null>(null)
  const onError = useCallback((m: string) => setToast({ text: m }), [])
  const onInfo = useCallback((m: string) => setToast({ text: m, ok: true }), [])
  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), toast.ok ? 2500 : 5000)
    return () => clearTimeout(t)
  }, [toast])
  return (
    <div className="menu-app floor-app">
      <TopBar />
      <SettingsBack />
      <main className="settings-main">{props.children(onError, onInfo)}</main>
      {toast && (
        <div className={'toast' + (toast.ok ? ' toast-ok' : '')} role={toast.ok ? 'status' : 'alert'} onClick={() => setToast(null)}>
          {toast.text}
        </div>
      )}
    </div>
  )
}

/** A settings page that needs the floor state (shop settings), with a toast; Thanh toán unless children say otherwise. */
function PaymentPage(props: { repo: FloorRepo; children?: (floor: FloorState, onError: (m: string) => void, onInfo: (m: string) => void) => ReactNode }) {
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
      <main className="settings-main">{floor ? (props.children ? props.children(floor, onError, onInfo) : <PaymentSettings floor={floor} repo={props.repo} onError={onError} onInfo={onInfo} />) : <p className="muted">Đang tải…</p>}</main>
      {toast && (
        <div className={'toast' + (toast.ok ? ' toast-ok' : '')} role={toast.ok ? 'status' : 'alert'} onClick={() => setToast(null)}>
          {toast.text}
        </div>
      )}
    </div>
  )
}
