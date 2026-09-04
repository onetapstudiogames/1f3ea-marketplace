// --- HTTP -----------------------------------------------------------------

/**
 * Wraps a fetch failure (DNS, connection refused, timeout, TLS -- anything
 * before a response ever arrives) into a caller-facing message that names
 * the origin, says nothing was created, and suggests a next step, instead of
 * letting the bare engine error ("fetch failed") escape unexplained. Kept as
 * a byte-identical copy of the market's own reference client
 * (scripts/identity-client.mjs); if this file ever diverges from that
 * upstream copy, port the fix there too.
 */
async function fetchOrExplain(url, init) {
  try {
    // redirect: 'error' overrides anything a caller passed in `init` -- a
    // real identity door has no reason to redirect any of these calls, and
    // without this, a 307/308 response from the (validated) named origin
    // could carry a secret request body to an entirely different host on
    // the next hop, a hop assertAllowedOrigin (called only against the
    // first-hop origin, in originOf above) never gets a chance to check.
    return await fetch(url, { ...init, redirect: 'error' })
  } catch (error) {
    // Node's fetch wraps the real failure in `error.cause`, which for a
    // connection failure is itself an AggregateError with an EMPTY top-level
    // message and the useful text one level deeper in `.errors[0].message`
    // (or just a `.code` like ECONNREFUSED/ENOTFOUND when even that is
    // absent) -- so fall through several levels rather than printing a bare
    // "(network error: )" with nothing after the colon.
    const cause = error?.cause
    const detail =
      cause?.message
      || cause?.errors?.[0]?.message
      || cause?.code
      || error?.message
      || String(error)
    throw new Error(
      `could not reach ${url} (network error: ${detail}); nothing was created -- check the address and ` +
      'your connection, then retry',
    )
  }
}

async function postJson(origin, path, body) {
  const response = await fetchOrExplain(`${origin}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  let parsed = null
  try {
    parsed = await response.json()
  } catch {
    // Non-JSON response falls through with parsed === null below.
  }
  if (!response.ok || !parsed) {
    const error = parsed?.error ?? `HTTP ${response.status} with no readable JSON body`
    // The market's own refusal envelope is exactly {error, reason} (and the
    // same `reason` on the X-1F3EA-Reason header) -- never `next_step`,
    // which no door here returns. Surface the machine-readable reason the
    // market actually publishes instead of a field that can never fire.
    const reason = typeof parsed?.reason === 'string' ? ` reason: ${parsed.reason}` : ''
    throw new Error(`${path} refused: ${error}.${reason}`)
  }
  return parsed
}

async function postAuthed(origin, path, merchantKey, body) {
  const response = await fetchOrExplain(`${origin}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${merchantKey}`,
    },
    body: JSON.stringify(body ?? {}),
  })
  let parsed = null
  try {
    parsed = await response.json()
  } catch {
    // handled below
  }
  if (!response.ok || !parsed) {
    const error = parsed?.error ?? `HTTP ${response.status} with no readable JSON body`
    // Same reason-surfacing tail as postJson above -- the market's refusal
    // envelope on an authed door (e.g. /api/pair) is the same {error, reason}
    // shape, and a caller or harness relies on the machine-readable name to
    // decide what to do next (auth_required, unexpected_fields,
    // pairing_unavailable, rate_limited, storage_unavailable).
    const reason = typeof parsed?.reason === 'string' ? ` reason: ${parsed.reason}` : ''
    throw new Error(`${path} refused: ${error}.${reason}`)
  }
  return parsed
}

// --- Commands ---------------------------------------------------------

/**
 * Best effort: tells the market to release a stage it will otherwise just
 * let expire on its own. Unlike the city's single `stage_token`, the
 * market's own confirm/cancel shape is a `session` + `csrf` PAIR (see the
 * served front door's coding-client doors section: every action other than
 * `recovery generate` accepts `{"action":"cancel","session","csrf"}`) -- so
 * this takes both rather than one opaque token.
 */
async function cancelStage(origin, path, session, csrf) {
  try {
    await postJson(origin, path, { action: 'cancel', session, csrf })
  } catch {
    // Best effort -- the stage expires on its own either way, and the
    // caller above is already reporting the real failure.
  }
}


export { postJson, postAuthed, cancelStage }

