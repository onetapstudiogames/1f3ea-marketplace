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
// `rejected` is true only for an answer that can only have come from the
// market's own credential check on THIS read: HTTP 401 with a body that
// parsed as JSON and carries the market's own `error` string, exactly --
// `MARKET_REJECTION_MESSAGE` below -- the one and only shape GET /api/me
// answers a bad or missing bearer secret with, via `err(c, 401, 'bad or
// missing bearer secret')` -> `c.json({ error: message }, 401)` (ref-market
// src/collection-routes.ts, src/core.ts). The market's /api/me never
// answers 403 at all -- there is no suspended or banned merchant state
// anywhere in its schema or routes, and this path carries no ownership
// check to fail one on -- so treating a 403 as a rejection buys nothing
// except every intermediary's 403: a Vercel Firewall / Attack Challenge
// Mode page, a Cloudflare interstitial, or a corporate proxy sitting in
// front of a perfectly healthy origin all answer 403 too (round-4 MEDIUM
// finding: `rejected` used to fire on ANY 401 or 403, letting one of those
// pages make a caller destroy a working live key). The same reasoning
// throws out an HTML 401: a Vercel deployment-protection page answers 401
// for a perfectly good key, and it carries no JSON `error` string -- only
// the market's own answer does. Round-5's LOW finding narrowed this
// further: matching ANY 401 JSON with a string `error` field was still too
// wide, because a JSON-speaking intermediary in front of a healthy origin
// (a rate limiter, a gateway) could answer 401 with its own JSON `error`
// text that is not the market's -- and that used to count as a rejection
// too, destroying a working live key on a message the market never sent.
// `rejected` now requires the exact string. This literal is never
// published anywhere (not llms.txt, not door.ts, not the docs) -- it is an
// internal detail of a separate repo -- so pinning it fails CLOSED if it
// ever drifts: `npm run check:live-truth` carries one anonymous assertion
// (no bearer sent) that GET https://1f3ea.com/api/me still answers exactly
// this 401 JSON, so a reword upstream trips that gate instead of quietly
// turning every future adopt into a permanent refuser. Every other failure
// -- a timeout, a DNS failure, connection refused, an HTTP 5xx, a 429, a
// 403, a 401 whose body did not parse as JSON, or a 401 JSON `error` string
// that is not this exact one -- leaves `rejected: false` alongside
// `ok: false`, because none of those can only have come from the market's
// own check; they are the market (or something standing in front of it)
// being unreachable, unrecognized, or misquoted, which proves nothing about
// the key. Callers that refuse on `!rejected` quote `error` verbatim in
// their own message and never say "the market" about text the market could
// not have produced. `status` still carries the raw HTTP status code
// whenever a response was received at all (undefined only for a pure
// transport failure), so a caller can always see what was actually seen
// even when `rejected` alone is not enough detail.

import { assertAllowedOrigin } from './origin-guard.mjs'

const DEFAULT_TIMEOUT_MS = 10_000

// The market's one and only GET /api/me credential-rejection message --
// `err(c, 401, 'bad or missing bearer secret')` in ref-market's
// src/collection-routes.ts, via `err`'s `c.json({ error: message }, status)`
// in src/core.ts. Exported so `npm run check:live-truth` can pin the exact
// same literal against the live market instead of duplicating it (see the
// long comment above for why pinning it at all is deliberate, fail-closed
// behaviour, not an accident waiting to bit-rot).
export const MARKET_REJECTION_MESSAGE = 'bad or missing bearer secret'

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
        rejected: response.status === 401 && parsed != null && parsed.error === MARKET_REJECTION_MESSAGE,
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
