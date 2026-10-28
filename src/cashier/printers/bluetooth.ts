// Bluetooth receipt printers through Web Bluetooth (Chrome / Edge on Windows, Android, Mac; not iPhone/iPad, not
// Firefox). Most 58/80mm printers sold as "Bluetooth" offer a BLE service with one writable characteristic that takes
// ESC/POS bytes; the known ones are listed so the browser lets the page use them. Classic-only (SPP) printers do not
// show up here: pair them in Windows and print through the dialog instead.

/* Minimal Web Bluetooth types (not in TypeScript's DOM lib). */
interface BtCharacteristic {
  properties: { write: boolean; writeWithoutResponse: boolean }
  writeValueWithResponse(v: BufferSource): Promise<void>
  writeValueWithoutResponse(v: BufferSource): Promise<void>
}
interface BtService {
  getCharacteristics(): Promise<BtCharacteristic[]>
}
interface BtServer {
  connected: boolean
  connect(): Promise<BtServer>
  disconnect(): void
  getPrimaryServices(): Promise<BtService[]>
}
export interface BtDevice {
  id: string
  name?: string
  gatt?: BtServer
}
interface BtApi {
  requestDevice(o: { acceptAllDevices: boolean; optionalServices: string[] }): Promise<BtDevice>
  getDevices?(): Promise<BtDevice[]>
}

const bt = (): BtApi | undefined => (navigator as unknown as { bluetooth?: BtApi }).bluetooth

/** Services of common printer chips (Xprinter, Goojprt, MTP, Rongta, ISSC, generic "18F0"). */
const PRINTER_SERVICES = [
  '000018f0-0000-1000-8000-00805f9b34fb',
  'e7810a71-73ae-499d-8c15-faa9aef0c3f2',
  '49535343-fe7d-4ae5-8fa9-9fafd205e455',
  '0000ff00-0000-1000-8000-00805f9b34fb',
  '0000ffe0-0000-1000-8000-00805f9b34fb',
  '0000fee7-0000-1000-8000-00805f9b34fb',
  '0000ae30-0000-1000-8000-00805f9b34fb',
]

export const bluetoothSupported = () => !!bt()

/** The device picked in this tab (Web Bluetooth only reconnects without a tap through getDevices). */
let current: BtDevice | null = null

/** Opens the browser's Bluetooth chooser (must run from a tap). */
export async function pickBluetoothPrinter(): Promise<BtDevice> {
  const api = bt()
  if (!api) throw new Error('Trình duyệt này không kết nối Bluetooth được. Dùng Chrome hoặc Edge trên Windows/Android (iPhone, iPad: in qua WiFi).')
  const d = await api.requestDevice({ acceptAllDevices: true, optionalServices: PRINTER_SERVICES })
  await writable(d) // fails now, not at the first bill, when it is not a printer
  current = d
  return d
}

async function find(id: string): Promise<BtDevice> {
  if (current?.id === id) return current
  const known = (await bt()?.getDevices?.()) ?? []
  const d = known.find(x => x.id === id)
  if (d) return (current = d)
  // not remembered by this browser: ask again (the print button counts as the tap)
  return pickBluetoothPrinter()
}

async function writable(d: BtDevice): Promise<BtCharacteristic> {
  if (!d.gatt) throw new Error('Thiết bị này không phải máy in Bluetooth')
  const server = d.gatt.connected ? d.gatt : await d.gatt.connect()
  for (const s of await server.getPrimaryServices()) {
    for (const c of await s.getCharacteristics()) if (c.properties.write || c.properties.writeWithoutResponse) return c
  }
  throw new Error(`${d.name || 'Thiết bị'} không nhận lệnh in qua Bluetooth`)
}

const CHUNK = 180

/** Sends ESC/POS bytes to the Bluetooth printer `id`, in small writes the printer's buffer keeps up with. */
export async function sendBluetooth(id: string, data: Uint8Array): Promise<void> {
  const d = await find(id)
  const c = await writable(d)
  for (let i = 0; i < data.length; i += CHUNK) {
    const part = data.slice(i, i + CHUNK)
    if (c.properties.write) await c.writeValueWithResponse(part)
    else {
      await c.writeValueWithoutResponse(part)
      await new Promise(r => setTimeout(r, 15))
    }
  }
}

export function forgetBluetooth() {
  current?.gatt?.disconnect()
  current = null
}
