// Pins scripts/run-tests-with-home-guard.mjs's pre-existing-leak classifier
// directly: findPreexistingLoopbackLeaks() (and the parseVaultTargetName /
// isLoopbackOrigin helpers under it) is the piece that inspects the BEFORE
// platform-vault snapshot -- the before/after diff elsewhere in that file
// only ever catches a leak that happens DURING a run, so a credential that
// leaked on a PREVIOUS run and is still sitting in the real vault when this
// run starts is present in both snapshots and invisible to that diff. This
// file exists to pin the classifier's two failure-mode boundaries in
// isolation, without spawning `node --test` recursively: importing
// run-tests-with-home-guard.mjs never runs the guard itself (see the
// isMainModule gate at the bottom of that file) -- only `npm test`'s own
// direct `node scripts/run-tests-with-home-guard.mjs` invocation does.

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  findPreexistingLoopbackLeaks,
  isLoopbackOrigin,
  parseVaultTargetName,
} from '../scripts/run-tests-with-home-guard.mjs'

test('parseVaultTargetName splits origin and label around the origin\'s own port colon', () => {
  const parsed = parseVaultTargetName('1f3ea:http://127.0.0.1:54321:alice-agent')
  assert.deepEqual(parsed, { origin: 'http://127.0.0.1:54321', label: 'alice-agent' })
})

test('parseVaultTargetName handles a portless https origin', () => {
  const parsed = parseVaultTargetName('1f3ea:https://1f3ea.com:alice-agent')
  assert.deepEqual(parsed, { origin: 'https://1f3ea.com', label: 'alice-agent' })
})

test('parseVaultTargetName returns null for a name outside the 1f3ea: target shape', () => {
  assert.equal(parseVaultTargetName('not-a-1f3ea-target-at-all'), null)
})

test('isLoopbackOrigin is true for localhost and 127.0.0.1, false for a real hostname', () => {
  assert.equal(isLoopbackOrigin('http://localhost:41234'), true)
  assert.equal(isLoopbackOrigin('http://127.0.0.1:41234'), true)
  assert.equal(isLoopbackOrigin('https://1f3ea.com'), false)
  assert.equal(isLoopbackOrigin('not a url at all'), false)
})

test('findPreexistingLoopbackLeaks flags a leftover stub-origin target from a previous run', () => {
  const targetsBefore = {
    supported: true,
    names: ['1f3ea:http://127.0.0.1:54321:alice-agent--pending-registration-deadbeef'],
  }
  const leaks = findPreexistingLoopbackLeaks(targetsBefore)
  assert.deepEqual(leaks, ['1f3ea:http://127.0.0.1:54321:alice-agent--pending-registration-deadbeef'])
})

test('findPreexistingLoopbackLeaks never flags a real, non-loopback merchant entry', () => {
  const targetsBefore = {
    supported: true,
    names: ['1f3ea:https://1f3ea.com:real-operator-merchant'],
  }
  assert.deepEqual(findPreexistingLoopbackLeaks(targetsBefore), [])
})

test('findPreexistingLoopbackLeaks returns empty rather than false-flagging when the platform scan is unsupported', () => {
  assert.deepEqual(findPreexistingLoopbackLeaks({ supported: false, names: [] }), [])
})

test('findPreexistingLoopbackLeaks handles a mix of loopback residue and a real merchant entry correctly', () => {
  const targetsBefore = {
    supported: true,
    names: [
      '1f3ea:http://localhost:9999:leaked-test-agent',
      '1f3ea:https://1f3ea.com:real-operator-merchant',
    ],
  }
  assert.deepEqual(findPreexistingLoopbackLeaks(targetsBefore), ['1f3ea:http://localhost:9999:leaked-test-agent'])
})
