// A tiny, in-memory stand-in for the coding-client JSON identity doors
// (POST /api/register, /api/rotate, /api/recovery, /api/pair, GET /api/me),
// implemented in enough detail for scripts/identity-client.mjs and its
// wrappers (setup/connect/key) to run their real code paths end to end
// against it -- staging, confirming, promoting a vault entry, revealing (or
// not) a real secret -- without ever touching the live market. It is not a
// spec of the real door's behavior; it exists only to give the client
// something real to talk to.
//
// Served over HTTPS (with the self-signed localhost fixture cert in
// test/helpers/fixtures/) because scripts/lib/origin-guard.mjs refuses plain
// http even for localhost, matching the real door.

import { createServer as createHttpsServer } from 'node:https'
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const TLS_OPTIONS = {
  key: readFileSync(join(here, 'fixtures', 'localhost-key.pem')),
  cert: readFileSync(join(here, 'fixtures', 'localhost-cert.pem')),
}

const rootKey = () => `1f3ea_sk_${randomBytes(24).toString('hex')}`
const recoveryCode = () => `1f3ea_rc_${randomBytes(32).toString('hex')}`
const recoveryCodes = () => Array.from({ length: 8 }, recoveryCode)
const token = () => randomBytes(16).toString('hex')

function readBody(req) {
  return new Promise((resolvePromise, rejectPromise) => {
    let data = ''
    req.on('data', chunk => { data += chunk })
    req.on('end', () => {
      try {
        resolvePromise(data ? JSON.parse(data) : {})
      } catch (error) {
        rejectPromise(error)
      }
    })
    req.on('error', rejectPromise)
  })
}

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

function bearerKey(req) {
  const header = req.headers.authorization ?? ''
  const match = /^Bearer (.+)$/u.exec(header)
  return match ? match[1] : null
}

/**
 * Starts the stub on an ephemeral localhost port. Returns
 * { origin, merchants, close() }. `merchants` is a live Map keyed by handle
 * (values: { merchant_key, recovery_codes, client_class }) a test can
 * inspect directly after driving a real CLI command against `origin`, or
 * pre-seed before starting a scenario.
 */
export async function startStubMarketServer() {
  const merchants = new Map()
  // Every pending map is keyed by `session` (an opaque value, unrelated to
  // its `csrf` companion) -- mirrors the market's own confirm shape
  // {"action":"confirm","session","csrf","merchant_key"}, which is why this
  // stub tracks TWO values per pending stage/begin, not city's single
  // stage_token.
  const pendingRegistrations = new Map() // session -> { handle, merchant_key, recovery_codes, client_class, csrf }
  const pendingRotations = new Map() // session -> { handle, merchant_key, client_class, csrf }
  const pendingRecoveries = new Map() // session -> { handle, merchant_key, csrf }

  function confirmed(pendingMap, body) {
    const pending = pendingMap.get(body.session)
    if (!pending || pending.csrf !== body.csrf || pending.merchant_key !== body.merchant_key) return null
    pendingMap.delete(body.session)
    return pending
  }

  const server = createHttpsServer(TLS_OPTIONS, async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/api/me') {
        const key = bearerKey(req)
        const found = [...merchants.entries()].find(([, value]) => value.merchant_key === key)
        if (!found) return send(res, 401, { error: 'invalid or expired merchant key' })
        return send(res, 200, { handle: found[0] })
      }

      if (req.method !== 'POST') return send(res, 404, { error: 'not found' })
      const body = await readBody(req)

      if (req.url === '/api/register') {
        if (body.action === 'stage') {
          if (merchants.has(body.handle)) {
            return send(res, 409, { error: `handle "${body.handle}" is already taken`, reason: 'handle_taken' })
          }
          const session = token()
          const entry = {
            handle: body.handle,
            merchant_key: rootKey(),
            recovery_codes: recoveryCodes(),
            client_class: body.client_class,
            csrf: token(),
          }
          pendingRegistrations.set(session, entry)
          return send(res, 200, { ...entry, session })
        }
        if (body.action === 'confirm') {
          const pending = confirmed(pendingRegistrations, body)
          if (!pending) return send(res, 403, { error: 'session, csrf, or merchant key mismatch' })
          merchants.set(pending.handle, {
            merchant_key: pending.merchant_key,
            recovery_codes: pending.recovery_codes,
            client_class: pending.client_class,
          })
          return send(res, 200, { handle: pending.handle, merchant_id: merchants.size })
        }
        if (body.action === 'cancel') {
          pendingRegistrations.delete(body.session)
          return send(res, 200, { status: 'cancelled' })
        }
        return send(res, 400, { error: `unknown register action "${body.action}"` })
      }

      if (req.url === '/api/rotate') {
        if (body.action === 'begin') {
          const found = [...merchants.entries()].find(([, value]) => value.merchant_key === body.merchant_key)
          if (!found) return send(res, 403, { error: 'credential_rejected' })
          if (body.client_class !== 'coding_persistent' && body.client_class !== 'coding_ephemeral') {
            return send(res, 400, { error: 'client_class must be coding_persistent or coding_ephemeral' })
          }
          const session = token()
          const entry = { handle: found[0], merchant_key: rootKey(), client_class: body.client_class, csrf: token() }
          pendingRotations.set(session, entry)
          return send(res, 200, { ...entry, session })
        }
        if (body.action === 'confirm') {
          const pending = confirmed(pendingRotations, body)
          if (!pending) return send(res, 403, { error: 'session, csrf, or merchant key mismatch' })
          const merchant = merchants.get(pending.handle)
          // The real door invalidates every recovery code the moment a
          // rotation confirms -- simulated here by clearing them, so a
          // test can assert the client never claims stale codes survived.
          merchants.set(pending.handle, {
            ...merchant,
            merchant_key: pending.merchant_key,
            client_class: pending.client_class,
            recovery_codes: [],
          })
          return send(res, 200, { handle: pending.handle })
        }
        if (body.action === 'cancel') {
          pendingRotations.delete(body.session)
          return send(res, 200, { status: 'cancelled' })
        }
        return send(res, 400, { error: `unknown rotate action "${body.action}"` })
      }

      if (req.url === '/api/recovery') {
        if (body.action === 'generate') {
          const found = [...merchants.entries()].find(([, value]) => value.merchant_key === body.merchant_key)
          if (!found) return send(res, 403, { error: 'credential_rejected' })
          const codes = recoveryCodes()
          merchants.set(found[0], { ...found[1], recovery_codes: codes })
          return send(res, 200, { handle: found[0], recovery_codes: codes })
        }
        if (body.action === 'begin') {
          const found = [...merchants.entries()].find(([, value]) => value.recovery_codes?.includes(body.recovery_code))
          if (!found) return send(res, 403, { error: 'credential_rejected' })
          const session = token()
          const entry = { handle: found[0], merchant_key: rootKey(), csrf: token() }
          pendingRecoveries.set(session, entry)
          return send(res, 200, { ...entry, session })
        }
        if (body.action === 'confirm') {
          const pending = confirmed(pendingRecoveries, body)
          if (!pending) return send(res, 403, { error: 'session, csrf, or merchant key mismatch' })
          const merchant = merchants.get(pending.handle)
          merchants.set(pending.handle, { ...merchant, merchant_key: pending.merchant_key, recovery_codes: [] })
          return send(res, 200, { handle: pending.handle })
        }
        if (body.action === 'cancel') {
          pendingRecoveries.delete(body.session)
          return send(res, 200, { status: 'cancelled' })
        }
        return send(res, 400, { error: `unknown recovery action "${body.action}"` })
      }

      if (req.url === '/api/pair') {
        const key = bearerKey(req)
        const found = [...merchants.entries()].find(([, value]) => value.merchant_key === key)
        if (!found) return send(res, 401, { error: 'invalid or expired merchant key' })
        return send(res, 200, {
          pairing_code: `pair-${token()}`,
          expires_at: new Date(Date.now() + 600_000).toISOString(),
        })
      }

      return send(res, 404, { error: 'not found' })
    } catch (error) {
      send(res, 500, { error: error.message })
    }
  })

  await new Promise((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise)
    server.listen(0, '127.0.0.1', resolvePromise)
  })
  const { port } = server.address()

  return {
    origin: `https://localhost:${port}`,
    merchants,
    close: () => new Promise(resolvePromise => server.close(resolvePromise)),
  }
}

/**
 * A stub that answers every request with a 307 redirect to `location`,
 * regardless of method or path -- used only to prove postJson/postAuthed
 * (identity-client.mjs) and probeMe (lib/identity-probe.mjs) refuse to
 * follow it instead of resending a secret-carrying request to wherever it
 * points. Served over HTTPS with the same fixture cert as
 * startStubMarketServer, since assertAllowedOrigin refuses plain http even
 * for localhost, so this must look like a legitimate origin up to the
 * redirect itself.
 */
export async function startRedirectingStubServer(location) {
  const server = createHttpsServer(TLS_OPTIONS, (req, res) => {
    res.writeHead(307, { location })
    res.end()
  })
  await new Promise((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise)
    server.listen(0, '127.0.0.1', resolvePromise)
  })
  const { port } = server.address()
  return {
    // 127.0.0.1, not localhost: the server above only binds IPv4, and on at
    // least one sandboxed CI-like environment resolving "localhost" here hit
    // undici's ~10s connect timeout trying (and failing) an IPv6 leg first.
    // assertAllowedOrigin allows 127.0.0.1 unconditionally too, same as
    // localhost, so this is not a weaker test of the origin guard.
    origin: `https://127.0.0.1:${port}`,
    close: () => new Promise(resolvePromise => server.close(resolvePromise)),
  }
}
