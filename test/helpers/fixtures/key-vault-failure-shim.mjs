import { SecretReadFailure } from '../../../scripts/identity-client.mjs'

export * from '../../../scripts/identity-client.mjs'

let reads = 0

export function readSecret(origin, label) {
  reads += 1
  const failAt = Number.parseInt(process.env.TEST_VAULT_FAIL_AT ?? '1', 10)
  if (reads === failAt) {
    throw new SecretReadFailure(`the test vault entry for "${label}" could not be read`)
  }
  if (process.env.TEST_VAULT_LIVE_MISSING === '1' && reads > 1) return { found: false }
  return {
    found: true,
    value: {
      kind: 'merchant',
      handle: label,
      client_class: 'coding_persistent',
      merchant_key: 'fixture-not-a-secret',
      recovery_codes: [],
      origin,
    },
  }
}

export function promoteReplacementKey() {
  if (process.env.TEST_PROMOTE_FAILURE === '1') throw new Error('fixture promotion failure')
  throw new Error('test promote shim was called without TEST_PROMOTE_FAILURE=1')
}
