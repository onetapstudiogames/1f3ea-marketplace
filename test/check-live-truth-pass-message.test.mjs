// Permanent coverage for round-7 finding 4 (scripts/check-live-truth.mjs),
// pre-existing at 5e03eb2 and found on a release walk: the pass line named
// only "llms.txt and /api/official" even though a third check -- the
// anonymous GET /api/me rejection-message pin -- runs and must pass too,
// so an operator reading a green `npm run check:live-truth` could not
// tell that pin ran at all. The SKIP notice already named all three; the
// pass line was the odd one out.
//
// This drives the real script as a subprocess (like
// test/live-drift.test.mjs's own real-network test does) rather than
// re-testing checkLiveTruth()'s internals, which live-drift.test.mjs
// already covers -- this test is only about the printed pass-line text.

import assert from 'node:assert/strict'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { runNode } from './helpers/run-identity-cli.mjs'

const checkLiveTruthPath = fileURLToPath(new URL('../scripts/check-live-truth.mjs', import.meta.url))

test('check-live-truth: the pass line names all three checks it actually runs, not just two of them', async () => {
  const result = await runNode(checkLiveTruthPath, [], { env: { REQUIRE_LIVE_TRUTH: '0' } })
  // Against a live, reachable market this exits 0 and prints the pass
  // line; if the network is unavailable in this environment, checkLiveTruth
  // returns a SKIP notice instead (REQUIRE_LIVE_TRUTH is '0' here) -- in
  // that case there is no pass line to check, so only assert the pass-line
  // shape when this run actually produced one.
  if (result.status === 0 && /^Live truth check passed/u.test(result.stdout)) {
    assert.match(result.stdout, /llms\.txt/u)
    assert.match(result.stdout, /\/api\/official/u)
    assert.match(result.stdout, /\/api\/me/u, 'the pass line must also name the /api/me rejection pin')
  }
})
