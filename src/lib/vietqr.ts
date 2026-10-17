// VietQR (NAPAS 247) payload in EMVCo merchant-presented format.
// Any Vietnamese banking app can scan it with amount and transfer note pre-filled.

const tlv = (id: string, value: string) => id + String(value.length).padStart(2, '0') + value

export function crc16ccitt(s: string): string {
  let crc = 0xffff
  for (const byte of new TextEncoder().encode(s)) {
    crc ^= byte << 8
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff
  }
  return crc.toString(16).toUpperCase().padStart(4, '0')
}

/** Bank notes must be plain ASCII; strip Vietnamese marks and anything else. */
export function asciiNote(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .replace(/[^A-Za-z0-9 ]/g, '')
    .slice(0, 25)
}

export interface VietQrInput {
  bankBin: string
  account: string
  amount?: number
  note?: string
}

export function vietQrPayload({ bankBin, account, amount, note }: VietQrInput): string {
  const beneficiary = tlv('00', bankBin) + tlv('01', account)
  const merchant = tlv('00', 'A000000727') + tlv('01', beneficiary) + tlv('02', 'QRIBFTTA')
  let body =
    tlv('00', '01') +
    tlv('01', amount ? '12' : '11') +
    tlv('38', merchant) +
    tlv('53', '704') +
    (amount ? tlv('54', String(Math.round(amount))) : '') +
    tlv('58', 'VN')
  const cleanNote = note ? asciiNote(note) : ''
  if (cleanNote) body += tlv('62', tlv('08', cleanNote))
  body += '6304'
  return body + crc16ccitt(body)
}
