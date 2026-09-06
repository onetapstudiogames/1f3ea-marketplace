import assert from 'node:assert/strict'
import test from 'node:test'

import '../scripts/lib/vault-backends.mjs'

test('file-vault loader matches vault-backends.mjs on every OS', async () => {
  const { matched } = await import('force-file-vault:match-state')
  assert.equal(matched, true, 'the test loader matched vault-backends.mjs and installed its file-vault shims')
})
