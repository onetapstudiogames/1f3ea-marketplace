import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { makeTempHome, runNode } from './helpers/run-identity-cli.mjs'
import { startStubMarketServer } from './helpers/stub-market-server.mjs'
import { statusGuidance } from '../scripts/lib/mcp-bridge.mjs'
import { LOST_KEY_GUIDANCE, UNREADABLE_ENTRY_GUIDANCE } from '../scripts/lib/recovery-guidance.mjs'

// Two cases, never merged.
//
//   Case A -- the vault entry could not be read. The key is NOT known to be
//   gone, so a second identity is exactly the wrong move.
//   Case B -- the key is known to be lost. One unused recovery code replaces
//   it; a new identity is the way forward only when no unused code is left.
//
// The bug this file guards against is the inversion: Case A refusals that
// ended "create a new identity", which is the opposite of what they must say.

// The case-B sentence without its "If the key is gone, " lead-in. Two guides
// already carry that condition in their own list label ("Lost key: ...",
// "**Lost key recovery** -- ...") and repeating it there stutters, so the
// invariant every copy shares is this body.
const LOST_KEY_BODY = 'the human enters one unused recovery code at https://1f3ea.com/recovery, saves the replacement key, and re-enters it there; only if no unused code remains is a new identity the way forward.'

// Guides that state the condition themselves and so carry the body alone.
const labelledGuides = ['SETUP.md', 'skills/key/SKILL.md', 'skills-codex/key/SKILL.md']

// Every guide that must carry the lost-key advice, once.
const guides = [
  'SKILL.md',
  'SETUP.md',
  'references/wallet.md',
  'skills/key/SKILL.md',
  'skills/connect/SKILL.md',
  'skills/setup/SKILL.md',
  'skills/1f3ea-marketplace/SKILL.md',
  'skills/1f3ea-marketplace/references/wallet.md',
  'skills-codex/key/SKILL.md',
  'skills-codex/connect/SKILL.md',
  'skills-codex/setup/SKILL.md',
  'skills-codex/1f3ea-marketplace/SKILL.md',
  'skills-codex/1f3ea-marketplace/references/wallet.md',
]

const readRepoFile = (relativePath) => readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8')

test('the two cases are distinct sentences, and neither borrows the other ending', () => {
  assert.ok(LOST_KEY_GUIDANCE.endsWith(LOST_KEY_BODY), 'case B is its labelled body plus the condition')
  assert.equal(LOST_KEY_GUIDANCE, `If the key is gone, ${LOST_KEY_BODY}`)
  assert.ok(
    UNREADABLE_ENTRY_GUIDANCE.endsWith('never create a second identity to work around an unreadable entry.'),
    'case A ends with the duplicate-identity guard',
  )
  assert.match(UNREADABLE_ENTRY_GUIDANCE, /Repair or remove the unreadable entry first, then re-run/u)
  assert.match(UNREADABLE_ENTRY_GUIDANCE, /https:\/\/1f3ea\.com\/recovery/u)
  // The inversion itself: case A must never tell anyone to make a new identity.
  assert.doesNotMatch(UNREADABLE_ENTRY_GUIDANCE, /create a new identity/iu)
  assert.ok(!UNREADABLE_ENTRY_GUIDANCE.includes(LOST_KEY_BODY), 'case A never carries the case-B sentence')
  assert.ok(!LOST_KEY_GUIDANCE.includes('unreadable'), 'case B never claims the entry is unreadable')
})

test('every guide carries the lost-key sentence exactly once, in the same words', () => {
  for (const guide of guides) {
    const source = readRepoFile(guide)
    const copies = source.split(LOST_KEY_BODY).length - 1
    assert.equal(copies, 1, `${guide}: expected exactly one lost-key sentence, found ${copies}`)
    if (!labelledGuides.includes(guide)) {
      assert.ok(source.includes(LOST_KEY_GUIDANCE), `${guide}: omits the "If the key is gone" condition`)
    }
  }
})

test('a guide that labels the case in its own bullet does not stutter the condition', () => {
  for (const guide of labelledGuides) {
    const source = readRepoFile(guide)
    assert.doesNotMatch(source, /Lost key[^\n]*:\s*If the key is gone/iu, `${guide}: label repeats the condition`)
    assert.doesNotMatch(source, /Lost key recovery\*\*\s*—\s*If the key is gone/iu, `${guide}: label repeats the condition`)
  }
})

test('the lost-key bullet does not contradict the reuse-your-identity bullet next to it', () => {
  for (const skill of ['SKILL.md', 'skills/1f3ea-marketplace/SKILL.md', 'skills-codex/1f3ea-marketplace/SKILL.md']) {
    const source = readRepoFile(skill)
    const lines = source.split('\n')
    const index = lines.findIndex((line) => line.includes(LOST_KEY_BODY))
    assert.ok(index > 0, `${skill}: no lost-key bullet found`)
    assert.match(lines[index], /^- /u, `${skill}: the lost-key sentence is not a list item`)
    assert.match(lines[index - 1], /^- /u, `${skill}: a blank line splits the identity list`)
    assert.match(lines[index + 1], /Do not create replacement identities merely because a connector cannot authenticate/u)
    // The neighbour forbids replacement identities for an authentication
    // failure; this bullet may only allow one when no unused code is left.
    assert.doesNotMatch(lines[index], /; if no unused code remains, create a new identity/u)
  }
})

test('no refusal for an unreadable entry tells anyone to create a new identity', () => {
  for (const script of ['scripts/connect.mjs', 'scripts/key.mjs', 'scripts/setup.mjs', 'scripts/lib/mcp-bridge.mjs']) {
    const source = readRepoFile(script)
    assert.doesNotMatch(source, /create a new identity/iu, `${script}: carries the inverted guard`)
    // Every refusal that fires on an unreadable read reaches for the shared
    // case-A constant instead of retyping (or inverting) the sentence.
    if (source.includes('unreadable') || source.includes('SecretReadFailure')) {
      assert.match(source, /UNREADABLE_ENTRY_GUIDANCE/u, `${script}: does not use the shared case-A sentence`)
    }
  }
})

test('bridge separates an unreadable entry from a key that is gone', () => {
  for (const status of ['setup_unreadable', 'key_unreadable']) {
    const output = statusGuidance({ status, handle: 'test-handle' })
    assert.ok(output.includes(UNREADABLE_ENTRY_GUIDANCE), `${status}: missing the unreadable-entry sentence`)
    assert.ok(!output.includes(LOST_KEY_BODY), `${status}: merges the two cases`)
    assert.doesNotMatch(output, /create a new identity/iu, `${status}: carries the inverted guard`)
  }
  for (const status of ['setup_missing', 'key_missing']) {
    const output = statusGuidance({ status, handle: 'test-handle' })
    assert.ok(output.includes(LOST_KEY_GUIDANCE), `${status}: missing the lost-key sentence`)
    assert.ok(!output.includes(UNREADABLE_ENTRY_GUIDANCE), `${status}: claims the entry is unreadable`)
  }
})

test('key status emits the lost-key sentence when its vault entry is missing', async () => {
  const home = makeTempHome('missing-key-guidance-')
  const stub = await startStubMarketServer()
  try {
    const keyPath = fileURLToPath(new URL('../scripts/key.mjs', import.meta.url))
    const origin = stub.origin
    const result = await runNode(keyPath, ['status', '--origin', origin, '--allow-origin', origin, '--handle', 'missing-handle'], { env: home.env })
    assert.notEqual(result.status, 0)
    const output = result.stdout + result.stderr
    assert.ok(output.includes(LOST_KEY_GUIDANCE), output)
    assert.ok(!output.includes(UNREADABLE_ENTRY_GUIDANCE), output)
  } finally {
    home.cleanup()
    await stub.close()
  }
})
