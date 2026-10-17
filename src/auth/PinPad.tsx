// PIN entry for shared devices: dots for the digits typed, a big 3×4 keypad (also the keyboard: digits,
// Backspace, Enter). 4–6 digits; OK submits.

import { useEffect, useRef, useState } from 'react'

export function PinPad(props: { onSubmit: (pin: string) => void; busy?: boolean; error?: string; disabled?: boolean; label: string; resetKey?: unknown }) {
  const [pin, setPinState] = useState('')
  const pinRef = useRef('')
  const setPin = (f: (p: string) => string) => {
    pinRef.current = f(pinRef.current)
    setPinState(pinRef.current)
  }
  const { onSubmit, busy, disabled } = props
  useEffect(() => {
    pinRef.current = ''
    setPinState('')
  }, [props.resetKey, props.error])
  const off = !!busy || !!disabled
  const press = (k: string) => {
    if (off) return
    if (k === 'del') setPin(p => p.slice(0, -1))
    else if (k === 'ok') {
      if (pin.length >= 4) onSubmit(pin)
    } else setPin(p => (p.length < 6 ? p + k : p))
  }
  useEffect(() => {
    const set = (p: string) => {
      pinRef.current = p
      setPinState(p)
    }
    const f = (e: KeyboardEvent) => {
      if (off || e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      const p = pinRef.current
      if (/^[0-9]$/.test(e.key)) set(p.length < 6 ? p + e.key : p)
      else if (e.key === 'Backspace') set(p.slice(0, -1))
      else if (e.key === 'Enter') {
        if (pinRef.current.length >= 4) onSubmit(pinRef.current)
      } else return
      e.preventDefault()
    }
    window.addEventListener('keydown', f)
    return () => window.removeEventListener('keydown', f)
  }, [off, onSubmit])
  return (
    <div className="pinpad">
      <div className="pin-dots" role="status" aria-label={`${props.label}: đã nhập ${pin.length} số`}>
        {Array.from({ length: Math.max(4, pin.length) }, (_, i) => (
          <span key={i} className={'pin-dot' + (i < pin.length ? ' is-on' : '')} />
        ))}
      </div>
      <p className={'pin-msg' + (props.error ? ' is-error' : '')} role={props.error ? 'alert' : undefined}>
        {props.error || (busy ? 'Đang kiểm tra…' : '4–6 chữ số')}
      </p>
      <div className="pin-keys" role="group" aria-label={props.label}>
        {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map(k => (
          <button key={k} type="button" className="pin-key" disabled={off} onClick={() => press(k)}>
            {k}
          </button>
        ))}
        <button type="button" className="pin-key pin-key-fn" disabled={off || !pin} onClick={() => press('del')} aria-label="Xoá một số">
          ⌫
        </button>
        <button type="button" className="pin-key" disabled={off} onClick={() => press('0')}>
          0
        </button>
        <button type="button" className="pin-key pin-key-ok" disabled={off || pin.length < 4} onClick={() => press('ok')}>
          OK
        </button>
      </div>
    </div>
  )
}
