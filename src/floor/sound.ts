// Short synthesized alerts, one per event, so the kitchen knows what happened without looking:
// new ticket "ding", SỬA two beeps, HUỶ a long horn, GIỤC a bell, late a low tone, waiter "món xong".
// Browsers only play sound after a tap: the kitchen starts the shift with "Bắt đầu ca – bật âm thanh".

export type SoundKind = 'new' | 'modify' | 'void' | 'chase' | 'late' | 'ready' | 'move'

type Tone = { f: number; at: number; dur: number; type?: OscillatorType; gain?: number }

const PATTERNS: Record<SoundKind, Tone[]> = {
  new: [{ f: 1320, at: 0, dur: 0.35, type: 'sine' }],
  modify: [{ f: 990, at: 0, dur: 0.14, type: 'square', gain: 0.25 }, { f: 990, at: 0.22, dur: 0.14, type: 'square', gain: 0.25 }],
  void: [{ f: 440, at: 0, dur: 1.2, type: 'sawtooth', gain: 0.3 }],
  chase: [{ f: 1760, at: 0, dur: 0.25 }, { f: 1480, at: 0.25, dur: 0.25 }, { f: 1760, at: 0.5, dur: 0.35 }],
  late: [{ f: 196, at: 0, dur: 0.6, type: 'triangle', gain: 0.6 }],
  ready: [{ f: 880, at: 0, dur: 0.15 }, { f: 1175, at: 0.16, dur: 0.3 }],
  move: [{ f: 660, at: 0, dur: 0.12, gain: 0.25 }],
}

let ctx: AudioContext | null = null
let volume = 0.8
const lastPlayed = new Map<SoundKind, number>()

export function soundReady(): boolean {
  return !!ctx && ctx.state === 'running'
}

/** Call from a tap. Returns false when the browser has no audio. */
export async function unlockSound(): Promise<boolean> {
  try {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!AC) return false
    ctx ??= new AC()
    await ctx.resume()
    return ctx.state === 'running'
  } catch {
    return false
  }
}

export function setVolume(v: number) {
  volume = Math.max(0, Math.min(1, v))
}

/** Plays one alert; the same kind at most once every 2 seconds (many tickets at once ring once). */
export function play(kind: SoundKind) {
  if (!ctx || ctx.state !== 'running' || volume === 0) return
  const t = performance.now()
  if (t - (lastPlayed.get(kind) ?? -1e9) < 2000) return
  lastPlayed.set(kind, t)
  const start = ctx.currentTime + 0.02
  for (const tone of PATTERNS[kind]) {
    const osc = ctx.createOscillator()
    const g = ctx.createGain()
    osc.type = tone.type ?? 'sine'
    osc.frequency.value = tone.f
    const peak = (tone.gain ?? 0.5) * volume
    g.gain.setValueAtTime(0.0001, start + tone.at)
    g.gain.exponentialRampToValueAtTime(peak, start + tone.at + 0.02)
    g.gain.exponentialRampToValueAtTime(0.0001, start + tone.at + tone.dur)
    osc.connect(g).connect(ctx.destination)
    osc.start(start + tone.at)
    osc.stop(start + tone.at + tone.dur + 0.05)
  }
}
