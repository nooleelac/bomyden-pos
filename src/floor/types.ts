// Floor (areas, tables, orders on tables) and kitchen model as the screens see it.
// Mirrors 0001–0005 (snake_case there, camelCase here). Money is whole VND, times are ISO strings.

import type { ReceiptTemplate } from '../cashier/template'
import type { PayMethod } from '../lib/billing'
import type { GuestGeo } from '../lib/geo'
import type { Carrier, ShipRules } from '../lib/ship'
import type { RoundingMode, VatGroup } from '../lib/pricing'

export interface Area {
  id: string
  name: string
  sort: number
  /** false = tạm đóng (grey, no new orders) */
  active: boolean
}

export interface Table {
  id: string
  areaId: string
  name: string
  /** Standard seats: more guests only warns. */
  seats: number
  sort: number
  active: boolean
  /** Bàn tạm (kê thêm) */
  temporary: boolean
  /** Secret of the table's QR link #/goi/<token> (0023); null/missing = no QR yet. */
  qrToken?: string | null
}

export type OrderStatus = 'open' | 'paid' | 'void' | 'merged'
export type OrderKind = 'dine_in' | 'takeaway'

/** An order's seat at one table. suffix: first order on a table 'A', then 'B', 'C'. */
export interface OrderTable {
  tableId: string
  suffix: string
  joinedAt: string
}

export interface Order {
  id: string
  kind: OrderKind
  /** Takeaway number of the day: 1 -> MV-01 */
  takeawayNo: number | null
  customerName: string
  /** Primary table (null for takeaway). */
  tableId: string | null
  /** Tables the order sits at now; 2+ = merged group. */
  tables: OrderTable[]
  guestCount: number | null
  /** 'đầu bàn', '2 khách áo xanh': required once a table holds 2+ orders. */
  positionLabel: string
  /** Order note for the kitchen, ≤ 60 characters, boxed on top of every ticket. */
  note: string
  allergy: boolean
  status: OrderStatus
  openedAt: string
  openedBy: string
  closedAt: string | null
  mergedInto: string | null
  /** Rounds sent so far (Lượt 1, Lượt 2 …). */
  rounds: number
  /** In tạm tính: Chờ thanh toán until something changes the bill. */
  billRequestedAt: string | null
  billPrintCount: number
  /** Cashier has the payment screen open: Đang thanh toán (other devices cannot change lines). */
  payingAt: string | null
  payingBy: string | null
  /** Last Giục; spacing ≥ 3 minutes. */
  chasedAt: string | null
  chaseCount: number
}

/** Chờ làm → Đang làm → Xong → Đã bưng; Huỷ. */
export type LineStatus = 'new' | 'cooking' | 'ready' | 'served' | 'void'

export const LINE_STATUS_LABEL: Record<LineStatus, string> = {
  new: 'Chờ làm',
  cooking: 'Đang làm',
  ready: 'Xong',
  served: 'Đã bưng',
  void: 'Đã huỷ',
}

export interface LineMod {
  kind: 'option' | 'addon' | 'removal'
  name: string
  kitchenName: string
  qty: number
  /** Per unit, signed (removals negative). */
  unitDelta: number
  /** Quầy làm when not the line's own station (sốt at the cold counter); null or absent = the line's station. */
  stationId?: string | null
}

/**
 * Phần đi kèm (0012 order_items.side_parts): the part of a dish made at another station than the dish, with its own
 * kitchen state. Beefsteak at Bếp nóng: one side part at Quầy rau with SALAD, BÁNH MÌ and the sốt option.
 * The bill never sees it; it travels with the line through tách, gộp, chuyển and huỷ.
 */
export interface SidePart {
  stationId: string
  /** Components made there, ticket text per portion ("SALAD", "BÁNH MÌ x2"). */
  parts: string[]
  /** new | cooking | ready | served */
  status: LineStatus
  startedAt: string | null
  readyAt: string | null
  servedAt: string | null
}

/** A line sent to the kitchen. Price and snapshots are locked at Gửi bếp. */
export interface Line {
  id: string
  orderId: string
  /** The order it was rung on (kept across merge / move). */
  originOrderId: string
  menuItemId: string
  name: string
  /** Kitchen name, capitals. */
  shortName: string
  variantId: string | null
  variantName: string
  qty: number
  /** Unit price locked at send. */
  price: number
  stationId: string
  status: LineStatus
  note: string
  mods: LineMod[]
  /** Parts made at other stations; [] for a dish made in one place. */
  sideParts: SidePart[]
  /** Where the guest sits; kitchen prints it big. */
  deliveryTableId: string | null
  round: number
  sendBatch: string
  sentAt: string
  sentBy: string
  rush: boolean
  rushReason: string
  startedAt: string | null
  readyAt: string | null
  servedAt: string | null
  voidReason: string
  voidedAt: string | null
  /** Kitchen state when it was voided: decides whether the kitchen is told. */
  voidStage: LineStatus | null
  /** Set on the old line when SỬA replaced it. */
  replacedBy: string | null
  /** Label before a move ("5"), shown as CHUYỂN TỪ 5 for 15 minutes. */
  movedFromLabel: string
  movedAt: string | null
  /** Picker choices, so SỬA can reopen the picker. */
  options: Record<string, number>
  removals: string[]
  /** Tax flags snapshotted at send (order_items.vat_rate etc.), so the bill never changes with the menu. */
  vatRate: number
  priceIncludesVat: boolean
  discountable: boolean
  serviceCharge: boolean
}

export type NoticeKind = 'void' | 'modify' | 'chase' | 'move' | 'modify_rejected'

/** Kitchen or waiter notice. HUỶ, SỬA and GIỤC wait for "Đã biết" / "Đã nhận". */
export interface Notice {
  id: string
  kind: NoticeKind
  orderId: string
  lineId: string | null
  stationId: string | null
  /** Ticket the notice belongs to (send batch), when it is about one line. */
  sendBatch: string | null
  text: string
  /** Old content, struck through (SỬA). */
  before: string
  createdAt: string
  createdBy: string
  ackAt: string | null
  /** SỬA on a dish already cooking waits for the kitchen: pending -> accepted | rejected. */
  status: 'done' | 'pending' | 'accepted' | 'rejected'
  /** Pending SỬA: the new line, as sent to send_order_lines. */
  payload: SendLineInput | null
}

/** Bump / recall state of one kitchen ticket (send batch × station × order × delivery table). */
export interface TicketState {
  key: string
  bumpedAt: string | null
  recalledAt: string | null
  recallCount: number
}

export interface StationTiming {
  /** Minutes until the ticket turns yellow / red. Example values, the shop sets them. */
  warn: number
  late: number
}

export interface FloorSettings {
  maxOrdersPerTable: number
  maxMergeTables: number
  /** Waiters see amounts on the floor map. */
  waiterSeesAmounts: boolean
  /** By station id. */
  timing: Record<string, StationTiming>
  /** Business-day start for takeaway numbers, HH:MM. */
  businessDayStart: string
  /** Huỷ món needs a manager for every sent line ('sent', default) or only once the kitchen started it ('started'). */
  voidApproval?: 'sent' | 'started'
  /** Khách quét QR tự gọi món (0023 branch_settings.guest_order); missing = on. */
  guestOrder?: boolean
  /** Quick picks on Gọi phục vụ / Gọi thanh toán (0025); a missing list = DEFAULT_CALL_CHIPS. */
  guestCallChips?: Partial<CallChips>
  /** Chống phá (0026): the shop's position and the radius guests must be within; on only when all three are set. */
  guestGeo?: GuestGeoSettings
  /** Nhận đơn online (0027 branch_settings.online_order); the database's default is off, missing = on (sample). */
  onlineOrder?: boolean
  /** Bảng giá ship tạm tính; missing = DEFAULT_SHIP. */
  onlineShip?: ShipRules
}

export interface FloorState {
  sample?: boolean
  settings: FloorSettings
  areas: Area[]
  tables: Table[]
  orders: Order[]
  lines: Line[]
  notices: Notice[]
  tickets: TicketState[]
  /** Closed bills (recent ones and the open shift's), newest last. */
  bills: Bill[]
  /** Cashier shifts: the open one and recently closed ones. */
  shifts: Shift[]
  /** Receipt header, bank account for VietQR, rounding and service charge (shop_settings). */
  shop: ShopProfile
  /** Server time minus device time, ms (timers use shop time). */
  clockOffset?: number
  /** Khách gọi món qua QR: the waiting ones and those decided in the last hours (0023); missing = none. */
  guestRequests?: GuestRequest[]
  /** Đơn giao hàng từ web: the open ones and those finished in the last hours (0027); missing = none. */
  onlineOrders?: OnlineOrder[]
}

export type OnlineStatus = 'pending' | 'quoted' | 'agreed' | 'accepted' | 'rejected' | 'cancelled'

export type OnlinePay = 'transfer' | 'cod'

/** A delivery order from the web page: staff enter the real ship fee, the guest agrees, staff accept it into the kitchen. */
export interface OnlineOrder {
  id: string
  /** send_order_lines form; priced when accepted. */
  lines: SendLineInput[]
  note: string
  customerName: string
  phone: string
  address: string
  lat: number | null
  lng: number | null
  /** Straight line from the branch, metres; null without the guest's position. */
  distanceM: number | null
  shipEstimate: number | null
  payMethod: OnlinePay
  /** Set by staff with the fee: what the guest is asked to pay. */
  foodTotal: number | null
  shipFee: number | null
  carrier: Carrier | ''
  status: OnlineStatus
  /** Why it was rejected, shown to the guest. */
  reason: string
  createdAt: string
  decidedAt: string | null
  decidedBy: string
  /** The takeaway order it went onto. */
  orderId: string | null
}

export type GuestRequestStatus = 'pending' | 'accepted' | 'rejected'

/** Gọi món (dishes, 0023), Gọi thanh toán or Gọi phục vụ (0024: no lines, Đã xử lý marks them done). */
export type GuestRequestKind = 'order' | 'bill' | 'service'

/** The quick picks a guest taps when calling: what they need (phục vụ), how they pay (thanh toán). */
export type CallChips = Record<'service' | 'bill', string[]>

/** Cài đặt → Mã QR gọi món → Chống phá: the position is kept when the radius is turned off (null). */
export interface GuestGeoSettings {
  lat: number | null
  lng: number | null
  radius: number | null
}

/** The geofence in force, or null (off). */
export const activeGeo = (g: GuestGeoSettings | null | undefined): GuestGeo | null =>
  g && g.lat != null && g.lng != null && g.radius != null ? { lat: g.lat, lng: g.lng, radius: g.radius } : null
export const DEFAULT_CALL_CHIPS: CallChips = {
  service: ['Thêm nước đá', 'Thêm chén đũa', 'Dọn bàn', 'Tư vấn món'],
  bill: ['Tiền mặt', 'Chuyển khoản', 'Thẻ'],
}
export const CALL_CHIP_MAX = 12
export const CALL_CHIP_LEN = 30

/** The branch's lists, a missing one filled with the default. */
export const callChips = (c: Partial<CallChips> | null | undefined): CallChips => ({
  service: c?.service ?? DEFAULT_CALL_CHIPS.service,
  bill: c?.bill ?? DEFAULT_CALL_CHIPS.bill,
})

/** What a guest sent from the table's QR page. Nothing reaches the kitchen until a waiter accepts it. */
export interface GuestRequest {
  id: string
  /** Missing = 'order' (saved before 0024). */
  kind?: GuestRequestKind
  tableId: string
  /** send_order_lines form; priced when accepted. */
  lines: SendLineInput[]
  /** Dishes: becomes the order note when the order has none; a call: what the guest needs (≤ 60). */
  note: string
  guestCount: number | null
  status: GuestRequestStatus
  /** Why it was rejected, shown to the guest. */
  reason: string
  createdAt: string
  decidedAt: string | null
  decidedBy: string
  /** The order it went onto. */
  orderId: string | null
}

/** One line for send_order_lines (same shape as picker.ts SendLine, plus the delivery table). */
export interface SendLineInput {
  menu_item_id: string
  variant_id?: string
  qty: number
  note?: string
  options: { option_id: string; qty?: number }[]
  removals: string[]
  delivery_table_id?: string
}

export type TableState = 'free' | 'occupied' | 'bill' | 'paying' | 'closed'

export const TABLE_STATE_LABEL: Record<TableState, string> = {
  free: 'Trống',
  occupied: 'Đang ngồi',
  bill: 'Chờ thanh toán',
  paying: 'Đang thanh toán',
  closed: 'Khu tạm đóng',
}

export const VOID_REASONS = ['Khách đổi ý', 'Gọi nhầm', 'Hết món', 'Ra quá lâu', 'Món lỗi', 'Khác'] as const
export const RUSH_REASONS = ['Khách vội', 'Trẻ em', 'Khách quen', 'Làm lại', 'Khác'] as const

/** Notes: item and order notes are short so the ticket stays readable. */
export const NOTE_MAX = 60

export type Role = 'owner' | 'manager' | 'cashier' | 'kitchen' | 'waiter'

export interface Actor {
  /** Staff name for tickets and logs. */
  name: string
  role: Role
}

// ---------------------------------------------------------------- cashier (0005)

/** One payment row of a closed bill. */
export interface Payment {
  id: string
  method: PayMethod
  amount: number
  /** Cash handed over (change = tendered − amount); null when exact or not cash. */
  tendered: number | null
  /** Card: last 4 digits or slip number; transfer: bank reference. Optional. */
  ref: string
  /** Transfer: the shop account the guest paid into, as it was at pay time (null: cash, card, or paid before 0020). */
  bankAccount?: BankAccount | null
  receivedBy: string
  receivedAt: string
}

/** A settled bill (bills row). Amounts are the server's, from calc_bill at pay time. */
export interface Bill {
  id: string
  orderId: string
  /** HD000123, running number. */
  billNo: string
  tableLabel: string
  subtotal: number
  discount: number
  discountReason: string
  serviceCharge: number
  vatAdded: number
  vatTotal: number
  rounding: number
  total: number
  vatLines: VatGroup[]
  payments: Payment[]
  cashier: string
  paidAt: string
  shiftId: string | null
  /** Receipts printed so far: the 2nd and later carry "IN LẠI – lần n". */
  printCount: number
  lastPrintAt: string | null
  lastPrintBy: string
}

/** A dish of a settled bill as the reports see it (Hoá đơn, Doanh thu). amount = unit price × qty. */
export interface SoldLine {
  orderId: string
  name: string
  variantName: string
  qty: number
  amount: number
}

/** Bills paid in a time range with their dishes (the floor state keeps only the last hours). */
export interface BillHistory {
  bills: Bill[]
  lines: SoldLine[]
}

/** Ca thu ngân: one open shift per register; cash needs an open shift. */
export interface Shift {
  id: string
  register: string
  openedBy: string
  openedAt: string
  /** Tiền lẻ đầu ca. */
  openingFloat: number
  closedAt: string | null
  closedBy: string | null
  /** Counted at close, and the count per note ("500000": 3). */
  countedCash: number | null
  countedDetail: Record<string, number>
  /** Opening float + cash taken, as computed when the shift closed. */
  expectedCash: number | null
  note: string
}

export interface ShopProfile {
  /** true while the header and bank account are placeholders. */
  sample?: boolean
  name: string
  address: string
  phone: string
  taxCode: string
  /** NAPAS BIN of the receiving bank, account number and holder for VietQR: the default account (bankAccounts[0]). */
  bankBin: string
  bankName: string
  bankAccount: string
  bankAccountName: string
  /** Every account the shop takes transfers to, the default first; missing = only the one above (saved before 0019). */
  bankAccounts?: BankAccount[]
  footer: string
  serviceChargePct: number
  roundingMode: RoundingMode
  roundingUnit: number
  /** Cài đặt → Thanh toán: payment methods the cashier may take (missing = all three). */
  payMethods?: Record<PayMethod, boolean>
  /** One VAT % for every dish sent from now on; null/missing = by menu group (8% món ăn, 10% bia rượu). */
  vatRate?: number | null
  /** Print the VAT lines on bills and pre-bills (missing = yes). */
  showVat?: boolean
  /** Cài đặt → Mẫu in: words and sizes on receipts (any shape; receiptTemplate() fills in the defaults). */
  receiptTemplate?: unknown
}

/** A bank account the cashier can show a VietQR for. */
export interface BankAccount {
  id: string
  /** NAPAS BIN, e.g. 970436. */
  bin: string
  bankName: string
  account: string
  holder: string
}

/** Cài đặt → Mẫu in, saved with saveReceipt: the shop header, the thank-you line and the template. */
export type ReceiptSettings = Pick<ShopProfile, 'name' | 'address' | 'phone' | 'taxCode' | 'footer'> & { template: ReceiptTemplate }

/** Cài đặt → Thanh toán, saved with saveShop. */
export type PaymentSettings = {
  /** The default account first. */
  bankAccounts: BankAccount[]
  payMethods: Record<PayMethod, boolean>
  vatRate: number | null
  showVat: boolean
}
