import { describe, expect, it } from 'vitest'
import { announceText, vndWords } from './announce'

describe('đọc to tiền về', () => {
  it('reads amounts the Vietnamese way', () => {
    expect(vndWords(2000)).toBe('hai nghìn')
    expect(vndWords(15000)).toBe('mười lăm nghìn')
    expect(vndWords(21000)).toBe('hai mươi mốt nghìn')
    expect(vndWords(54000)).toBe('năm mươi tư nghìn')
    expect(vndWords(105000)).toBe('một trăm linh năm nghìn')
    expect(vndWords(250000)).toBe('hai trăm năm mươi nghìn')
    expect(vndWords(296500)).toBe('hai trăm chín mươi sáu nghìn năm trăm')
    expect(vndWords(1005000)).toBe('một triệu không trăm linh năm nghìn')
    expect(vndWords(2000000)).toBe('hai triệu')
    expect(vndWords(1250000000)).toBe('một tỷ hai trăm năm mươi triệu')
    expect(announceText(2000)).toBe('Đã nhận chuyển khoản hai nghìn đồng')
  })
})
