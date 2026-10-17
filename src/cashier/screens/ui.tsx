// Small pieces shared by the cashier screens: money input, receipt preview (the exact print HTML in an iframe),
// QR image.

import { useEffect, useMemo, useRef, useState } from 'react'
import { formatMoney } from '../../lib/billing'
import { qrSvg, receiptHtml } from '../print'
import type { Block } from '../receipt'

/** Whole-đồng input shown with thousand dots ("1.274.000"); empty = null. */
export function MoneyInput(props: { value: number | null; onChange: (v: number | null) => void; label: string; disabled?: boolean; autoFocus?: boolean; placeholder?: string }) {
  const [text, setText] = useState(props.value == null ? '' : formatMoney(props.value))
  const [focused, setFocused] = useState(false)
  const shown = focused ? text : props.value == null ? '' : formatMoney(props.value)
  return (
    <span className="money">
      <input
        inputMode="numeric"
        aria-label={props.label}
        disabled={props.disabled}
        autoFocus={props.autoFocus}
        placeholder={props.placeholder}
        value={shown}
        onFocus={e => {
          setFocused(true)
          setText(props.value == null ? '' : formatMoney(props.value))
          e.target.select()
        }}
        onBlur={() => setFocused(false)}
        onChange={e => {
          const digits = e.target.value.replace(/\D/g, '').slice(0, 11)
          setText(digits ? formatMoney(Number(digits)) : '')
          props.onChange(digits ? Number(digits) : null)
        }}
      />
      <span className="money-unit">đ</span>
    </span>
  )
}

/** The receipt exactly as it prints, in an iframe sized to its content. */
export function ReceiptPreview(props: { blocks: Block[]; title: string }) {
  const html = useMemo(() => receiptHtml(props.blocks, props.title), [props.blocks, props.title])
  const ref = useRef<HTMLIFrameElement>(null)
  const [h, setH] = useState(600)
  useEffect(() => {
    const f = ref.current
    if (!f) return
    const fit = () => {
      const d = f.contentDocument
      if (d?.body) setH(d.documentElement.scrollHeight + 4)
    }
    f.addEventListener('load', fit)
    return () => f.removeEventListener('load', fit)
  }, [html])
  return (
    <div className="receipt-paper">
      <iframe ref={ref} title={props.title} srcDoc={html} style={{ height: h }} />
    </div>
  )
}

export function QrImage(props: { payload: string; label: string }) {
  const svg = useMemo(() => qrSvg(props.payload, props.label), [props.payload, props.label])
  return <div className="qr-img" dangerouslySetInnerHTML={{ __html: svg }} />
}
