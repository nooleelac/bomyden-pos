// Floor map: one page per area, one tile per table, colour from the orders (never set by hand).
// Tap a free table to open it straight into Gọi món, an occupied one to enter its order (choose the order when the
// table is shared), long-press (or right-click) for the quick menu (on a free table: guest count and gộp bàn).
// Takeaway orders sit in their own column.

import { useRef, useState } from 'react'
import { vnd } from '../../menu/picker'
import { go, markQuickOpened } from '../hooks'
import { areaTables, formatDuration, openOrdersAt, orderAmount, orderLabel, orderTitle, tableTile, type TableTile } from '../logic'
import type { FloorRepo } from '../repo'
import { TABLE_STATE_LABEL, type FloorState, type Order, type Role, type TableState } from '../types'
import { GuestPicker, Sheet } from './Sheet'

type Filter = 'all' | 'free' | 'mine' | 'bill'
const TAKEAWAY = 'takeaway'

export function FloorMap(props: { floor: FloorState; repo: FloorRepo; now: Date; role: Role; me: string; online: boolean; onError: (m: string) => void }) {
  const { floor, repo, now, role } = props
  const areas = [...floor.areas].sort((a, b) => a.sort - b.sort)
  const [areaId, setAreaId] = useState(() => {
    try {
      return sessionStorage.getItem('bmd-area') ?? areas[0]?.id
    } catch {
      return areas[0]?.id
    }
  })
  const [filter, setFilter] = useState<Filter>('all')
  const [openFor, setOpenFor] = useState<string | null>(null)
  const [pickFor, setPickFor] = useState<TableTile | null>(null)
  const [sharedFor, setSharedFor] = useState<string | null>(null)
  const [takeaway, setTakeaway] = useState(false)
  const area = areas.find(a => a.id === areaId) ?? areas[0]
  const seeAmounts = role !== 'waiter' || floor.settings.waiterSeesAmounts
  const fail = (e: unknown) => props.onError(e instanceof Error ? e.message : String(e))

  const tiles = area ? areaTables(floor, area.id).map(t => tableTile(floor, t, now)) : []
  const allTiles = floor.tables.filter(t => t.active).map(t => tableTile(floor, t, now))
  const count = (ts: TableTile[], st: TableState) => ts.filter(t => t.state === st).length
  const shown = tiles.filter(t =>
    filter === 'all' ? true
    : filter === 'free' ? t.state === 'free'
    : filter === 'bill' ? t.state === 'bill' || t.state === 'paying'
    : t.orders.some(o => o.openedBy === props.me),
  )
  const takeaways = floor.orders.filter(o => o.kind === 'takeaway' && o.status === 'open').sort((a, b) => (a.takeawayNo ?? 0) - (b.takeawayNo ?? 0))

  // One tap on a free table opens it with its seat count as the guest count (editable on the order screen) and goes
  // straight to Gọi món. Gộp bàn / exact guest count: long-press (right-click) a free table for the full sheet.
  const opening = useRef(false)
  const quickOpen = (t: TableTile) => {
    if (opening.current) return
    opening.current = true
    repo
      .openTable({ tableId: t.table.id, guestCount: Math.min(99, Math.max(1, t.table.seats || 1)) })
      .then(id => {
        markQuickOpened(id)
        go(`ban/don/${id}`)
      }, fail)
      .finally(() => (opening.current = false))
  }

  const tap = (t: TableTile) => {
    if (t.state === 'cleaning') return repo.markClean(t.table.id).catch(fail)
    if (t.orders.length === 0) {
      if (t.state === 'closed') return props.onError('Khu này đang tạm đóng')
      if (!props.online) return props.onError('Mất kết nối: chưa mở bàn mới được')
      return quickOpen(t)
    }
    if (t.orders.length === 1) return go(`ban/don/${t.orders[0].id}`)
    setPickFor(t)
  }

  const pickArea = (id: string) => {
    setAreaId(id)
    try {
      sessionStorage.setItem('bmd-area', id)
    } catch {
      /* ignore */
    }
  }
  const openOrders = floor.orders.filter(o => o.status === 'open').length
  const showTakeaway = areaId === TAKEAWAY
  const since = (iso: string) => formatDuration(now.getTime() - new Date(iso).getTime())
  const tileSub = (t: TableTile) =>
    t.state === 'free' ? 'Bàn trống'
    : t.state === 'closed' ? 'Tạm đóng'
    : t.state === 'cleaning' ? 'Chạm: dọn xong'
    : t.state === 'paying' ? 'Đang thanh toán'
    : t.state === 'bill' ? `Chờ TT · ${since(t.orders.map(o => o.billRequestedAt!).sort()[0])}`
    : since(t.seatedSince!)

  return (
    <div className="floor screen">
      <p className="floor-counts" aria-label="Đếm bàn">
        <span>
          Tổng số đơn: <b>{openOrders}</b>
        </span>
        <span>
          Bàn trống: <b>{count(allTiles, 'free')}</b>/{allTiles.length}
        </span>
      </p>
      <div className="floor-body">
        <nav className="area-rail" aria-label="Khu vực">
          {areas.map(a => (
            <button key={a.id} type="button" className={'rail-item' + (!showTakeaway && a.id === area?.id ? ' is-on' : '') + (a.active ? '' : ' is-closed')} onClick={() => pickArea(a.id)}>
              {a.name}
            </button>
          ))}
          <button type="button" className={'rail-item' + (showTakeaway ? ' is-on' : '')} onClick={() => pickArea(TAKEAWAY)}>
            🥡 Mang về
            {takeaways.length > 0 && <span className="rail-count">{takeaways.length}</span>}
          </button>
        </nav>
        <div className="floor-main">
          {showTakeaway ? (
            <section className="card takeaway-col" aria-label="Mang về">
              <header className="card-head">
                <h2>Mang về</h2>
                <button type="button" className="btn btn-small btn-primary" onClick={() => (props.online ? setTakeaway(true) : props.onError('Mất kết nối'))}>
                  + Tạo đơn mang về
                </button>
              </header>
              {takeaways.length === 0 && <p className="muted small">Chưa có đơn mang về</p>}
              <ul className="rows">
                {takeaways.map(o => (
                  <li key={o.id}>
                    <a className="order-pick" href={`#/ban/don/${o.id}`}>
                      <b>{orderTitle(floor, o)}</b>
                      <span className="muted small">
                        {since(o.openedAt)}
                        {seeAmounts && ` · ${vnd(orderAmount(floor, o.id))}`}
                      </span>
                    </a>
                  </li>
                ))}
              </ul>
            </section>
          ) : (
            <>
              <div className="chip-row filter-row" role="group" aria-label="Lọc bàn">
                {(
                  [
                    ['all', 'Tất cả'],
                    ['free', 'Bàn trống'],
                    ['mine', 'Bàn của tôi'],
                    ['bill', 'Chờ thanh toán'],
                  ] as [Filter, string][]
                ).map(([k, v]) => (
                  <button key={k} type="button" className={'chip chip-sm' + (filter === k ? ' is-on' : '')} aria-pressed={filter === k} onClick={() => setFilter(k)}>
                    {v}
                  </button>
                ))}
              </div>
              <ul className="table-grid">
                {shown.map(t => (
                  <li key={t.table.id}>
                    <button
                      type="button"
                      className={`table-tile st-${t.state}`}
                      aria-label={`Bàn ${t.table.name}: ${TABLE_STATE_LABEL[t.state]}`}
                      onClick={() => tap(t)}
                      onContextMenu={e => {
                        e.preventDefault()
                        if (t.orders.length) return setPickFor(t)
                        if (t.state === 'free' && props.online) setOpenFor(t.table.id)
                      }}
                    >
                      <span className="tile-marks">
                        {t.kitchenHeat && t.kitchenHeat !== 'ok' && <span className={`mark heat-${t.kitchenHeat}`} title="Món gửi bếp lâu chưa ra" />}
                        {t.readyCount > 0 && (
                          <span className="mark ready" title="Món xong chờ bưng">
                            {t.readyCount}
                          </span>
                        )}
                      </span>
                      <b className="tile-name">{t.table.name}</b>
                      <span className="tile-sub">{tileSub(t)}</span>
                      {t.orders.length > 0 && (
                        <span className="tile-info">
                          {t.orders.length > 1 && <b>{t.orders.length} đơn · </b>}
                          <span className={t.overSeats ? 'over' : ''}>{t.guests} khách</span>
                          {seeAmounts && t.amount > 0 && <> · {vnd(t.amount)}</>}
                        </span>
                      )}
                      {t.groupLabel && <span className="tile-group">{t.groupLabel}</span>}
                    </button>
                  </li>
                ))}
                {shown.length === 0 && <li className="empty">Không có bàn phù hợp</li>}
              </ul>
            </>
          )}
        </div>
      </div>

      {openFor && (
        <OpenTableSheet
          floor={floor}
          tableId={openFor}
          onClose={() => setOpenFor(null)}
          onOpen={(g, extra) =>
            repo.openTable({ tableId: openFor, guestCount: g, extraTableIds: extra }).then(id => {
              markQuickOpened(id)
              go(`ban/don/${id}`)
            }, fail)
          }
        />
      )}
      {pickFor && (
        <Sheet title={`Bàn ${pickFor.table.name}`} subtitle={pickFor.orders.length > 1 ? 'Bàn có nhiều đơn: chọn đúng đơn trước khi gọi món' : undefined} onClose={() => setPickFor(null)}>
          <ul className="rows">
            {pickFor.orders.map((o: Order) => (
              <li key={o.id}>
                <a className="order-pick" href={`#/ban/don/${o.id}`}>
                  <b>{orderTitle(floor, o)}</b>
                  <span className="muted small">
                    {o.guestCount} khách · {formatDuration(now.getTime() - new Date(o.openedAt).getTime())}
                    {o.billRequestedAt && ' · chờ thanh toán'}
                    {seeAmounts && ` · ${vnd(orderAmount(floor, o.id))}`}
                  </span>
                </a>
              </li>
            ))}
          </ul>
          <button type="button" className="btn" onClick={() => (setSharedFor(pickFor.table.id), setPickFor(null))}>
            + Thêm đơn ghép (khách ngồi chung, tính riêng)
          </button>
        </Sheet>
      )}
      {sharedFor && (
        <SharedOrderSheet
          floor={floor}
          tableId={sharedFor}
          onClose={() => setSharedFor(null)}
          onCreate={inp => repo.addSharedOrder({ tableId: sharedFor, ...inp }).then(id => go(`ban/don/${id}`), fail)}
        />
      )}
      {takeaway && <TakeawaySheet onClose={() => setTakeaway(false)} onCreate={name => repo.openTakeaway({ customerName: name }).then(id => go(`ban/don/${id}`), fail)} />}
    </div>
  )
}

function OpenTableSheet(props: { floor: FloorState; tableId: string; onClose: () => void; onOpen: (guests: number, extra: string[]) => void }) {
  const { floor } = props
  const t = floor.tables.find(x => x.id === props.tableId)!
  const [guests, setGuests] = useState(0)
  const [extra, setExtra] = useState<string[]>([])
  const freeNear = areaTables(floor, t.areaId).filter(x => x.id !== t.id && x.active && openOrdersAt(floor, x.id).length === 0 && !x.needsCleaning)
  const seats = t.seats + extra.reduce((n, id) => n + (floor.tables.find(x => x.id === id)?.seats ?? 0), 0)
  return (
    <Sheet
      title={`Mở bàn ${t.name}`}
      subtitle={`${t.seats} ghế`}
      onClose={props.onClose}
      foot={
        <button type="button" className="btn btn-primary btn-grow" disabled={guests < 1 || guests > 99} onClick={() => props.onOpen(guests, extra)}>
          <span>Mở bàn{extra.length ? ` (gộp ${[t.name, ...extra.map(id => floor.tables.find(x => x.id === id)?.name)].join('+')})` : ''}</span>
          <b>{guests || '—'} khách</b>
        </button>
      }
    >
      <GuestPicker value={guests} onChange={setGuests} />
      {guests > seats && <p className="warn">⚠ Bàn {seats} ghế mà có {guests} khách: gộp thêm bàn? (vẫn mở được)</p>}
      {freeNear.length > 0 && (
        <fieldset className="pick-group">
          <legend>Gộp thêm bàn (một hoá đơn chung)</legend>
          <div className="chip-row">
            {freeNear.map(x => {
              const on = extra.includes(x.id)
              return (
                <button key={x.id} type="button" className={'chip' + (on ? ' is-on' : '')} aria-pressed={on} onClick={() => setExtra(p => (on ? p.filter(i => i !== x.id) : [...p, x.id]))}>
                  Bàn {x.name}
                </button>
              )
            })}
          </div>
        </fieldset>
      )}
    </Sheet>
  )
}

export function SharedOrderSheet(props: {
  floor: FloorState
  tableId: string
  onClose: () => void
  onCreate: (inp: { guestCount: number; positionLabel: string; existingLabels: Record<string, string> }) => void
}) {
  const { floor } = props
  const t = floor.tables.find(x => x.id === props.tableId)!
  const existing = openOrdersAt(floor, t.id)
  const unlabeled = existing.filter(o => !o.positionLabel)
  const [guests, setGuests] = useState(0)
  const [label, setLabel] = useState('')
  const [labels, setLabels] = useState<Record<string, string>>({})
  const ok = guests >= 1 && label.trim() && unlabeled.every(o => labels[o.id]?.trim())
  return (
    <Sheet
      title={`Thêm đơn ghép bàn ${t.name}`}
      subtitle="Khách lạ ngồi chung: đơn, phiếu bếp và hoá đơn riêng"
      onClose={props.onClose}
      foot={
        <button type="button" className="btn btn-primary btn-grow" disabled={!ok} onClick={() => props.onCreate({ guestCount: guests, positionLabel: label, existingLabels: labels })}>
          <span>Tạo đơn ghép</span>
        </button>
      }
    >
      {unlabeled.map(o => (
        <label key={o.id} className="field">
          <span className="field-label">Vị trí ngồi của đơn {orderLabel(floor, o)} đang có (bắt buộc khi bàn có 2 đơn)</span>
          <input maxLength={30} placeholder="VD: đầu bàn" value={labels[o.id] ?? ''} onChange={e => setLabels(p => ({ ...p, [o.id]: e.target.value }))} />
        </label>
      ))}
      <label className="field">
        <span className="field-label">Vị trí ngồi / nhận diện đơn mới</span>
        <input maxLength={30} placeholder="VD: 2 khách áo xanh" value={label} onChange={e => setLabel(e.target.value)} />
      </label>
      <GuestPicker value={guests} onChange={setGuests} />
    </Sheet>
  )
}

function TakeawaySheet(props: { onClose: () => void; onCreate: (name: string) => void }) {
  const [name, setName] = useState('')
  return (
    <Sheet
      title="Đơn mang về"
      onClose={props.onClose}
      foot={
        <button type="button" className="btn btn-primary btn-grow" onClick={() => props.onCreate(name)}>
          <span>Tạo đơn mang về</span>
        </button>
      }
    >
      <label className="field">
        <span className="field-label">Tên khách (không bắt buộc)</span>
        <input maxLength={40} placeholder="VD: anh Tuấn" value={name} onChange={e => setName(e.target.value)} />
      </label>
    </Sheet>
  )
}
