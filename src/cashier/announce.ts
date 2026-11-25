// Đọc to tiền về (Pay2S, 0030): when the bank reports a transfer, the cashier device says
// "Đã nhận chuyển khoản hai trăm năm mươi nghìn đồng", like the shop's payment speaker.
// The browser's own voice (Web Speech) is used; a device without a Vietnamese voice plays a chime instead.
// It is a per-device choice (localStorage): one cashier screen speaking is enough.

import { useEffect, useState } from 'react'

const DIGITS = ['không', 'một', 'hai', 'ba', 'bốn', 'năm', 'sáu', 'bảy', 'tám', 'chín']

/** 0–999 in words. `full` reads the hundreds even when 0 ("không trăm linh năm") for a group after a bigger one. */
function triple(n: number, full: boolean): string {
  const h = Math.floor(n / 100)
  const t = Math.floor((n % 100) / 10)
  const u = n % 10
  const out: string[] = []
  if (h > 0 || full) out.push(DIGITS[h], 'trăm')
  if (t > 1) {
    out.push(DIGITS[t], 'mươi')
    if (u === 1) out.push('mốt')
    else if (u === 4) out.push('tư')
    else if (u === 5) out.push('lăm')
    else if (u > 0) out.push(DIGITS[u])
  } else if (t === 1) {
    out.push('mười')
    if (u === 5) out.push('lăm')
    else if (u > 0) out.push(DIGITS[u])
  } else if (u > 0) {
    if (out.length) out.push('linh')
    out.push(DIGITS[u])
  }
  return out.join(' ')
}

/** Vietnamese words for a whole amount: 250000 → "hai trăm năm mươi nghìn". */
export function vndWords(amount: number): string {
  let n = Math.floor(Math.abs(amount))
  if (n === 0) return 'không'
  const units = ['', 'nghìn', 'triệu', 'tỷ', 'nghìn tỷ']
  const groups: number[] = []
  while (n > 0) {
    groups.push(n % 1000)
    n = Math.floor(n / 1000)
  }
  const out: string[] = []
  for (let i = groups.length - 1; i >= 0; i--) {
    const g = groups[i]
    if (g === 0) continue
    out.push(triple(g, i < groups.length - 1), units[i] ?? '')
  }
  return out.filter(Boolean).join(' ')
}

export const announceText = (amount: number) => `Đã nhận chuyển khoản ${vndWords(amount)} đồng`

const KEY = 'bmd-announce-money'

export function announceOn(): boolean {
  try {
    return localStorage.getItem(KEY) !== '0'
  } catch {
    return true
  }
}

export function useAnnounce(): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(announceOn)
  const set = (v: boolean) => {
    setOn(v)
    try {
      localStorage.setItem(KEY, v ? '1' : '0')
    } catch {
      /* no storage: this visit only */
    }
  }
  return [on, set]
}

function viVoice(): SpeechSynthesisVoice | undefined {
  const all = window.speechSynthesis?.getVoices() ?? []
  const vi = all.filter(v => v.lang.toLowerCase().replace('_', '-').startsWith('vi'))
  // the online voices sound more natural than the offline ones
  return vi.find(v => /natural|online|google/i.test(v.name)) ?? vi[0]
}

/** A Vietnamese voice, or none known: iPhone apps opened from the home screen often list no voices at all yet still
 * speak by language, so an empty list is worth a try. False only when voices are listed and none is Vietnamese. */
function maySpeakVi(): boolean {
  const synth = typeof window !== 'undefined' ? window.speechSynthesis : undefined
  if (!synth) return false
  return !!viVoice() || synth.getVoices().length === 0
}

/** True when this device can say it in Vietnamese; false means only a chime. Voices load late, so it listens. */
export function useViVoice(): boolean {
  const [has, setHas] = useState(maySpeakVi)
  useEffect(() => {
    const synth = window.speechSynthesis
    if (!synth) return
    const f = () => setHas(maySpeakVi())
    synth.addEventListener?.('voiceschanged', f)
    f()
    return () => synth.removeEventListener?.('voiceschanged', f)
  }, [])
  return has
}

/** Says the text in Vietnamese, or calls `fallback` (a chime) when the device has no Vietnamese voice. */
export function speakVi(text: string, fallback: () => void) {
  const synth = window.speechSynthesis
  if (!synth || !maySpeakVi()) return fallback()
  const voice = viVoice()
  const u = new SpeechSynthesisUtterance(text)
  if (voice) u.voice = voice
  u.lang = voice?.lang ?? 'vi-VN'
  u.rate = 0.95
  // Android lists Vietnamese even when its voice data is not downloaded, then fails: chime instead of silence
  u.onerror = e => {
    if (e.error !== 'interrupted' && e.error !== 'canceled') fallback()
  }
  synth.resume() // Safari can be left paused after the page was in the background
  synth.speak(u)
}

let speechUnlocked = false
/**
 * iPhone (Safari) speaks only after the page has spoken once inside a tap, and keeps page sound behind the silent
 * switch. Call from a tap handler, synchronously: a silent utterance unlocks speech, and the audio session is set to
 * "playback" (Safari 16.4+) so announcements sound even when the phone is on silent.
 */
export function unlockSpeech() {
  try {
    const nav = navigator as Navigator & { audioSession?: { type: string } }
    if (nav.audioSession) nav.audioSession.type = 'playback'
  } catch {
    /* older Safari: the silent switch mutes the chime */
  }
  const synth = window.speechSynthesis
  if (speechUnlocked || !synth) return
  speechUnlocked = true
  const u = new SpeechSynthesisUtterance(' ')
  u.volume = 0
  u.lang = 'vi-VN'
  synth.speak(u)
}

type Lock = { release: () => Promise<void> }
type WakeNav = Navigator & { wakeLock?: { request: (t: 'screen') => Promise<Lock> } }

/** Keeps the screen on while `active` (a phone on the counter would sleep and stop speaking). The browser drops the
 * lock when the page is hidden, so it is asked again when the page comes back. Returns whether the device supports it. */
export function useWakeLock(active: boolean): boolean {
  const supported = typeof navigator !== 'undefined' && !!(navigator as WakeNav).wakeLock
  useEffect(() => {
    if (!active || !supported) return
    let lock: Lock | null = null
    let gone = false
    const take = () => {
      if (document.visibilityState !== 'visible') return
      ;(navigator as WakeNav).wakeLock!.request('screen').then(
        l => (gone ? void l.release().catch(() => {}) : (lock = l)),
        () => {}, // refused (battery saver, no tap yet): the screen sleeps as usual
      )
    }
    take()
    document.addEventListener('visibilitychange', take)
    window.addEventListener('pointerdown', take, { once: true })
    return () => {
      gone = true
      document.removeEventListener('visibilitychange', take)
      window.removeEventListener('pointerdown', take)
      void lock?.release().catch(() => {})
    }
  }, [active, supported])
  return supported
}

// voices load late in Chrome: ask once early so they are ready when money comes
if (typeof window !== 'undefined' && window.speechSynthesis) window.speechSynthesis.getVoices()
