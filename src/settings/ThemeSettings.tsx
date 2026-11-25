// #/cai-dat/giao-dien: the branch's colours (theme/theme.ts, branches.theme 0035). A preset applies at once; the
// three colour pickers make a custom theme; every change shows on the whole page straight away (the page is its own
// preview, plus a strip of sample buttons and table tiles) and is saved for the branch a moment later (a picker sends
// one save when the dragging stops); every device of the branch then changes too.

import { useEffect, useRef, useState } from 'react'
import { useAuth } from '../auth/context'
import { errText } from '../floor/hooks'
import { Section } from '../menu/ui'
import { applyTheme, CUSTOM, contrast, defaultTheme, isDefault, keepTheme, loadTheme, onThemeChange, PRESETS, tokens, type Preset, type Theme } from '../theme/theme'

type Key = 'accent' | 'bg' | 'card' | 'bar'

const PICKERS: { key: Key; label: string; hint: string }[] = [
  { key: 'accent', label: 'Màu chính', hint: 'Nút chính, chữ liên kết, tab đang chọn' },
  { key: 'bg', label: 'Nền', hint: 'Nền màn hình, phía sau các thẻ' },
  { key: 'card', label: 'Thẻ', hint: 'Ô bàn, thẻ đơn, phiếu bếp, khung cài đặt, nút, ô nhập' },
  { key: 'bar', label: 'Thanh trên', hint: 'Thanh có ☰, tên quán và chuông' },
]

/** A preset as a theme (without its name; no card key when the preset works the cards out from the background). */
const themeOf = ({ preset, accent, bg, bar, card }: Preset): Theme => (card ? { preset, accent, bg, bar, card } : { preset, accent, bg, bar })

export function ThemeSettings(props: { onError: (m: string) => void; onInfo: (m: string) => void }) {
  const { repo, branch } = useAuth()
  const [theme, setTheme] = useState<Theme>(loadTheme)
  const [saving, setSaving] = useState(false)
  // a change shown but not saved yet (the picker is still moving)
  const pending = useRef<{ t: Theme; timer: ReturnType<typeof setTimeout> } | null>(null)
  const where = branch?.name ?? 'chi nhánh'
  const { onError, onInfo } = props
  const save = useRef((t: Theme) => {
    void t
  })
  save.current = (t: Theme) => {
    pending.current = null
    setSaving(true)
    repo
      .saveTheme(isDefault(t) ? null : t)
      .then(
        () => {
          keepTheme(t)
          onInfo(`Đã lưu màu cho ${where}: mọi máy của chi nhánh đổi theo.`)
        },
        e => {
          const back = loadTheme()
          applyTheme(back)
          setTheme(back)
          onError(errText(e))
        },
      )
      .finally(() => setSaving(false))
  }
  // another device (or the server after a save) changed the colours: follow, unless a change is waiting here
  useEffect(() => onThemeChange(t => pending.current || setTheme(t)), [])
  // leaving the page while a picker change waits: save it now
  useEffect(
    () => () => {
      const p = pending.current
      if (p) {
        clearTimeout(p.timer)
        save.current(p.t)
      }
    },
    [],
  )
  const pick = (t: Theme, delay = 0) => {
    setTheme(t)
    applyTheme(t)
    if (pending.current) clearTimeout(pending.current.timer)
    pending.current = { t, timer: setTimeout(() => save.current(t), delay) }
  }
  const k = tokens(theme)
  return (
    <div className="theme-settings">
      <h1>Giao diện</h1>
      <p className="muted small">
        Màu của app cho <b>cả {where}</b>: mọi máy của chi nhánh (sơ đồ bàn, bếp, thu ngân, cài đặt, màn đăng nhập) đổi theo ngay, giữ cả
        sau khi tải lại. Trang khách tự gọi món và đặt hàng online giữ màu mặc định.
        {saving && <b> Đang lưu…</b>}
      </p>

      <Section title="Bộ màu sẵn">
        <div className="theme-presets" role="radiogroup" aria-label="Bộ màu sẵn">
          {PRESETS.map(p => (
            <PresetCard key={p.preset} p={p} on={theme.preset === p.preset} onPick={() => pick(themeOf(p))} />
          ))}
        </div>
      </Section>

      <Section title="Tự chỉnh màu" aside={theme.preset === CUSTOM ? <span className="tag-default">Đang dùng</span> : undefined}>
        <div className="theme-pickers">
          {PICKERS.map(f => {
            // no card colour picked: the picker shows the one worked out from the background
            const value = theme[f.key] ?? k.surface
            return (
              <div key={f.key} className="theme-picker">
                <input type="color" id={'theme-' + f.key} value={value} onChange={e => pick({ ...theme, [f.key]: e.target.value, preset: CUSTOM }, 700)} aria-label={f.label} />
                <label htmlFor={'theme-' + f.key}>
                  <b>{f.label}</b> <code className="muted small">{f.key === 'card' && !theme.card ? 'tự theo nền' : value}</code>
                  <span className="muted small block">{f.hint}</span>
                </label>
                {f.key === 'card' && theme.card && (
                  <button
                    type="button"
                    className="link small"
                    onClick={() => {
                      const { card: _, ...rest } = theme
                      void _
                      pick({ ...rest, preset: CUSTOM })
                    }}
                  >
                    Theo nền
                  </button>
                )}
              </div>
            )
          })}
        </div>
        {!isDefault(theme) && <ul className="theme-checks small">
          <Check label="Chữ trên nền" ratio={contrast(k.page.text, k.bg)} need={4.5} />
          <Check label="Chữ trên thẻ" ratio={contrast(k.card.text, k.surface)} need={4.5} />
          <Check label="Chữ trên nút chính" ratio={contrast(k.card.accentInk, k.card.accent)} need={4.5} />
          <Check label="Chữ trên thanh trên" ratio={contrast(k.barInk, k.bar)} need={4.5} />
        </ul>}
        {k.accentAdjusted && <p className="muted small">Màu chính hơi nhạt / đậm so với màu thẻ nên trên thẻ app dùng {k.card.accent} (gần giống) để chữ đọc được.</p>}
        {k.bgAdjusted && <p className="muted small">Nền này lưng chừng giữa sáng và tối nên app dùng {k.bg} để chữ đọc được.</p>}
        {k.cardAdjusted && <p className="muted small">Màu thẻ này lưng chừng giữa sáng và tối nên app dùng {k.surface} để chữ đọc được.</p>}
      </Section>

      <Section title="Xem trước">
        <div className="theme-sample">
          <div className="btn-row">
            <button type="button" className="btn btn-primary">Gửi bếp</button>
            <button type="button" className="btn">Huỷ</button>
            <button type="button" className="chip is-on">Đang chọn</button>
            <button type="button" className="chip">Chưa chọn</button>
          </div>
          <div className="btn-row">
            <span className="badge">Mặc định</span>
            <span className="badge badge-active">Còn món</span>
            <span className="badge badge-req">Bắt buộc</span>
            <a href="#/cai-dat/giao-dien" className="link" onClick={e => e.preventDefault()}>
              Chữ liên kết
            </a>
          </div>
          <div className="theme-tiles">
            <span className="theme-tile st-free">Bàn 1<small>Trống</small></span>
            <span className="theme-tile st-occupied">Bàn 2<small>Có khách</small></span>
            <span className="theme-tile st-bill">Bàn 3<small>Chờ thanh toán</small></span>
          </div>
          <p className="muted small">Chữ phụ trông như thế này.</p>
        </div>
      </Section>

      <div className="pay-settings-actions">
        <button type="button" className="btn" disabled={isDefault(theme) || saving} onClick={() => pick(defaultTheme())}>
          ↺ Về mặc định
        </button>
      </div>
    </div>
  )
}

function PresetCard(props: { p: Preset; on: boolean; onPick: () => void }) {
  const k = tokens(props.p)
  return (
    <button type="button" role="radio" aria-checked={props.on} className={'theme-preset' + (props.on ? ' is-on' : '')} onClick={props.onPick}>
      <span className="theme-mini" style={{ background: k.bg, borderColor: k.page.line }} aria-hidden>
        <span className="theme-mini-bar" style={{ background: k.bar, color: k.barAccent }}>
          ☰ <b>Bò Mỹ Đen</b>
        </span>
        <span className="theme-mini-body">
          <span className="theme-mini-card" style={{ background: k.surface, color: k.card.text, borderColor: k.card.line }}>
            Bàn 1
          </span>
          <span className="theme-mini-btn" style={{ background: k.card.accent, color: k.card.accentInk }}>
            Tạo đơn
          </span>
        </span>
      </span>
      <b>{props.p.name}</b>
    </button>
  )
}

function Check(props: { label: string; ratio: number; need: number }) {
  const ok = props.ratio >= props.need
  return (
    <li className={ok ? 'is-ok' : 'is-low'}>
      {ok ? '✓' : '⚠'} {props.label}: {props.ratio.toFixed(1)} : 1 {ok ? '(dễ đọc)' : `(nên từ ${props.need} : 1)`}
    </li>
  )
}
