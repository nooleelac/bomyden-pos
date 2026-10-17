// The signed-in person's session token. In Supabase mode every request carries it as the x-staff-session header
// (my_staff_id() in 0006 resolves it); the device itself is the Supabase auth user.

export const staffToken: { current: string | null } = { current: null }

/** fetch for createClient({ global: { fetch } }): adds the header while someone is signed in. */
export const staffFetch: typeof fetch = (input, init) => {
  const t = staffToken.current
  if (!t) return fetch(input, init)
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
  headers.set('x-staff-session', t)
  return fetch(input, { ...init, headers })
}
