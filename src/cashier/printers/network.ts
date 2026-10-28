// WiFi/LAN receipt printers through the shop's bridge app (migration 0018, public/cau-noi-may-in.mjs): the device
// queues ESC/POS bytes in Supabase, the bridge on a shop computer sends them to the printer's port 9100 and reports
// back. Works from any device, iPhone and iPad included. Only with the database: sample mode has no server.

import type { SupabaseClient } from '@supabase/supabase-js'

let db: SupabaseClient | null = null
let conn: { url: string; anonKey: string } | null = null

/** Called once by App.connect() when the app talks to Supabase. */
export function setPrintClient(client: SupabaseClient, url: string, anonKey: string) {
  db = client
  conn = { url, anonKey }
}

export const networkPrintingAvailable = () => !!db

async function rpc<T>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
  if (!db) throw new Error('In qua WiFi cần kết nối máy chủ (bản dữ liệu mẫu không có)')
  const { data, error } = await db.rpc(fn, args)
  if (error) throw new Error(error.message)
  return data as T
}

export interface FoundPrinter {
  host: string
  port: number
  name?: string
}

export interface PrintAgent {
  id: string
  name: string
  printers: FoundPrinter[]
  lastSeen: string | null
  online: boolean
}

export const listAgents = () => rpc<PrintAgent[]>('print_agents_list')
export const rescanAgent = (id: string) => rpc<void>('print_agent_rescan', { p_id: id })
export const deleteAgent = (id: string) => rpc<void>('print_agent_delete', { p_id: id })

/**
 * A new bridge. Returns the connection code to paste into the bridge app: server address, public key and the
 * bridge's secret token in one line (the token is shown this once; only its hash is stored).
 */
export async function createAgent(name: string): Promise<string> {
  const token = await rpc<string>('print_agent_create', { p_name: name })
  const json = JSON.stringify({ u: conn!.url, k: conn!.anonKey, t: token })
  return 'BMD1.' + btoa(json)
}

function base64(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

/** Queues the bytes and waits until the bridge has printed them (or says why not). */
export async function sendNetwork(agentId: string, host: string, port: number, data: Uint8Array, title: string): Promise<void> {
  const id = await rpc<number>('print_submit', { p_agent: agentId, p_host: host, p_port: port, p_data: base64(data), p_title: title.slice(0, 100) })
  const until = Date.now() + 30_000
  while (Date.now() < until) {
    await new Promise(r => setTimeout(r, 600))
    const st = await rpc<{ status: string; error: string } | null>('print_job_status', { p_id: id })
    if (st?.status === 'done') return
    if (st?.status === 'failed') throw new Error(`Máy in ${host}: ${st.error || 'không in được'}`)
  }
  throw new Error('App cầu nối chưa in sau 30 giây: kiểm tra máy tính chạy cầu nối còn bật và có mạng')
}
