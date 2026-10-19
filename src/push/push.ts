// Web Push on this device (migration 0015 + supabase/functions/push-send): the service worker shows every activity
// (gửi bếp, món xong, thu tiền…) even when the app is closed. Only with the database: sample mode has no server.
// iPhone / iPad: only after "Thêm vào Màn hình chính" (iOS 16.4+), and the app opened from that icon.

import type { SupabaseClient } from '@supabase/supabase-js'

let db: SupabaseClient | null = null

/** Called once by App.connect() when the app talks to Supabase. */
export function setPushClient(client: SupabaseClient) {
  db = client
}

export type PushState = 'unsupported' | 'need-install' | 'denied' | 'off' | 'on'

const isIos = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
const standalone = () => window.matchMedia?.('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true

export function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return
  navigator.serviceWorker.register('/sw.js').catch(() => {
    /* no service worker: no pushes, the app works the same */
  })
  // a tapped notification asks an open window to go to its screen
  navigator.serviceWorker.addEventListener('message', e => {
    const d = e.data as { type?: string; url?: string }
    if (d?.type === 'open' && d.url) location.href = d.url
  })
}

export async function pushState(): Promise<PushState> {
  if (!db) return 'unsupported'
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return isIos() && !standalone() ? 'need-install' : 'unsupported'
  if (Notification.permission === 'denied') return 'denied'
  const reg = await navigator.serviceWorker.getRegistration()
  const sub = await reg?.pushManager.getSubscription()
  return sub && Notification.permission === 'granted' ? 'on' : 'off'
}

function keyBytes(b64url: string): Uint8Array {
  const b64 = (b64url + '='.repeat((4 - (b64url.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/')
  return Uint8Array.from(atob(b64), c => c.charCodeAt(0))
}

async function rpc(fn: string, args: Record<string, unknown> = {}) {
  const { data, error } = await db!.rpc(fn, args)
  if (error) throw new Error(error.message)
  return data
}

/** Asks the browser (must run from a tap), subscribes and saves the subscription for this device. */
export async function enablePush(): Promise<PushState> {
  if (!db) return 'unsupported'
  const perm = await Notification.requestPermission()
  if (perm !== 'granted') return perm === 'denied' ? 'denied' : 'off'
  const reg = await navigator.serviceWorker.register('/sw.js')
  await navigator.serviceWorker.ready
  const key = String((await rpc('push_public_key')) ?? '')
  if (!key) throw new Error('Máy chủ chưa cài khoá thông báo')
  const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key) as BufferSource }))
  const j = sub.toJSON()
  await rpc('push_subscribe', { p_endpoint: sub.endpoint, p_p256dh: j.keys?.p256dh ?? '', p_auth: j.keys?.auth ?? '' })
  await rpc('push_test')
  return 'on'
}

export async function disablePush(): Promise<PushState> {
  const reg = await navigator.serviceWorker.getRegistration()
  const sub = await reg?.pushManager.getSubscription()
  if (sub) {
    await rpc('push_unsubscribe', { p_endpoint: sub.endpoint }).catch(() => undefined)
    await sub.unsubscribe()
  }
  return 'off'
}

export async function testPush() {
  await rpc('push_test')
}
