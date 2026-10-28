#!/usr/bin/env node
// Bò Mỹ Đen POS — app cầu nối máy in WiFi/LAN (migration 0018).
//
// Chạy trên một máy tính ở quán, cùng mạng với máy in. Nó:
//   * dò máy in trong mạng (cổng 9100) và báo về để chọn ở Cài đặt → Máy in,
//   * nhận lệnh in từ mọi máy (cả iPad, điện thoại) rồi gửi thẳng tới máy in.
//
// Cần Node.js 18 trở lên (https://nodejs.org). Lần đầu:  node cau-noi-may-in.mjs   → dán mã kết nối.
// Tự chạy khi bật máy (Windows):                          node cau-noi-may-in.mjs --tu-chay
// Không cần cài thêm gì: chỉ dùng thư viện có sẵn của Node.

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createConnection } from 'node:net'
import { networkInterfaces } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const CONFIG = join(here, 'cau-noi-may-in.json')
const POLL_MS = 1500
const SCAN_EVERY_MS = 10 * 60_000
const PORTS = [9100]

const log = (...a) => console.log(new Date().toLocaleTimeString('vi-VN'), ...a)

// ---------------------------------------------------------------- mã kết nối

function decode(code) {
  const c = code.trim()
  if (!c.startsWith('BMD1.')) throw new Error('Mã kết nối phải bắt đầu bằng BMD1.')
  const j = JSON.parse(Buffer.from(c.slice(5), 'base64').toString('utf8'))
  if (!j.u || !j.k || !j.t) throw new Error('Mã kết nối thiếu thông tin')
  return { url: j.u, anonKey: j.k, token: j.t }
}

async function loadConfig() {
  const fromArg = process.argv.find(a => a.startsWith('BMD1.'))
  if (fromArg) {
    const cfg = decode(fromArg)
    writeFileSync(CONFIG, JSON.stringify(cfg, null, 2))
    return cfg
  }
  if (existsSync(CONFIG)) return JSON.parse(readFileSync(CONFIG, 'utf8'))
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  console.log('Vào Cài đặt → Máy in → WiFi/LAN → "Thêm app cầu nối" để lấy mã kết nối.')
  const code = await rl.question('Dán mã kết nối rồi bấm Enter: ')
  rl.close()
  const cfg = decode(code)
  writeFileSync(CONFIG, JSON.stringify(cfg, null, 2))
  log('Đã lưu mã kết nối vào', CONFIG)
  return cfg
}

// ---------------------------------------------------------------- tự chạy khi bật máy (Windows)

function installStartup() {
  if (process.platform !== 'win32') {
    console.log('Tự chạy chỉ cài sẵn cho Windows. Trên máy khác hãy thêm lệnh này vào chương trình khởi động:')
    console.log(`  node "${fileURLToPath(import.meta.url)}"`)
    return
  }
  const dir = join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup')
  const bat = join(dir, 'cau-noi-may-in-bomyden.bat')
  writeFileSync(bat, `@echo off\r\ncd /d "${here}"\r\nstart "Cau noi may in" /min "${process.execPath}" "${fileURLToPath(import.meta.url)}"\r\n`)
  console.log('Đã cài tự chạy khi bật máy:', bat)
}

// ---------------------------------------------------------------- máy chủ

async function rpc(cfg, fn, args) {
  const r = await fetch(`${cfg.url}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { apikey: cfg.anonKey, Authorization: `Bearer ${cfg.anonKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  })
  const text = await r.text()
  if (!r.ok) {
    let msg = text
    try {
      msg = JSON.parse(text).message || text
    } catch {
      /* not JSON */
    }
    throw new Error(msg)
  }
  return text ? JSON.parse(text) : null
}

// ---------------------------------------------------------------- dò máy in

function probe(host, port, ms = 500) {
  return new Promise(resolve => {
    const s = createConnection({ host, port })
    const done = ok => {
      s.destroy()
      resolve(ok)
    }
    s.setTimeout(ms, () => done(false))
    s.once('connect', () => done(true))
    s.once('error', () => done(false))
  })
}

function subnets() {
  const out = new Set()
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family !== 'IPv4' && a.family !== 4) continue
      if (a.internal || a.address.startsWith('169.254.')) continue
      out.add(a.address.split('.').slice(0, 3).join('.'))
    }
  }
  return [...out]
}

async function scan() {
  const targets = []
  for (const net of subnets()) for (let i = 1; i < 255; i++) for (const port of PORTS) targets.push({ host: `${net}.${i}`, port })
  log(`Đang dò máy in trong mạng ${subnets().map(n => n + '.x').join(', ') || '(không có mạng)'}…`)
  const found = []
  let next = 0
  await Promise.all(
    Array.from({ length: 64 }, async () => {
      while (next < targets.length) {
        const t = targets[next++]
        if (await probe(t.host, t.port)) found.push({ host: t.host, port: t.port, name: `Máy in ${t.host}` })
      }
    }),
  )
  found.sort((a, b) => a.host.localeCompare(b.host, 'en', { numeric: true }))
  log(found.length ? `Tìm thấy ${found.length} máy in: ${found.map(f => f.host).join(', ')}` : 'Chưa thấy máy in nào (cổng 9100)')
  return found
}

// ---------------------------------------------------------------- in

function send(host, port, data) {
  return new Promise((resolve, reject) => {
    const s = createConnection({ host, port })
    s.setTimeout(10_000, () => s.destroy(new Error('máy in không trả lời (hết 10 giây)')))
    s.once('error', e => reject(new Error(e.code === 'ECONNREFUSED' ? 'máy in từ chối kết nối' : e.code === 'EHOSTUNREACH' ? 'không tới được máy in' : e.message)))
    s.once('connect', () => s.end(data))
    s.once('close', hadError => (hadError ? undefined : resolve()))
  })
}

async function main() {
  if (process.argv.includes('--tu-chay')) installStartup()
  const cfg = await loadConfig()
  let printers = null
  let lastScan = 0
  let name = ''
  let failing = false
  log('App cầu nối máy in đang chạy. Để cửa sổ này mở (hoặc cài tự chạy: --tu-chay).')
  for (;;) {
    try {
      let report = null
      if (printers === null || Date.now() - lastScan > SCAN_EVERY_MS) {
        printers = await scan()
        lastScan = Date.now()
        report = printers
      }
      const res = await rpc(cfg, 'agent_poll', { p_token: cfg.token, p_printers: report })
      if (failing || res.name !== name) log(`Đã kết nối máy chủ: cầu nối "${res.name}"`)
      failing = false
      name = res.name
      if (res.rescan) lastScan = 0
      for (const job of res.jobs) {
        let err = ''
        try {
          await send(job.host, job.port, Buffer.from(job.data, 'base64'))
          log(`In xong lệnh ${job.id} → ${job.host}`)
        } catch (e) {
          err = e.message
          log(`Lỗi in lệnh ${job.id} → ${job.host}: ${err}`)
        }
        await rpc(cfg, 'agent_done', { p_token: cfg.token, p_id: job.id, p_error: err })
      }
    } catch (e) {
      if (!failing) log('Không kết nối được máy chủ:', e.message, '(sẽ thử lại)')
      failing = true
      if (/Mã kết nối không đúng/.test(e.message)) {
        log(`Mã kết nối không còn dùng được. Xoá ${CONFIG} rồi chạy lại để dán mã mới.`)
        process.exit(1)
      }
    }
    await new Promise(r => setTimeout(r, POLL_MS))
  }
}

main().catch(e => {
  console.error('Lỗi:', e.message)
  process.exit(1)
})
