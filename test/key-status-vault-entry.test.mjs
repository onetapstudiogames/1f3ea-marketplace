// Permanent coverage for round-7 finding 3 (scripts/key.mjs
// requireStoredKey), pre-existing at 5e03eb2 and found on a release walk:
// `requireStoredKey` collapsed "no vault entry at all" and "an entry
// exists but carries no merchant_key" into the same "no vault entry
// found" message, contradicting `show()` below (which already worded the
// two states separately) for the exact same handle -- and contradicting
// the very refusal (identity-client.mjs promoteReplacementKey's mismatch
// case) that sends an agent to `key status` to "work out which of the two
// entries is the one you actually want": an agent following that pointer
// was told no entry exists one line after being told an entry is there.
// requireStoredKey now splits the two conditions the way show() already
// does.

import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { makeTempHome, runNode } from './helpers/run-identity-cli.mjs'

const keyPath = fileURLToPath(new URL('../scripts/key.mjs', import.meta.url))
const fileVaultLoaderUrl = new URL('helpers/force-file-vault-loader.mjs', import.meta.url).href
const NO_SECRET_LITERAL = /1f3ea_(?:sk|rc)_[0-9a-f]+/u

function assertNoSecretLeaked(result, label) {
  assert.doesNotMatch(result.stdout ?? '', NO_SECRET_LITERAL, `${label}: stdout never carries a raw secret`)
  assert.doesNotMatch(result.stderr ?? '', NO_SECRET_LITERAL, `${label}: stderr never carries a raw secret`)
}

test('key status: an entry that exists but carries no merchant_key is never reported as "no vault entry found"', async () => {
  const origin = 'https://example.invalid'
  const home = makeTempHome('key-status-nokey-')
  try {
    const credentialsDir = join(home.dir, '.1f3ea', 'credentials')
    await mkdir(credentialsDir, { recursive: true })
    const safeOrigin = origin.replace(/[^a-z0-9.-]/giu, '_')
    await writeFile(
      join(credentialsDir, `${safeOrigin}__keyless-handle.json`),
      JSON.stringify({ kind: 'merchant', handle: 'keyless-handle', origin }),
    )
    const result = await runNode(
      keyPath,
      ['status', '--origin', origin, '--allow-origin', origin, '--handle', 'keyless-handle'],
      { env: {
        ...home.env,
        AGENT_1F3EA_STUB_ONLY: '0',
        NODE_OPTIONS: `--import ${fileVaultLoaderUrl}`,
      } },
    )
    assert.notEqual(result.status, 0)
    assert.doesNotMatch(result.stderr, /no vault entry found/u, 'a keyless entry is not "no entry"')
    assert.match(result.stderr, /a vault entry exists for "keyless-handle".*but it carries no merchant_key field/u)
    assertNoSecretLeaked(result, 'key status keyless entry')
  } finally {
    home.cleanup()
  }
})

test('key status: truly no vault entry still says "no vault entry found" (control)', async () => {
  const origin = 'https://example.invalid'
  const home = makeTempHome('key-status-noentry-')
  try {
    const result = await runNode(
      keyPath,
      ['status', '--origin', origin, '--allow-origin', origin, '--handle', 'never-registered'],
      { env: { ...home.env, AGENT_1F3EA_STUB_ONLY: '0' } },
    )
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /no vault entry found for "never-registered"/u)
    assert.match(result.stderr, /stored key: no vault entry/u)
    assert.match(result.stderr, /next: Run setup, or run `key status --handle <the handle you meant>`/u)
    assertNoSecretLeaked(result, 'key status no entry at all')
  } finally {
    home.cleanup()
  }
})

for (const originArgs of [['--origin'], ['--origin=']]) {
  test(`key status: malformed ${originArgs[0]} is a contained refusal with a next step`, async () => {
    const result = await runNode(
      keyPath,
      ['status', '--handle', 'bridge-buyer', ...originArgs],
      { env: { AGENT_1F3EA_STUB_ONLY: '0' } },
    )

    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /key: could not start/u)
    assert.match(result.stderr, /No vault change was attempted/u)
    assert.match(result.stderr, /Fix the origin, then run `key status` or the same key command again/u)
    assert.match(result.stderr, /https:\/\/1f3ea\.com\//u)
    assert.doesNotMatch(result.stderr, /TypeError:|\n\s+at file:/u)
    assertNoSecretLeaked(result, `key status ${originArgs[0]}`)
  })
}
