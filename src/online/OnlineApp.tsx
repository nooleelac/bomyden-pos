// Đặt hàng online (dathang.bomyden.vn, or #/dat-hang): the guest picks a branch (nearest with their position), the
// dishes, then name, phone, address and how to pay. Staff enter the real ship fee; the guest sees the sum and agrees; a
// transfer then shows the VietQR. No sign-in: the order ids this phone picked are what it can read.

import { useCallback, useEffect, useState } from 'react'
import { qrSvg } from '../cashier/print'
import { errText } from '../floor/hooks'
import { Sheet } from '../floor/screens/Sheet'
import type { OnlinePay, OnlineStatus } from '../floor/types'
import type { GeoFix } from '../lib/geo'
import { carrierLabel, onlineCode } from '../lib/ship'
import { vietQrPayload } from '../lib/vietqr'
import { useCart } from '../menu/cart'
import '../menu/menu.css'
import '../floor/floor.css'
import { describeLine, quoteLine, toSendLine, vnd } from '../menu/picker'
import { newId } from '../menu/repo'
import { OrderScreen } from '../menu/screens/OrderScreen'
import '../guest/guest.css'
import type { OnlineBranch, OnlineMenuView, OnlineOrderView, OnlineRepo } from './repo'

const POLL_MS = 5000
const MENU_MS = 60_000
const SENT_KEY = 'bmd-online-sent'

function useSentIds() {
  const [ids, setIds] = useState<string[]>(() => {
    try {
      const v = JSON.parse(localStorage.getItem(SENT_KEY) ?? '[]')
      return Array.isArray(v) ? v.slice(-20) : []
    } catch {
      return []
    }
  })
  const add = (id: string) =>
    setIds(prev => {
      const next = [...prev, id].slice(-20)
      try {
        localStorage.setItem(SENT_KEY, JSON.stringify(next))
      } catch {
        /* private mode: kept in memory */
      }
      return next
    })
  return [ids, add] as const
}

/** The phone's position, or the reason there is none. */
function locate(): Promise<GeoFix> {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('Trình duyệt này không lấy được vị trí'))
    navigator.geolocation.getCurrentPosition(
      p => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy }),
      e => reject(new Error(e.code === e.PERMISSION_DENIED ? 'Trình duyệt đang chặn vị trí: cho phép vị trí rồi thử lại' : 'Chưa lấy được vị trí, bạn vẫn đặt được: quán sẽ báo phí ship')),
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 60_000 },
    )
  })
}

const km = (m: number) => `${(m / 1000).toLocaleString('vi-VN', { maximumFractionDigits: 1 })} km`

export function OnlineApp(props: { repo: OnlineRepo }) {
  const { repo } = props
  const [branches, setBranches] = useState<OnlineBranch[] | null>(null)
  const [branchId, setBranchId] = useState('')
  const [picked, setPicked] = useState(false)
  const [fix, setFix] = useState<GeoFix | null>(null)
  const [locating, setLocating] = useState(false)
  const [fatal, setFatal] = useState('')
  const [tab, setTab] = useState<'menu' | 'orders'>('menu')
  const [orders, setOrders] = useState<OnlineOrderView[]>([])
  const [toast, setToast] = useState<{ text: string; ok?: boolean } | null>(null)
  const [sentIds, addSent] = useSentIds()

  const loadBranches = useCallback(
    (f: GeoFix | null) =>
      repo.branches(f).then(
        list => {
          setBranches(list)
          setFatal('')
          // nearest in range, unless the guest chose one
          setBranchId(cur => (picked && list.some(b => b.id === cur) ? cur : (list.find(b => !b.tooFar) ?? list[0])?.id ?? ''))
        },
        e => setFatal(errText(e)),
      ),
    [repo, picked],
  )
  const loadOrders = useCallback(() => repo.status(sentIds).then(setOrders, () => undefined), [repo, sentIds])

  useEffect(() => {
    void loadBranches(null)
    // first load only: a position reloads the list itself
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo])
  useEffect(() => {
    void loadOrders()
    const t = setInterval(() => document.visibilityState === 'visible' && void loadOrders(), POLL_MS)
    return () => clearInterval(t)
  }, [loadOrders])
  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), toast.ok ? 3000 : 6000)
    return () => clearTimeout(t)
  }, [toast])

  const findMe = () => {
    setLocating(true)
    return locate()
      .then(f => (setFix(f), loadBranches(f)))
      .catch(e => setToast({ text: errText(e) }))
      .finally(() => setLocating(false))
  }

  if (fatal && !branches)
    return (
      <div className="menu-app guest-app">
        <div className="guest-fatal">
          <p className="guest-fatal-icon" aria-hidden>
            🛵
          </p>
          <p>{fatal}</p>
          <button type="button" className="btn" onClick={() => void loadBranches(null)}>
            Thử lại
          </button>
        </div>
      </div>
    )
  if (!branches) return <div className="menu-app guest-app loading">Đang mở thực đơn…</div>
  const branch = branches.find(b => b.id === branchId)
  if (!branch)
    return (
      <div className="menu-app guest-app">
        <div className="guest-fatal">
          <p className="guest-fatal-icon" aria-hidden>
            🛵
          </p>
          <p>Quán chưa mở đặt hàng online.</p>
        </div>
      </div>
    )
  const open = orders.filter(o => o.status === 'quoted').length

  return (
    <div className="menu-app guest-app">
      <header className="guest-head">
        <div>
          <b className="guest-shop">{branch.shopName}</b>
          <span className="guest-table">Đặt giao hàng</span>
        </div>
        <nav className="guest-tabs" aria-label="Trang">
          <button type="button" className={tab === 'menu' ? 'is-on' : ''} onClick={() => setTab('menu')}>
            Thực đơn
          </button>
          <button type="button" className={tab === 'orders' ? 'is-on' : ''} onClick={() => setTab('orders')}>
            Đơn của bạn
            {open > 0 && <span className="rail-count">{open}</span>}
          </button>
        </nav>
      </header>

      {tab === 'orders' ? (
        <OrdersTab
          repo={repo}
          orders={orders}
          onChanged={loadOrders}
          onMenu={() => setTab('menu')}
          onError={m => setToast({ text: m })}
        />
      ) : (
        <>
          <div className="online-branch">
            {branches.length > 1 ? (
              <label className="field">
                <span className="field-label">Chi nhánh giao hàng</span>
                <select
                  value={branch.id}
                  onChange={e => {
                    setPicked(true)
                    setBranchId(e.target.value)
                  }}
                >
                  {branches.map(b => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                      {b.distanceM != null ? ` · ${km(b.distanceM)}` : ''}
                      {b.tooFar ? ' · ngoài phạm vi' : ''}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <p className="muted small">{branch.address}</p>
            )}
            <button type="button" className="btn btn-small" disabled={locating} onClick={() => void findMe()}>
              {locating ? 'Đang lấy vị trí…' : fix ? '📍 Cập nhật vị trí' : '📍 Tìm chi nhánh gần tôi'}
            </button>
          </div>
          <BranchShop
            key={branch.id}
            repo={repo}
            branch={branch}
            fix={fix}
            locating={locating}
            onLocate={findMe}
            onSent={id => {
              addSent(id)
              setTab('orders')
              setToast({ text: 'Đã gửi đơn. Quán sẽ báo phí ship trong giây lát.', ok: true })
            }}
            onError={m => setToast({ text: m })}
          />
        </>
      )}
      {toast && (
        <div className={'toast' + (toast.ok ? ' toast-ok' : '')} role={toast.ok ? 'status' : 'alert'} onClick={() => setToast(null)}>
          {toast.text}
        </div>
      )}
    </div>
  )
}

/** One branch's menu, with its own cart: dish ids differ between branches. */
function BranchShop(props: {
  repo: OnlineRepo
  branch: OnlineBranch
  fix: GeoFix | null
  locating: boolean
  onLocate: () => Promise<unknown>
  onSent: (id: string) => void
  onError: (m: string) => void
}) {
  const { repo, branch } = props
  const [view, setView] = useState<OnlineMenuView | null>(null)
  const [error, setError] = useState('')
  const [now, setNow] = useState(() => new Date())
  const [checkout, setCheckout] = useState(false)
  const cart = useCart(`bmd-online-cart-${branch.id}`)

  const load = useCallback(
    () =>
      repo.menu(branch.id).then(
        v => (setView(v), setError(''), setNow(new Date())),
        e => setError(errText(e)),
      ),
    [repo, branch.id],
  )
  useEffect(() => {
    void load()
    const t = setInterval(() => document.visibilityState === 'visible' && void load(), MENU_MS)
    return () => clearInterval(t)
  }, [load])
  useEffect(() => {
    if (view) document.title = `Đặt hàng · ${view.shopName}`
  }, [view])

  if (!view) return error ? <p className="field-error block">{error}</p> : <p className="muted loading">Đang mở thực đơn…</p>
  return (
    <>
      {!view.isOpen && <div className="offline-bar">Quán đang ngoài giờ phục vụ</div>}
      <OrderScreen menu={view.menu} now={now} cart={cart} onNext={() => setCheckout(true)} searchHint="🔍 Tìm món: gõ tên món, không cần dấu" />
      {checkout && (
        <CheckoutSheet
          view={view}
          branch={branch}
          now={now}
          cart={cart}
          locating={props.locating}
          located={!!props.fix}
          onLocate={props.onLocate}
          onClose={() => setCheckout(false)}
          onSend={async inp => {
            const id = newId()
            await repo.place({ ...inp, id, branchId: branch.id, fix: props.fix })
            cart[1]([])
            setCheckout(false)
            props.onSent(id)
          }}
          onError={props.onError}
        />
      )}
    </>
  )
}

function CheckoutSheet(props: {
  view: OnlineMenuView
  branch: OnlineBranch
  now: Date
  cart: ReturnType<typeof useCart>
  locating: boolean
  located: boolean
  onLocate: () => Promise<unknown>
  onClose: () => void
  onSend: (inp: { lines: ReturnType<typeof toSendLine>[]; customerName: string; phone: string; address: string; payMethod: OnlinePay; note: string }) => Promise<void>
  onError: (m: string) => void
}) {
  const { view, branch, now } = props
  const [lines] = props.cart
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [address, setAddress] = useState('')
  const [pay, setPay] = useState<OnlinePay>('transfer')
  const [note, setNote] = useState('')
  const [sending, setSending] = useState(false)
  const menu = view.menu
  const rows = lines.map(l => {
    const item = menu.items.find(i => i.id === l.state.itemId)
    return { l, item, q: item ? quoteLine(menu, item, l.state, now) : null }
  })
  const total = rows.reduce((t, r) => t + (r.q?.total ?? 0), 0)
  const bad = rows.some(r => !r.q?.canAdd)
  const ready = name.trim() && phone.trim() && address.trim().length >= 8
  const send = () => {
    setSending(true)
    props
      .onSend({ lines: lines.map(l => toSendLine(l.state)), customerName: name, phone, address, payMethod: pay, note })
      .catch(e => props.onError(errText(e)))
      .finally(() => setSending(false))
  }
  return (
    <Sheet
      title="Thông tin giao hàng"
      subtitle={branch.name}
      onClose={props.onClose}
      foot={
        <button type="button" className="btn btn-primary btn-grow" disabled={!lines.length || bad || !ready || branch.tooFar || sending} onClick={send}>
          <span>{sending ? 'Đang gửi…' : 'Gửi đơn'}</span>
          <b>{vnd(total)}</b>
        </button>
      }
    >
      <ul className="rows">
        {rows.map(({ l, item, q }) => (
          <li key={l.key} className={'guest-line' + (q?.canAdd ? '' : ' is-bad')}>
            <span>
              <b>
                {l.state.qty} × {item?.name ?? 'Món không còn bán'}
              </b>
              <span className="muted small">{item ? describeLine(menu, item, l.state) : ''}</span>
              {q && !q.canAdd && <span className="field-error">{q.issues.find(i => i.level === 'error')?.message}</span>}
            </span>
            <b>{q?.total != null ? vnd(q.total) : '—'}</b>
          </li>
        ))}
      </ul>
      <label className="field">
        <span className="field-label">Họ tên người nhận</span>
        <input autoComplete="name" maxLength={40} value={name} onChange={e => setName(e.target.value)} />
      </label>
      <label className="field">
        <span className="field-label">Số điện thoại</span>
        <input type="tel" inputMode="tel" autoComplete="tel" maxLength={14} placeholder="VD: 0901234567" value={phone} onChange={e => setPhone(e.target.value)} />
      </label>
      <label className="field">
        <span className="field-label">Địa chỉ giao hàng</span>
        <textarea rows={2} autoComplete="street-address" maxLength={200} placeholder="Số nhà, đường, phường/xã, quận/huyện" value={address} onChange={e => setAddress(e.target.value)} />
      </label>
      <div className="online-ship">
        {branch.tooFar ? (
          <p className="field-error">Vị trí của bạn ngoài phạm vi giao của chi nhánh này.</p>
        ) : branch.shipEstimate != null ? (
          <p>
            Phí ship dự kiến: <b>{vnd(branch.shipEstimate)}</b> {branch.distanceM != null ? `(khoảng ${km(branch.distanceM)} đường chim bay)` : ''}
          </p>
        ) : (
          <p className="muted small">Quán sẽ báo phí ship sau khi nhận đơn.</p>
        )}
        {!props.located && (
          <button type="button" className="btn btn-small" disabled={props.locating} onClick={() => void props.onLocate()}>
            {props.locating ? 'Đang lấy vị trí…' : '📍 Tính theo vị trí của tôi'}
          </button>
        )}
      </div>
      <fieldset className="pick-group">
        <legend>Thanh toán</legend>
        <div className="chip-row">
          <button type="button" className={'chip' + (pay === 'transfer' ? ' is-on' : '')} aria-pressed={pay === 'transfer'} onClick={() => setPay('transfer')}>
            Chuyển khoản (VietQR)
          </button>
          <button type="button" className={'chip' + (pay === 'cod' ? ' is-on' : '')} aria-pressed={pay === 'cod'} onClick={() => setPay('cod')}>
            Tiền mặt khi nhận
          </button>
        </div>
      </fieldset>
      <label className="field">
        <span className="field-label">Ghi chú cho quán (không bắt buộc)</span>
        <input maxLength={120} placeholder="VD: gọi trước khi tới, ít cay" value={note} onChange={e => setNote(e.target.value)} />
      </label>
      <p className="muted small">Quán báo phí ship chính xác, bạn đồng ý rồi đơn mới được làm. Số tiền trên chưa gồm phí ship.</p>
    </Sheet>
  )
}

const STATUS_LABEL: Record<OnlineStatus, string> = {
  pending: 'Quán đang kiểm tra phí ship',
  quoted: 'Quán đã báo phí ship: mời bạn xác nhận',
  agreed: 'Đã đồng ý: chờ quán nhận đơn',
  accepted: 'Quán đã nhận đơn, đang chuẩn bị',
  rejected: 'Quán không nhận đơn này',
  cancelled: 'Bạn đã huỷ đơn',
}

function OrdersTab(props: { repo: OnlineRepo; orders: OnlineOrderView[]; onChanged: () => Promise<unknown>; onMenu: () => void; onError: (m: string) => void }) {
  const { orders } = props
  return (
    <main className="guest-sent">
      {orders.length === 0 && <p className="muted">Bạn chưa có đơn nào trên điện thoại này.</p>}
      {[...orders].reverse().map(o => (
        <OrderCard key={o.id} repo={props.repo} order={o} onChanged={props.onChanged} onError={props.onError} />
      ))}
      <button type="button" className="btn btn-primary btn-grow" onClick={props.onMenu}>
        + Đặt thêm món
      </button>
    </main>
  )
}

function OrderCard(props: { repo: OnlineRepo; order: OnlineOrderView; onChanged: () => Promise<unknown>; onError: (m: string) => void }) {
  const { repo, order: o } = props
  const [busy, setBusy] = useState(false)
  const code = onlineCode(o.id)
  const sum = (o.foodTotal ?? 0) + (o.shipFee ?? 0)
  const act = (f: () => Promise<void>) => {
    setBusy(true)
    f()
      .then(props.onChanged)
      .catch(e => props.onError(errText(e)))
      .finally(() => setBusy(false))
  }
  const canCancel = o.status === 'pending' || o.status === 'quoted' || o.status === 'agreed'
  return (
    <section className="card">
      <header className="card-head">
        <h2>Đơn {code}</h2>
        <span className="muted small">{new Date(o.createdAt).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })}</span>
      </header>
      <p className={`online-status st-${o.status}`}>
        <b>{STATUS_LABEL[o.status]}</b>
        {o.status === 'rejected' && o.reason ? ` · ${o.reason}` : ''}
      </p>
      {o.status === 'pending' && o.shipEstimate != null && <p className="muted small">Phí ship dự kiến {vnd(o.shipEstimate)}, quán sẽ báo số chính xác.</p>}
      {o.shipFee != null && o.foodTotal != null && (
        <>
          <p className="guest-total">
            <span>Tiền món</span>
            <span>{vnd(o.foodTotal)}</span>
          </p>
          <p className="guest-total">
            <span>Phí ship{o.carrier ? ` (${carrierLabel(o.carrier)})` : ''}</span>
            <span>{vnd(o.shipFee)}</span>
          </p>
          <p className="guest-total">
            <span>Tổng cộng</span>
            <b>{vnd(sum)}</b>
          </p>
          <p className="muted small">{o.payMethod === 'cod' ? 'Trả tiền mặt khi nhận hàng.' : 'Thanh toán chuyển khoản trước khi quán làm món.'}</p>
        </>
      )}
      {o.status === 'agreed' && o.payMethod === 'transfer' && <Transfer order={o} sum={sum} code={code} />}
      <div className="btn-row">
        {canCancel && (
          <button type="button" className="btn" disabled={busy} onClick={() => confirm('Huỷ đơn này?') && act(() => repo.cancel(o.id))}>
            Huỷ đơn
          </button>
        )}
        {o.status === 'quoted' && (
          <button type="button" className="btn btn-primary btn-grow" disabled={busy} onClick={() => act(() => repo.agree(o.id, o.shipFee ?? 0))}>
            <span>{busy ? 'Đang gửi…' : 'Đồng ý'}</span>
            <b>{vnd(sum)}</b>
          </button>
        )}
      </div>
      {o.phone && canCancel && (
        <p className="muted small">
          Cần hỏi thêm? Gọi quán: <a href={`tel:${o.phone}`}>{o.phone}</a>
        </p>
      )}
    </section>
  )
}

function Transfer(props: { order: OnlineOrderView; sum: number; code: string }) {
  const { bank } = props.order
  if (!bank?.bin || !bank.account) return <p className="warn">Quán chưa cài tài khoản nhận tiền: mời bạn gọi quán.</p>
  const note = `BMD ${props.code}`
  return (
    <div className="online-qr">
      <div dangerouslySetInnerHTML={{ __html: qrSvg(vietQrPayload({ bankBin: bank.bin, account: bank.account, amount: props.sum, note }), `Mã VietQR đơn ${props.code}`) }} />
      <p>
        <b>{bank.bankName}</b> · {bank.account}
        <br />
        {bank.holder}
        <br />
        Nội dung: <b>{note}</b>
      </p>
      <p className="muted small">Mở app ngân hàng, quét mã để chuyển đúng số tiền. Chuyển xong quán sẽ xác nhận và làm món.</p>
    </div>
  )
}
