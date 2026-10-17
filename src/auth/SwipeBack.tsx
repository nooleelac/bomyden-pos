// Swipe from left to right anywhere on a screen = back to the previous screen (like the phone's own back gesture).
// A ‹ bubble follows the finger and turns blue once letting go will go back. Not started on fields, on rows that
// scroll sideways, or while a sheet, the menu or the bell list is open. With no earlier screen in this session it goes
// home (Bàn; the kitchen screen for kitchen accounts).

import { useEffect, useRef, useState } from 'react'
import { useAuth } from './context'
import { canOpen, homeRoute } from './guards'

const TRIGGER = 90 // px to the right before letting go goes back

function blocked(target: EventTarget | null): boolean {
  let el = target instanceof Element ? target : null
  if (!el) return true
  if (el.closest('input, textarea, select, [contenteditable], .sheet-backdrop, .drawer-backdrop, .bell-panel, .approval-layer')) return true
  // a row that scrolls sideways (nhóm món, chips, tables) keeps its own swipe
  for (; el && el !== document.body; el = el.parentElement) {
    if (el.scrollWidth > el.clientWidth + 2) {
      const ox = getComputedStyle(el).overflowX
      if (ox === 'auto' || ox === 'scroll') return true
    }
  }
  return false
}

export function SwipeBack() {
  const { session } = useAuth()
  const [dx, setDx] = useState(0)
  // screens visited in this session, to know whether "back" stays inside the app
  const stack = useRef<string[]>([location.hash])
  useEffect(() => {
    const f = () => {
      const s = stack.current
      if (s.length > 1 && s[s.length - 2] === location.hash) s.pop()
      else if (s[s.length - 1] !== location.hash) s.push(location.hash)
    }
    window.addEventListener('hashchange', f)
    return () => window.removeEventListener('hashchange', f)
  }, [])

  const role = session.role
  useEffect(() => {
    const home = '#/' + (canOpen(role, 'floor') ? 'ban' : homeRoute(role))
    // in the browser (not installed as an app) the phone's own edge swipe already goes back: leave the edge to it
    const standalone = matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true
    let start: { x: number; y: number } | null = null
    let active = false
    let last = 0
    const reset = () => {
      start = null
      active = false
      last = 0
      setDx(0)
    }
    const down = (e: TouchEvent) => {
      const t = e.touches[0]
      if (e.touches.length !== 1 || (!standalone && t.clientX < 24) || blocked(e.target)) return reset()
      start = { x: t.clientX, y: t.clientY }
      active = false
    }
    const move = (e: TouchEvent) => {
      if (!start) return
      const t = e.touches[0]
      const x = t.clientX - start.x
      const y = t.clientY - start.y
      if (!active) {
        if (Math.abs(y) > 14 && Math.abs(y) > x) return reset() // scrolling the page
        if (x > 14 && x > 2 * Math.abs(y)) active = true
      }
      if (active) {
        last = Math.max(0, x)
        setDx(last)
      }
    }
    const up = () => {
      const go = active && last >= TRIGGER
      reset()
      if (!go) return
      if (stack.current.length > 1) history.back()
      else if (location.hash !== home) location.hash = home
    }
    window.addEventListener('touchstart', down, { passive: true })
    window.addEventListener('touchmove', move, { passive: true })
    window.addEventListener('touchend', up)
    window.addEventListener('touchcancel', reset)
    return () => {
      window.removeEventListener('touchstart', down)
      window.removeEventListener('touchmove', move)
      window.removeEventListener('touchend', up)
      window.removeEventListener('touchcancel', reset)
    }
  }, [role])

  if (dx <= 0) return null
  const shift = Math.min(dx, TRIGGER + 30)
  return (
    <div className={'swipe-back' + (dx >= TRIGGER ? ' is-ready' : '')} style={{ transform: `translate(${shift - 56}px, -50%)` }} aria-hidden>
      ‹
    </div>
  )
}
