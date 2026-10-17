// Small form pieces shared by the menu screens.

import type { ReactNode } from 'react'

export function Field(props: { label: string; error?: string; hint?: ReactNode; children: ReactNode; wide?: boolean }) {
  return (
    <label className={'field' + (props.wide ? ' field-wide' : '') + (props.error ? ' has-error' : '')}>
      <span className="field-label">{props.label}</span>
      {props.children}
      {props.error ? <span className="field-error">{props.error}</span> : props.hint ? <span className="field-hint">{props.hint}</span> : null}
    </label>
  )
}

export function Switch(props: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; disabled?: boolean }) {
  return (
    <label className={'switch' + (props.disabled ? ' is-disabled' : '')}>
      <input type="checkbox" checked={props.checked} disabled={props.disabled} onChange={e => props.onChange(e.target.checked)} />
      <span className="switch-track" aria-hidden />
      <span>{props.label}</span>
    </label>
  )
}

/** Whole-VND input. Empty reads as 0. */
export function MoneyInput(props: { value: number; onChange: (v: number) => void; ariaLabel?: string; disabled?: boolean }) {
  return (
    <span className="money">
      <input
        type="number"
        inputMode="numeric"
        min={0}
        step={1000}
        aria-label={props.ariaLabel}
        disabled={props.disabled}
        value={Number.isFinite(props.value) ? props.value : ''}
        onChange={e => props.onChange(e.target.value === '' ? 0 : Number(e.target.value))}
      />
      <span className="money-unit">đ</span>
    </span>
  )
}

export function Stepper(props: { value: number; min?: number; max?: number; onChange: (v: number) => void; label: string }) {
  const min = props.min ?? 0
  const max = props.max ?? 99
  return (
    <span className="stepper" role="group" aria-label={props.label}>
      <button type="button" onClick={() => props.onChange(Math.max(min, props.value - 1))} disabled={props.value <= min} aria-label={`Bớt ${props.label}`}>
        −
      </button>
      <span className="stepper-value">{props.value}</span>
      <button type="button" onClick={() => props.onChange(Math.min(max, props.value + 1))} disabled={props.value >= max} aria-label={`Thêm ${props.label}`}>
        +
      </button>
    </span>
  )
}

export function Section(props: { title: string; children: ReactNode; aside?: ReactNode; error?: string }) {
  return (
    <section className="card">
      <header className="card-head">
        <h2>{props.title}</h2>
        {props.aside}
      </header>
      {props.error && <p className="field-error block">{props.error}</p>}
      {props.children}
    </section>
  )
}
