// A tiny, in-memory stand-in for the coding-client JSON identity doors
// (POST /api/register, /api/rotate, /api/recovery, /api/pair, GET /api/me),
// implemented in enough detail for scripts/identity-client.mjs and its
// wrappers (setup/connect/key) to run their real code paths end to end
// against it -- staging, confirming, promoting a vault entry, revealing (or
// not) a real secret -- without ever touching the live market. Its field
// validation, refusal shape (a human-worded `error`, a machine-readable
// `reason`, and the X-1F3EA-Reason header), refusal ordering (shape checked
// before any credential lookup), and success-response shapes are all
// deliberately mirrored from the real doors in the market server's own
// source (src/market-identity-json-routes.ts, src/market-pairing-routes.ts,
// src/core.ts) -- not invented independently -- because a test that proves
// the client works against a fictional contract proves nothing about
// whether it works against the real one. Rate limiting and Postgres-level
// deadlock retry are NOT modeled: nothing here needs them. Field presence
// (exactJsonFields is subset-only: extra keys are refused, missing ones are
// left for the per-field validators below to catch with the real door's own
// reason name) and the session/csrf 64-hex ceremony-token shape ARE modeled
// (mirrors requireCeremony's invalid_ceremony guard), because a caller
// relies on those specific reason names to decide what to do next; the
// actual match against a staged session's own value is still this stub's
// plain Map lookup, not the market's real hashed-lookup mechanism.
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

// Matches the real market's credentialShapePattern for these two families
// (src/core.ts: secret => 'sk_' + 48 hex, recovery_code => 'rc_' + 64 hex)
// and the handle rule every JSON door enforces (src/core.ts HANDLE_RE).
const HANDLE_RE = /^[a-z0-9][a-z0-9-]{2,31}$/u
// src/market-identity-json-routes.ts's own MERCHANT_KEY_RE (via
// credentialShapeRe('secret')) -- used below by the confirm doors' own
// requireMerchantKeyShape, matching the real requireMerchantKey's SHAPE-only
// check (src/market-identity-json-routes.ts:137-141), before any pending-
// stage lookup.
const MERCHANT_KEY_RE = /^1f3ea_sk_[0-9a-f]{48}$/u
// src/market-identity-fields.ts CEREMONY_TOKEN_RE -- both session and csrf
// must be exactly this shape before this stub even looks either up.
const CEREMONY_TOKEN_RE = /^[0-9a-f]{64}$/u
// src/market-identity-fields.ts's own DISALLOWED_MODEL_CHARACTERS (used by
// identityModelValue below) -- kept as a separate copy here, deliberately
// not imported from scripts/identity-client.mjs, so this stub stays an
// independent double of the real market's own validation, the same way
// HANDLE_RE/CEREMONY_TOKEN_RE above are already independent copies.
const DISALLOWED_MODEL_CHARACTERS_RE =
  new RegExp('[\\u0000-\\u001f\\u007f\\u061c\\u200e\\u200f\\u2028-\\u202e\\u2066-\\u2069]', 'u')
const CODING_CLIENT_CLASSES = new Set(['coding_persistent', 'coding_ephemeral'])
const CEREMONY_SECONDS = 900
const PAIRING_CODE_SECONDS = 10 * 60

const rootKey = () => `1f3ea_sk_${randomBytes(24).toString('hex')}`
const recoveryCode = () => `1f3ea_rc_${randomBytes(32).toString('hex')}`
const recoveryCodes = () => Array.from({ length: 8 }, recoveryCode)
const token = () => randomBytes(32).toString('hex')
const pairingCode = () => `1f3ea_pc_${randomBytes(24).toString('hex')}`

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

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...headers })
  res.end(JSON.stringify(body))
}

/**
 * Mirrors the real doors' fail() (market-identity-json-routes.ts /
 * market-pairing-routes.ts): a human-worded sentence in `error`, the
 * machine-readable name in `reason`, and the same name again on the
 * X-1F3EA-Reason header -- so a test asserting on the client's own printed
 * refusal message is proving something about a shape the real market
 * actually returns, not a stub-only convenience string.
 */
function fail(res, status, reason, message) {
  send(res, status, { error: message, reason }, { 'x-1f3ea-reason': reason })
}

function bearerKey(req) {
  const header = req.headers.authorization ?? ''
  const match = /^Bearer (.+)$/u.exec(header)
  return match ? match[1] : null
}

/**
 * Subset-only, exactly like exactJsonFields in bounded-json.ts: every key
 * `body` carries must be in `allowed`, but `allowed` may have keys `body`
 * does not -- a MISSING field is never this check's job. That is left to
 * the per-field validators below (requireClientClass, the handle/model
 * check, requireCeremonyFields), which produce the real door's own reason
 * name for a missing or malformed value instead of the generic
 * unexpected_fields this used to return for both cases alike.
 */
function exactFields(body, allowed) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false
  const allowedNames = new Set(allowed)
  return Object.keys(body).every(key => allowedNames.has(key))
}

function requireFields(res, body, allowed) {
  if (exactFields(body, allowed)) return true
  fail(res, 400, 'unexpected_fields', `This action accepts exactly these fields: ${allowed.join(', ')}.`)
  return false
}

/**
 * Mirrors requireClientClass in market-identity-json-routes.ts -- checked
 * BEFORE any credential lookup on every door that takes both, matching the
 * real handler order (register stage, rotate begin, recovery generate,
 * recovery begin all check client_class first) so a test driven against
 * this stub proves the same refusal-ordering property the real market's own
 * test suite pins (market-identity-json-routes.test.ts: "register refuses a
 * browser-only client_class before touching storage").
 */
function requireClientClass(res, body) {
  const clientClass = body.client_class
  if (typeof clientClass === 'string' && CODING_CLIENT_CLASSES.has(clientClass)) return clientClass
  fail(
    res, 400, 'invalid_client_class',
    'client_class must be "coding_persistent" or "coding_ephemeral". A human without a key-capable ' +
      'client should use the private browser page instead.',
  )
  return null
}

/**
 * Mirrors requireCeremony in market-identity-json-routes.ts -- checked
 * BEFORE the pending-stage lookup on every confirm/cancel door, so a
 * missing or malformed session/csrf is refused with invalid_ceremony
 * rather than being looked up (as `undefined`, or as a well-formed but
 * unrecognized value) and reported as the unrelated request_unavailable.
 * Returns `true` and does nothing when both fields are present and shaped
 * like a real ceremony token; the actual match against a staged session's
 * own value is still each caller's own Map lookup.
 */
function requireCeremonyFields(res, body) {
  const { session, csrf } = body
  if (
    typeof session === 'string' && typeof csrf === 'string'
    && CEREMONY_TOKEN_RE.test(session) && CEREMONY_TOKEN_RE.test(csrf)
  ) return true
  fail(
    res, 403, 'invalid_ceremony',
    'session and csrf must be the exact 64-character hex values returned by the earlier stage, ' +
      'begin, or generate response.',
  )
  return false
}

/**
 * Mirrors requireMerchantKey in market-identity-json-routes.ts -- SHAPE only
 * (never a store lookup), checked BEFORE the pending-stage Map lookup on
 * every confirm door (register/rotate/recovery), matching the real
 * handler's own order (requireFields -> requireCeremony -> requireMerchantKey
 * -> storage). Without this, a malformed key on an unknown/expired session
 * was refused the unrelated request_unavailable instead of credential_rejected
 * -- a fidelity gap this stub's own comment block documents pinning against.
 * The pending Map's own merchant_key VALUE comparison (each confirm
 * handler's own `pending.merchant_key !== body.merchant_key` check) is a
 * separate, later check and is untouched by this.
 */
function requireMerchantKeyShape(res, body) {
  const key = body.merchant_key
  if (typeof key === 'string' && MERCHANT_KEY_RE.test(key)) return true
  fail(res, 403, 'credential_rejected', 'That merchant key could not be verified. Check it and retry.')
  return false
}

/**
 * Mirrors identityModelValue in market-identity-fields.ts: at most 120 code
 * points after trimming, no control or directional-override marks. Returns
 * the trimmed model, or `null` on a value that fails either rule (the
 * caller then reports the same invalid_identity reason the real door does).
 */
function identityModelValue(value) {
  const trimmed = value.trim()
  if (Array.from(trimmed).length > 120 || DISALLOWED_MODEL_CHARACTERS_RE.test(trimmed)) return null
  return trimmed
}

const REGISTER_STAGE_FIELDS = ['action', 'handle', 'model', 'client_class', 'human_approved']
const REGISTER_CONFIRM_FIELDS = ['action', 'session', 'csrf', 'merchant_key']
const REGISTER_CANCEL_FIELDS = ['action', 'session', 'csrf']
const ROTATE_BEGIN_FIELDS = ['action', 'client_class', 'merchant_key']
const ROTATE_CONFIRM_FIELDS = ['action', 'session', 'csrf', 'merchant_key']
const ROTATE_CANCEL_FIELDS = ['action', 'session', 'csrf']
const RECOVERY_GENERATE_FIELDS = ['action', 'client_class', 'merchant_key']
const RECOVERY_BEGIN_FIELDS = ['action', 'client_class', 'recovery_code']
const RECOVERY_CONFIRM_FIELDS = ['action', 'session', 'csrf', 'merchant_key']
const RECOVERY_CANCEL_FIELDS = ['action', 'session', 'csrf']

/**
 * Starts the stub on an ephemeral localhost port. Returns
 * { origin, merchants, close() }. `merchants` is a live Map keyed by handle
 * (values: { merchant_key, recovery_codes, client_class }) a test can
 * inspect directly after driving a real CLI command against `origin`, or
 * pre-seed before starting a scenario.
 *
 * `registerConfirmBarrier` (optional): `{ handle, count }`. When set,
 * register's 'confirm' action for any session whose staged handle equals
 * `handle` is held -- not responded to at all -- until `count` such confirm
 * requests are concurrently outstanding, at which point every held one is
 * released together. A held request is also released, on its own, after
 * REGISTER_CONFIRM_BARRIER_TIMEOUT_MS if `count` never arrives (one racing
 * subprocess failing before its own confirm -- a PowerShell CredWrite
 * hiccup, a storeSecret refusal, a crash) -- so that turns into a loud,
 * failing assertion in the test instead of an indefinite CI hang. This
 * exists for exactly one caller: the concurrent-registration race test in
 * test/identity-commands.test.mjs, which needs its two real subprocesses to
 * genuinely overlap rather than hoping OS scheduling makes them.
 * confirm is the FIRST network call register() makes AFTER its own local
 * pre-flight vault check (readSecret, called right after stage() -- see
 * register()'s own comment in identity-client.mjs) -- so a confirm request
 * reaching this server already proves that process's own pre-flight check
 * has already run. Holding every such request until `count` have arrived
 * therefore guarantees, structurally rather than by luck, that no process
 * can reach its own vault write before every other racing process has
 * already staged and pre-flight-checked -- which is the actual overlap the
 * race test means to exercise. Every other caller of this function omits
 * the option, so it changes nothing about the ~20 other scenarios sharing
 * this stub.
 */
const REGISTER_CONFIRM_BARRIER_TIMEOUT_MS = 10_000
/**
 * rotateConfirmHandleOverride / recoveryConfirmHandleOverride (round-4
 * review, MEDIUM finding): when set, the `handle` field in the /api/rotate
 * or /api/recovery `confirm` RESPONSE is this value instead of the honestly
 * staged `pending.handle` -- simulating a rogue market that names one handle
 * on begin and a different one on confirm (or embeds a newline in it), while
 * everything this stub actually stores server-side stays keyed by the real,
 * honestly-staged handle, exactly like a real confirm response is the only
 * thing an attacker-controlled door could lie about. Every other caller
 * omits both options, so this changes nothing about the ~20 other scenarios
 * sharing this stub.
 */
/**
 * registerStageHandleOverride (round-6 review, MEDIUM finding): when set,
 * the `handle` field in the /api/register `stage` RESPONSE is this value
 * instead of the honestly staged `entry.handle` -- simulating a rogue
 * market that names a malformed (or `--pending-`-suffixed) handle on stage,
 * exactly like rotateConfirmHandleOverride/recoveryConfirmHandleOverride
 * above simulate one lying on confirm. Everything this stub actually stores
 * server-side (`pendingRegistrations`, `merchants`) stays keyed by the
 * real, honestly-requested handle. Every other caller omits this option, so
 * it changes nothing about the ~20 other scenarios sharing this stub.
 */
export async function startStubMarketServer({
  registerConfirmBarrier, pairingUnavailable = false, rotateConfirmHandleOverride, recoveryConfirmHandleOverride,
  registerStageHandleOverride,
} = {}) {
  const merchants = new Map()
  // Every pending map is keyed by `session` (an opaque value, unrelated to
  // its `csrf` companion) -- mirrors the market's own confirm shape
  // {"action":"confirm","session","csrf","merchant_key"}, which is why this
  // stub tracks TWO values per pending stage/begin, not a single stage_token.
  const pendingRegistrations = new Map() // session -> { handle, model, merchant_key, recovery_codes, client_class, csrf }
  const pendingRotations = new Map() // session -> { handle, merchant_key, client_class, csrf }
  const pendingRecoveries = new Map() // session -> { handle, merchant_key, csrf }
  let confirmBarrierWaiters = []
  let confirmBarrierTimer = null

  function findByKey(map, key) {
    return [...map.entries()].find(([, value]) => value.merchant_key === key)
  }

  const server = createHttpsServer(TLS_OPTIONS, async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/api/me') {
        const key = bearerKey(req)
        const found = findByKey(merchants, key)
        if (!found) return send(res, 401, { error: 'bad or missing bearer secret' })
        return send(res, 200, { handle: found[0] })
      }

      if (req.method !== 'POST') return send(res, 404, { error: 'not found' })
      const body = await readBody(req)

      if (req.url === '/api/register') {
        if (body.action === 'stage') {
          if (!requireFields(res, body, REGISTER_STAGE_FIELDS)) return
          const clientClass = requireClientClass(res, body)
          if (!clientClass) return
          if (body.human_approved !== true) {
            return fail(
              res, 403, 'human_approval_required',
              'human_approved must be true: a human must approve this permanent public handle before it is created.',
            )
          }
          // Mirrors requireHandleAndModel: model must be PRESENT (an empty
          // string is fine), never merely truthy -- this is the exact check
          // whose absence let a model-less registration through before. Once
          // present, it also runs through identityModelValue above (trim,
          // at most 120 code points, no control/directional marks) --
          // without this a 200-character or control-character model was
          // silently accepted here even though the real door refuses both.
          const handle = typeof body.handle === 'string' ? body.handle.toLowerCase().trim() : null
          const rawModel = typeof body.model === 'string' ? body.model : null
          const model = rawModel === null ? null : identityModelValue(rawModel)
          if (!handle || !HANDLE_RE.test(handle) || model === null) {
            return fail(
              res, 400, 'invalid_identity',
              'handle must match ^[a-z0-9][a-z0-9-]{2,31}$ and model (present, "" allowed) must be at most ' +
                '120 ordinary characters with no directional or control marks.',
            )
          }
          // Real handle_taken is checked against CONFIRMED merchants only
          // (`EXISTS (SELECT 1 FROM merchants WHERE handle = ...)`), never
          // against other in-flight stages -- so two concurrent stages for
          // the same not-yet-confirmed handle can both succeed, and the
          // race is decided at CONFIRM below, exactly like the real market.
          if (merchants.has(handle)) {
            return fail(
              res, 409, 'handle_taken',
              `The handle "${handle}" is already taken. Check GET /api/store/${handle} before choosing ` +
                'another handle; this attempt created nothing.',
            )
          }
          const session = token()
          const entry = {
            handle, model, client_class: clientClass, merchant_key: rootKey(),
            recovery_codes: recoveryCodes(), csrf: token(),
          }
          pendingRegistrations.set(session, entry)
          return send(res, 200, {
            status: 'staged', handle: registerStageHandleOverride ?? entry.handle, client_class: entry.client_class,
            session, csrf: entry.csrf, expires_in_seconds: CEREMONY_SECONDS,
            merchant_key: entry.merchant_key, recovery_codes: entry.recovery_codes,
            instructions: 'Save the merchant key and all eight recovery codes now; confirm or cancel within the window.',
          })
        }
        if (body.action === 'confirm') {
          if (!requireFields(res, body, REGISTER_CONFIRM_FIELDS)) return
          if (!requireCeremonyFields(res, body)) return
          if (!requireMerchantKeyShape(res, body)) return
          const pending = pendingRegistrations.get(body.session)
          if (!pending || pending.csrf !== body.csrf) {
            return fail(
              res, 403, 'request_unavailable',
              'This registration expired, was canceled, or already advanced. Stage a fresh registration; check ' +
                'GET /api/merchants first in case an earlier confirm response was lost.',
            )
          }
          if (pending.merchant_key !== body.merchant_key) {
            return fail(res, 403, 'credential_rejected', 'That saved merchant key could not be verified. Check it and retry confirm.')
          }
          if (registerConfirmBarrier && pending.handle === registerConfirmBarrier.handle) {
            // Synchronous (no `await` between push and the length check) --
            // Node's single-threaded event loop means no other request's
            // handler can interleave here, so two concurrent confirms can
            // never both observe a stale waiters length and both release.
            await new Promise(releaseThis => {
              confirmBarrierWaiters.push(releaseThis)
              if (confirmBarrierWaiters.length === 1) {
                // Deadline for THIS batch: if `count` never arrives (a
                // racing subprocess failed before reaching its own
                // confirm), release whoever IS waiting instead of parking
                // them here forever -- see the doc comment above.
                confirmBarrierTimer = setTimeout(() => {
                  const waiters = confirmBarrierWaiters
                  confirmBarrierWaiters = []
                  confirmBarrierTimer = null
                  for (const release of waiters) release()
                }, REGISTER_CONFIRM_BARRIER_TIMEOUT_MS)
              }
              if (confirmBarrierWaiters.length >= registerConfirmBarrier.count) {
                if (confirmBarrierTimer) {
                  clearTimeout(confirmBarrierTimer)
                  confirmBarrierTimer = null
                }
                const waiters = confirmBarrierWaiters
                confirmBarrierWaiters = []
                for (const release of waiters) release()
              }
            })
          }
          pendingRegistrations.delete(body.session)
          if (merchants.has(pending.handle)) {
            // Another registration for the same handle confirmed first,
            // between this one staging and this confirm arriving -- mirrors
            // the real confirm's own separate handle_taken check.
            return fail(
              res, 409, 'handle_taken',
              'That handle was taken by another registration before this one confirmed. This losing key and ' +
                'its recovery codes are inactive. Check GET /api/merchants before choosing another handle.',
            )
          }
          merchants.set(pending.handle, {
            merchant_key: pending.merchant_key, recovery_codes: pending.recovery_codes, client_class: pending.client_class,
          })
          return send(res, 200, { status: 'confirmed', merchant_id: merchants.size, handle: pending.handle })
        }
        if (body.action === 'cancel') {
          if (!requireFields(res, body, REGISTER_CANCEL_FIELDS)) return
          if (!requireCeremonyFields(res, body)) return
          const pending = pendingRegistrations.get(body.session)
          if (!pending || pending.csrf !== body.csrf) {
            return fail(res, 403, 'request_unavailable', 'No staged registration is waiting for this session and csrf.')
          }
          pendingRegistrations.delete(body.session)
          return send(res, 200, { status: 'canceled' })
        }
        return fail(res, 400, 'invalid_action', 'action must be one of: stage, confirm, cancel.')
      }

      if (req.url === '/api/rotate') {
        if (body.action === 'begin') {
          if (!requireFields(res, body, ROTATE_BEGIN_FIELDS)) return
          // Shape (client_class) before credential (merchant_key) -- matches
          // the real rotateBegin's own check order (requireClientClass runs
          // before requireMerchantKey), so a bad key never even gets looked
          // up when client_class is also invalid.
          const clientClass = requireClientClass(res, body)
          if (!clientClass) return
          const found = findByKey(merchants, body.merchant_key)
          if (!found) return fail(res, 403, 'credential_rejected', 'That current merchant key could not be verified. Check it and retry.')
          const session = token()
          const entry = { handle: found[0], merchant_key: rootKey(), client_class: clientClass, csrf: token() }
          pendingRotations.set(session, entry)
          return send(res, 200, {
            status: 'staged', handle: entry.handle, client_class: entry.client_class,
            session, csrf: entry.csrf, expires_in_seconds: CEREMONY_SECONDS, merchant_key: entry.merchant_key,
            instructions: 'This replacement merchant key is shown exactly once. Confirm or cancel within the window.',
          })
        }
        if (body.action === 'confirm') {
          if (!requireFields(res, body, ROTATE_CONFIRM_FIELDS)) return
          if (!requireCeremonyFields(res, body)) return
          if (!requireMerchantKeyShape(res, body)) return
          const pending = pendingRotations.get(body.session)
          if (!pending || pending.csrf !== body.csrf) {
            return fail(
              res, 403, 'request_unavailable',
              'This rotation expired, was canceled, or the merchant changed since it was staged. Begin a fresh rotation with the current key.',
            )
          }
          if (pending.merchant_key !== body.merchant_key) {
            return fail(res, 403, 'credential_rejected', 'That saved replacement merchant key could not be verified. Check it and retry confirm.')
          }
          pendingRotations.delete(body.session)
          const merchant = merchants.get(pending.handle)
          // The real door invalidates every recovery code the moment a
          // rotation confirms -- simulated here by clearing them, so a
          // test can assert the client never claims stale codes survived.
          merchants.set(pending.handle, {
            ...merchant, merchant_key: pending.merchant_key, client_class: pending.client_class, recovery_codes: [],
          })
          return send(res, 200, { status: 'rotated', merchant_id: 1, handle: rotateConfirmHandleOverride ?? pending.handle })
        }
        if (body.action === 'cancel') {
          if (!requireFields(res, body, ROTATE_CANCEL_FIELDS)) return
          if (!requireCeremonyFields(res, body)) return
          const pending = pendingRotations.get(body.session)
          if (!pending || pending.csrf !== body.csrf) {
            return fail(res, 403, 'request_unavailable', 'No staged rotation is waiting for this session and csrf.')
          }
          pendingRotations.delete(body.session)
          return send(res, 200, { status: 'canceled' })
        }
        return fail(res, 400, 'invalid_action', 'action must be one of: begin, confirm, cancel.')
      }

      if (req.url === '/api/recovery') {
        if (body.action === 'generate') {
          if (!requireFields(res, body, RECOVERY_GENERATE_FIELDS)) return
          const clientClass = requireClientClass(res, body)
          if (!clientClass) return
          const found = findByKey(merchants, body.merchant_key)
          if (!found) return fail(res, 403, 'credential_rejected', 'That merchant key could not be verified. Check it and retry.')
          const codes = recoveryCodes()
          merchants.set(found[0], { ...found[1], recovery_codes: codes })
          return send(res, 200, {
            status: 'generated', handle: found[0], merchant_id: 1, generation: 1, client_class: clientClass,
            recovery_codes: codes,
            instructions: 'These eight recovery codes are shown exactly once and replace every earlier set immediately.',
          })
        }
        if (body.action === 'begin') {
          if (!requireFields(res, body, RECOVERY_BEGIN_FIELDS)) return
          const clientClass = requireClientClass(res, body)
          if (!clientClass) return
          const found = [...merchants.entries()].find(([, value]) => value.recovery_codes?.includes(body.recovery_code))
          if (!found) {
            return fail(
              res, 403, 'credential_rejected',
              'That recovery code could not be verified, was already used, or belongs to a superseded set.',
            )
          }
          const session = token()
          const entry = { handle: found[0], merchant_key: rootKey(), csrf: token() }
          pendingRecoveries.set(session, entry)
          return send(res, 200, {
            status: 'staged', handle: entry.handle, client_class: clientClass,
            session, csrf: entry.csrf, expires_in_seconds: CEREMONY_SECONDS, merchant_key: entry.merchant_key,
            instructions: 'This replacement merchant key is shown exactly once. Confirm or cancel within the window.',
          })
        }
        if (body.action === 'confirm') {
          if (!requireFields(res, body, RECOVERY_CONFIRM_FIELDS)) return
          if (!requireCeremonyFields(res, body)) return
          if (!requireMerchantKeyShape(res, body)) return
          const pending = pendingRecoveries.get(body.session)
          if (!pending || pending.csrf !== body.csrf) {
            return fail(
              res, 403, 'request_unavailable',
              'This recovery expired, was canceled, or the merchant changed since it was staged. Begin a fresh recovery with an unused code.',
            )
          }
          if (pending.merchant_key !== body.merchant_key) {
            return fail(res, 403, 'credential_rejected', 'That saved replacement merchant key could not be verified. Check it and retry confirm.')
          }
          pendingRecoveries.delete(body.session)
          const merchant = merchants.get(pending.handle)
          merchants.set(pending.handle, { ...merchant, merchant_key: pending.merchant_key, recovery_codes: [] })
          return send(res, 200, { status: 'recovered', merchant_id: 1, handle: recoveryConfirmHandleOverride ?? pending.handle })
        }
        if (body.action === 'cancel') {
          if (!requireFields(res, body, RECOVERY_CANCEL_FIELDS)) return
          if (!requireCeremonyFields(res, body)) return
          const pending = pendingRecoveries.get(body.session)
          if (!pending || pending.csrf !== body.csrf) {
            return fail(res, 403, 'request_unavailable', 'No staged recovery is waiting for this session and csrf.')
          }
          pendingRecoveries.delete(body.session)
          return send(res, 200, { status: 'canceled' })
        }
        return fail(res, 400, 'invalid_action', 'action must be one of: generate, begin, confirm, cancel.')
      }

      if (req.url === '/api/pair') {
        const key = bearerKey(req)
        const found = findByKey(merchants, key)
        if (!found) {
          return fail(
            res, 401, 'auth_required',
            'Send Authorization: Bearer <merchant_key> for the merchant this pairing code should link.',
          )
        }
        // Real door: a body may be omitted OR must be exactly `{}` -- never
        // any other fields, since the credential is the bearer header, not
        // the body.
        if (req.headers['content-type'] && !exactFields(body, [])) {
          return fail(
            res, 400, 'unexpected_fields',
            'This door takes its credential only from Authorization: Bearer <merchant_key>. Send no request ' +
              'body, or an empty JSON object.',
          )
        }
        if (pairingUnavailable) {
          return fail(
            res, 503, 'pairing_unavailable',
            'The hosted connector sign-in door is not enabled on this deployment, so a pairing code would ' +
              'have nowhere to be redeemed. No code was issued.',
          )
        }
        const code = pairingCode()
        return send(res, 200, {
          status: 'created',
          pairing_code: code,
          expires_in_seconds: PAIRING_CODE_SECONDS,
          expires_at: new Date(Date.now() + PAIRING_CODE_SECONDS * 1000).toISOString(),
          one_use: true,
          instructions:
            'Shown exactly once. Within 10 minutes, have the human enter this code -- instead of the merchant ' +
            'key -- on the "I already have a store" panel of the hosted connector sign-in page.',
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
    // Exposed (round-6 review, LOW finding) so a test can confirm a
    // cancelled stage is actually GONE server-side -- not just that the
    // client claimed cancellation -- since cancelStage's own request is
    // best-effort and swallows every error by design (see its doc comment
    // in identity-client.mjs): a client that silently failed to send the
    // cancel at all would otherwise look identical, from the client's own
    // output, to one that succeeded.
    pendingRegistrations,
    pendingRotations,
    pendingRecoveries,
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
