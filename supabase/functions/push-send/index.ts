// push-send: one event from the database (push_outbox_flush in migration 0015) → a Web Push to every subscribed
// browser, except the device that did it (exclude_device) or only to one device (only_device, "Gửi thử").
// Called by pg_net with the shared secret in x-push-secret, so it is deployed without JWT verification.
// Subscriptions the push service says are gone (404 / 410) are deleted.

import { createClient } from 'npm:@supabase/supabase-js@2.45.4'
import webpush from 'npm:web-push@3.6.7'

const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } })

interface Event {
  title: string
  body: string
  url: string
  tag: string
  exclude_device: string | null
  only_device: string | null
}

Deno.serve(async req => {
  if (req.method !== 'POST') return new Response('method', { status: 405 })
  const { data: cfg, error } = await db.from('push_config').select('*').eq('id', 1).single()
  if (error || !cfg) return new Response('config', { status: 500 })
  if (!cfg.hook_secret || req.headers.get('x-push-secret') !== cfg.hook_secret) return new Response('forbidden', { status: 403 })

  const ev = (await req.json()) as Event
  let q = db.from('push_subscriptions').select('endpoint, p256dh, auth, device_id')
  if (ev.only_device) q = q.eq('device_id', ev.only_device)
  else if (ev.exclude_device) q = q.neq('device_id', ev.exclude_device)
  const { data: subs, error: subErr } = await q
  if (subErr) return new Response(subErr.message, { status: 500 })

  webpush.setVapidDetails(cfg.vapid_subject, cfg.vapid_public, cfg.vapid_private)
  const payload = JSON.stringify({ title: ev.title, body: ev.body, url: ev.url, tag: ev.tag })
  const gone: string[] = []
  let sent = 0
  await Promise.all(
    (subs ?? []).map(async s => {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, { TTL: 3600, urgency: 'high' })
        sent++
      } catch (e) {
        const code = (e as { statusCode?: number }).statusCode
        if (code === 404 || code === 410) gone.push(s.endpoint)
        else console.error('push failed', code, (e as Error).message)
      }
    }),
  )
  if (gone.length) await db.from('push_subscriptions').delete().in('endpoint', gone)
  return Response.json({ sent, gone: gone.length })
})
