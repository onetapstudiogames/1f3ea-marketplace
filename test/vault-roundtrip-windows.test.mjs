// One isolated file-vault round trip on Windows, using a fake key of the
// exact merchant-key shape identity-client.mjs validates (never a real one):
// write, read back, promote (via promoteReplacementKey, the same path
// rotate()/recoverBegin() use), and delete. The suite's test-only module
// loader makes vault-backends.mjs select its file backend under the throwaway
// HOME, so this test never reaches Windows Credential Manager.
//
// The console evidence is redacted: it prints only booleans and backend
// names, never the fake key or recovery codes. Cleanup remains unconditional
// so a failed assertion cannot leave data in the throwaway HOME.

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { deleteSecret, promoteReplacementKey, readSecret, storeSecret } from '../scripts/identity-client.mjs'

const posix = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
// Matches MERCHANT_KEY_RE / RECOVERY_CODE_RE in identity-client.mjs exactly
// (^1f3ea_sk_[0-9a-f]{48}$ / ^1f3ea_rc_[0-9a-f]{64}$) with real random hex,
// never a real merchant's key — this is a fixture, not a live credential.
const fakeKey = () => `1f3ea_sk_${randomBytes(24).toString('hex')}`
const fakeRecoveryCode = () => `1f3ea_rc_${randomBytes(32).toString('hex')}`

test(
  'Windows test suite file-vault round trip: write, read back, promote, delete',
  { skip: process.platform !== 'win32' && 'this probe only exercises the test-isolated Windows path' },
  () => {
    const origin = `https://vault-roundtrip-test.invalid/${posix()}`
    const handle = `vault-test-${posix()}`
    const stagingLabel = `${handle}--pending-rotation`

    const originalKey = fakeKey()
    const recoveryCodes = Array.from({ length: 8 }, () => fakeRecoveryCode())
    const replacementKey = fakeKey()
    assert.notEqual(originalKey, replacementKey, 'test fixture sanity: original and replacement differ')

    const homeDir = mkdtempSync(join(tmpdir(), 'vault-roundtrip-windows-'))
    const deps = { homeDir }
    // Tracks which vault labels (never raw targets) still need cleaning up
    // through deleteSecret -- the same real-credential-plus-temp-index pair
    // storeSecret wrote -- so a failed assertion never leaves either half
    // behind.
    let cleanupNeeded = [handle, stagingLabel]
    try {
      // --- write --------------------------------------------------------
      const writeLocation = storeSecret(origin, handle, {
        kind: 'merchant',
        handle,
        client_class: 'coding_persistent',
        merchant_key: originalKey,
        recovery_codes: recoveryCodes,
        origin,
      }, deps)
      console.log(`[vault-roundtrip] write: ok (${writeLocation.startsWith('local file') ? 'isolated local file' : 'unexpected backend'})`)
      assert.match(writeLocation, /^local file/u)

      // --- read back: must equal exactly what was written ---------------
      const readBack = readSecret(origin, handle, deps)
      assert.equal(readBack.found, true)
      assert.equal(readBack.value.merchant_key, originalKey, 'read-back merchant_key matches exactly what was written')
      assert.deepEqual(readBack.value.recovery_codes, recoveryCodes, 'read-back recovery_codes match exactly')
      console.log(`[vault-roundtrip] read back: ok (merchant_key matches: ${readBack.value.merchant_key === originalKey}, recovery_codes match: ${JSON.stringify(readBack.value.recovery_codes) === JSON.stringify(recoveryCodes)})`)

      // --- promote: same path rotate()/recoverBegin() use ---------------
      // Stage the replacement under a distinct target first, exactly as
      // rotate() does, before promoting it over the live entry.
      storeSecret(origin, stagingLabel, {
        kind: 'merchant',
        handle,
        merchant_key: replacementKey,
        origin,
      }, deps)
      const promoteLocation = promoteReplacementKey(origin, handle, stagingLabel, replacementKey, (previous) => ({
        ...(previous?.client_class ? { client_class: previous.client_class } : {}),
        ...(previous?.recovery_codes ? { recovery_codes: previous.recovery_codes } : {}),
      }), deps)
      assert.match(promoteLocation, /^local file/u)
      const afterPromote = readSecret(origin, handle, deps)
      assert.equal(afterPromote.found, true)
      assert.equal(afterPromote.value.merchant_key, replacementKey, 'live entry now holds the promoted replacement key')
      assert.notEqual(afterPromote.value.merchant_key, originalKey, 'the old key no longer lives at the live entry')
      assert.deepEqual(afterPromote.value.recovery_codes, recoveryCodes, 'recovery_codes carried forward across promotion')
      console.log(`[vault-roundtrip] promote: ok (live entry now holds replacement: ${afterPromote.value.merchant_key === replacementKey}, staging cleaned up: ${!readSecret(origin, stagingLabel, deps).found})`)
      assert.equal(readSecret(origin, stagingLabel, deps).found, false, 'promoteReplacementKey deletes the staging entry on success')
      cleanupNeeded = [handle] // staging already deleted by promotion

      // --- delete -------------------------------------------------------
      deleteSecret(origin, handle, deps)
      cleanupNeeded = []
      const afterDelete = readSecret(origin, handle, deps)
      assert.equal(afterDelete.found, false, 'entry is gone from the isolated file vault after deleteSecret')
    } finally {
      // Best-effort cleanup even on assertion failure, so a failed run
      // never leaves a fixture in the isolated file vault.
      for (const leftoverLabel of cleanupNeeded) {
        try {
          deleteSecret(origin, leftoverLabel, deps)
        } catch {
          // Nothing to delete, or already gone — fine either way.
        }
      }
      rmSync(homeDir, { recursive: true, force: true })
    }
  },
)
