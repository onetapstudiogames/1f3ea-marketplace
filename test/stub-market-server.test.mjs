// Pins the stub market server's field-validation contract directly against
// its own reason vocabulary (test/helpers/stub-market-server.mjs), driving
// the HTTPS JSON doors with raw fetch calls rather than through
// identity-client.mjs -- so a future change to exactFields/requireFields
// that quietly regresses back to whole-body equality (round-2 review
// finding: "the stub's exactFields requires exact set equality, but the
// real exactJsonFields is subset-only") fails a fast, direct assertion
// instead of only ever showing up as an unrelated client-side test flaking
// on the wrong refusal wording. Each reason asserted here is pinned against
// the market's own real doors too, in src/market-identity-json-routes.test.ts
// (invalid_identity: :85-92, unexpected_fields for an EXTRA key: :105-112) --
// this file exists to keep the STUB honest against that same contract, not
// to duplicate proving the real market's own behavior.

import assert from 'node:assert/strict'
import test from 'node:test'

import { startStubMarketServer } from './helpers/stub-market-server.mjs'

// The stub's self-signed fixture cert is not in any trust store this
// process consults -- same accommodation test/helpers/run-identity-cli.mjs
// makes for the real CLI subprocess it spawns (NODE_TLS_REJECT_UNAUTHORIZED
// = '0'), needed here too since this file talks to the stub directly rather
// than through that helper. node --test isolates each test file in its own
// process by default, so this never leaks into an unrelated file's own TLS
// verification.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

async function postJson(origin, path, body) {
  const response = await fetch(`${origin}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const parsed = await response.json().catch(() => null)
  return { status: response.status, reason: parsed?.reason, headerReason: response.headers.get('x-1f3ea-reason') }
}

test('stub register stage: a model-less body is refused invalid_identity, not unexpected_fields', async () => {
  const stub = await startStubMarketServer()
  try {
    const result = await postJson(stub.origin, '/api/register', {
      action: 'stage', handle: 'valid-store', client_class: 'coding_persistent', human_approved: true,
    })
    assert.equal(result.status, 400)
    assert.equal(result.reason, 'invalid_identity')
    assert.equal(result.headerReason, 'invalid_identity')
  } finally {
    await stub.close()
  }
})

test('stub recovery generate: a client_class-less body is refused invalid_client_class, not unexpected_fields', async () => {
  const stub = await startStubMarketServer()
  try {
    const result = await postJson(stub.origin, '/api/recovery', {
      action: 'generate', merchant_key: '1f3ea_sk_deadbeef',
    })
    assert.equal(result.status, 400)
    assert.equal(result.reason, 'invalid_client_class')
    assert.equal(result.headerReason, 'invalid_client_class')
  } finally {
    await stub.close()
  }
})

test('stub recovery begin: a client_class-less body is refused invalid_client_class, not unexpected_fields', async () => {
  const stub = await startStubMarketServer()
  try {
    const result = await postJson(stub.origin, '/api/recovery', {
      action: 'begin', recovery_code: '1f3ea_rc_deadbeef',
    })
    assert.equal(result.status, 400)
    assert.equal(result.reason, 'invalid_client_class')
    assert.equal(result.headerReason, 'invalid_client_class')
  } finally {
    await stub.close()
  }
})

test('stub register cancel: a csrf-less body is refused invalid_ceremony, not unexpected_fields or request_unavailable', async () => {
  const stub = await startStubMarketServer()
  try {
    const result = await postJson(stub.origin, '/api/register', {
      action: 'cancel', session: 'a'.repeat(64),
    })
    assert.equal(result.status, 403)
    assert.equal(result.reason, 'invalid_ceremony')
    assert.equal(result.headerReason, 'invalid_ceremony')
  } finally {
    await stub.close()
  }
})

test('stub rotate cancel: a malformed (non-hex-64) session is refused invalid_ceremony', async () => {
  const stub = await startStubMarketServer()
  try {
    const result = await postJson(stub.origin, '/api/rotate', {
      action: 'cancel', session: 'not-a-real-session-token', csrf: 'a'.repeat(64),
    })
    assert.equal(result.status, 403)
    assert.equal(result.reason, 'invalid_ceremony')
  } finally {
    await stub.close()
  }
})

test('stub register stage: an EXTRA unrecognized field is still refused unexpected_fields', async () => {
  const stub = await startStubMarketServer()
  try {
    const result = await postJson(stub.origin, '/api/register', {
      action: 'stage', handle: 'valid-store', model: '', client_class: 'coding_persistent',
      human_approved: true, unexpected_extra_field: 'nope',
    })
    assert.equal(result.status, 400)
    assert.equal(result.reason, 'unexpected_fields')
  } finally {
    await stub.close()
  }
})

test('stub register stage: a model over 120 characters (or with a control character) is refused invalid_identity', async () => {
  const stub = await startStubMarketServer()
  try {
    const tooLong = await postJson(stub.origin, '/api/register', {
      action: 'stage', handle: 'valid-store-2', model: 'x'.repeat(121), client_class: 'coding_persistent',
      human_approved: true,
    })
    assert.equal(tooLong.status, 400)
    assert.equal(tooLong.reason, 'invalid_identity')

    const controlChar = await postJson(stub.origin, '/api/register', {
      action: 'stage', handle: 'valid-store-3', model: 'claude\u0001opus', client_class: 'coding_persistent',
      human_approved: true,
    })
    assert.equal(controlChar.status, 400)
    assert.equal(controlChar.reason, 'invalid_identity')
  } finally {
    await stub.close()
  }
})

// Round-3 review, LOW finding: every confirm door looked up the pending
// stage BEFORE checking the merchant-key shape, inverting the real market's
// own order (requireFields -> requireCeremony -> requireMerchantKey, THEN
// the store lookup) -- so a malformed key on an unknown/expired session was
// refused request_unavailable here instead of the real door's own
// credential_rejected. Pinned on all three confirm doors, matching the
// five reason-name tests already in this file.

test('stub register confirm: a malformed merchant_key is refused credential_rejected before the pending lookup, not request_unavailable', async () => {
  const stub = await startStubMarketServer()
  try {
    const result = await postJson(stub.origin, '/api/register', {
      action: 'confirm', session: 'a'.repeat(64), csrf: 'b'.repeat(64), merchant_key: 'nope',
    })
    assert.equal(result.status, 403)
    assert.equal(result.reason, 'credential_rejected')
    assert.equal(result.headerReason, 'credential_rejected')
  } finally {
    await stub.close()
  }
})

test('stub rotate confirm: a malformed merchant_key is refused credential_rejected before the pending lookup, not request_unavailable', async () => {
  const stub = await startStubMarketServer()
  try {
    const result = await postJson(stub.origin, '/api/rotate', {
      action: 'confirm', session: 'a'.repeat(64), csrf: 'b'.repeat(64), merchant_key: 'nope',
    })
    assert.equal(result.status, 403)
    assert.equal(result.reason, 'credential_rejected')
    assert.equal(result.headerReason, 'credential_rejected')
  } finally {
    await stub.close()
  }
})

test('stub recovery confirm: a malformed merchant_key is refused credential_rejected before the pending lookup, not request_unavailable', async () => {
  const stub = await startStubMarketServer()
  try {
    const result = await postJson(stub.origin, '/api/recovery', {
      action: 'confirm', session: 'a'.repeat(64), csrf: 'b'.repeat(64), merchant_key: 'nope',
    })
    assert.equal(result.status, 403)
    assert.equal(result.reason, 'credential_rejected')
    assert.equal(result.headerReason, 'credential_rejected')
  } finally {
    await stub.close()
  }
})
