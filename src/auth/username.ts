// Tên đăng nhập (0033): the same rules as _username_norm / username_problem / _username_from in SQL.

/** Typed account → plain lowercase, no accents, no spaces ("Lan " → "lan", "Quản lý Hà" → "quanlyha"). */
export function normalizeUsername(s: string): string {
  return s
    .trim()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase()
    .replace(/\s/g, '')
}

export function usernameProblem(u: string): string | null {
  return /^[a-z0-9][a-z0-9._]{1,19}$/.test(u) ? null : 'Tên đăng nhập 2–20 ký tự: chữ không dấu, số, dấu chấm hoặc gạch dưới'
}

/** A free account made from a name: base, base2, base3… */
export function usernameFrom(name: string, taken: (u: string) => boolean): string {
  let base = normalizeUsername(name).replace(/[^a-z0-9]/g, '').slice(0, 17)
  if (base.length < 2) base = 'nv' + base
  let u = base
  for (let i = 2; taken(u); i++) u = base + i
  return u
}

const LAST_KEY = 'bmd-last-username'

/** The account last signed in on this device, to fill the box (never a list of names). */
export function lastUsername(): string {
  try {
    return localStorage.getItem(LAST_KEY) ?? ''
  } catch {
    return ''
  }
}
export function rememberUsername(u: string | null) {
  try {
    if (u) localStorage.setItem(LAST_KEY, u)
    else localStorage.removeItem(LAST_KEY)
  } catch {
    /* not remembered */
  }
}
