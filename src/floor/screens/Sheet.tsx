// Bottom sheet used by the floor dialogs (same look as the item picker).

import type { ReactNode } from 'react'

export function Sheet(props: { title: string; subtitle?: ReactNode; onClose: () => void; children: ReactNode; foot?: ReactNode }) {
  return (
    <div className="sheet-backdrop" onClick={props.onClose}>
      <div className="sheet" role="dialog" aria-label={props.title} onClick={e => e.stopPropagation()}>
        <header className="sheet-head">
          <div>
            <h2>{props.title}</h2>
            {props.subtitle && <p className="muted">{props.subtitle}</p>}
          </div>
          <button type="button" className="icon-btn" onClick={props.onClose} aria-label="Đóng">
            ✕
          </button>
        </header>
        <div className="sheet-body">{props.children}</div>
        {props.foot && <footer className="sheet-foot">{props.foot}</footer>}
      </div>
    </div>
  )
}

/** Quick guest-count buttons 1–12 plus a number box. */
export function GuestPicker(props: { value: number; onChange: (n: number) => void }) {
  return (
    <div>
      <div className="guest-grid" role="group" aria-label="Số khách">
        {Array.from({ length: 12 }, (_, i) => i + 1).map(n => (
          <button key={n} type="button" className={'chip guest-btn' + (props.value === n ? ' is-on' : '')} aria-pressed={props.value === n} onClick={() => props.onChange(n)}>
            {n}
          </button>
        ))}
      </div>
      <label className="field">
        <span className="field-label">Hoặc gõ số khách</span>
        <input type="number" inputMode="numeric" min={1} max={99} value={props.value || ''} onChange={e => props.onChange(Number(e.target.value) || 0)} />
      </label>
    </div>
  )
}
