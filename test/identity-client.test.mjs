import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { writeFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import {
  deleteSecret,
  isValidModel,
  listVaultLabels,
  parseKeychainServiceNames,
  promoteReplacementKey,
  readSecret,
  SecretReadFailure,
  shouldReveal,
  storeSecret,
  unescapeSecurityDumpString,
} from '../scripts/identity-client.mjs'
import { assertAllowedOrigin } from '../scripts/lib/origin-guard.mjs'
import { probeMe } from '../scripts/lib/identity-probe.mjs'
import { startRedirectingStubServer } from './helpers/stub-market-server.mjs'
import { runNode } from './helpers/run-identity-cli.mjs'

const identityClientPath = fileURLToPath(new URL('../scripts/identity-client.mjs', import.meta.url))

// These subprocess tests below all target --origin https://example.invalid
// (reserved by RFC 2606, can never resolve to anything real) to exercise
// flag parsing, printed output shape, or refusal wording unrelated to the
// origin guard itself -- the same rationale test/helpers/run-identity-cli.mjs
// documents for its own NOT_A_REAL_ORIGIN_ENV. runCli is a raw spawnSync, not
// routed through that helper's minimalBaseEnv, so it inherits the FULL
// parent process.env by default -- including a real, exported
// AGENT_1F3EA_STUB_ONLY=1 (this repo's own documented review guardrail), for
// which the child would refuse every non-loopback --origin, example.invalid
// included, before ever reaching the behavior each test below actually means
// to exercise. Pin it to '0' explicitly here, same as NOT_A_REAL_ORIGIN_ENV
// does, so this file's own assertions hold regardless of whether the caller
// exported that guardrail into this test-runner process.
const runCli = (args, input) => spawnSync(process.execPath, [identityClientPath, ...args], {
  encoding: 'utf8',
  input,
  stdio: input === undefined ? ['ignore', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, AGENT_1F3EA_STUB_ONLY: '0' },
})

// --- Refusals: every one of these must fail before any network call -------

test('rotate refuses a bare --merchant-key flag', () => {
  const result = runCli(['rotate', '--origin', 'https://example.invalid', '--allow-origin', 'https://example.invalid', '--merchant-key', '1f3ea_sk_' + 'a'.repeat(48)])
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /refused as a bare flag/u)
  assert.match(result.stderr, /--merchant-key-file/u)
})

test('recover begin refuses a bare --recovery-code flag', () => {
  const result = runCli(['recover', 'begin', '--origin', 'https://example.invalid', '--allow-origin', 'https://example.invalid', '--recovery-code', '1f3ea_rc_' + 'b'.repeat(64)])
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /refused as a bare flag/u)
  assert.match(result.stderr, /--recovery-code-file/u)
})

test('register refuses an invalid client_class before any network call', () => {
  const result = runCli(['register', '--origin', 'https://example.invalid', '--allow-origin', 'https://example.invalid', '--handle', 'test-agent', '--client-class', 'hosted_browser', '--human-approved'])
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /client-class must be coding_persistent or coding_ephemeral/u)
})

test('register refuses to proceed without human approval on a non-interactive stdin', () => {
  const result = runCli(['register', '--origin', 'https://example.invalid', '--allow-origin', 'https://example.invalid', '--handle', 'test-agent', '--client-class', 'coding_persistent'], '')
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /needs human approval/u)
})

test('rotate refuses a malformed merchant key shape before any network call', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'identity-client-'))
  try {
    const keyFile = join(dir, 'key.txt')
    await writeFile(keyFile, 'not-a-real-key\n')
    const result = runCli(['rotate', '--origin', 'https://example.invalid', '--allow-origin', 'https://example.invalid', '--merchant-key-file', keyFile])
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /must point to the current, valid merchant key/u)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('recover begin refuses a malformed recovery code shape before any network call', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'identity-client-'))
  try {
    const codeFile = join(dir, 'code.txt')
    await writeFile(codeFile, 'not-a-real-code\n')
    const result = runCli(['recover', 'begin', '--origin', 'https://example.invalid', '--allow-origin', 'https://example.invalid', '--recovery-code-file', codeFile])
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /must point to a valid, unused recovery code/u)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('an unknown command refuses with a usage line', () => {
  const result = runCli(['bogus'])
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /usage: identity-client\.mjs/u)
})

test('the --name=value form of a bare secret flag is refused exactly like the space form', () => {
  // parseArgs must split "--merchant-key=VALUE" into flags['merchant-key'],
  // not a literal flag named "merchant-key=1f3ea_sk_..." -- otherwise the
  // bare-flag refusal below never fires and the key sits in argv/history
  // with a misleading, unrelated error instead.
  const equalsForm = runCli(['rotate', '--origin', 'https://example.invalid', '--allow-origin', 'https://example.invalid', `--merchant-key=1f3ea_sk_${'a'.repeat(48)}`])
  assert.notEqual(equalsForm.status, 0)
  assert.match(equalsForm.stderr, /refused as a bare flag/u)
  assert.match(equalsForm.stderr, /--merchant-key-file/u)
  assert.match(equalsForm.stderr, /treat that value as exposed now and rotate it/u)

  const equalsRecoveryForm = runCli(['recover', 'begin', '--origin', 'https://example.invalid', '--allow-origin', 'https://example.invalid', `--recovery-code=1f3ea_rc_${'b'.repeat(64)}`])
  assert.notEqual(equalsRecoveryForm.status, 0)
  assert.match(equalsRecoveryForm.stderr, /refused as a bare flag/u)
  assert.match(equalsRecoveryForm.stderr, /--recovery-code-file/u)
})

// --- Origin allowlist: only the real market or an explicit, matching opt-in -

test('assertAllowedOrigin refuses plain http, even for localhost', () => {
  assert.throws(() => assertAllowedOrigin('http://1f3ea.com'), /only https is allowed/u)
  assert.throws(() => assertAllowedOrigin('http://localhost:3000'), /only https is allowed/u)
})

// Both tests below assert the ORDINARY (non-stub-only) refusal/allow
// wording, so they must run with AGENT_1F3EA_STUB_ONLY cleared regardless of
// whatever this test-runner process itself was started with -- unlike the
// runCli-driven subprocess tests above, these call assertAllowedOrigin
// in-process and read process.env directly, so a real exported
// AGENT_1F3EA_STUB_ONLY=1 (this repo's own documented review guardrail)
// would otherwise leak straight in and produce the stub-only wording
// instead. Same save/clear/restore shape the positive AGENT_1F3EA_STUB_ONLY
// tests further down already use.

test('assertAllowedOrigin refuses a foreign https origin without a matching --allow-origin', () => {
  const previous = process.env.AGENT_1F3EA_STUB_ONLY
  delete process.env.AGENT_1F3EA_STUB_ONLY
  try {
    assert.throws(
      () => assertAllowedOrigin('https://evil.example'),
      /refusing to send a merchant key to "https:\/\/evil\.example"/u,
    )
    assert.throws(
      () => assertAllowedOrigin('https://evil.example', { allowOrigin: 'https://other.example' }),
      /refusing to send a merchant key/u,
    )
  } finally {
    if (previous === undefined) delete process.env.AGENT_1F3EA_STUB_ONLY
    else process.env.AGENT_1F3EA_STUB_ONLY = previous
  }
})

test('assertAllowedOrigin allows the real market, https://localhost, and an exactly-matching --allow-origin', () => {
  const previous = process.env.AGENT_1F3EA_STUB_ONLY
  delete process.env.AGENT_1F3EA_STUB_ONLY
  try {
    assert.equal(assertAllowedOrigin('https://1f3ea.com'), 'https://1f3ea.com')
    assert.equal(assertAllowedOrigin('https://localhost:4000'), 'https://localhost:4000')
    assert.equal(assertAllowedOrigin('https://127.0.0.1:4000'), 'https://127.0.0.1:4000')
    assert.equal(
      assertAllowedOrigin('https://evil.example', { allowOrigin: 'https://evil.example' }),
      'https://evil.example',
    )
  } finally {
    if (previous === undefined) delete process.env.AGENT_1F3EA_STUB_ONLY
    else process.env.AGENT_1F3EA_STUB_ONLY = previous
  }
})

// --- Finding 8: AGENT_1F3EA_STUB_ONLY=1 refuses every non-loopback origin -
// (the guard that would have stopped the incident where a review agent ran
// these scripts against the real market by hand) -- including the real market
// itself, and including a value the caller confirmed with --allow-origin.

test('assertAllowedOrigin refuses the real market, https://1f3ea.com, when AGENT_1F3EA_STUB_ONLY=1 is set', () => {
  const previous = process.env.AGENT_1F3EA_STUB_ONLY
  process.env.AGENT_1F3EA_STUB_ONLY = '1'
  try {
    assert.throws(
      () => assertAllowedOrigin('https://1f3ea.com'),
      /AGENT_1F3EA_STUB_ONLY=1 is set/u,
      'the real market is refused even though it is ordinarily the allowed default origin',
    )
  } finally {
    if (previous === undefined) delete process.env.AGENT_1F3EA_STUB_ONLY
    else process.env.AGENT_1F3EA_STUB_ONLY = previous
  }
})

test('assertAllowedOrigin refuses a foreign origin under AGENT_1F3EA_STUB_ONLY=1 even with a matching --allow-origin', () => {
  const previous = process.env.AGENT_1F3EA_STUB_ONLY
  process.env.AGENT_1F3EA_STUB_ONLY = '1'
  try {
    assert.throws(
      () => assertAllowedOrigin('https://evil.example', { allowOrigin: 'https://evil.example' }),
      /AGENT_1F3EA_STUB_ONLY=1 is set/u,
      '--allow-origin is not an escape hatch from this guardrail',
    )
  } finally {
    if (previous === undefined) delete process.env.AGENT_1F3EA_STUB_ONLY
    else process.env.AGENT_1F3EA_STUB_ONLY = previous
  }
})

test('assertAllowedOrigin still allows localhost/127.0.0.1 when AGENT_1F3EA_STUB_ONLY=1 is set', () => {
  const previous = process.env.AGENT_1F3EA_STUB_ONLY
  process.env.AGENT_1F3EA_STUB_ONLY = '1'
  try {
    assert.equal(assertAllowedOrigin('https://localhost:4000'), 'https://localhost:4000')
    assert.equal(assertAllowedOrigin('https://127.0.0.1:4000'), 'https://127.0.0.1:4000')
  } finally {
    if (previous === undefined) delete process.env.AGENT_1F3EA_STUB_ONLY
    else process.env.AGENT_1F3EA_STUB_ONLY = previous
  }
})

test('setup.mjs refuses https://1f3ea.com before any network call when AGENT_1F3EA_STUB_ONLY=1 is set', async () => {
  const setupPath = fileURLToPath(new URL('../scripts/setup.mjs', import.meta.url))
  const result = await runNode(setupPath, [
    '--origin', 'https://1f3ea.com', '--handle', 'should-never-register', '--client-class', 'coding_persistent',
  ], { env: { AGENT_1F3EA_STUB_ONLY: '1' } })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /AGENT_1F3EA_STUB_ONLY=1 is set/u)
  assert.equal(result.stdout.trim(), '', 'nothing at all was printed before the guard refused')
})

test('every printed env-var name in the identity-client usage comment is a legal shell identifier', async () => {
  const source = await (await import('node:fs/promises')).readFile(identityClientPath, 'utf8')
  const envVarNames = [...source.matchAll(/\b([A-Z][A-Z0-9_]*_[A-Z0-9_]*SECRET|[A-Z][A-Z0-9_]*MERCHANT_KEY)\b/gu)]
    .map((match) => match[1])
  assert.ok(envVarNames.length > 0, 'sanity: found at least one candidate env-var name to check')
  for (const name of envVarNames) {
    assert.match(name, /^[A-Za-z_][A-Za-z0-9_]*$/u, `${name} is a legal POSIX shell identifier`)
  }
})

// --- Reveal gating: a secret never reaches a captured (non-TTY) stdout ----

test('shouldReveal is true only when --reveal was passed AND stdout is a real TTY', () => {
  // This is the pure predicate revealOrHide is built on. It is tested
  // directly, in addition to (not instead of) the subprocess test below,
  // because a subprocess's own stdout can never be a real TTY either way --
  // asserting only through a spawned child can prove secrets stay hidden
  // when captured, but can never prove the reveal branch itself is wired up
  // correctly, or fail if it silently stopped being called at all.
  assert.equal(shouldReveal({ reveal: true }, true), true)
  assert.equal(shouldReveal({ reveal: true }, false), false)
  assert.equal(shouldReveal({ reveal: true }, undefined), false)
  assert.equal(shouldReveal({}, true), false)
  assert.equal(shouldReveal({ reveal: false }, true), false)
})

// The prior version of this suite also carried a subprocess-driven "reveal"
// test pointed at https://example.invalid, which always died in
// fetchOrExplain before revealOrHide was ever reached -- it could not fail
// even with the reveal gate replaced by an unconditional print. Real
// coverage of "a secret never reaches captured stdout even with --reveal"
// now lives in shouldReveal above (the pure predicate) plus the
// stub-server-driven leak assertions in test/identity-commands.test.mjs
// (setup's second pass, key rotate, key recover generate), which actually
// exercise a real staged key and would go red if the gate broke.

// --- Redirects: never followed, even to another allowed-origin host -------
// (finding 7 / the redirect exfiltration primitive)

test('identity-client.mjs never follows a redirect from the (allowed) origin to another host', async () => {
  const { createServer } = await import('node:http')
  let attackerHit = false
  let attackerBody = null
  const attacker = createServer((req, res) => {
    attackerHit = true
    let data = ''
    req.on('data', chunk => { data += chunk })
    req.on('end', () => {
      attackerBody = data
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{}')
    })
  })
  await new Promise(resolvePromise => attacker.listen(0, '127.0.0.1', resolvePromise))
  const attackerPort = attacker.address().port

  // https://localhost:<port> is allowed unconditionally (local development),
  // so no --allow-origin is needed to reach this stub -- exactly like a real
  // deployment pointed at the real market.
  const redirecting = await startRedirectingStubServer(`http://127.0.0.1:${attackerPort}/stolen`)
  try {
    // Must be runNode (async spawn), never spawnSync/runCli: this test's
    // stub HTTPS server runs in THIS process's own event loop, and a
    // synchronous child would block that loop -- starving the very server
    // the child is trying to reach -- exactly the pitfall runNode's own doc
    // comment in test/helpers/run-identity-cli.mjs describes.
    const result = await runNode(identityClientPath, [
      'register', '--origin', redirecting.origin,
      '--handle', 'test-agent', '--client-class', 'coding_persistent', '--human-approved',
    ])
    assert.notEqual(result.status, 0, 'register refuses rather than following the redirect')
    assert.equal(attackerHit, false, 'the redirect target never received any request at all')
    assert.equal(attackerBody, null)
    assert.doesNotMatch(result.stdout + result.stderr, /1f3ea_sk_|1f3ea_rc_/u, 'no secret literal anywhere in the CLI output either')
    assert.match(result.stderr, /redirect/iu, 'sanity: the failure is actually the redirect refusal (fetch\'s redirect: "error")')
  } finally {
    await redirecting.close()
    await new Promise(resolvePromise => attacker.close(resolvePromise))
  }
})

test('probeMe never follows a redirect from the origin to another host', async () => {
  const { createServer } = await import('node:http')
  let attackerHit = false
  const attacker = createServer((req, res) => {
    attackerHit = true
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{}')
  })
  await new Promise(resolvePromise => attacker.listen(0, '127.0.0.1', resolvePromise))
  const attackerPort = attacker.address().port

  const redirecting = await startRedirectingStubServer(`http://127.0.0.1:${attackerPort}/stolen`)
  // probeMe runs in THIS process (unlike the subprocess test above), so the
  // self-signed fixture cert needs the same trust relaxation
  // test/helpers/run-identity-cli.mjs sets via env for subprocess callers --
  // set and restore it directly on this process so it never leaks into
  // other tests in this file.
  const previousTlsSetting = process.env.NODE_TLS_REJECT_UNAUTHORIZED
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
  try {
    const probe = await probeMe(redirecting.origin, `1f3ea_sk_${'a'.repeat(48)}`)
    assert.equal(probe.ok, false, 'probeMe reports failure rather than following the redirect')
    // The definitive proof this is the redirect refusal (not, say, an
    // unrelated network hiccup): the redirect target genuinely never saw a
    // request. probe.error's exact text is not asserted here -- undici
    // reports a redirect-mode-error failure only as a bare "fetch failed" at
    // this level, with the real reason one level deeper in error.cause,
    // which probeMe's catch (unlike fetchOrExplain's) does not unwrap.
    assert.equal(attackerHit, false, 'the redirect target never received the bearer-authenticated request')
  } finally {
    if (previousTlsSetting === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previousTlsSetting
    await redirecting.close()
    await new Promise(resolvePromise => attacker.close(resolvePromise))
  }
})

// --- Vault round trip against the temp-file backend -----------------------
// The temp-file backend is the fallback used on any platform that is
// neither win32 nor darwin (see storeSecret/readSecret in
// identity-client.mjs); it depends on real POSIX permission-bit semantics
// (chmodSync narrowing an existing file, statSync reporting the narrowed
// mode) that NTFS does not provide. On a real Linux runner (this repo's own
// CI: ubuntu-latest) storeSecret narrows the file to mode 600 and this round
// trip passes; on a Windows dev machine, forcing the file backend still
// writes through real fs calls against NTFS, which cannot represent group/
// other permission bits the way POSIX can, so the safety check that refuses
// an over-open file is untestable here. This suite skips itself on win32
// rather than assert something NTFS cannot honor either way.
const posixFileBackend = process.platform !== 'win32'

test('vault round trip against the temp-file backend: store then read returns exactly what was written', { skip: !posixFileBackend && 'temp-file backend depends on POSIX permission bits; run on Linux/macOS or in this repo\'s CI' }, async () => {
  const homeDir = await mkdtemp(join(tmpdir(), 'identity-client-vault-'))
  try {
    const payload = {
      kind: 'merchant',
      handle: 'roundtrip-tester',
      client_class: 'coding_persistent',
      merchant_key: `1f3ea_sk_${'a'.repeat(48)}`,
      recovery_codes: Array.from({ length: 8 }, (_unused, index) => `1f3ea_rc_${index.toString().padStart(2, '0')}${'b'.repeat(62)}`),
      origin: 'https://example.invalid',
      stored_at: new Date().toISOString(),
    }
    const deps = { platform: 'linux', homeDir }

    const location = storeSecret('https://example.invalid', 'roundtrip-tester', payload, deps)
    assert.match(location, /local file .*mode 600\)/u)

    const read = readSecret('https://example.invalid', 'roundtrip-tester', deps)
    assert.equal(read.found, true)
    assert.deepEqual(read.value, payload)
  } finally {
    await rm(homeDir, { recursive: true, force: true })
  }
})

test('vault round trip: reading a label that was never stored reports found:false, not an error', { skip: !posixFileBackend && 'temp-file backend depends on POSIX permission bits' }, async () => {
  const homeDir = await mkdtemp(join(tmpdir(), 'identity-client-vault-'))
  try {
    const read = readSecret('https://example.invalid', 'never-stored', { platform: 'linux', homeDir })
    assert.deepEqual(read, { found: false, value: null })
  } finally {
    await rm(homeDir, { recursive: true, force: true })
  }
})

test('vault round trip: a corrupted stored entry throws SecretReadFailure, never a silent empty read', { skip: !posixFileBackend && 'temp-file backend depends on POSIX permission bits' }, async () => {
  const homeDir = await mkdtemp(join(tmpdir(), 'identity-client-vault-'))
  try {
    const deps = { platform: 'linux', homeDir }
    storeSecret('https://example.invalid', 'corrupt-me', { merchant_key: 'x' }, deps)
    // identity-client.mjs does not export its internal path builder, so we
    // reconstruct the same deterministic path it documents (safeOrigin,
    // safeLabel) to corrupt the file it just wrote, exercising the decode
    // failure path exactly as a real corrupted vault entry would.
    const safeOrigin = 'https://example.invalid'.replace(/[^a-z0-9.-]/giu, '_')
    const safeLabel = 'corrupt-me'.replace(/[^a-z0-9._-]/giu, '_')
    const filePath = join(homeDir, '.1f3ea', 'credentials', `${safeOrigin}__${safeLabel}.json`)
    writeFileSync(filePath, 'not valid json{{{', { mode: 0o600 })

    assert.throws(() => readSecret('https://example.invalid', 'corrupt-me', deps), SecretReadFailure)
  } finally {
    await rm(homeDir, { recursive: true, force: true })
  }
})

test('promoteReplacementKey merges forward client_class and recovery_codes from the live entry', { skip: !posixFileBackend && 'temp-file backend depends on POSIX permission bits' }, async () => {
  const homeDir = await mkdtemp(join(tmpdir(), 'identity-client-vault-'))
  try {
    const origin = 'https://example.invalid'
    const deps = { platform: 'linux', homeDir }
    storeSecret(origin, 'promote-me', {
      kind: 'merchant',
      handle: 'promote-me',
      client_class: 'coding_persistent',
      merchant_key: `1f3ea_sk_${'0'.repeat(48)}`,
      recovery_codes: [`1f3ea_rc_${'1'.repeat(64)}`],
      origin,
    }, deps)

    const stagingLabel = 'promote-me--pending-rotation'
    storeSecret(origin, stagingLabel, {
      kind: 'merchant',
      handle: 'promote-me',
      merchant_key: `1f3ea_sk_${'2'.repeat(48)}`,
      origin,
    }, deps)

    const location = promoteReplacementKey(origin, 'promote-me', stagingLabel, `1f3ea_sk_${'2'.repeat(48)}`, (previous) => ({
      ...(previous?.client_class ? { client_class: previous.client_class } : {}),
      ...(previous?.recovery_codes ? { recovery_codes: previous.recovery_codes } : {}),
    }), deps)
    assert.match(location, /local file/u)

    const promoted = readSecret(origin, 'promote-me', deps)
    assert.equal(promoted.found, true)
    assert.equal(promoted.value.merchant_key, `1f3ea_sk_${'2'.repeat(48)}`)
    assert.equal(promoted.value.client_class, 'coding_persistent')
    assert.deepEqual(promoted.value.recovery_codes, [`1f3ea_rc_${'1'.repeat(64)}`])

    const staging = readSecret(origin, stagingLabel, deps)
    assert.equal(staging.found, false, 'the staging copy is deleted once promotion succeeds')
  } finally {
    await rm(homeDir, { recursive: true, force: true })
  }
})

test('promoteReplacementKey refuses to swallow a write failure after the server already confirmed the new key (finding 3)', () => {
  // Fully mocked via injected deps (execFileSync never runs a real `security`
  // binary), so this runs on every platform: the read side succeeds (a live
  // entry exists) and the write side fails (a locked keychain), exactly the
  // shape a caller must never see reported as a bare "could not write" with
  // no context -- by the time this function runs, the server already
  // confirmed the rotation/recovery, so the OLD key is already dead, and the
  // ONLY place the new one lives is the staging label.
  const origin = 'https://example.invalid'
  const handle = 'promote-write-fail'
  const stagingLabel = `${handle}--pending-rotation`
  const previousValue = { kind: 'merchant', handle, client_class: 'coding_persistent', merchant_key: 'old-key', origin }
  const execFileSync = (command, args) => {
    if (command === 'security' && args[0] === 'find-generic-password') {
      return Buffer.from(JSON.stringify(previousValue), 'utf8').toString('base64')
    }
    if (command === 'security' && args[0] === '-i') {
      throw new Error('keychain is locked')
    }
    throw new Error(`unexpected exec call in this test: ${command} ${args.join(' ')}`)
  }
  // promoteReplacementKey now takes a per-(origin, handle) file lock (see
  // Finding 2 test block below) before ever calling readSecret/storeSecret,
  // so every call -- including this fully-mocked one -- needs a temp
  // homeDir or that lock file would land under the real ~/.1f3ea.
  const homeDir = mkdtempSync(join(tmpdir(), 'identity-client-promote-'))
  const deps = { execFileSync, platform: 'darwin', homeDir }

  try {
    assert.throws(
      () => promoteReplacementKey(origin, handle, stagingLabel, 'new-key', (previous) => ({
        ...(previous?.client_class ? { client_class: previous.client_class } : {}),
      }), deps),
      (error) => {
        assert.match(error.message, /old key.*no longer works/iu, 'names the old key as already dead')
        assert.match(
          error.message,
          new RegExp(stagingLabel.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')),
          'names the staging label where the confirmed replacement key still lives',
        )
        assert.doesNotMatch(error.message, /new-key|old-key/u, 'never includes the raw key values')
        return true
      },
    )
  } finally {
    rmSync(homeDir, { recursive: true, force: true })
  }
})

// --- Finding 2: register()'s overwrite guard is re-checked immediately ----
// before the final vault write, not only once before the stage/confirm
// network round trips -- closing the window where a concurrent run could
// create the same handle in between.

test('promoteReplacementKey with refuseIfPresent:true refuses to overwrite a live entry that now exists, and never touches the staging copy', () => {
  const origin = 'https://example.invalid'
  const handle = 'race-handle'
  const stagingLabel = `${handle}--pending-registration`
  const liveValue = { kind: 'merchant', handle, client_class: 'coding_persistent', merchant_key: 'won-the-race-key', origin }
  let storeCalled = false
  const execFileSync = (command, args) => {
    if (command === 'security' && args[0] === 'find-generic-password') {
      return Buffer.from(JSON.stringify(liveValue), 'utf8').toString('base64')
    }
    if (command === 'security' && args[0] === '-i') {
      storeCalled = true
      throw new Error('this test must never reach a write attempt')
    }
    throw new Error(`unexpected exec call in this test: ${command} ${args.join(' ')}`)
  }
  // See the temp-homeDir comment on the write-failure test above -- same
  // reason: promoteReplacementKey's per-(origin, handle) lock file needs
  // somewhere that is not the real ~/.1f3ea.
  const homeDir = mkdtempSync(join(tmpdir(), 'identity-client-promote-'))
  const deps = { execFileSync, platform: 'darwin', homeDir }

  try {
    assert.throws(
      () => promoteReplacementKey(origin, handle, stagingLabel, 'new-confirmed-key', () => ({}), deps, { refuseIfPresent: true }),
      (error) => {
        assert.match(error.message, /now exists/u, 'names the race, not a generic write failure')
        assert.match(error.message, new RegExp(stagingLabel.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')), 'points at the staging label')
        assert.doesNotMatch(error.message, /won-the-race-key|new-confirmed-key/u, 'never includes a raw key value')
        return true
      },
    )
    assert.equal(storeCalled, false, 'the write is never even attempted once the live entry is found present')
  } finally {
    rmSync(homeDir, { recursive: true, force: true })
  }
})

test('promoteReplacementKey with refuseIfPresent:true still writes normally when nothing is there yet', () => {
  const origin = 'https://example.invalid'
  const handle = 'no-race-handle'
  const stagingLabel = `${handle}--pending-registration`
  const execFileSync = (command, args) => {
    if (command === 'security' && args[0] === 'find-generic-password') {
      throw new Error('not found') // readSecret treats a lookup failure as "not found"
    }
    if (command === 'security' && args[0] === '-i') {
      return '' // the write succeeds
    }
    throw new Error(`unexpected exec call in this test: ${command} ${args.join(' ')}`)
  }
  // A successful write here reaches storeSecret's darwin branch, which
  // also calls updateVaultIndex -- on top of the per-(origin, handle) lock
  // file every promoteReplacementKey call now takes (see the two tests
  // above), both need a temp homeDir or they would touch the real
  // ~/.1f3ea.
  const homeDir = mkdtempSync(join(tmpdir(), 'identity-client-promote-'))
  const deps = { execFileSync, platform: 'darwin', homeDir }

  try {
    const location = promoteReplacementKey(origin, handle, stagingLabel, 'brand-new-key', () => ({ client_class: 'coding_persistent' }), deps, { refuseIfPresent: true })
    assert.match(location, /macOS Keychain/u)
  } finally {
    rmSync(homeDir, { recursive: true, force: true })
  }
})

// --- Finding 4: the non-secret vault index is now serialized with a -------
// short-retry, stale-aware lockfile, so two updates in close succession
// never clobber each other, and an abandoned lock is broken rather than
// honored forever.

test('storeSecret/listVaultLabels: an abandoned (stale) vault-index lock is broken rather than blocking the next update forever', async () => {
  const homeDir = await mkdtemp(join(tmpdir(), 'identity-client-lock-'))
  try {
    const origin = 'https://example.invalid'
    const deps = { platform: 'win32', homeDir, execFileSync: () => {} } // no-op: never touches the real Windows Credential Manager
    const noop = { kind: 'merchant', handle: 'agent-lock-a', client_class: 'coding_persistent', merchant_key: 'k', origin }

    storeSecret(origin, 'agent-lock-a', noop, deps)
    assert.deepEqual(listVaultLabels(origin, deps), ['agent-lock-a'])

    // Simulate a process that acquired the vault-index lock and then died
    // before ever releasing it: create the lockfile directly and backdate
    // its mtime well past the staleness threshold.
    const lockDir = join(homeDir, '.1f3ea')
    mkdirSync(lockDir, { recursive: true })
    const lockPath = join(lockDir, 'vault-index.json.lock')
    writeFileSync(lockPath, '')
    const longAgo = new Date(Date.now() - 60_000)
    utimesSync(lockPath, longAgo, longAgo)

    const startedAt = Date.now()
    storeSecret(origin, 'agent-lock-b', { ...noop, handle: 'agent-lock-b' }, deps)
    const elapsedMs = Date.now() - startedAt
    assert.ok(elapsedMs < 3_000, `the stale lock was broken quickly (${elapsedMs}ms), not honored for the full wait budget`)

    const labels = listVaultLabels(origin, deps)
    assert.ok(labels.includes('agent-lock-a'), 'the entry from before the stale lock is still there')
    assert.ok(labels.includes('agent-lock-b'), 'the update behind the stale lock actually landed')

    deleteSecret(origin, 'agent-lock-a', deps)
    deleteSecret(origin, 'agent-lock-b', deps)
    assert.deepEqual(listVaultLabels(origin, deps), [])
  } finally {
    await rm(homeDir, { recursive: true, force: true })
  }
})

// --- listVaultLabels must mark staging by DATA, never by label text -------
// HANDLE_RE alone allows a real merchant to register a handle ending in
// "--pending-rotation"/"-recovery"/"-registration[-hex]" -- the exact suffix
// shapes pendingLabel mints for a staging copy (blocked going forward by
// RESERVED_HANDLE_SUBSTRING_RE in register(), but a handle already in the
// wild before that check existed must still work correctly). isPendingLabel
// (a label-text guess) would filter such a merchant's own live vault entry
// out of listVaultLabels, making it invisible to setup.mjs's duplicate-
// identity guard. storeSecret now records a `staging` marker (from the
// bundle's own `kind` field) in the non-secret vault index / alongside the
// file backend's bundle, and listVaultLabels prefers that marker over the
// suffix guess -- covered here on every backend this script supports.

const posixFileBackendForStagingTests = process.platform !== 'win32'

for (const backendPlatform of ['win32', 'darwin', 'linux']) {
  const skip = backendPlatform === 'linux' && !posixFileBackendForStagingTests
    ? 'temp-file backend depends on POSIX permission bits; run on Linux/macOS or in this repo\'s CI'
    : false

  test(`listVaultLabels (${backendPlatform}): a real merchant whose handle ends in --pending-rotation is still listed`, { skip }, async () => {
    const origin = 'https://example.invalid'
    const homeDir = await mkdtemp(join(tmpdir(), `identity-client-staging-${backendPlatform}-`))
    const deps = { platform: backendPlatform, homeDir, execFileSync: () => '' }
    const handle = 'agent--pending-rotation'
    try {
      storeSecret(origin, handle, {
        kind: 'merchant',
        handle,
        client_class: 'coding_persistent',
        merchant_key: `1f3ea_sk_${'a'.repeat(48)}`,
        origin,
      }, deps)

      assert.deepEqual(
        listVaultLabels(origin, deps),
        [handle],
        'a real merchant is never dropped just because its handle looks like a staging label',
      )
    } finally {
      deleteSecret(origin, handle, deps)
      await rm(homeDir, { recursive: true, force: true })
    }
  })

  test(`listVaultLabels (${backendPlatform}): a genuine staging entry is never listed`, { skip }, async () => {
    const origin = 'https://example.invalid'
    const homeDir = await mkdtemp(join(tmpdir(), `identity-client-staging-${backendPlatform}-`))
    const deps = { platform: backendPlatform, homeDir, execFileSync: () => '' }
    const stagingLabel = 'agent-under-stage--pending-registration-deadbeef'
    try {
      storeSecret(origin, stagingLabel, {
        kind: 'staging',
        handle: 'agent-under-stage',
        client_class: 'coding_persistent',
        merchant_key: `1f3ea_sk_${'b'.repeat(48)}`,
        origin,
      }, deps)

      assert.deepEqual(listVaultLabels(origin, deps), [])
    } finally {
      deleteSecret(origin, stagingLabel, deps)
      await rm(homeDir, { recursive: true, force: true })
    }
  })

  // A pre-marker leftover predates the `staging` marker entirely: an older
  // storeSecret always wrote `kind: 'merchant'` (staging or not) and never
  // recorded a `staging` field anywhere. Neither an entry this version never
  // indexed at all nor a legacy bare-string index entry (written before the
  // index carried `staging`) is trustworthy as a definite negative -- both
  // must fall back to isPendingLabel's suffix guess and stay excluded,
  // exactly as they were before this marker existed, rather than being
  // reclassified as a real second identity just because `kind !== 'staging'`.
  // This is the fixture the "leftover registration staging label" coverage
  // in test/identity-commands.test.mjs originally used before it was
  // aligned with the (also-covered) new `kind: 'staging'` marker.
  const label = 'agent-abandoned--pending-registration-deadbeef'
  const origin = 'https://example.invalid'

  test(
    `listVaultLabels (${backendPlatform}): a bundle discoverable with no index entry at all still falls back to the suffix guess`,
    // Meaningful only where a label can be discovered by something other
    // than the index itself: the file backend discovers labels by reading
    // the credentials directory, win32 additionally unions a real cmdkey
    // scrape, and darwin (since the dump-keychain union added earlier in
    // this same PR -- see listVaultLabels' own 'darwin' branch and the
    // "enumerates the Keychain itself via dump-keychain" test above) unions
    // a real `security dump-keychain` scrape the same way.
    { skip },
    async () => {
      const homeDir = await mkdtemp(join(tmpdir(), `identity-client-legacy-staging-${backendPlatform}-`))
      try {
        let deps
        if (backendPlatform === 'linux') {
          // The pre-marker bundle itself, written directly to the
          // deterministic path (never through the current storeSecret,
          // which would correctly index it) -- exactly the shape a
          // pre-index version left behind: discoverable via readdirSync,
          // indexed nowhere.
          const safeOrigin = origin.replace(/[^a-z0-9.-]/giu, '_')
          const safeLabel = label.replace(/[^a-z0-9._-]/giu, '_')
          mkdirSync(join(homeDir, '.1f3ea', 'credentials'), { recursive: true })
          writeFileSync(
            join(homeDir, '.1f3ea', 'credentials', `${safeOrigin}__${safeLabel}.json`),
            `${JSON.stringify({ kind: 'merchant', handle: 'agent-abandoned', origin })}\n`,
          )
          deps = { platform: backendPlatform, homeDir, execFileSync: () => '' }
        } else if (backendPlatform === 'darwin') {
          // darwin: discoverable only via the dump-keychain scrape, same
          // "svce"<blob>= shape as the "enumerates the Keychain itself"
          // test above (a real merchant found only that way must not be
          // dropped just because the index never recorded it).
          deps = {
            platform: backendPlatform,
            homeDir,
            execFileSync: (command, args) => {
              if (command === 'security' && args[0] === 'dump-keychain') {
                return `    "svce"<blob>="1f3ea:${origin}:${label}"`
              }
              throw new Error(`unexpected exec call: ${command} ${args.join(' ')}`)
            },
          }
        } else {
          // win32: discoverable only via the cmdkey scrape (a real merchant
          // found only that way must not be dropped just because the index
          // never recorded it).
          deps = {
            platform: backendPlatform,
            homeDir,
            execFileSync: () => `Target: 1f3ea:${origin}:${label}`,
          }
        }

        assert.deepEqual(
          listVaultLabels(origin, deps),
          [],
          'no index entry at all for this label must fall back to the suffix guess, not be trusted as a real merchant',
        )
      } finally {
        await rm(homeDir, { recursive: true, force: true })
      }
    },
  )

  test(
    `listVaultLabels (${backendPlatform}): a legacy bare-string index entry (staging unknown) still falls back to the suffix guess`,
    { skip },
    async () => {
      const homeDir = await mkdtemp(join(tmpdir(), `identity-client-legacy-staging-${backendPlatform}-`))
      try {
        if (backendPlatform === 'linux') {
          // The file backend also needs the bundle itself discoverable
          // (readdirSync-driven, same as above) -- the index entry alone
          // adds no labels there, only a staging hint for ones already found.
          const safeOrigin = origin.replace(/[^a-z0-9.-]/giu, '_')
          const safeLabel = label.replace(/[^a-z0-9._-]/giu, '_')
          mkdirSync(join(homeDir, '.1f3ea', 'credentials'), { recursive: true })
          writeFileSync(
            join(homeDir, '.1f3ea', 'credentials', `${safeOrigin}__${safeLabel}.json`),
            `${JSON.stringify({ kind: 'merchant', handle: 'agent-abandoned', origin })}\n`,
          )
        }
        mkdirSync(join(homeDir, '.1f3ea'), { recursive: true })
        writeFileSync(
          join(homeDir, '.1f3ea', 'vault-index.json'),
          `${JSON.stringify({ [origin]: [label] }, null, 2)}\n`,
        )
        const deps = { platform: backendPlatform, homeDir, execFileSync: () => '' }

        assert.deepEqual(
          listVaultLabels(origin, deps),
          [],
          'a legacy bare-string index entry (staging unknown) must also fall back to the suffix guess',
        )
      } finally {
        await rm(homeDir, { recursive: true, force: true })
      }
    },
  )

  // Round-3 review, LOW finding: the two tests above only assert the READ
  // half of the legacy-index fix (vaultIndexEntriesToMap/isStagingLabel).
  // Nothing pinned the other half -- updateVaultIndex's own
  // `meta.staging === undefined ? entryLabel : {...}` -- which is what
  // actually keeps a rewrite from silently upgrading a legacy bare-string
  // entry to `staging: false`, or touching a real, already-known boolean.
  // Revert that one line to the old unconditional object form and the two
  // tests above still pass; only this one catches it.
  test(
    `storeSecret (${backendPlatform}): a rewrite for an unrelated label preserves an existing legacy bare-string entry and a real staging boolean, never inventing one`,
    { skip },
    async () => {
      const homeDir = await mkdtemp(join(tmpdir(), `identity-client-index-preserve-${backendPlatform}-`))
      try {
        const seededOrigin = 'https://example.invalid'
        mkdirSync(join(homeDir, '.1f3ea'), { recursive: true })
        writeFileSync(
          join(homeDir, '.1f3ea', 'vault-index.json'),
          `${JSON.stringify({
            [seededOrigin]: [
              'legacy-bare-label',
              { label: 'obj-false-label', staging: false },
            ],
          }, null, 2)}\n`,
        )
        const deps = { platform: backendPlatform, homeDir, execFileSync: () => '' }

        // storeSecret for an UNRELATED label -- exercising the same
        // read-modify-write updateVaultIndex runs on every store/delete.
        storeSecret(seededOrigin, 'brand-new-label', {
          kind: 'merchant',
          handle: 'brand-new-label',
          client_class: 'coding_persistent',
          merchant_key: `1f3ea_sk_${'a'.repeat(48)}`,
          origin: seededOrigin,
        }, deps)

        const rewritten = JSON.parse(readFileSync(join(homeDir, '.1f3ea', 'vault-index.json'), 'utf8'))
        const entries = rewritten[seededOrigin]
        assert.ok(Array.isArray(entries), 'the origin still has an entries array')
        assert.ok(
          entries.includes('legacy-bare-label'),
          'the legacy bare-string entry is still a bare string, not silently upgraded to an object',
        )
        const objEntry = entries.find(entry => typeof entry === 'object' && entry?.label === 'obj-false-label')
        assert.ok(objEntry, 'the object-form entry is still present')
        assert.equal(objEntry.staging, false, 'its real staging:false boolean was preserved exactly, not flipped or dropped')
        const newEntry = entries.find(entry => typeof entry === 'object' && entry?.label === 'brand-new-label')
        assert.ok(newEntry, 'the newly-stored label was added to the index')
        assert.equal(newEntry.staging, false, 'the new entry itself correctly records a real (non-staging) boolean')
      } finally {
        await rm(homeDir, { recursive: true, force: true })
      }
    },
  )
}

// --- Round-3 review, MEDIUM finding: darwin Keychain enumeration ----------
// listVaultLabels on darwin trusted the HOME-resident vault-index.json
// alone, so setup.mjs's duplicate-identity guard failed open in exactly the
// "state file gone, vault intact" scenario the guard exists to catch. Fixed
// by having listVaultLabels enumerate the Keychain itself via
// `security dump-keychain` (metadata only, never `-d`), unioned with the
// index -- the same way the win32 branch already unions a `cmdkey /list`
// scrape. This darwin backend cannot actually run on this (non-macOS) CI
// runner, so the parser below is pinned against a captured, documented
// sample of real `security dump-keychain` output rather than a live binary.

const SAMPLE_DUMP_KEYCHAIN_OUTPUT = [
  'keychain: "/Users/agent/Library/Keychains/login.keychain-db"',
  'version: 512',
  'class: "genp"',
  'attributes:',
  '    0x00000007 <blob>="1f3ea:https://1f3ea.com:alice"',
  '    0x00000008 <blob>=<NULL>',
  '    "acct"<blob>="alice"',
  '    "crtr"<uint32>=<NULL>',
  '    "cusi"<sint32>=<NULL>',
  '    "desc"<blob>=<NULL>',
  '    "gena"<blob>=<NULL>',
  '    "icmt"<blob>=<NULL>',
  '    "invi"<sint32>=<NULL>',
  '    "pdmn"<blob>="ak"',
  '    "prot"<blob>=<NULL>',
  '    "scrp"<sint32>=<NULL>',
  '    "svce"<blob>="1f3ea:https://1f3ea.com:alice"',
  '    "sync"<sint32>=0x00000000 ',
  '    "tomb"<sint32>=0x00000000 ',
  '    "type"<uint32>=<NULL>',
  '',
  'keychain: "/Users/agent/Library/Keychains/login.keychain-db"',
  'version: 512',
  'class: "genp"',
  'attributes:',
  '    0x00000007 <blob>="AIM"',
  '    0x00000008 <blob>=<NULL>',
  '    "acct"<blob>="unrelated-app-account"',
  '    "svce"<blob>="AIM"',
  '    "sync"<sint32>=0x00000000 ',
  '    "tomb"<sint32>=0x00000000 ',
  '    "type"<uint32>=<NULL>',
  '',
  'keychain: "/Users/agent/Library/Keychains/login.keychain-db"',
  'version: 512',
  'class: "genp"',
  'attributes:',
  '    0x00000007 <blob>="1f3ea:https://1f3ea.com:bob--pending-rotation"',
  '    "acct"<blob>="bob--pending-rotation"',
  '    "svce"<blob>="1f3ea:https://1f3ea.com:bob--pending-rotation"',
  '    "sync"<sint32>=0x00000000 ',
  '    "tomb"<sint32>=0x00000000 ',
  '    "type"<uint32>=<NULL>',
  '',
  'keychain: "/Users/agent/Library/Keychains/login.keychain-db"',
  'version: 512',
  'class: "genp"',
  'attributes:',
  '    "acct"<blob>="no-service-name"',
  '    "svce"<blob>=<NULL>',
  '    "sync"<sint32>=0x00000000 ',
  '    "tomb"<sint32>=0x00000000 ',
  '    "type"<uint32>=<NULL>',
  '',
  'keychain: "/Users/agent/Library/Keychains/login.keychain-db"',
  'version: 512',
  'class: "genp"',
  'attributes:',
  '    "acct"<blob>="escaped-quote-account"',
  String.raw`    "svce"<blob>="1f3ea:https://1f3ea.com:has\"quote"`,
  '    "sync"<sint32>=0x00000000 ',
  '    "tomb"<sint32>=0x00000000 ',
  '    "type"<uint32>=<NULL>',
  '',
  'keychain: "/Users/agent/Library/Keychains/login.keychain-db"',
  'version: 512',
  'class: "genp"',
  'attributes:',
  '    "acct"<blob>="utf8-account"',
  // Round-6 review, LOW finding: `security` escapes a multi-byte UTF-8
  // character per BYTE, not per character -- "café" (the last character is
  // U+00E9, UTF-8 bytes 0xC3 0xA9) prints its final byte pair as TWO octal
  // escapes, \303 (0xC3) and \251 (0xA9), never one. Decoding each escape
  // independently with String.fromCharCode (a UTF-16 code unit) would yield
  // "cafÃ©" (U+00C3, U+00A9) instead of the real "café".
  String.raw`    "svce"<blob>="1f3ea:https://1f3ea.com:caf\303\251"`,
  '    "sync"<sint32>=0x00000000 ',
  '    "tomb"<sint32>=0x00000000 ',
  '    "type"<uint32>=<NULL>',
  '',
  'keychain: "/Users/agent/Library/Keychains/login.keychain-db"',
  'version: 512',
  'class: "genp"',
  'attributes:',
  '    "acct"<blob>="hexform-account"',
  // Round-6 review, LOW finding: for a value needing escaping, `security`
  // ALSO prints a `0x<HEX>` rendering ahead of the same escaped-quoted
  // string on the same line -- `"svce"<blob>=0x<hex>  "escaped"` -- which
  // the old `^"..."` -only match required `=\"` immediately and so simply
  // never matched, silently dropping the entry from the enumeration. The
  // hex below is the real UTF-8 bytes of "1f3ea:https://1f3ea.com:hexform".
  '    "svce"<blob>=0x31663365613a68747470733a2f2f31663365612e636f6d3a686578666f726d  "1f3ea:https://1f3ea.com:hexform"',
  '    "sync"<sint32>=0x00000000 ',
  '    "tomb"<sint32>=0x00000000 ',
  '    "type"<uint32>=<NULL>',
  '',
].join('\n')

test('parseKeychainServiceNames: reads every "svce" attribute from a captured real dump-keychain sample, skips <NULL>, unescapes a backslash-quote correctly, decodes a multi-byte UTF-8 octal escape as bytes (not UTF-16 code units), and reads the `0x<hex> "..."` form', () => {
  const services = parseKeychainServiceNames(SAMPLE_DUMP_KEYCHAIN_OUTPUT)
  assert.deepEqual(services, [
    '1f3ea:https://1f3ea.com:alice',
    'AIM',
    '1f3ea:https://1f3ea.com:bob--pending-rotation',
    '1f3ea:https://1f3ea.com:has"quote',
    '1f3ea:https://1f3ea.com:café',
    '1f3ea:https://1f3ea.com:hexform',
  ])
})

test('unescapeSecurityDumpString: decodes a per-byte octal-escaped multi-byte UTF-8 character correctly, not as UTF-16 code units', () => {
  assert.equal(unescapeSecurityDumpString(String.raw`caf\303\251`), 'café')
  // A three-byte character too: "€" is U+20AC, UTF-8 E2 82 AC.
  assert.equal(unescapeSecurityDumpString(String.raw`\342\202\254`), '€')
})

test('unescapeSecurityDumpString: still handles a plain ASCII value, an embedded escaped quote, and an escaped backslash', () => {
  assert.equal(unescapeSecurityDumpString('plain-ascii'), 'plain-ascii')
  assert.equal(unescapeSecurityDumpString(String.raw`has\"quote`), 'has"quote')
  assert.equal(unescapeSecurityDumpString(String.raw`back\\slash`), 'back\\slash')
})

test('parseKeychainServiceNames: empty or unrelated output yields no services', () => {
  assert.deepEqual(parseKeychainServiceNames(''), [])
  assert.deepEqual(parseKeychainServiceNames('keychain: "/x"\nversion: 512\n'), [])
})

test(
  'listVaultLabels (darwin): enumerates the Keychain itself via dump-keychain, unioned with the index -- ' +
  'so a lost/reset HOME (index gone, Keychain intact) still surfaces the real entry',
  async () => {
    const origin = 'https://1f3ea.com'
    const homeDir = await mkdtemp(join(tmpdir(), 'identity-client-darwin-keychain-'))
    try {
      const dumpOutput = [
        '    "svce"<blob>="1f3ea:https://1f3ea.com:real-merchant"',
        '    "svce"<blob>="1f3ea:https://1f3ea.com:real-merchant--pending-rotation"',
        '    "svce"<blob>="1f3ea:https://other-origin.invalid:not-this-origin"',
      ].join('\n')
      const deps = {
        platform: 'darwin',
        homeDir, // deliberately empty -- no vault-index.json at all, simulating "state lost"
        execFileSync: (command, args) => {
          if (command === 'security' && args[0] === 'dump-keychain') return dumpOutput
          throw new Error(`unexpected exec call: ${command} ${args.join(' ')}`)
        },
      }

      assert.deepEqual(
        listVaultLabels(origin, deps),
        ['real-merchant'],
        'the real Keychain entry is found even with no index at all, and its own staging sibling is excluded ' +
        'by the suffix guess (no index entry to say otherwise)',
      )
    } finally {
      await rm(homeDir, { recursive: true, force: true })
    }
  },
)

test('listVaultLabels (darwin): a failed dump-keychain call falls back to the index alone, same as the win32 cmdkey fallback', async () => {
  const origin = 'https://1f3ea.com'
  const homeDir = await mkdtemp(join(tmpdir(), 'identity-client-darwin-keychain-fail-'))
  try {
    mkdirSync(join(homeDir, '.1f3ea'), { recursive: true })
    writeFileSync(
      join(homeDir, '.1f3ea', 'vault-index.json'),
      `${JSON.stringify({ [origin]: [{ label: 'indexed-merchant', staging: false }] }, null, 2)}\n`,
    )
    const deps = {
      platform: 'darwin',
      homeDir,
      execFileSync: () => { throw new Error('security not found') },
    }

    assert.deepEqual(listVaultLabels(origin, deps), ['indexed-merchant'])
  } finally {
    await rm(homeDir, { recursive: true, force: true })
  }
})

// --- Round-6 review, MEDIUM finding: an ENOBUFS/ETIMEDOUT dump-keychain ---
// call is an INCOMPLETE enumeration, not an empty one -- a bare catch could
// not tell that apart from "no `security` binary on PATH" (ENOENT), so a
// large login Keychain (a few thousand Safari/wifi/certificate/app-token
// items, easily past Node's 1 MiB execFileSync default) silently answered
// "found nothing" and let setup.mjs's duplicate-identity guard fail open.
// Fixed by passing an explicit maxBuffer/timeout and marking the result
// `incomplete` (a non-enumerable property, invisible to the plain-array
// assertions above) whenever the dump throws ENOBUFS or ETIMEDOUT, so
// setup.mjs's guard can refuse instead of reading an empty result as safe.

test('listVaultLabels (darwin): an ENOBUFS from a truncated dump-keychain call is marked incomplete, not read as empty', async () => {
  const origin = 'https://1f3ea.com'
  const homeDir = await mkdtemp(join(tmpdir(), 'identity-client-darwin-keychain-enobufs-'))
  try {
    // No vault-index.json at all -- exactly "state lost, vault intact":
    // the scenario the whole union exists to protect.
    const deps = {
      platform: 'darwin',
      homeDir,
      execFileSync: () => {
        const error = new Error('spawnSync security ENOBUFS')
        error.code = 'ENOBUFS'
        throw error
      },
    }

    const labels = listVaultLabels(origin, deps)
    assert.deepEqual(labels, [], 'nothing was actually enumerated, so the label list itself stays empty')
    assert.equal(labels.incomplete, true, 'the truncated dump must be surfaced as incomplete, not "found nothing"')
  } finally {
    await rm(homeDir, { recursive: true, force: true })
  }
})

test('listVaultLabels (darwin): an ETIMEDOUT from dump-keychain is marked incomplete the same way as ENOBUFS', async () => {
  const origin = 'https://1f3ea.com'
  const homeDir = await mkdtemp(join(tmpdir(), 'identity-client-darwin-keychain-etimedout-'))
  try {
    const deps = {
      platform: 'darwin',
      homeDir,
      execFileSync: () => {
        const error = new Error('spawnSync security ETIMEDOUT')
        error.code = 'ETIMEDOUT'
        throw error
      },
    }

    const labels = listVaultLabels(origin, deps)
    assert.equal(labels.incomplete, true)
  } finally {
    await rm(homeDir, { recursive: true, force: true })
  }
})

test('listVaultLabels (darwin): a missing `security` binary (ENOENT) is NOT marked incomplete -- that really is "nothing found"', async () => {
  const origin = 'https://1f3ea.com'
  const homeDir = await mkdtemp(join(tmpdir(), 'identity-client-darwin-keychain-enoent-'))
  try {
    const deps = {
      platform: 'darwin',
      homeDir,
      execFileSync: () => {
        const error = new Error('spawnSync security ENOENT')
        error.code = 'ENOENT'
        throw error
      },
    }

    const labels = listVaultLabels(origin, deps)
    assert.deepEqual(labels, [])
    assert.equal(labels.incomplete, undefined, 'a genuinely missing binary must not trip the incomplete signal')
  } finally {
    await rm(homeDir, { recursive: true, force: true })
  }
})

test('listVaultLabels (darwin): passes an explicit maxBuffer and timeout to execFileSync so a normal-sized Keychain dump never hits the 1 MiB default', async () => {
  const origin = 'https://1f3ea.com'
  const homeDir = await mkdtemp(join(tmpdir(), 'identity-client-darwin-keychain-opts-'))
  try {
    let seenOptions = null
    const deps = {
      platform: 'darwin',
      homeDir,
      execFileSync: (command, args, options) => {
        if (command === 'security' && args[0] === 'dump-keychain') {
          seenOptions = options
          return ''
        }
        throw new Error(`unexpected exec call: ${command} ${args.join(' ')}`)
      },
    }

    listVaultLabels(origin, deps)
    assert.ok(seenOptions, 'dump-keychain must actually be invoked')
    assert.equal(seenOptions.maxBuffer, 64 * 1024 * 1024)
    assert.ok(Number.isFinite(seenOptions.timeout) && seenOptions.timeout > 0, 'a timeout must be set')
  } finally {
    await rm(homeDir, { recursive: true, force: true })
  }
})

// --- Round-3 review, MEDIUM finding: --model validation mirrors the -------
// market's own identityModelValue (trim, <=120 code points, no control or
// directional-override marks).

test('isValidModel: accepts an empty string, a normal label, and exactly 120 characters after trimming', () => {
  assert.equal(isValidModel(''), true)
  assert.equal(isValidModel('  claude-opus  '), true)
  assert.equal(isValidModel('x'.repeat(120)), true)
})

test('isValidModel: refuses more than 120 characters after trimming, and any control or directional-override mark', () => {
  assert.equal(isValidModel('x'.repeat(121)), false)
  assert.equal(isValidModel(`  ${'x'.repeat(121)}  `), false, 'trims before counting, but 121 real characters still refuses')
  assert.equal(isValidModel('claude\u0000opus'), false, 'a NUL control character is refused')
  assert.equal(isValidModel('claude‎opus'), false, 'a left-to-right mark (directional override) is refused')
})
