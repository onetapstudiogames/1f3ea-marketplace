import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

import { postAuthed, postJson } from '../scripts/lib/identity-http.mjs'
import { listVaultLabels } from '../scripts/identity-client.mjs'

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url))
const commandFetchLoader = pathToFileURL(join(repositoryRoot, 'test/helpers/force-command-fetch.mjs')).href
const keyVaultLoader = pathToFileURL(join(repositoryRoot, 'test/helpers/force-key-vault-failure-loader.mjs')).href
const setupFailureLoader = pathToFileURL(join(repositoryRoot, 'test/helpers/force-setup-failure-loader.mjs')).href

function runScript(relativePath, args = [], env = {}) {
  return spawnSync(process.execPath, [join(repositoryRoot, relativePath), ...args], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  })
}

function runNetworkCommand(relativePath, args, mode, env = {}) {
  return runScript(relativePath, args, {
    NODE_OPTIONS: `--import=${commandFetchLoader}`,
    TEST_FETCH_MODE: mode,
    ...env,
  })
}

test('key refuses each unreadable-vault path instead of treating it as an empty entry', () => {
  const cases = [
    ['rotate client class', ['rotate'], '2'],
    ['recover generate client class', ['recover', 'generate'], '2'],
    ['recover begin validation', ['recover', 'begin', '--recovery-code-file', 'unused'], '1'],
    ['recover begin client class', ['recover', 'begin', '--recovery-code-file', 'unused'], '2'],
  ]

  for (const [label, command, failAt] of cases) {
    const result = runScript('scripts/key.mjs', [
      ...command,
      '--origin', 'https://localhost',
      '--handle', 'fixture-merchant',
    ], {
      NODE_OPTIONS: `--import=${keyVaultLoader}`,
      TEST_VAULT_FAIL_AT: failAt,
      TEST_KEY_HANDLE: 'fixture-merchant',
    })
    assert.notEqual(result.status, 0, `${label}: exits non-zero`)
    assert.match(result.stderr, /not "no key stored"|refusing to guess/iu, `${label}: names the unreadable vault refusal`)
    assert.match(result.stderr, /Repair or remove .* first/iu, `${label}: gives the prerequisite before recovery`)
    assert.doesNotMatch(result.stderr, /no client_class known/iu, `${label}: never reports the failed read as missing data`)
    assert.doesNotMatch(result.stderr, /^\s*at\s+\S+/mu, `${label}: no raw stack trace`)
  }
})

test('network failures use non-zero exits, except an unknown storefront remains a successful read', () => {
  for (const [label, script, args, mode] of [
    ['changelog 404', 'scripts/changelog.mjs', [], 'not-found'],
    ['links 404', 'scripts/links.mjs', [], 'not-found'],
    ['links transport failure', 'scripts/links.mjs', [], 'transport'],
    ['store 503', 'scripts/store.mjs', ['fixture-merchant'], 'server-error'],
    ['update manifest failure', 'scripts/update.mjs', [], 'server-error'],
    ['update changelog failure', 'scripts/update.mjs', [], 'update-changelog-failure'],
    ['update invalid manifest JSON', 'scripts/update.mjs', [], 'update-invalid-json'],
    ['update invalid version', 'scripts/update.mjs', [], 'update-invalid-version'],
  ]) {
    const result = runNetworkCommand(script, args, mode)
    assert.notEqual(result.status, 0, `${label}: failed read exits non-zero`)
  }

  const unknownStore = runNetworkCommand('scripts/store.mjs', ['missing-merchant'], 'not-found')
  assert.equal(unknownStore.status, 0, 'store 404 is a completed lookup for an unknown handle')
  assert.match(unknownStore.stdout, /No storefront is registered/iu)
})

test('store prints the human storefront as canonical and labels the API address as raw data', () => {
  const result = runNetworkCommand('scripts/store.mjs', ['fixture-merchant'], 'store-success')
  assert.equal(result.status, 0)
  assert.match(result.stdout, /Canonical public URL: https:\/\/1f3ea\.com\/window\?store=fixture-merchant/u)
  assert.match(result.stdout, /Raw public data: https:\/\/1f3ea\.com\/api\/store\/fixture-merchant/u)
})

test('help prints a valid live catalog and contains malformed catalog responses', () => {
  const valid = runNetworkCommand('scripts/help.mjs', [], 'help-success')
  assert.equal(valid.status, 0, valid.stderr)
  assert.match(valid.stdout, /front_door\s+public/u)
  assert.match(valid.stdout, /set_store\s+key required/u)

  const malformed = runNetworkCommand('scripts/help.mjs', [], 'help-malformed')
  assert.notEqual(malformed.status, 0)
  assert.match(malformed.stdout, /Live market tools[\s\S]*unavailable: response had an invalid tools list/u)
  assert.match(malformed.stdout, /https:\/\/1f3ea\.com\/api\/help/u)
  assert.doesNotMatch(malformed.stderr, /TypeError:|^\s*at\s+\S+/mu)
})

test('identity HTTP refusals keep their numeric status with readable JSON bodies', async () => {
  const originalFetch = globalThis.fetch
  try {
    for (const [helper, status] of [[postJson, 409], [postAuthed, 429]]) {
      globalThis.fetch = async () => new Response(
        JSON.stringify({ error: 'fixture refusal', reason: 'fixture_reason' }),
        { status, headers: { 'content-type': 'application/json' } },
      )
      await assert.rejects(
        () => helper('https://example.invalid', '/api/fixture', 'fixture-key', {}),
        new RegExp(`HTTP ${status}.*fixture refusal.*fixture_reason`, 'iu'),
      )
    }
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('Windows vault enumeration warns before falling back to the non-secret index', () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'b1-win-vault-warning-'))
  const messages = []
  const originalError = console.error
  console.error = message => messages.push(String(message))
  try {
    assert.deepEqual(listVaultLabels('https://1f3ea.com', {
      platform: 'win32',
      homeDir,
      execFileSync: () => { throw new Error('fixture cmdkey failure') },
    }), [])
  } finally {
    console.error = originalError
    rmSync(homeDir, { recursive: true, force: true })
  }
  assert.match(messages.join('\n'), /Windows Credential Manager lookup failed/iu)
  assert.match(messages.join('\n'), /falling back/iu)
})

test('key usage and top-level handlers give a next command and the live front door', async () => {
  const keyUsage = runScript('scripts/key.mjs')
  assert.notEqual(keyUsage.status, 0)
  assert.match(keyUsage.stderr, /key status/iu)
  assert.match(keyUsage.stderr, /help/iu)

  for (const [script, prefix] of [
    ['scripts/setup.mjs', 'setup'],
    ['scripts/connect.mjs', 'connect'],
    ['scripts/key.mjs', 'key'],
    ['scripts/identity-client.mjs', 'identity-client'],
  ]) {
    const args = script.endsWith('identity-client.mjs')
      ? ['unknown-command']
      : ['--origin', 'http://not-https.invalid']
    const result = runScript(script, args)
    assert.notEqual(result.status, 0, `${prefix}: exits non-zero`)
    assert.match(result.stderr, /https:\/\/1f3ea\.com\//iu, `${prefix}: points to the live front door`)
    assert.match(result.stderr, /run .*?(?:setup|connect|key status|help)/iu, `${prefix}: gives a next command`)
    assert.doesNotMatch(result.stderr, /^\s*at\s+\S+/mu, `${prefix}: no raw stack trace`)
  }
})

test('generic setup and key-adopt failures keep detail and add safe recovery context', () => {
  const setup = runScript('scripts/setup.mjs', [
    '--origin', 'https://localhost',
    '--handle', 'fixture-merchant',
    '--client-class', 'coding_persistent',
  ], { NODE_OPTIONS: `--import=${setupFailureLoader}` })
  assert.notEqual(setup.status, 0)
  assert.match(setup.stderr, /fixture setup failure/iu)
  assert.match(setup.stderr, /Do not assume an identity or key was stored/iu)
  assert.match(setup.stderr, /Run `key status`/iu)
  assert.match(setup.stderr, /https:\/\/1f3ea\.com\//iu)
  assert.doesNotMatch(setup.stderr, /^\s*at\s+\S+/mu)

  const adopt = runScript('scripts/key.mjs', [
    'adopt',
    '--origin', 'https://localhost',
    '--handle', 'fixture-merchant',
    '--from-label', 'fixture-merchant--pending-rotation',
  ], {
    NODE_OPTIONS: `--import=${keyVaultLoader}`,
    TEST_VAULT_FAIL_AT: '0',
    TEST_VAULT_LIVE_MISSING: '1',
    TEST_PROMOTE_FAILURE: '1',
    TEST_KEY_HANDLE: 'fixture-merchant',
  })
  assert.notEqual(adopt.status, 0)
  assert.match(adopt.stderr, /fixture promotion failure/iu)
  assert.match(adopt.stderr, /Do not assume either vault entry moved/iu)
  assert.match(adopt.stderr, /key status --handle fixture-merchant/iu)
  assert.match(adopt.stderr, /https:\/\/1f3ea\.com\//iu)
  assert.doesNotMatch(adopt.stderr, /^\s*at\s+\S+/mu)
})

test('direct release checks wrap failures with state, next command, and the live front door', () => {
  const liveTruth = runNetworkCommand(
    'scripts/check-live-truth.mjs',
    [],
    'transport',
    { REQUIRE_LIVE_TRUTH: '1' },
  )
  assert.notEqual(liveTruth.status, 0)
  assert.match(liveTruth.stderr, /fixture network unavailable/iu)
  assert.match(liveTruth.stderr, /changed no market data/iu)
  assert.match(liveTruth.stderr, /npm run check:live-truth/iu)
  assert.match(liveTruth.stderr, /https:\/\/1f3ea\.com\//iu)
  assert.doesNotMatch(liveTruth.stderr, /^\s*at\s+\S+/mu)

  const release = runScript('scripts/check-release-version.mjs', [], {
    ECC_SKIP_GIT_HOOKS: '1',
    REQUIRE_RELEASE_BASE: '1',
    SKILL_VERSION_BASE_SHA: 'definitely-not-a-ref',
  })
  assert.notEqual(release.status, 0)
  assert.match(release.stderr, /release base is required/iu)
  assert.match(release.stderr, /changed no release files/iu)
  assert.match(release.stderr, /reported release-check problem/iu)
  assert.match(release.stderr, /npm run check:release-version/iu)
  assert.match(release.stderr, /https:\/\/1f3ea\.com\//iu)
  assert.doesNotMatch(release.stderr, /^\s*at\s+\S+/mu)
})
