// #/cai-dat/thong-bao: every kind of notice in one place.
//   Thông báo đẩy trên máy này   Web Push (0015): every activity, even with the app closed or the phone locked; owner
//                                and managers also get the loss-control alerts (0029), cashiers the money in (0032).
//   Đọc to tiền về              this device says "Đã nhận chuyển khoản … đồng" when Pay2S reports money (cashier roles).
//   Tự xác nhận chuyển khoản    the Pay2S link itself (owner, 0030–0031), which feeds the two above.
// The first two are per device (each phone chooses), the last is the shop's.

import { useEffect, useState } from 'react'
import { useAuth } from '../auth/context'
import { roleCan } from '../auth/permissions'
import { announceText, speakVi, unlockSpeech, useAnnounce, useViVoice } from '../cashier/announce'
import { play, unlockSound } from '../floor/sound'
import type { FloorRepo } from '../floor/repo'
import type { FloorState } from '../floor/types'
import { Section, Switch } from '../menu/ui'
import { disablePush, enablePush, pushState, testPush, type PushState } from '../push/push'
import { BankFeedSettings } from './BankFeedSettings'

export function NotifySettings(props: { floor: FloorState; repo: FloorRepo; onError: (m: string) => void; onInfo: (m: string) => void }) {
  const { session } = useAuth()
  const cashier = roleCan(session.role, 'pay.collect')
  const alerts = roleCan(session.role, 'audit.view')
  return (
    <>
      <h1>Thông báo</h1>
      <PushSection cashier={cashier} alerts={alerts} onError={props.onError} onInfo={props.onInfo} />
      {cashier && <AnnounceSection feedOn={!!props.floor.bankFeed} owner={session.role === 'owner'} />}
      {session.role === 'owner' && <BankFeedSettings repo={props.repo} onError={props.onError} onInfo={props.onInfo} />}
    </>
  )
}

const PUSH_TAG: Record<PushState, string> = { unsupported: 'Không hỗ trợ', 'need-install': 'Cần cài app', denied: 'Đang bị chặn', off: 'Đang tắt', on: 'Đang bật' }

function PushSection(props: { cashier: boolean; alerts: boolean; onError: (m: string) => void; onInfo: (m: string) => void }) {
  const [state, setState] = useState<PushState | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    pushState().then(setState, () => setState('unsupported'))
  }, [])
  const run = (f: () => Promise<PushState | void>, ok: string) => async () => {
    setBusy(true)
    try {
      const s = await f()
      if (s) setState(s)
      props.onInfo(ok)
    } catch (e) {
      props.onError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Section title="Thông báo đẩy trên máy này" aside={state && <span className={'tag-default' + (state === 'on' ? '' : ' is-off')}>{PUSH_TAG[state]}</span>}>
      <p className="muted small">
        Hiện thông báo kèm tiếng “ting” của máy, kể cả khi đã tắt app hoặc khoá màn hình: mở bàn, gửi bếp, món xong, giục món, khách gọi…
        {props.cashier && ' Thu ngân nhận thêm “🏦 Tiền về … · Bàn …” khi Pay2S báo chuyển khoản.'}
        {props.alerts && ' Chủ quán và quản lý nhận thêm cảnh báo thất thoát (huỷ món, xác nhận chuyển khoản tay, két lệch…).'}
      </p>
      {!state ? (
        <p className="muted">Đang kiểm tra…</p>
      ) : state === 'unsupported' ? (
        <p className="muted small">Máy hoặc trình duyệt này không nhận được thông báo đẩy (bản dữ liệu mẫu cũng không có). Dùng Chrome trên Android / máy tính, Safari trên iPhone.</p>
      ) : state === 'need-install' ? (
        <ol className="feed-steps">
          <li>
            Trong Safari bấm nút <b>Chia sẻ</b> → <b>Thêm vào Màn hình chính</b>.
          </li>
          <li>Đóng Safari, mở app từ biểu tượng Bò Mỹ Đen ở màn hình chính, đăng nhập.</li>
          <li>Quay lại trang này và bấm Bật thông báo (cần iOS 16.4 trở lên).</li>
        </ol>
      ) : state === 'denied' ? (
        <p className="small">
          Trình duyệt đang chặn thông báo của app. Mở cài đặt trang web (biểu tượng ổ khoá cạnh địa chỉ, hoặc Cài đặt → Thông báo trên điện thoại) →{' '}
          <b>Cho phép</b>, rồi tải lại trang.
        </p>
      ) : state === 'off' ? (
        <button type="button" className="btn btn-primary" disabled={busy} onClick={run(enablePush, 'Đã bật thông báo, máy sẽ nhận một thông báo thử')}>
          {busy ? 'Đang bật…' : '🔔 Bật thông báo trên máy này'}
        </button>
      ) : (
        <div className="notify-actions">
          <button type="button" className="btn" disabled={busy} onClick={run(testPush, 'Đã gửi thông báo thử')}>
            Gửi thử
          </button>
          <button type="button" className="btn" disabled={busy} onClick={run(disablePush, 'Đã tắt thông báo trên máy này')}>
            Tắt thông báo
          </button>
        </div>
      )}
    </Section>
  )
}

function AnnounceSection(props: { feedOn: boolean; owner: boolean }) {
  const [on, setOn] = useAnnounce()
  const voice = useViVoice()
  const test = () => {
    // inside the tap itself: iPhone refuses speech started after an await
    unlockSpeech()
    speakVi(announceText(2000), () => void unlockSound().then(() => play('money')))
  }
  return (
    <Section title="Đọc to tiền về" aside={<span className={'tag-default' + (on && props.feedOn ? '' : ' is-off')}>{on && props.feedOn ? 'Đang bật' : 'Đang tắt'}</span>}>
      <p className="muted small">
        Khi Pay2S báo tiền về, máy đang mở màn <b>Thu ngân</b> đọc to “Đã nhận chuyển khoản … đồng”, như loa thanh toán. Chọn riêng cho từng máy: quán có hai
        máy thu ngân thì bật ở một máy.
      </p>
      {!props.feedOn && (
        <p className="small notify-warn">
          Tự xác nhận chuyển khoản (Pay2S) đang tắt nên chưa có gì để đọc.{props.owner ? ' Bật ở mục bên dưới.' : ' Nhờ chủ quán bật.'}
        </p>
      )}
      <Switch
        checked={on}
        onChange={setOn}
        label={
          <span>
            <b>Đọc to trên máy này</b>
            <span className="muted small block">
              {voice ? 'Máy có giọng tiếng Việt.' : 'Máy chưa có giọng tiếng Việt nên chỉ kêu chuông.'} Màn hình Thu ngân luôn sáng khi đang bật.
            </span>
          </span>
        }
      />
      {on && (
        <div className="notify-actions">
          <button type="button" className="btn" onClick={test}>
            🔊 Nghe thử
          </button>
        </div>
      )}
      <ul className="muted small notify-tips">
        <li>Mỗi lần mở app, chạm vào màn hình một lần thì máy mới phát được tiếng.</li>
        <li>Chỉ đọc khi màn hình đang sáng và app đang mở. Khoá màn hình thì dùng thông báo đẩy ở trên.</li>
        <li>
          Chỉ nghe chuông: Android vào <b>Cài đặt → Hệ thống → Ngôn ngữ → Chuyển văn bản thành lời nói</b>, tải giọng Tiếng Việt; iPhone vào{' '}
          <b>Cài đặt → Trợ năng → Nội dung được đọc → Giọng nói</b>; máy tính Windows nên mở app bằng Edge.
        </li>
      </ul>
    </Section>
  )
}
