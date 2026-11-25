// Voice ordering: the spoken text → the voice-order Edge Function (supabase/functions/voice-order) → order lines.
// Only with the database: the Anthropic key lives on the server, so sample mode has no AI (setVoiceParser can stand
// in for it in tests and in the browser console while developing).

import type { SupabaseClient } from '@supabase/supabase-js'
import type { VoiceResult } from './toDrafts'

let db: SupabaseClient | null = null
let override: ((text: string) => Promise<VoiceResult>) | null = null

/** Called once by App.connect() when the app talks to Supabase (its fetch adds x-staff-session). */
export function setVoiceClient(client: SupabaseClient) {
  db = client
}

/** Replace the server call (tests, or `(await import('/src/voice/voiceApi.ts')).setVoiceParser(...)` in dev). */
export function setVoiceParser(fn: ((text: string) => Promise<VoiceResult>) | null) {
  override = fn
}

export const voiceAvailable = () => !!(override || db)

export async function parseSpoken(text: string): Promise<VoiceResult> {
  if (override) return override(text)
  if (!db) throw new Error('Gọi món bằng giọng nói cần kết nối máy chủ')
  const { data, error } = await db.functions.invoke('voice-order/parse', { body: { text } })
  if (error) {
    // FunctionsHttpError carries the Response: the function answers { error: 'message in Vietnamese' }
    const res = (error as { context?: Response }).context
    const msg = res && typeof res.json === 'function' ? await res.json().then(j => (j as { error?: string }).error, () => null) : null
    throw new Error(msg || 'Không gọi được AI, thử lại')
  }
  const r = data as Partial<VoiceResult> | null
  return { lines: r?.lines ?? [], unmatched: r?.unmatched ?? [] }
}
