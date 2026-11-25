// Gọi món bằng giọng nói: listen → AI reads the sentence (voice-order) → the waiter checks the lines → into the cart.
// Nothing reaches the cart without "Thêm vào giỏ". The heard text can be corrected and read again; lines open in the
// usual item picker, and a line still missing something (size, độ chín) goes into the cart red, as when tapped.

import { useCallback, useEffect, useState } from 'react'
import { describeLine, quoteLine, vnd, type PickerState } from '../menu/picker'
import { ItemPicker } from '../menu/screens/ItemPicker'
import type { Menu, MenuItem } from '../menu/types'
import { toDrafts } from './toDrafts'
import { speechSupported, useSpeechInput } from './useSpeechInput'
import { parseSpoken } from './voiceApi'
import './voice.css'

type Line = { id: number; item: MenuItem; state: PickerState; heard: string }
type Phase = 'listening' | 'typing' | 'reading' | 'review'

let nextId = 1

export function VoiceSheet(props: { menu: Menu; now: Date; onAdd: (lines: PickerState[]) => void; onClose: () => void }) {
  const { menu, now } = props
  const [phase, setPhase] = useState<Phase>(speechSupported() ? 'listening' : 'typing')
  const [said, setSaid] = useState('')
  const [lines, setLines] = useState<Line[]>([])
  const [unmatched, setUnmatched] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState<Line | null>(null)

  const read = useCallback(async (text: string) => {
    const t = text.trim()
    setSaid(t)
    if (!t) {
      setPhase('typing')
      setError('Không nghe thấy gì. Nói lại hoặc gõ câu gọi món.')
      return
    }
    setPhase('reading')
    setError(null)
    try {
      const r = toDrafts(menu, await parseSpoken(t), now)
      setLines(prev => [...prev, ...r.drafts.map(d => ({ id: nextId++, item: d.item, state: d.state, heard: d.heard }))])
      setUnmatched(r.unmatched)
      setSaid('')
      setPhase('review')
    } catch (e) {
      setError((e as Error).message)
      setPhase('typing')
    }
  }, [menu, now])

  const speech = useSpeechInput(read)
  const { start } = speech
  useEffect(() => {
    if (phase === 'listening') start()
    // only when the sheet opens; "Nói tiếp" starts it again
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useEffect(() => {
    if (speech.state === 'error') {
      setError(speech.error)
      setPhase('typing')
    }
  }, [speech.state, speech.error])

  const listenAgain = () => {
    setError(null)
    setPhase('listening')
    start()
  }

  const quoted = lines.map(l => ({ l, q: quoteLine(menu, l.item, l.state, now) }))
  const bad = quoted.filter(x => !x.q.canAdd).length
  const total = quoted.reduce((s, x) => s + (x.q.total ?? 0), 0)

  return (
    <div className="sheet-backdrop" onClick={props.onClose}>
      <div className="sheet voice-sheet" role="dialog" aria-label="Gọi món bằng giọng nói" onClick={e => e.stopPropagation()}>
        <header className="sheet-head">
          <div>
            <h2>🎤 Gọi món bằng giọng nói</h2>
            <p className="muted">Ví dụ: “2 steak 300 medium không trứng, 3 lon Tiger”</p>
          </div>
          <button type="button" className="icon-btn" aria-label="Đóng" onClick={props.onClose}>
            ✕
          </button>
        </header>

        <div className="sheet-body">
          {phase === 'listening' && (
            <div className="voice-listen">
              <button type="button" className="voice-orb is-on" aria-label="Dừng nghe" onClick={speech.stop}>
                🎤
              </button>
              <p className="voice-live">{speech.text || 'Đang nghe… mời nói'}</p>
              <p className="muted small">Ngừng nói một chút là tự dừng, hoặc bấm micro.</p>
            </div>
          )}

          {phase === 'reading' && (
            <div className="voice-listen">
              <p className="voice-live">«{said}»</p>
              <p className="muted">⏳ Đang hiểu câu gọi món…</p>
            </div>
          )}

          {phase === 'typing' && (
            <form className="voice-type" onSubmit={e => (e.preventDefault(), read(said))}>
              {error && <p className="warn">{error}</p>}
              <label className="muted small" htmlFor="voice-text">
                Câu gọi món (sửa chữ nghe sai rồi bấm Đọc lại)
              </label>
              <textarea id="voice-text" rows={3} value={said} onChange={e => setSaid(e.target.value)} placeholder="2 steak 300 medium, 3 lon Tiger" />
              <div className="btn-pair">
                {speechSupported() && (
                  <button type="button" className="btn" onClick={listenAgain}>
                    🎤 Nói lại
                  </button>
                )}
                <button type="submit" className="btn btn-primary" disabled={!said.trim()}>
                  Đọc lại
                </button>
              </div>
            </form>
          )}

          {(lines.length > 0 || unmatched.length > 0) && (
            <ul className="voice-lines" aria-label="Món nghe được">
              {quoted.map(({ l, q }) => (
                <li key={l.id} className={q.canAdd ? '' : 'is-bad'}>
                  <button type="button" className="cart-line" onClick={() => setEditing(l)}>
                    <span>
                      <b>
                        {l.state.qty} × {l.item.name}
                      </b>
                      <span className="muted small">{describeLine(menu, l.item, l.state)}</span>
                      {l.heard && <span className="voice-heard">«{l.heard}»</span>}
                      {!q.canAdd && <span className="field-error">{q.issues.find(i => i.level === 'error')?.message} · bấm để sửa</span>}
                    </span>
                    <b>{q.total != null ? vnd(q.total) : '—'}</b>
                  </button>
                  <button type="button" className="icon-btn" aria-label="Bỏ dòng" onClick={() => setLines(p => p.filter(x => x.id !== l.id))}>
                    ✕
                  </button>
                </li>
              ))}
              {unmatched.map((u, i) => (
                <li key={'u' + i} className="voice-unmatched">
                  ❓ Chưa hiểu: «{u}» — nói lại hoặc chọn tay trên menu
                </li>
              ))}
            </ul>
          )}
        </div>

        <footer className="sheet-foot">
          {phase === 'review' && (
            <button type="button" className="btn" onClick={listenAgain} disabled={!speechSupported()}>
              🎤 Nói tiếp
            </button>
          )}
          <button
            type="button"
            className="btn btn-primary btn-grow"
            disabled={!lines.length || phase === 'reading' || phase === 'listening'}
            onClick={() => props.onAdd(lines.map(l => l.state))}
          >
            <span>
              {!lines.length ? 'Thêm vào giỏ' : bad > 0 ? `Thêm ${lines.length} món (${bad} cần sửa)` : `Thêm ${lines.length} món · ${vnd(total)}`}
            </span>
          </button>
        </footer>
      </div>

      {editing && (
        <ItemPicker
          key={editing.id}
          menu={menu}
          item={editing.item}
          initial={editing.state}
          now={now}
          addLabel="Lưu"
          onAdd={s => (setLines(p => p.map(x => (x.id === editing.id ? { ...x, state: s } : x))), setEditing(null))}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  )
}
