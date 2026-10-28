// Cài đặt → Máy in → Kết nối máy in: how this device prints — the browser's print dialog, a Bluetooth printer found from
// here (Web Bluetooth), or a WiFi/LAN printer found by one of the shop's bridge apps (migration 0018). The choice is
// kept on this device (paper.ts); bridges are shared by the shop and added by whoever may edit settings.

import { useCallback, useEffect, useState } from 'react'
import { useAuth } from '../auth/context'
import { roleCan } from '../auth/permissions'
import { setPrintSettings, usePrintSettings, type PrintTarget } from '../cashier/paper'
import { bluetoothSupported, forgetBluetooth, pickBluetoothPrinter } from '../cashier/printers/bluetooth'
import { createAgent, deleteAgent, listAgents, networkPrintingAvailable, rescanAgent, type PrintAgent } from '../cashier/printers/network'
import { errText } from '../floor/hooks'
import { Section } from '../menu/ui'

type Mode = PrintTarget['kind']

const MODES: { id: Mode; label: string }[] = [
  { id: 'dialog', label: 'Hộp thoại in' },
  { id: 'bluetooth', label: 'Bluetooth' },
  { id: 'network', label: 'WiFi / LAN' },
]

function ago(iso: string | null): string {
  if (!iso) return 'chưa chạy lần nào'
  const min = Math.round((Date.now() - new Date(iso).getTime()) / 60000)
  return min < 1 ? 'vừa xong' : min < 60 ? `${min} phút trước` : min < 1440 ? `${Math.round(min / 60)} giờ trước` : `${Math.round(min / 1440)} ngày trước`
}

export function PrinterConnect(props: { onError: (m: string) => void; onInfo: (m: string) => void }) {
  const s = usePrintSettings()
  const t = s.target
  const [mode, setMode] = useState<Mode>(t.kind)

  return (
    <Section title="Kết nối máy in">
      <div className="chip-row" role="group" aria-label="Cách in">
        {MODES.map(m => (
          <button
            key={m.id}
            type="button"
            className={'chip' + (mode === m.id ? ' is-on' : '')}
            aria-pressed={mode === m.id}
            onClick={() => {
              setMode(m.id)
              if (m.id === 'dialog') setPrintSettings({ target: { kind: 'dialog' } })
            }}
          >
            {m.label}
          </button>
        ))}
      </div>
      <p className="printer-now">
        Đang in qua: <b>{t.kind === 'dialog' ? 'hộp thoại in của trình duyệt' : t.kind === 'bluetooth' ? `Bluetooth · ${t.name}` : `WiFi · ${t.name} (${t.agentName})`}</b>
      </p>
      {mode === 'dialog' && <p className="muted small">Dùng máy in đã cài trên máy này (USB, hoặc Bluetooth/WiFi đã thêm vào Windows). Mỗi lần in sẽ hiện hộp thoại in.</p>}
      {mode === 'bluetooth' && <BluetoothPanel {...props} />}
      {mode === 'network' && <NetworkPanel {...props} />}
    </Section>
  )
}

function BluetoothPanel(props: { onError: (m: string) => void; onInfo: (m: string) => void }) {
  const { target } = usePrintSettings()
  const [busy, setBusy] = useState(false)
  if (!bluetoothSupported())
    return (
      <p className="field-error block">
        Trình duyệt này không kết nối Bluetooth được. Dùng Chrome hoặc Edge trên máy tính Windows hoặc máy Android. iPhone/iPad không hỗ trợ Bluetooth trên web: hãy in qua WiFi / LAN.
      </p>
    )
  const find = () => {
    setBusy(true)
    pickBluetoothPrinter()
      .then(d => {
        const name = d.name || 'Máy in Bluetooth'
        setPrintSettings({ target: { kind: 'bluetooth', id: d.id, name } })
        props.onInfo(`Đã kết nối ${name}. Bấm In thử để kiểm tra.`)
      })
      .catch(e => {
        // closing the chooser is not an error
        if ((e as Error)?.name !== 'NotFoundError') props.onError(errText(e))
      })
      .finally(() => setBusy(false))
  }
  return (
    <div className="printer-panel">
      {target.kind === 'bluetooth' && (
        <div className="printer-row is-on">
          <span>
            <b>{target.name}</b>
            <span className="muted small block">Đã kết nối trên máy này</span>
          </span>
          <button
            type="button"
            className="btn btn-small"
            onClick={() => {
              forgetBluetooth()
              setPrintSettings({ target: { kind: 'dialog' } })
            }}
          >
            Ngắt
          </button>
        </div>
      )}
      <button type="button" className="btn btn-primary" disabled={busy} onClick={find}>
        {busy ? 'Đang tìm…' : '🔍 Tìm máy in Bluetooth'}
      </button>
      <ul className="muted small hint-list">
        <li>Bật máy in và bật Bluetooth trên máy này, để máy in gần (dưới 5m).</li>
        <li>Chọn tên máy in trong danh sách hiện ra (thường bắt đầu bằng Printer, XP-, MTP-, RPP-…) rồi bấm Ghép nối.</li>
        <li>
          Không thấy máy in? Máy in chỉ có Bluetooth đời cũ: ghép đôi nó trong Windows (Cài đặt → Bluetooth) rồi chọn <b>Hộp thoại in</b>.
        </li>
      </ul>
    </div>
  )
}

function NetworkPanel(props: { onError: (m: string) => void; onInfo: (m: string) => void }) {
  const { session } = useAuth()
  const canManage = roleCan(session.role, 'settings.edit')
  const { target } = usePrintSettings()
  const [agents, setAgents] = useState<PrintAgent[] | null>(null)
  const [manual, setManual] = useState<Record<string, string>>({})
  const [newName, setNewName] = useState('Máy tính quầy')
  const [code, setCode] = useState('')
  const { onError } = props

  const load = useCallback(() => {
    listAgents().then(setAgents, e => onError(errText(e)))
  }, [onError])
  useEffect(() => {
    if (!networkPrintingAvailable()) return
    load()
    const t = setInterval(load, 5000)
    return () => clearInterval(t)
  }, [load])

  if (!networkPrintingAvailable()) return <p className="field-error block">In qua WiFi cần kết nối máy chủ; bản dữ liệu mẫu không dùng được.</p>

  const choose = (a: PrintAgent, host: string, port: number, name: string) => {
    setPrintSettings({ target: { kind: 'network', agentId: a.id, agentName: a.name, host, port, name } })
    props.onInfo(`Đã chọn ${name}. Bấm In thử để kiểm tra.`)
  }
  const chooseManual = (a: PrintAgent) => {
    const [host, p] = (manual[a.id] ?? '').trim().split(':')
    if (!/^[0-9A-Za-z.-]{3,100}$/.test(host ?? '')) return props.onError('Nhập địa chỉ IP máy in, ví dụ 192.168.1.100')
    const port = p ? Number(p) : 9100
    if (!Number.isInteger(port) || port < 1 || port > 65535) return props.onError('Cổng phải là số từ 1 đến 65535')
    choose(a, host, port, `Máy in ${host}`)
  }
  const add = () => {
    if (!newName.trim()) return props.onError('Đặt tên cho máy tính chạy cầu nối')
    createAgent(newName.trim()).then(c => {
      setCode(c)
      load()
    }, e => props.onError(errText(e)))
  }

  return (
    <div className="printer-panel">
      {agents === null ? (
        <p className="muted">Đang tải…</p>
      ) : agents.length === 0 ? (
        <p className="muted">Chưa có app cầu nối nào. {canManage ? 'Thêm ở bên dưới.' : 'Nhờ quản lý thêm app cầu nối trên máy tính ở quán.'}</p>
      ) : (
        agents.map(a => (
          <div key={a.id} className="agent-card">
            <div className="agent-head">
              <span>
                <b>💻 {a.name}</b>
                <span className={'small block ' + (a.online ? 'agent-on' : 'muted')}>{a.online ? '● Đang chạy' : `○ Không chạy · lần cuối ${ago(a.lastSeen)}`}</span>
              </span>
              <span className="agent-actions">
                <button type="button" className="btn btn-small" disabled={!a.online} onClick={() => rescanAgent(a.id).then(() => props.onInfo('Cầu nối đang dò lại máy in (khoảng 10 giây)'), e => props.onError(errText(e)))}>
                  Dò lại
                </button>
                {canManage && (
                  <button
                    type="button"
                    className="btn btn-small"
                    onClick={() => {
                      if (confirm(`Xoá cầu nối "${a.name}"? App trên máy tính đó sẽ ngừng in.`)) deleteAgent(a.id).then(load, e => props.onError(errText(e)))
                    }}
                  >
                    Xoá
                  </button>
                )}
              </span>
            </div>
            {a.printers.length ? (
              a.printers.map(p => {
                const on = target.kind === 'network' && target.agentId === a.id && target.host === p.host && target.port === p.port
                return (
                  <div key={`${p.host}:${p.port}`} className={'printer-row' + (on ? ' is-on' : '')}>
                    <span>
                      <b>🖨 {p.name || p.host}</b>
                      <span className="muted small block">
                        {p.host}:{p.port}
                      </span>
                    </span>
                    <button type="button" className={'btn btn-small' + (on ? '' : ' btn-primary')} disabled={on} onClick={() => choose(a, p.host, p.port, p.name || p.host)}>
                      {on ? '✓ Đang dùng' : 'Dùng máy in này'}
                    </button>
                  </div>
                )
              })
            ) : (
              <p className="muted small">{a.online ? 'Chưa thấy máy in nào trong mạng (cổng 9100). Kiểm tra máy in đã bật và cùng WiFi, rồi bấm Dò lại.' : 'Bật máy tính chạy cầu nối để thấy máy in.'}</p>
            )}
            <div className="manual-row">
              <input
                placeholder="Hoặc nhập IP máy in, ví dụ 192.168.1.100"
                aria-label="Địa chỉ IP máy in"
                value={manual[a.id] ?? ''}
                onChange={e => setManual({ ...manual, [a.id]: e.target.value })}
              />
              <button type="button" className="btn btn-small" onClick={() => chooseManual(a)}>
                Dùng
              </button>
            </div>
          </div>
        ))
      )}

      {canManage && (
        <details className="agent-add" open={!!code || agents?.length === 0}>
          <summary>➕ Thêm app cầu nối (máy tính ở quán)</summary>
          <ol className="print-steps">
            <li>
              Chọn một máy tính Windows ở quán, luôn bật và cùng mạng WiFi/LAN với máy in. Cài <b>Node.js</b> bản LTS từ{' '}
              <a href="https://nodejs.org" target="_blank" rel="noreferrer">
                nodejs.org
              </a>
              .
            </li>
            <li>
              Trên máy tính đó, tải file{' '}
              <a href="/cau-noi-may-in.mjs" download>
                cau-noi-may-in.mjs
              </a>{' '}
              vào một thư mục, ví dụ <code>C:\BoMyDen</code>.
            </li>
            <li>
              Tạo mã kết nối:
              <div className="manual-row">
                <input aria-label="Tên máy tính chạy cầu nối" value={newName} maxLength={60} onChange={e => setNewName(e.target.value)} />
                <button type="button" className="btn btn-small btn-primary" onClick={add}>
                  Tạo mã
                </button>
              </div>
              {code && (
                <div className="agent-code">
                  <textarea readOnly rows={3} value={code} onFocus={e => e.target.select()} aria-label="Mã kết nối" />
                  <button type="button" className="btn btn-small" onClick={() => navigator.clipboard?.writeText(code).then(() => props.onInfo('Đã chép mã kết nối'), () => undefined)}>
                    Chép mã
                  </button>
                  <span className="field-error block small">Mã chỉ hiện một lần. Ai có mã này đều in được ra máy in của quán: không gửi lên mạng xã hội.</span>
                </div>
              )}
            </li>
            <li>
              Mở <b>Command Prompt</b> trong thư mục đó, chạy <code>node cau-noi-may-in.mjs --tu-chay</code> rồi dán mã. Cầu nối sẽ tự dò máy in và tự chạy mỗi khi bật máy.
            </li>
          </ol>
        </details>
      )}
    </div>
  )
}
