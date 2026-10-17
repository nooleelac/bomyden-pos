// Dishes picked but not sent to the kitchen yet ("chưa lưu"), kept on this device per order until they are sent or
// removed. Shared by the menu (Gọi món) and the order's Chi tiết hoá đơn screen.

import { useEffect, useState } from 'react'
import type { PickerState } from './picker'

export interface Draft {
  key: number
  state: PickerState
}

export const draftKey = () => Date.now() + Math.random()

function loadCart(key: string | undefined): Draft[] {
  if (!key) return []
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? '[]')
    return Array.isArray(v) ? (v as Draft[]) : []
  } catch {
    return []
  }
}

export function useCart(storageKey: string | undefined) {
  const [lines, setLines] = useState<Draft[]>(() => loadCart(storageKey))
  useEffect(() => {
    if (!storageKey) return
    try {
      if (lines.length) localStorage.setItem(storageKey, JSON.stringify(lines))
      else localStorage.removeItem(storageKey)
    } catch {
      /* storage blocked: the cart still lives in memory */
    }
  }, [lines, storageKey])
  return [lines, setLines] as const
}

export type Cart = ReturnType<typeof useCart>
