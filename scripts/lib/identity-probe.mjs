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
// { ok, handle, error, status, rejected } and decide what to say.
//
// `rejected` is true only when the market actually answered and refused the
// credential (HTTP 401 or 403 on THIS read) -- the one case a caller may
// safely treat as "this key is dead". Every other failure -- a timeout, a
// DNS failure, connection refused, an HTTP 5xx, a 429, or any other
// non-2xx/non-401/403 status -- leaves `rejected: false` alongside
// `ok: false`, because none of those are the market telling anyone the
// credential is bad; they are the market (or the network) being
// unreachable, which proves nothing about the key. `status` carries the raw
// HTTP status code when a response was received at all (undefined for a
// pure transport failure, so a caller can still tell the two apart even
// when `rejected` alone is not enough detail).

import { assertAllowedOrigin } from './origin-guard.mjs'

const DEFAULT_TIMEOUT_MS = 10_000

export async function probeMe(origin, merchantKey, { timeoutMs = DEFAULT_TIMEOUT_MS, allowOrigin } = {}) {
  let safeOrigin
  try {
    safeOrigin = assertAllowedOrigin(origin, { allowOrigin })
  } catch (error) {
    return { ok: false, error: error.message, rejected: false }
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
      return {
        ok: false,
        error: parsed?.error ?? `HTTP ${response.status}`,
        status: response.status,
        rejected: response.status === 401 || response.status === 403,
      }
    }
    return { ok: true, handle: parsed.handle ?? null }
  } catch (error) {
    return { ok: false, error: error?.message ?? String(error), rejected: false }
  }
}

/**
 * One anonymous GET /api/official read, used only by setup.mjs's
 * pre-registration check: whether the coding-client identity doors
 * (/api/register, /api/rotate, /api/recovery, /api/pair) are even open,
 * BEFORE ever spending a human-approval nonce on a registration that would
 * be refused for that reason alone. The market publishes
 * identity.coding_client_doors as null while those doors are gated behind
 * MARKET_CODING_IDENTITY_ENABLED (ref-market src/door.ts,
 * src/market-identity-routes.ts) and refuses /api/register itself with
 * reason coding_identity_dormant in that state -- this read exists only to
 * catch that case one step earlier, before the nonce round trip, not to
 * replace that refusal as the source of truth. Public data with no secret
 * attached, so unlike probeMe above this carries no Authorization header.
 * Never throws -- callers get { ok, codingDoorsOpen, error } and decide what
 * to say; a failed read (ok: false) is not evidence either way and must fall
 * through to the existing verbatim register()-time refusal as the backstop.
 */
export async function probeOfficialDoors(origin, { timeoutMs = DEFAULT_TIMEOUT_MS, allowOrigin } = {}) {
  let safeOrigin
  try {
    safeOrigin = assertAllowedOrigin(origin, { allowOrigin })
  } catch (error) {
    return { ok: false, error: error.message }
  }
  try {
    const response = await fetch(`${safeOrigin}/api/official`, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
      // Same reasoning as probeMe above: a redirect from the validated
      // origin could send this read somewhere assertAllowedOrigin never got
      // a chance to check.
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
    return { ok: true, codingDoorsOpen: parsed.identity?.coding_client_doors != null }
  } catch (error) {
    return { ok: false, error: error?.message ?? String(error) }
  }
}
