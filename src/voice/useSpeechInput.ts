// Speech → text in the browser (Web Speech API, vi-VN): free, good on Chrome / Android, uneven on iPhone.
// Listening stops by itself after a short silence, or when stop() is called. Phones without it fall back to typing
// for now (step 4 adds recording + FPT.AI on the server).

import { useCallback, useEffect, useRef, useState } from 'react'

// The Web Speech types are not in TypeScript's DOM lib; only what is used here.
interface Recognition {
  lang: string
  continuous: boolean
  interimResults: boolean
  onresult: ((e: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null
  onerror: ((e: { error: string }) => void) | null
  onend: (() => void) | null
  start(): void
  stop(): void
  abort(): void
}
type RecognitionCtor = new () => Recognition

const Ctor = (): RecognitionCtor | null => {
  if (typeof window === 'undefined') return null
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}

export const speechSupported = () => Ctor() != null

const ERRORS: Record<string, string> = {
  'not-allowed': 'Chưa cho phép dùng micro. Bấm vào biểu tượng ổ khoá trên thanh địa chỉ để cho phép.',
  'service-not-allowed': 'Trình duyệt không cho nhận giọng nói ở trang này.',
  'no-speech': 'Không nghe thấy gì, hãy nói gần micro hơn.',
  'audio-capture': 'Không tìm thấy micro.',
  network: 'Mất mạng nên không nhận được giọng nói.',
}

const isIos = () =>
  typeof navigator !== 'undefined' &&
  (/iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1))

/**
 * The whole sentence from the recognition results so far. Rebuilt from every result each time instead of added up:
 * Safari on iPhone sends results again, and often each one repeats the words before it ("hai steak", "hai steak 300"),
 * which added up gave "hai steak hai steak 300".
 */
export function joinResults(parts: string[]): string {
  const out: string[] = []
  for (const raw of parts) {
    const t = raw.trim().replace(/\s+/g, ' ')
    if (!t) continue
    const last = out[out.length - 1]
    if (last != null && t.toLowerCase().startsWith(last.toLowerCase())) out[out.length - 1] = t // grew: keep the longer one
    else if (last != null && last.toLowerCase().startsWith(t.toLowerCase())) continue // repeat of what we have
    else if (!out.some(x => x.toLowerCase() === t.toLowerCase())) out.push(t)
  }
  return out.join(' ')
}

export type SpeechState = 'idle' | 'listening' | 'error'

/** `onDone` gets the whole sentence once listening ends (empty when nothing was heard). */
export function useSpeechInput(onDone: (text: string) => void, silenceMs = 2200) {
  const [state, setState] = useState<SpeechState>('idle')
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const rec = useRef<Recognition | null>(null)
  const timer = useRef<number | undefined>(undefined)
  const done = useRef(onDone)
  done.current = onDone

  const stop = useCallback(() => {
    window.clearTimeout(timer.current)
    rec.current?.stop()
  }, [])

  const start = useCallback(() => {
    const C = Ctor()
    if (!C) {
      setState('error')
      setError('Máy này chưa nghe được giọng nói, hãy gõ câu gọi món.')
      return
    }
    rec.current?.abort()
    const r = new C()
    r.lang = 'vi-VN'
    // iPhone: one utterance per start (its continuous mode repeats and drops words); it stops after a pause by itself
    r.continuous = !isIos()
    r.interimResults = true
    let finalText = ''
    let failed = false
    r.onresult = e => {
      const parts: string[] = []
      for (let i = 0; i < e.results.length; i++) parts.push(e.results[i][0].transcript)
      finalText = joinResults(parts)
      setText(finalText)
      window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => r.stop(), silenceMs)
    }
    r.onerror = e => {
      if (e.error === 'aborted') return
      failed = true
      setState('error')
      setError(ERRORS[e.error] ?? 'Không nhận được giọng nói (' + e.error + ')')
    }
    r.onend = () => {
      window.clearTimeout(timer.current)
      if (rec.current === r) rec.current = null
      if (failed) return
      setState('idle')
      done.current(finalText)
    }
    rec.current = r
    setText('')
    setError(null)
    setState('listening')
    try {
      r.start()
    } catch {
      setState('error')
      setError('Không bật được micro, thử lại.')
    }
  }, [silenceMs])

  useEffect(() => () => {
    window.clearTimeout(timer.current)
    rec.current?.abort()
  }, [])

  return { state, text, error, start, stop }
}
