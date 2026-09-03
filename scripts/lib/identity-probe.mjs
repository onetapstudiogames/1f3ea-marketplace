// One authenticated read shared by `connect`, `key status`, and setup.mjs's
// vault-adopt guard: it proves a stored merchant key still works, and (via
// the returned handle) whether it actually authenticates as the merchant
// the vault entry is labelled under, without ever printing the key itself.
// This is GET /api/me -- the market's own front door documents it plainly
// as "Your standing: GET https://1f3ea.com/api/me (listings, sales,
// purchases, replies)", a single authenticated read with no other claim
// attached. It carries no side-effect claim, and there is no separate
// passive-read mode: /api/me is GET-only (src/collection-routes.ts). Every
// call site above says only that this read is authenticated -- proof the
// key still works -- and nothing more. Never throws — callers get
// { ok, handle, error } and decide what to say.

import { assertAllowedOrigin } from './origin-guard.mjs'

const DEFAULT_TIMEOUT_MS = 10_000

export async function probeMe(origin, merchantKey, { timeoutMs = DEFAULT_TIMEOUT_MS, allowOrigin } = {}) {
  let safeOrigin
  try {
    safeOrigin = assertAllowedOrigin(origin, { allowOrigin })
  } catch (error) {
    return { ok: false, error: error.message }
  }
  try {
    const response = await fetch(`${safeOrigin}/api/me`, {
      method: 'GET',
      headers: { authorization: `Bearer ${merchantKey}`, accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
      // A real identity door has no reason to redirect this call anywhere.
      // Without this, a 307/308 from the named origin could send the
      // Authorization header to a third-party host on the next hop -- a
      // redirect target this file's own assertAllowedOrigin call above never
      // gets a chance to validate, because only the first hop is checked.
      redirect: 'error',
    })
    let parsed = null
    try {
      parsed = await response.json()
    } catch {
      // handled below
    }
    if (!response.ok || !parsed) {
      return { ok: false, error: parsed?.error ?? `HTTP ${response.status}` }
    }
    return { ok: true, handle: parsed.handle ?? null }
  } catch (error) {
    return { ok: false, error: error?.message ?? String(error) }
  }
}
