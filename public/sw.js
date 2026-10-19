// Service worker: shows the pushes sent by supabase/functions/push-send (gửi bếp, món xong, thu tiền…) even when the
// app is closed, and opens the right screen when the notification is tapped. No offline cache.

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()))

self.addEventListener('push', e => {
  let d = {}
  try {
    d = e.data ? e.data.json() : {}
  } catch {
    d = { body: e.data ? e.data.text() : '' }
  }
  e.waitUntil(
    self.registration.showNotification(d.title || 'Bò Mỹ Đen', {
      body: d.body || '',
      tag: d.tag || undefined,
      icon: '/icon-192.png',
      badge: '/badge-72.png',
      data: { url: d.url || '#/ban' },
      vibrate: [120, 60, 120],
    }),
  )
})

self.addEventListener('notificationclick', e => {
  e.notification.close()
  const target = new URL('/' + (e.notification.data?.url || '#/ban'), self.location.origin).href
  e.waitUntil(
    (async () => {
      const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      const win = wins.find(w => new URL(w.url).origin === self.location.origin)
      if (win) {
        await win.focus()
        return win.navigate(target).catch(() => win.postMessage({ type: 'open', url: target }))
      }
      return self.clients.openWindow(target)
    })(),
  )
})
