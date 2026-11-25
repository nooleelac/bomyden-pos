// Cài đặt → Thanh toán → Tự xác nhận chuyển khoản (owner only, migrations 0030–0031): link Pay2S, which reads the
// balance changes of the shop's bank accounts and posts each transfer to the edge function pay2s-hook. The owner adds a
// webhook in Pay2S with the address below, copies the token Pay2S makes for it into this page, then turns the feed on.
// While it is on, the cashier's VietQR sheet confirms a transfer by itself, and one confirmed by hand is reported to the
// owner (Kiểm soát thất thoát, push).

import { useEffect, useState } from 'react'
import { errText } from '../floor/hooks'
import type { FloorRepo } from '../floor/repo'
import type { BankFeedStatus } from '../floor/types'
import { Field, Section, Switch } from '../menu/ui'

const HOOK_URL = `${import.meta.env.VITE_SUPABASE_URL || 'https://<du-an>.supabase.co'}/functions/v1/pay2s-hook`

const ago = (iso: string) => {
  const min = Math.round((Date.now() - Date.parse(iso)) / 60_000)
  if (min < 1) return 'vừa xong'
  if (min < 60) return `${min} phút trước`
  if (min < 48 * 60) return `${Math.round(min / 60)} giờ trước`
  return new Date(iso).toLocaleDateString('vi-VN')
}

/** "abcd…wxyz": enough to tell which token is stored without showing it. */
const masked = (t: string) => (t.length > 8 ? `${t.slice(0, 4)}…${t.slice(-4)}` : '••••')

export function BankFeedSettings(props: { repo: FloorRepo; onError: (m: string) => void; onInfo: (m: string) => void }) {
  const [st, setSt] = useState<BankFeedStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [token, setToken] = useState('')
  const { repo } = props
  useEffect(() => {
    repo.bankFeedStatus().then(setSt, e => props.onError(errText(e)))
    // once per repo: onError is a new function every render
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo])

  const setup = (on: boolean, newToken?: string) => {
    setBusy(true)
    props.repo
      .setupBankFeed(on, newToken)
      .then(
        x => {
          setSt(x)
          if (newToken !== undefined) setToken('')
          props.onInfo(newToken !== undefined ? 'Đã lưu token Pay2S' : on ? 'Đã bật tự xác nhận chuyển khoản' : 'Đã tắt tự xác nhận chuyển khoản')
        },
        e => props.onError(errText(e)),
      )
      .finally(() => setBusy(false))
  }
  const copy = (text: string) =>
    navigator.clipboard.writeText(text).then(
      () => props.onInfo('Đã chép địa chỉ webhook'),
      () => props.onError('Không chép được: chọn và chép tay'),
    )

  return (
    <Section title="Tự xác nhận chuyển khoản (Pay2S)" aside={<span className={'tag-default' + (st?.on ? '' : ' is-off')}>{st?.on ? 'Đang bật' : 'Đang tắt'}</span>}>
      <p className="muted small">
        Pay2S đọc biến động số dư tài khoản của quán và báo về app. Khách chuyển đúng nội dung trên mã VietQR thì màn thu ngân tự xác nhận, thu ngân không cần bấm
        “Đã nhận tiền”. Khoản nào thu ngân xác nhận tay sẽ báo cho chủ quán.
      </p>
      {!st ? (
        <p className="muted">Đang tải…</p>
      ) : (
        <>
          <ol className="feed-steps">
            <li>
              Trên <b>pay2s.vn</b>, liên kết tài khoản ngân hàng nhận tiền của quán (đúng tài khoản in trên mã VietQR ở trên).
            </li>
            <li>
              Pay2S → <b>Webhooks → Danh sách webhook → Thêm webhook</b>: sự kiện <b>Tiền vào</b>, chọn tài khoản ngân hàng, ô “Gọi đến URL” dán địa chỉ này:
              <div className="feed-copy">
                <code>{HOOK_URL}</code>
                <button type="button" className="btn btn-small" onClick={() => copy(HOOK_URL)}>
                  Chép
                </button>
              </div>
              Token xác thực chọn <b>Token riêng</b>, cấu trúc mã thanh toán để <b>Không giới hạn</b>, rồi bấm <b>Thêm webhook</b>.
            </li>
            <li>
              Trong danh sách webhook của Pay2S, chép <b>token</b> của webhook vừa tạo và dán vào đây:
              <div className="feed-copy">
                <Field label="Token webhook Pay2S" hint={st.token ? `Đang lưu: ${masked(st.token)}` : 'Chưa có token'}>
                  <input type="password" autoComplete="off" spellCheck={false} value={token} placeholder="Dán token" onChange={e => setToken(e.target.value)} />
                </Field>
                <button type="button" className="btn btn-small btn-primary" disabled={busy || token.trim().length < 16} onClick={() => setup(st.on, token)}>
                  Lưu token
                </button>
              </div>
              <span className="muted small block">Giữ kín token: ai có token có thể gửi giao dịch giả vào app.</span>
            </li>
            <li>
              Bật công tắc bên dưới. Quay lại Pay2S bấm <b>Lưu và kiểm tra</b> (hoặc chuyển thử 2.000đ) rồi xem dòng “Lần cuối Pay2S gọi”.
            </li>
          </ol>
          <Switch
            checked={st.on}
            disabled={busy || (!st.on && !st.token)}
            onChange={v => setup(v)}
            label={
              <span>
                <b>Tự xác nhận chuyển khoản</b>
                <span className="muted small block">
                  {st.on
                    ? 'Thu ngân chờ ngân hàng báo; bấm xác nhận tay sẽ báo chủ quán'
                    : st.token
                      ? 'Thu ngân tự xem app ngân hàng rồi bấm “Đã nhận tiền” như trước'
                      : 'Lưu token Pay2S trước khi bật'}
                </span>
              </span>
            }
          />
          <p className="muted small">
            Lần cuối Pay2S gọi: <b>{st.lastAt ? ago(st.lastAt) : 'chưa lần nào'}</b> · {st.countToday} khoản tiền về trong 24 giờ
          </p>
        </>
      )}
    </Section>
  )
}
