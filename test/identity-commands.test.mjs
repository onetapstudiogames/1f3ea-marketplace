// Behavioral coverage for setup.mjs / connect.mjs / key.mjs beyond the
// file-exists / frontmatter checks in commands.test.mjs — driving them as
// real subprocesses against a stub market server (test/helpers/stub-market-server.mjs)
// and a throwaway per-test HOME/USERPROFILE, so the actual vault backend for
// this platform is exercised end to end: register, rotate, recover, adopt,
// and the honest two-pass human-approval gate.

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { deleteSecret, readSecret, storeSecret } from '../scripts/identity-client.mjs'
import { startStubMarketServer } from './helpers/stub-market-server.mjs'
import { makeTempHome, runNode } from './helpers/run-identity-cli.mjs'

/** Extracts the token setup.mjs's refusal prints for the required second pass. */
function extractApprovalToken(stderr) {
  return /--human-approved ([0-9a-f]{32})/u.exec(stderr)?.[1] ?? null
}

const setupPath = fileURLToPath(new URL('../scripts/setup.mjs', import.meta.url))
const connectPath = fileURLToPath(new URL('../scripts/connect.mjs', import.meta.url))
const keyPath = fileURLToPath(new URL('../scripts/key.mjs', import.meta.url))
const identityClientPath = fileURLToPath(new URL('../scripts/identity-client.mjs', import.meta.url))

const NO_SECRET_LITERAL = /1f3ea_(?:sk|rc)_[0-9a-f]+/u

// runNode sets AGENT_1F3EA_STUB_ONLY=1 by default (see run-identity-cli.mjs)
// so a test driving these scripts can never reach the real market. The
// handful of tests below that deliberately drive a script against
// https://example.invalid instead of a real stub server -- to exercise flag
// parsing, printed output shape, or refusal wording unrelated to the origin
// guard itself -- override it back to '0' with this constant. That origin
// is reserved by RFC 2606 and can never resolve to anything, real market
// included, so the stricter guard is not needed there and would only mask
// the behavior actually under test.
const NOT_A_REAL_ORIGIN_ENV = { AGENT_1F3EA_STUB_ONLY: '0' }

function assertNoSecretLeaked(result, label) {
  assert.doesNotMatch(result.stdout ?? '', NO_SECRET_LITERAL, `${label}: stdout never carries a raw secret`)
  assert.doesNotMatch(result.stderr ?? '', NO_SECRET_LITERAL, `${label}: stderr never carries a raw secret`)
}

/**
 * Enumerates every RAW label this platform's vault backend currently holds
 * for `origin` under `homeDir` -- unlike identity-client.mjs's own exported
 * listVaultLabels, this never filters out staging entries. A test that wants
 * to assert "no staging copy was left behind, whatever it would have been
 * named" must not check that through listVaultLabels: that function's whole
 * job is to hide staging labels, so it would report an empty result whether
 * or not one actually leaked, making such an assertion vacuous regardless of
 * label format. This reads the same on-disk/index shapes storeSecret and
 * deleteSecret in identity-client.mjs maintain (vault-index.json on win32/
 * darwin, the credentials directory listing everywhere else).
 */
function listRawVaultLabels(origin, homeDir) {
  if (process.platform === 'win32' || process.platform === 'darwin') {
    let parsed
    try {
      parsed = JSON.parse(readFileSync(join(homeDir, '.1f3ea', 'vault-index.json'), 'utf8'))
    } catch {
      return []
    }
    const entries = Array.isArray(parsed?.[origin]) ? parsed[origin] : []
    return entries
      .map(entry => (typeof entry === 'string' ? entry : entry?.label))
      .filter(label => typeof label === 'string')
  }
  const safeOrigin = origin.replace(/[^a-z0-9.-]/giu, '_')
  const dir = join(homeDir, '.1f3ea', 'credentials')
  const prefix = `${safeOrigin}__`
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return []
  }
  return entries
    .filter(name => name.startsWith(prefix) && name.endsWith('.json'))
    .map(name => name.slice(prefix.length, -'.json'.length))
}

// --- register() vault safety: never silently overwrite an existing entry -

test('register refuses to overwrite an existing vault entry under the confirmed handle, and cleans up the staging copy', async () => {
  const stub = await startStubMarketServer()
  const home = makeTempHome('register-collision-')
  try {
    storeSecret(stub.origin, 'agent-collide', {
      kind: 'merchant', handle: 'agent-collide', client_class: 'coding_persistent',
      merchant_key: `1f3ea_sk_${'z'.repeat(48)}`, recovery_codes: [], origin: stub.origin,
    }, { homeDir: home.dir })

    const result = await runNode(identityClientPath, [
      'register', '--origin', stub.origin, '--handle', 'agent-collide',
      '--client-class', 'coding_persistent', '--human-approved',
    ], { env: home.env })
    assert.notEqual(result.status, 0, 'refuses over an existing vault entry')
    assert.match(result.stderr, /refusing to register over the vault entry/u)
    assert.match(result.stderr, /--replace-vault-entry/u)
    assert.equal(stub.merchants.size, 0, 'the market never confirmed a duplicate merchant')
    assertNoSecretLeaked(result, 'register vault collision')

    const stillThere = readSecret(stub.origin, 'agent-collide', { homeDir: home.dir })
    assert.equal(stillThere.value.merchant_key, `1f3ea_sk_${'z'.repeat(48)}`, 'the original entry is untouched')

    // register()'s pre-flight collision check throws BEFORE the staging
    // label is even computed, so no staging entry is ever written on this
    // path -- and since pendingLabel mints a random hex suffix for every
    // registration attempt, checking one fixed bare label (as this used to)
    // would never actually detect a leak. Enumerate the RAW vault contents
    // (never filtered through listVaultLabels, which hides staging entries
    // by design) instead, so this keeps meaning something if a future
    // change ever did leave a suffixed staging copy orphaned here.
    const rawLabels = listRawVaultLabels(stub.origin, home.dir)
    const stagingLabelPattern = /^agent-collide--pending-registration(-[0-9a-f]+)?$/u
    assert.ok(
      rawLabels.every(label => !stagingLabelPattern.test(label)),
      `no staging copy (bare or suffixed) was left behind for this collision path; found: ${JSON.stringify(rawLabels)}`,
    )
  } finally {
    deleteSecret(stub.origin, 'agent-collide', { homeDir: home.dir })
    deleteSecret(stub.origin, 'agent-collide--pending-registration', { homeDir: home.dir })
    home.cleanup()
    await stub.close()
  }
})

test('register --replace-vault-entry deliberately overwrites an existing entry', async () => {
  const stub = await startStubMarketServer()
  const home = makeTempHome('register-replace-')
  try {
    storeSecret(stub.origin, 'agent-replace', {
      kind: 'merchant', handle: 'agent-replace', client_class: 'coding_persistent',
      merchant_key: `1f3ea_sk_${'y'.repeat(48)}`, recovery_codes: [], origin: stub.origin,
    }, { homeDir: home.dir })

    const result = await runNode(identityClientPath, [
      'register', '--origin', stub.origin, '--handle', 'agent-replace',
      '--client-class', 'coding_persistent', '--human-approved', '--replace-vault-entry',
    ], { env: home.env })
    assert.equal(result.status, 0, result.stderr)
    const now = readSecret(stub.origin, 'agent-replace', { homeDir: home.dir })
    assert.notEqual(now.value.merchant_key, `1f3ea_sk_${'y'.repeat(48)}`, 'the old key was deliberately replaced')
    assertNoSecretLeaked(result, 'register --replace-vault-entry')
  } finally {
    deleteSecret(stub.origin, 'agent-replace', { homeDir: home.dir })
    home.cleanup()
    await stub.close()
  }
})

// --- register()'s per-run staging label: two concurrent runs for the SAME
// handle must never share one staging label, or the winner's own cleanup
// would delete whatever the loser had just staged there (review finding
// "two concurrent register runs share one staging label").

test('two concurrent register runs for the same handle: the winner promotes, the loser refuses and cleans up after itself', { timeout: 20_000 }, async () => {
  // registerConfirmBarrier forces the two real subprocesses' confirm calls
  // to genuinely overlap at the server -- see the stub's own doc comment.
  // confirm is the FIRST network call register() makes AFTER its own local
  // pre-flight vault check, so a confirm reaching the barrier already
  // proves both processes independently staged and pre-flight-checked
  // without either seeing the other's work; without this, a loaded runner
  // could let one subprocess finish its entire run before the other even
  // got its stage() response back, making this test flaky about which
  // codepath it actually exercises rather than about the property it means
  // to verify (reproduced from a real CI failure, not theorized).
  const stub = await startStubMarketServer({
    registerConfirmBarrier: { handle: 'race-probe-handle', count: 2 },
  })
  const home = makeTempHome('register-race-')
  try {
    const args = [
      'register', '--origin', stub.origin, '--handle', 'race-probe-handle',
      '--client-class', 'coding_persistent', '--human-approved',
    ]
    // Two real, concurrent subprocesses racing the same requested handle
    // against the same stub server and the same shared vault home -- the
    // actual shape of the finding, not a mocked stand-in for it. The
    // barrier above is what makes the overlap deterministic; these are
    // still real, separate `node` processes actually racing each other
    // through the client's real vault-locking code once it releases them.
    const [first, second] = await Promise.all([
      runNode(identityClientPath, args, { env: home.env }),
      runNode(identityClientPath, args, { env: home.env }),
    ])

    const winner = first.status === 0 ? first : second
    const loser = first.status === 0 ? second : first
    assert.equal(winner.status, 0, `exactly one run must succeed (stderr: ${first.stderr}\n---\n${second.stderr})`)
    assert.notEqual(loser.status, 0, 'the other run must refuse rather than silently overwrite')

    // The market's own confirm enforces handle uniqueness atomically for two
    // concurrent stages of the same not-yet-confirmed handle (see the
    // stub's own comment: handle_taken is checked against CONFIRMED
    // merchants only, at both stage and confirm time), so with the barrier
    // above forcing genuine overlap, the loser's own confirm is the one the
    // market refuses -- and register()'s own catch on a failed confirm
    // deletes ITS OWN staging copy before rethrowing (identity-client.mjs
    // register()), so no staging copy should survive this path either. A
    // third shape -- "could not acquire the per-handle vault lock" -- is a
    // real, separately-reproduced refusal from promoteReplacementKey's own
    // file lock (review finding 13) and is accepted here too; only in that
    // branch does a staging copy legitimately survive (the loser's own,
    // untouched by the winner).
    const lockTimeout = /could not acquire the per-handle vault lock/u.test(loser.stderr)
    assert.match(
      loser.stderr,
      /already taken|handle_taken|could not acquire the per-handle vault lock/u,
      'names a legitimate refusal, not an unrelated failure',
    )

    const rawLabels = listRawVaultLabels(stub.origin, home.dir)
    const stagingLabelPattern = /^race-probe-handle--pending-registration-[0-9a-f]+$/u
    if (lockTimeout) {
      const survivors = rawLabels.filter(label => stagingLabelPattern.test(label))
      assert.equal(survivors.length, 1, "exactly the loser's own untouched staging copy survives this refusal shape")
      const staging = readSecret(stub.origin, survivors[0], { homeDir: home.dir })
      assert.equal(staging.value.handle, 'race-probe-handle')
      assert.ok(staging.value.merchant_key, 'the confirmed replacement key is actually recoverable from the named label')
      deleteSecret(stub.origin, survivors[0], { homeDir: home.dir })
    } else {
      assert.match(loser.stderr, /already taken|handle_taken/u, "names the market's own duplicate-handle refusal")
      assert.ok(
        rawLabels.every(label => !stagingLabelPattern.test(label)),
        `a confirm-time refusal cleans up its own staging copy -- none should survive; found: ${JSON.stringify(rawLabels)}`,
      )
    }

    assert.equal(stub.merchants.size, 1, 'exactly one merchant was registered by the race, regardless of which refusal fired')
    assertNoSecretLeaked(winner, 'register race winner')
    assertNoSecretLeaked(loser, 'register race loser')
  } finally {
    deleteSecret(stub.origin, 'race-probe-handle', { homeDir: home.dir })
    home.cleanup()
    await stub.close()
  }
})

test('register refuses a handle that does not match the market\'s handle rule, before any network call', async () => {
  const result = await runNode(identityClientPath, [
    'register', '--origin', 'https://example.invalid', '--allow-origin', 'https://example.invalid',
    '--handle', 'AB', '--client-class', 'coding_persistent', '--human-approved',
  ], { env: NOT_A_REAL_ORIGIN_ENV })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /does not match the market's handle rule/u)
})

// --- The "--pending-" namespace is reserved: HANDLE_RE alone would accept -
// a handle like "agent--pending-rotation" (23 chars, lowercase letters and
// hyphens), which would then read to isPendingLabel's suffix guess as an
// abandoned staging entry rather than a real merchant. register() must
// refuse it outright, before any network call, rather than let a real
// merchant register under a handle its own vault machinery cannot
// distinguish from staging.

test('register refuses a handle containing the reserved "--pending-" sequence, before any network call', async () => {
  const result = await runNode(identityClientPath, [
    'register', '--origin', 'https://example.invalid', '--allow-origin', 'https://example.invalid',
    '--handle', 'agent--pending-rotation', '--client-class', 'coding_persistent', '--human-approved',
  ], { env: NOT_A_REAL_ORIGIN_ENV })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /reserves.*--pending-|--pending-.*reserves/u)
})

test('setup.mjs refuses a handle that does not match the market\'s handle rule before ever asking for approval', async () => {
  const result = await runNode(setupPath, [
    '--origin', 'https://example.invalid', '--allow-origin', 'https://example.invalid',
    '--handle', 'AB', '--client-class', 'coding_persistent',
  ], { env: NOT_A_REAL_ORIGIN_ENV })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /does not match the market's handle rule/u)
  assert.doesNotMatch(result.stderr, /put this exact question to the human/u, 'never reaches the approval gate')
})

// --- The `--flag=value` equals form works identically to the space form ---

test('setup.mjs accepts --human-approved=<token> in equals form, not just the space form', async () => {
  const stub = await startStubMarketServer()
  const home = makeTempHome('setup-equals-token-')
  try {
    const firstPass = await runNode(
      setupPath,
      ['--origin', stub.origin, '--handle', 'agent-equals', '--client-class', 'coding_persistent'],
      { env: home.env, stdio: ['pipe', 'pipe', 'pipe'] },
    )
    const token = extractApprovalToken(firstPass.stderr)
    assert.ok(token, 'the first pass prints a token')

    // The equals form, exactly as a caller who read the printed command
    // literally would paste it -- this used to be silently swallowed by
    // parseArgs (flags['human-approved=<token>'] instead of
    // flags['human-approved']), reaching the mint-a-new-nonce branch instead
    // of ever comparing the supplied token.
    const secondPass = await runNode(
      setupPath,
      ['--origin', stub.origin, '--handle', 'agent-equals', '--client-class', 'coding_persistent', `--human-approved=${token}`],
      { env: home.env },
    )
    assert.equal(secondPass.status, 0, secondPass.stderr)
    assert.equal(stub.merchants.size, 1, 'the equals-form token actually registered')
    assertNoSecretLeaked(secondPass, 'setup.mjs equals-form token')
  } finally {
    deleteSecret(stub.origin, 'agent-equals', { homeDir: home.dir })
    home.cleanup()
    await stub.close()
  }
})

test('connect.mjs and key.mjs accept --handle=<value> in equals form, not just the space form', async () => {
  const connectResult = await runNode(connectPath, ['--origin=https://example.invalid', '--allow-origin=https://example.invalid', '--handle=agent-equals-connect'], { env: NOT_A_REAL_ORIGIN_ENV })
  assert.match(connectResult.stdout, /agent-equals-connect/u, 'connect.mjs actually used the equals-form --handle, not a fallback')

  const keyResult = await runNode(keyPath, ['status', '--origin=https://example.invalid', '--allow-origin=https://example.invalid', '--handle=agent-equals-key'], { env: NOT_A_REAL_ORIGIN_ENV })
  assert.match(keyResult.stderr, /agent-equals-key/u, 'key.mjs actually used the equals-form --handle, not a fallback')
})

// --- Findings 1-4: the printed MCP connector commands are correct ---------

test('connect.mjs prints a single-quoted, unexpanded Claude Code header targeting /mcp on one line (PowerShell-safe), under a distinct server name, and the real Codex flag', async () => {
  const result = await runNode(connectPath, ['--origin', 'https://example.invalid', '--allow-origin', 'https://example.invalid', '--handle', 'nobody'], { env: NOT_A_REAL_ORIGIN_ENV })
  const out = result.stdout
  const claudeLine = out.split(/\r?\n/u).find(line => line.trimStart().startsWith('claude mcp add'))
  assert.ok(claudeLine, 'the Claude Code command line is present')
  assert.match(
    claudeLine,
    /^\s*claude mcp add --transport http 1f3ea-key https:\/\/example\.invalid\/mcp --header 'Authorization: Bearer \$\{AGENT_1F3EA_SECRET\}'\s*$/u,
    'the whole command fits on one line -- a POSIX `\\` continuation is a hard parse error in PowerShell',
  )
  assert.doesNotMatch(claudeLine, /\\\s*$/u, 'the line never ends with a line-continuation backslash')
  assert.doesNotMatch(out, /\/mcp\/connect/u, 'the bearer-header (Claude Code) line never names /mcp/connect')
  assert.doesNotMatch(out, /--header "Authorization: Bearer \$\{/u, 'header is never double-quoted (that is what let the shell expand it)')
  assert.match(out, /codex mcp add 1f3ea-key --url https:\/\/example\.invalid\/mcp --bearer-token-env-var AGENT_1F3EA_SECRET/u)
  assert.doesNotMatch(out, /--bearer_token_env_var/u, 'never the underscored flag spelling the real Codex CLI rejects')
  // The bundled .mcp.json server is separately named "1f3ea" (hosted-chat
  // browser sign-in) -- the printed commands above must never collide with
  // it under the same server name.
  assert.match(out, /bundles?[\s\S]{0,80}`?1f3ea`?/iu, 'names the distinction from the bundled `1f3ea` connector')
  assertNoSecretLeaked(result, 'connect.mjs')
})

test('connect.mjs refuses a disallowed http origin before printing any MCP command, and exits non-zero (finding 2)', async () => {
  const result = await runNode(connectPath, ['--origin', 'http://attacker.example', '--handle', 'victim-agent'])
  assert.notEqual(result.status, 0)
  assert.doesNotMatch(result.stdout, /mcp add/u, 'no connector command line was ever printed')
  assert.match(result.stderr, /only https is allowed/iu)
  assertNoSecretLeaked(result, 'connect.mjs disallowed origin')
})

test('setup.mjs prints the same corrected MCP connector command shape, on one line, in its own connect step', async () => {
  // Reached via the "no existing identity, no handle/client-class given"
  // refusal path, which still prints nothing about the connector — so drive
  // this through the repair branch instead by seeding setup-state directly,
  // which is enough to reach printConnectStep() without any network call.
  const home = makeTempHome('setup-print-')
  try {
    const stateDir = `${home.dir}/.1f3ea`
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(
      `${stateDir}/setup-state.json`,
      JSON.stringify({ 'https://example.invalid': { handle: 'nobody', client_class: 'coding_persistent' } }),
    )
    const result = await runNode(setupPath, ['--origin', 'https://example.invalid', '--allow-origin', 'https://example.invalid'], { env: { ...home.env, ...NOT_A_REAL_ORIGIN_ENV } })
    const out = result.stdout
    const claudeLine = out.split(/\r?\n/u).find(line => line.trimStart().startsWith('claude mcp add'))
    assert.ok(claudeLine, 'the Claude Code command line is present')
    assert.match(
      claudeLine,
      /^\s*claude mcp add --transport http 1f3ea-key https:\/\/example\.invalid\/mcp --header 'Authorization: Bearer \$\{AGENT_1F3EA_SECRET\}'\s*$/u,
    )
    assert.doesNotMatch(claudeLine, /\\\s*$/u, 'the line never ends with a line-continuation backslash')
    assert.match(out, /codex mcp add 1f3ea-key --url https:\/\/example\.invalid\/mcp --bearer-token-env-var AGENT_1F3EA_SECRET/u)
    assert.doesNotMatch(out, /--bearer_token_env_var/u)
    assertNoSecretLeaked(result, 'setup.mjs (repair branch)')
  } finally {
    home.cleanup()
  }
})

test('setup.mjs refuses a disallowed http origin before printing anything at all, and exits non-zero (finding 2)', async () => {
  const result = await runNode(setupPath, ['--origin', 'http://attacker.example', '--handle', 'victim-agent', '--client-class', 'coding_persistent'])
  assert.notEqual(result.status, 0)
  assert.equal(result.stdout.trim(), '', 'nothing at all was printed to stdout')
  assert.match(result.stderr, /only https is allowed/iu)
  assertNoSecretLeaked(result, 'setup.mjs disallowed origin')
})

test('key.mjs refuses a disallowed http origin before running any command, and exits non-zero (finding 2)', async () => {
  const result = await runNode(keyPath, ['status', '--origin', 'http://attacker.example', '--handle', 'victim-agent'])
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /only https is allowed/iu)
  assertNoSecretLeaked(result, 'key.mjs disallowed origin')
})

// --- End-to-end against a stub market server ---------------------------------

test('setup.mjs: human approval needs two real passes -- a bare or fabricated --human-approved cannot self-approve in one call, only a token minted by a genuine first pass can', async () => {
  const stub = await startStubMarketServer()
  const home = makeTempHome('setup-approve-')
  try {
    // A bare --human-approved (no token at all) is exactly what the SKILL
    // used to instruct in one shot -- it must still refuse.
    const bareAttempt = await runNode(
      setupPath,
      ['--origin', stub.origin, '--handle', 'agent-one', '--client-class', 'coding_persistent', '--human-approved'],
      { env: home.env, stdio: ['pipe', 'pipe', 'pipe'] },
    )
    assert.notEqual(bareAttempt.status, 0, 'a bare --human-approved with no token still cannot self-approve in one call')
    assert.equal(stub.merchants.size, 0)

    const firstPass = await runNode(
      setupPath,
      ['--origin', stub.origin, '--handle', 'agent-one', '--client-class', 'coding_persistent'],
      { env: home.env, stdio: ['pipe', 'pipe', 'pipe'] },
    )
    assert.notEqual(firstPass.status, 0, 'refuses without a valid token on a non-interactive run')
    assert.match(firstPass.stderr, /put this exact question to the human/u)
    assert.match(firstPass.stderr, /"agent-one"/u)
    assert.match(firstPass.stderr, /register it now/iu)
    assert.match(firstPass.stderr, /false declaration/u)
    assert.ok(extractApprovalToken(firstPass.stderr), 'the refused first pass prints the exact second command, with a derived token')
    assert.equal(stub.merchants.size, 0, 'nothing was registered by the refused first pass')

    // A fabricated token -- something an unattended loop might try to guess
    // or construct without ever having seen a real refusal -- is refused
    // exactly like no token at all. Unlike the no-token case, this does NOT
    // mint a fresh nonce: a value WAS supplied for the pending handle/class,
    // just the wrong one, so the outstanding nonce from firstPass stays
    // alive and this refusal prints that SAME token back -- one wrong paste
    // must never destroy a still-valid, still-unused token.
    const fabricated = await runNode(
      setupPath,
      ['--origin', stub.origin, '--handle', 'agent-one', '--client-class', 'coding_persistent', '--human-approved', 'a'.repeat(32)],
      { env: home.env, stdio: ['pipe', 'pipe', 'pipe'] },
    )
    assert.notEqual(fabricated.status, 0, 'a fabricated token is refused')
    assert.equal(stub.merchants.size, 0)
    const token = extractApprovalToken(fabricated.stderr)
    assert.ok(token, 'this refusal too prints the exact second command, with the still-pending token')
    assert.equal(
      token,
      extractApprovalToken(firstPass.stderr),
      'a fabricated/wrong token never re-mints and so never destroys the token firstPass already printed',
    )

    const secondPass = await runNode(
      setupPath,
      ['--origin', stub.origin, '--handle', 'agent-one', '--client-class', 'coding_persistent', '--human-approved', token],
      { env: home.env },
    )
    assert.equal(secondPass.status, 0, secondPass.stderr)
    assert.equal(stub.merchants.size, 1, 'the second pass, carrying the token the most recent refusal minted, actually registered')
    assert.ok(stub.merchants.has('agent-one'))
    assertNoSecretLeaked(bareAttempt, 'setup.mjs bare --human-approved attempt')
    assertNoSecretLeaked(firstPass, 'setup.mjs first pass')
    assertNoSecretLeaked(fabricated, 'setup.mjs fabricated-token attempt')
    assertNoSecretLeaked(secondPass, 'setup.mjs second pass')

    const stored = readSecret(stub.origin, 'agent-one', { homeDir: home.dir })
    assert.equal(stored.found, true)
    assert.equal(stored.value.merchant_key, stub.merchants.get('agent-one').merchant_key)

    // The token is single-use: replaying it after a successful registration
    // must never register a second merchant. (By now setup-state.json names
    // "agent-one" for this origin, so this reaches the repair path, which
    // never registers regardless -- proving the single-use property would
    // need a second handle's worth of state; the repair-path assertion
    // below already proves no second merchant appears either way.)
    const replay = await runNode(
      setupPath,
      ['--origin', stub.origin, '--handle', 'agent-one', '--client-class', 'coding_persistent', '--human-approved', token],
      { env: home.env },
    )
    assert.equal(replay.status, 0, replay.stderr)
    assert.equal(stub.merchants.size, 1, 'replaying the token never creates a second merchant')

    // Re-running with no flags at all reads the state file and repairs,
    // never registering a second identity.
    const repairPass = await runNode(setupPath, ['--origin', stub.origin], { env: home.env })
    assert.equal(repairPass.status, 0, repairPass.stderr)
    assert.equal(stub.merchants.size, 1, 'a repair pass never creates a second merchant')
    assertNoSecretLeaked(repairPass, 'setup.mjs repair pass')
  } finally {
    // On win32, storeSecret/readSecret always use the real Windows
    // Credential Manager regardless of `homeDir` -- it is not scoped to the
    // throwaway per-test home the way the plain-file backend is -- so this
    // test's CLI-driven `setup` registration must be cleaned up explicitly,
    // the same way test/vault-roundtrip-windows.test.mjs does for its own
    // fixture entries.
    deleteSecret(stub.origin, 'agent-one', { homeDir: home.dir })
    home.cleanup()
    await stub.close()
  }
})

test('setup.mjs: the approval token is genuinely single-use -- once consumed by a successful pass, it approves nothing else afterward, even for a fresh registration attempt', async () => {
  const stub = await startStubMarketServer()
  const home = makeTempHome('setup-token-reuse-')
  try {
    const firstPass = await runNode(
      setupPath,
      ['--origin', stub.origin, '--handle', 'agent-token-reuse', '--client-class', 'coding_persistent'],
      { env: home.env, stdio: ['pipe', 'pipe', 'pipe'] },
    )
    const token = extractApprovalToken(firstPass.stderr)
    assert.ok(token)

    const secondPass = await runNode(
      setupPath,
      ['--origin', stub.origin, '--handle', 'agent-token-reuse', '--client-class', 'coding_persistent', '--human-approved', token],
      { env: home.env },
    )
    assert.equal(secondPass.status, 0, secondPass.stderr)
    assert.equal(stub.merchants.size, 1)

    // The successful pass above already consumed pending_approval (set it
    // to null in setup-state.json). Simulate the "state lost, vault intact"
    // stranding shape for a SECOND, distinct handle -- the only way to reach
    // a fresh registration attempt at all, since a repair run ignores
    // --handle entirely once setup-state.json names one for this origin --
    // and confirm the already-spent token still cannot approve it.
    writeFileSync(`${home.dir}/.1f3ea/setup-state.json`, JSON.stringify({}))
    const replay = await runNode(
      setupPath,
      ['--origin', stub.origin, '--handle', 'agent-token-reuse-2', '--client-class', 'coding_persistent', '--human-approved', token, '--new-identity'],
      { env: home.env },
    )
    assert.notEqual(replay.status, 0, 'the already-consumed token cannot approve a later registration')
    assert.equal(stub.merchants.size, 1, 'no second merchant was registered by replaying a spent token')
  } finally {
    deleteSecret(stub.origin, 'agent-token-reuse', { homeDir: home.dir })
    deleteSecret(stub.origin, 'agent-token-reuse-2', { homeDir: home.dir })
    home.cleanup()
    await stub.close()
  }
})

test('setup.mjs adopts an existing working vault entry instead of registering a duplicate (findings 7 & 13)', async () => {
  const stub = await startStubMarketServer()
  const home = makeTempHome('setup-adopt-')
  try {
    // Simulate the stranding scenario: the market already has this merchant
    // (confirm succeeded server-side) and the key is correctly vaulted, but
    // no setup-state.json was ever written (the response was lost).
    stub.merchants.set('agent-two', { merchant_key: `1f3ea_sk_${'c'.repeat(48)}`, recovery_codes: [], client_class: 'coding_persistent' })
    storeSecret(stub.origin, 'agent-two', {
      kind: 'merchant',
      handle: 'agent-two',
      client_class: 'coding_persistent',
      merchant_key: stub.merchants.get('agent-two').merchant_key,
      recovery_codes: [],
      origin: stub.origin,
      stored_at: new Date().toISOString(),
    }, { homeDir: home.dir })

    const result = await runNode(
      setupPath,
      ['--origin', stub.origin, '--handle', 'agent-two', '--client-class', 'coding_persistent'],
      { env: home.env },
    )
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /already exists/iu)
    assert.match(result.stdout, /[Aa]dopting it instead of registering a second one/u)
    assert.equal(stub.merchants.size, 1, 'no second merchant was registered')
    assertNoSecretLeaked(result, 'setup.mjs adopt')
  } finally {
    deleteSecret(stub.origin, 'agent-two', { homeDir: home.dir })
    home.cleanup()
    await stub.close()
  }
})

test('setup.mjs: --new-identity bypasses adoption and attempts a real registration, which the market itself refuses as a duplicate handle', async () => {
  const stub = await startStubMarketServer()
  // A fresh home with no setup-state.json at all -- this is the "vault entry
  // exists, but no repair state has ever been written" shape --new-identity
  // is actually meant to override (once a repair pass has run once, the
  // state file it writes takes over on every later run regardless of this
  // flag, which is exercised by the "adopts" test above).
  const home = makeTempHome('setup-new-identity-')
  try {
    stub.merchants.set('agent-two-b', { merchant_key: `1f3ea_sk_${'c'.repeat(48)}`, recovery_codes: [], client_class: 'coding_persistent' })
    storeSecret(stub.origin, 'agent-two-b', {
      kind: 'merchant',
      handle: 'agent-two-b',
      client_class: 'coding_persistent',
      merchant_key: stub.merchants.get('agent-two-b').merchant_key,
      recovery_codes: [],
      origin: stub.origin,
      stored_at: new Date().toISOString(),
    }, { homeDir: home.dir })

    // Two real passes are still required even with --new-identity.
    const firstPass = await runNode(
      setupPath,
      ['--origin', stub.origin, '--handle', 'agent-two-b', '--client-class', 'coding_persistent', '--new-identity'],
      { env: home.env, stdio: ['pipe', 'pipe', 'pipe'] },
    )
    assert.notEqual(firstPass.status, 0)
    const token = extractApprovalToken(firstPass.stderr)
    assert.ok(token, 'the refused first pass prints a token for the second run')

    const forced = await runNode(
      setupPath,
      ['--origin', stub.origin, '--handle', 'agent-two-b', '--client-class', 'coding_persistent', '--human-approved', token, '--new-identity'],
      { env: home.env },
    )
    assert.notEqual(forced.status, 0, '--new-identity still cannot create a real duplicate; the market itself refuses it')
    assert.match(forced.stdout + forced.stderr, /--new-identity was passed/u)
    assert.equal(stub.merchants.size, 1, 'still exactly the one, pre-existing merchant')
  } finally {
    deleteSecret(stub.origin, 'agent-two-b', { homeDir: home.dir })
    home.cleanup()
    await stub.close()
  }
})

test('setup.mjs refuses to guess on a corrupt setup-state.json rather than silently registering a duplicate (finding 13)', async () => {
  const home = makeTempHome('setup-corrupt-')
  try {
    mkdirSync(`${home.dir}/.1f3ea`, { recursive: true })
    writeFileSync(`${home.dir}/.1f3ea/setup-state.json`, 'not valid json{{{')

    const result = await runNode(
      setupPath,
      ['--origin', 'https://example.invalid', '--allow-origin', 'https://example.invalid', '--handle', 'agent-three', '--client-class', 'coding_persistent', '--human-approved'],
      { env: { ...home.env, ...NOT_A_REAL_ORIGIN_ENV } },
    )
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /could not be parsed as JSON/u)
    assert.match(result.stderr, /refusing to guess/u)
  } finally {
    home.cleanup()
  }
})

test('key rotate invalidates recovery codes instead of carrying them forward, and tells the agent to regenerate (finding 6)', async () => {
  const stub = await startStubMarketServer()
  const home = makeTempHome('key-rotate-')
  try {
    const originalKey = `1f3ea_sk_${'d'.repeat(48)}`
    const originalCodes = Array.from({ length: 8 }, (_unused, i) => `1f3ea_rc_${i.toString().padStart(2, '0')}${'e'.repeat(62)}`)
    stub.merchants.set('agent-four', { merchant_key: originalKey, recovery_codes: originalCodes, client_class: 'coding_persistent' })
    storeSecret(stub.origin, 'agent-four', {
      kind: 'merchant', handle: 'agent-four', client_class: 'coding_persistent',
      merchant_key: originalKey, recovery_codes: originalCodes, origin: stub.origin,
      stored_at: new Date().toISOString(),
    }, { homeDir: home.dir })

    const result = await runNode(keyPath, ['rotate', '--origin', stub.origin, '--handle', 'agent-four'], { env: home.env })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /recovery codes were invalidated by this rotation/u)
    assert.match(result.stdout, /key recover generate/u)
    assertNoSecretLeaked(result, 'key rotate')

    const stored = readSecret(stub.origin, 'agent-four', { homeDir: home.dir })
    assert.equal(stored.found, true)
    assert.notEqual(stored.value.merchant_key, originalKey, 'the live entry now holds the rotated key')
    assert.ok(!Array.isArray(stored.value.recovery_codes) || stored.value.recovery_codes.length === 0,
      'the stale pre-rotation codes are not carried forward')
    assert.equal(typeof stored.value.recovery_codes_invalidated_at, 'string',
      'the vault entry is marked so `key show` can refuse to print stale codes')
  } finally {
    deleteSecret(stub.origin, 'agent-four', { homeDir: home.dir })
    home.cleanup()
    await stub.close()
  }
})

test('key recover generate writes the fresh codes into the live vault entry, not a sibling label (finding 6)', async () => {
  const stub = await startStubMarketServer()
  const home = makeTempHome('key-recover-gen-')
  try {
    const merchantKey = `1f3ea_sk_${'f'.repeat(48)}`
    stub.merchants.set('agent-five', { merchant_key: merchantKey, recovery_codes: [], client_class: 'coding_persistent' })
    storeSecret(stub.origin, 'agent-five', {
      kind: 'merchant', handle: 'agent-five', client_class: 'coding_persistent',
      merchant_key: merchantKey, recovery_codes: [], origin: stub.origin,
      stored_at: new Date().toISOString(),
    }, { homeDir: home.dir })

    const result = await runNode(keyPath, ['recover', 'generate', '--origin', stub.origin, '--handle', 'agent-five'], { env: home.env })
    assert.equal(result.status, 0, result.stderr)
    assertNoSecretLeaked(result, 'key recover generate')

    const live = readSecret(stub.origin, 'agent-five', { homeDir: home.dir })
    assert.equal(live.found, true)
    assert.equal(live.value.recovery_codes.length, 8, 'the live entry holds the fresh set of eight codes')
    assert.equal(live.value.client_class, 'coding_persistent', 'client_class survives the merge')

    const sibling = readSecret(stub.origin, 'agent-five-recovery', { homeDir: home.dir })
    assert.equal(sibling.found, false, 'no separate sibling-label entry is left behind')
  } finally {
    deleteSecret(stub.origin, 'agent-five', { homeDir: home.dir })
    deleteSecret(stub.origin, 'agent-five-recovery', { homeDir: home.dir })
    home.cleanup()
    await stub.close()
  }
})

// --- Round-3 review, HIGH finding: recoverGenerate must take the same ------
// per-(origin, handle) lock promoteReplacementKey (register/rotate/recover
// begin) already takes, so a concurrent rotation confirming while a
// recover-generate call is still in flight can never silently revert the
// vault to the key that rotation just revoked. Proven deterministically
// here by pre-holding the exact lockfile identity-client.mjs's own
// promoteLockPath computes -- fresh, not stale -- and asserting
// recoverGenerate refuses to acquire it (mirroring promoteReplacementKey's
// own "could not acquire the per-handle vault lock" refusal) rather than
// silently bypassing it and rewriting the live entry anyway.

test('key recover generate refuses when the per-handle vault lock is already held, instead of silently bypassing it', async () => {
  const stub = await startStubMarketServer()
  const home = makeTempHome('key-recover-gen-lock-')
  const origin = stub.origin
  const handle = 'agent-lockrace'
  try {
    const merchantKey = `1f3ea_sk_${'8'.repeat(48)}`
    stub.merchants.set(handle, { merchant_key: merchantKey, recovery_codes: [], client_class: 'coding_persistent' })
    storeSecret(origin, handle, {
      kind: 'merchant', handle, client_class: 'coding_persistent',
      merchant_key: merchantKey, recovery_codes: [], origin,
      stored_at: new Date().toISOString(),
    }, { homeDir: home.dir })

    // Simulate another promoteReplacementKey call (a concurrent rotate/
    // recover-begin/register on this same handle) already holding the
    // per-(origin, handle) lock -- the exact lockfile name
    // identity-client.mjs's own promoteLockPath computes, fresh (not
    // stale), so this run cannot break it and must wait out its own 2s
    // budget and refuse.
    const safeOrigin = origin.replace(/[^a-z0-9.-]/giu, '_')
    const safeHandle = handle.replace(/[^a-z0-9._-]/giu, '_')
    const lockDir = join(home.dir, '.1f3ea')
    mkdirSync(lockDir, { recursive: true })
    const lockPath = join(lockDir, `promote-lock__${safeOrigin}__${safeHandle}.lock`)
    writeFileSync(lockPath, '')

    const result = await runNode(
      keyPath, ['recover', 'generate', '--origin', origin, '--handle', handle],
      { env: home.env, timeout: 10_000 },
    )
    assert.notEqual(result.status, 0, 'recover generate must refuse rather than silently rewrite the live entry while the lock is held')
    assert.match(result.stderr, /could not acquire the per-handle vault lock/u)
    assertNoSecretLeaked(result, 'key recover generate lock refusal')

    // The market DID mint fresh codes server-side (its own state changed --
    // recover generate posted to /api/recovery before ever touching the
    // lock), but the vault itself must be untouched: the live entry still
    // holds the ORIGINAL key and no recovery codes, never rewritten mid-lock.
    const stillLive = readSecret(origin, handle, { homeDir: home.dir })
    assert.equal(stillLive.found, true)
    assert.equal(stillLive.value.merchant_key, merchantKey, 'the live vault entry was never rewritten while the lock was held')
    assert.deepEqual(stillLive.value.recovery_codes, [], 'the just-minted codes were never written to the vault either')
  } finally {
    deleteSecret(origin, handle, { homeDir: home.dir })
    home.cleanup()
    await stub.close()
  }
})

// --- Round-3 review, MEDIUM finding: key.mjs's rotate/recover generate ----
// must run the same probeMe label-vs-identity check `key status` and
// `connect` already run, and refuse on a mismatch -- otherwise a mislabeled
// vault entry silently rotates/regenerates a DIFFERENT merchant than the
// one named, leaving the labelled entry holding a now-revoked key.

test('key rotate refuses to act when the stored key authenticates as a different handle, instead of silently rotating the wrong merchant', async () => {
  const stub = await startStubMarketServer()
  const home = makeTempHome('key-rotate-mismatch-')
  try {
    const bobKey = `1f3ea_sk_${'7'.repeat(48)}`
    stub.merchants.set('adv-bob-r', { merchant_key: bobKey, recovery_codes: [], client_class: 'coding_persistent' })
    // bob's key, planted under alice's label -- a stale label, a hand-copied
    // entry, or a market-normalized handle all produce this shape.
    storeSecret(stub.origin, 'adv-alice-r', {
      kind: 'merchant', handle: 'adv-alice-r', client_class: 'coding_persistent',
      merchant_key: bobKey, recovery_codes: [], origin: stub.origin,
      stored_at: new Date().toISOString(),
    }, { homeDir: home.dir })

    const result = await runNode(keyPath, ['rotate', '--origin', stub.origin, '--handle', 'adv-alice-r'], { env: home.env })
    assert.notEqual(result.status, 0, 'a handle mismatch must refuse, never rotate the wrong merchant')
    assert.match(result.stderr, /authenticates as "adv-bob-r"/u)
    assert.match(result.stderr, /adv-alice-r/u)
    assertNoSecretLeaked(result, 'key rotate mismatch')

    // Bob's key must still be exactly what it was -- never rotated behind
    // his back because someone else's vault entry happened to point at it.
    assert.equal(stub.merchants.get('adv-bob-r').merchant_key, bobKey)
  } finally {
    deleteSecret(stub.origin, 'adv-alice-r', { homeDir: home.dir })
    home.cleanup()
    await stub.close()
  }
})

test('key recover generate refuses when the stored key authenticates as a different handle, instead of silently regenerating codes for the wrong merchant', async () => {
  const stub = await startStubMarketServer()
  const home = makeTempHome('key-recover-gen-mismatch-')
  try {
    const bobKey = `1f3ea_sk_${'6'.repeat(48)}`
    stub.merchants.set('adv-bob-g', { merchant_key: bobKey, recovery_codes: [], client_class: 'coding_persistent' })
    storeSecret(stub.origin, 'adv-alice-g', {
      kind: 'merchant', handle: 'adv-alice-g', client_class: 'coding_persistent',
      merchant_key: bobKey, recovery_codes: [], origin: stub.origin,
      stored_at: new Date().toISOString(),
    }, { homeDir: home.dir })

    const result = await runNode(keyPath, ['recover', 'generate', '--origin', stub.origin, '--handle', 'adv-alice-g'], { env: home.env })
    assert.notEqual(result.status, 0, 'a handle mismatch must refuse, never regenerate codes for the wrong merchant')
    assert.match(result.stderr, /authenticates as "adv-bob-g"/u)
    assertNoSecretLeaked(result, 'key recover generate mismatch')

    // Bob's recovery codes must be untouched.
    assert.deepEqual(stub.merchants.get('adv-bob-g').recovery_codes, [])
  } finally {
    deleteSecret(stub.origin, 'adv-alice-g', { homeDir: home.dir })
    home.cleanup()
    await stub.close()
  }
})

// --- Round-4 review, MEDIUM finding: identity-client.mjs's rotate() and ----
// recoverBegin() must print (and act on) the already-validated STAGED
// handle -- the label they actually just wrote to -- never the confirm
// response's own, never-validated `handle` field. A server that names one
// handle on begin and a different one on confirm must never make the
// success output name a merchant that was never touched, and an embedded
// newline in that unvalidated field must never fabricate extra output
// lines. See scripts/identity-client.mjs's own comments at the two
// `if (typeof confirmed.handle === 'string' && confirmed.handle !== staged.handle)`
// checks in rotate() and recoverBegin().

test(
  'identity-client.mjs rotate refuses when the confirm response names a different handle than begin staged, ' +
  'instead of printing (or trusting) that name -- the staged handle is what was actually written',
  async () => {
    const stub = await startStubMarketServer({ rotateConfirmHandleOverride: 'attacker-agent' })
    const home = makeTempHome('rotate-confirm-mismatch-')
    try {
      const victimKey = `1f3ea_sk_${'9'.repeat(48)}`
      stub.merchants.set('victim-merchant', { merchant_key: victimKey, recovery_codes: [], client_class: 'coding_persistent' })

      const result = await runNode(identityClientPath, [
        'rotate', '--origin', stub.origin, '--client-class', 'coding_persistent',
      ], { env: { ...home.env, AGENT_1F3EA_SECRET: victimKey } })

      assert.notEqual(result.status, 0, 'a confirm-response handle that differs from what begin staged must refuse')
      assert.match(result.stderr, /victim-merchant/u, 'names the STAGED handle -- the one actually written')
      assert.match(result.stderr, /attacker-agent/u, 'also names the bogus confirmed handle, so the caller sees the discrepancy')
      assert.doesNotMatch(result.stdout, /handle: attacker-agent/u, 'stdout never claims the wrong merchant was rotated')
      assert.doesNotMatch(result.stdout, /^handle: /mu, 'the success "handle:" line is never printed at all once this refuses')
      assertNoSecretLeaked(result, 'identity-client rotate confirm mismatch')

      // The rotation genuinely happened server-side (the market really did
      // hand back a new key at begin) -- so the write under the STAGED
      // handle is real, and must be verifiable, not silently dropped along
      // with the refusal.
      const stored = readSecret(stub.origin, 'victim-merchant', { homeDir: home.dir })
      assert.equal(stored.found, true)
      assert.notEqual(stored.value.merchant_key, victimKey, 'the replacement key is genuinely written under the staged handle')

      // And nothing is ever written under the unvalidated, bogus confirmed name.
      const bogus = readSecret(stub.origin, 'attacker-agent', { homeDir: home.dir })
      assert.equal(bogus.found, false, 'nothing is ever written under the confirm response\'s own handle')
    } finally {
      deleteSecret(stub.origin, 'victim-merchant', { homeDir: home.dir })
      deleteSecret(stub.origin, 'attacker-agent', { homeDir: home.dir })
      home.cleanup()
      await stub.close()
    }
  },
)

test(
  'identity-client.mjs rotate: an embedded newline in the confirm response\'s handle never fabricates extra ' +
  'output lines -- it reaches the refusal message only escaped, via JSON.stringify',
  async () => {
    const poisoned = 'attacker-agent\nstored: 1f3ea:https://evil.invalid:TOTALLY FAKE\nmerchant_id: 999'
    const stub = await startStubMarketServer({ rotateConfirmHandleOverride: poisoned })
    const home = makeTempHome('rotate-confirm-newline-')
    try {
      const victimKey = `1f3ea_sk_${'8'.repeat(48)}`
      stub.merchants.set('victim-two', { merchant_key: victimKey, recovery_codes: [], client_class: 'coding_persistent' })

      const result = await runNode(identityClientPath, [
        'rotate', '--origin', stub.origin, '--client-class', 'coding_persistent',
      ], { env: { ...home.env, AGENT_1F3EA_SECRET: victimKey } })

      assert.notEqual(result.status, 0)
      // The poisoned value must appear only as an ESCAPED JSON string (real
      // newlines rendered as the two characters "\n", not an actual line
      // break) -- never raw, which is what would let it fabricate a
      // convincing extra "stored:"/"merchant_id:" line in a transcript the
      // key skill instructs the agent to relay verbatim.
      assert.match(result.stderr, /attacker-agent\\nstored: 1f3ea:https:\/\/evil\.invalid:TOTALLY FAKE\\nmerchant_id: 999/u)
      assert.doesNotMatch(result.stdout, /stored: 1f3ea:https:\/\/evil\.invalid:TOTALLY FAKE/u, 'the fabricated line never lands on stdout')
      assert.doesNotMatch(result.stdout, /merchant_id: 999/u, 'the fabricated line never lands on stdout')
      assert.doesNotMatch(result.stdout, /^handle: /mu, 'the success "handle:" line is never printed at all once this refuses')
      assertNoSecretLeaked(result, 'identity-client rotate confirm newline injection')
    } finally {
      deleteSecret(stub.origin, 'victim-two', { homeDir: home.dir })
      deleteSecret(stub.origin, poisoned, { homeDir: home.dir })
      home.cleanup()
      await stub.close()
    }
  },
)

test(
  'identity-client.mjs recover begin refuses when the confirm response names a different handle than begin ' +
  'staged, instead of printing (or trusting) that name',
  async () => {
    const stub = await startStubMarketServer({ recoveryConfirmHandleOverride: 'attacker-agent' })
    const home = makeTempHome('recover-confirm-mismatch-')
    try {
      const victimKey = `1f3ea_sk_${'5'.repeat(48)}`
      const recoveryCode = `1f3ea_rc_${'a'.repeat(64)}`
      stub.merchants.set('victim-three', {
        merchant_key: victimKey, recovery_codes: [recoveryCode], client_class: 'coding_persistent',
      })

      const result = await runNode(identityClientPath, [
        'recover', 'begin', '--origin', stub.origin, '--client-class', 'coding_persistent',
        '--recovery-code-file', '-',
      ], { input: recoveryCode, env: home.env })

      assert.notEqual(result.status, 0, 'a confirm-response handle that differs from what begin staged must refuse')
      assert.match(result.stderr, /victim-three/u, 'names the STAGED handle -- the one actually written')
      assert.match(result.stderr, /attacker-agent/u, 'also names the bogus confirmed handle')
      assert.doesNotMatch(result.stdout, /handle: attacker-agent/u)
      assert.doesNotMatch(result.stdout, /^handle: /mu, 'the success "handle:" line is never printed at all once this refuses')
      assertNoSecretLeaked(result, 'identity-client recover begin confirm mismatch')

      const stored = readSecret(stub.origin, 'victim-three', { homeDir: home.dir })
      assert.equal(stored.found, true)
      assert.notEqual(stored.value.merchant_key, victimKey, 'the replacement key is genuinely written under the staged handle')

      const bogus = readSecret(stub.origin, 'attacker-agent', { homeDir: home.dir })
      assert.equal(bogus.found, false, 'nothing is ever written under the confirm response\'s own handle')
    } finally {
      deleteSecret(stub.origin, 'victim-three', { homeDir: home.dir })
      deleteSecret(stub.origin, 'attacker-agent', { homeDir: home.dir })
      home.cleanup()
      await stub.close()
    }
  },
)

// --- Finding 11: --reveal is refused through a piped wrapper, not dropped -

test('key rotate/recover generate refuse --reveal outright when stdout is not a TTY, instead of silently dropping it', async () => {
  const stub = await startStubMarketServer()
  const home = makeTempHome('key-reveal-refuse-')
  try {
    const merchantKey = `1f3ea_sk_${'1'.repeat(48)}`
    stub.merchants.set('agent-six', { merchant_key: merchantKey, recovery_codes: [], client_class: 'coding_persistent' })
    storeSecret(stub.origin, 'agent-six', {
      kind: 'merchant', handle: 'agent-six', client_class: 'coding_persistent',
      merchant_key: merchantKey, recovery_codes: [], origin: stub.origin,
      stored_at: new Date().toISOString(),
    }, { homeDir: home.dir })

    const rotateResult = await runNode(keyPath, ['rotate', '--origin', stub.origin, '--handle', 'agent-six', '--reveal'], { env: home.env })
    assert.notEqual(rotateResult.status, 0)
    assert.match(rotateResult.stderr, /--reveal cannot work through this wrapper/u)
    assert.match(rotateResult.stderr, /identity-client\.mjs directly at an interactive terminal/u)
    // The refusal must happen before any network call: the stub never sees
    // a rotated key for this merchant.
    assert.equal(stub.merchants.get('agent-six').merchant_key, merchantKey)

    const recoverResult = await runNode(keyPath, ['recover', 'generate', '--origin', stub.origin, '--handle', 'agent-six', '--reveal'], { env: home.env })
    assert.notEqual(recoverResult.status, 0)
    assert.match(recoverResult.stderr, /--reveal cannot work through this wrapper/u)
  } finally {
    deleteSecret(stub.origin, 'agent-six', { homeDir: home.dir })
    home.cleanup()
    await stub.close()
  }
})

test('setup.mjs refuses --reveal outright when stdout is not a TTY, instead of silently dropping it', async () => {
  const stub = await startStubMarketServer()
  const home = makeTempHome('setup-reveal-refuse-')
  try {
    const firstPass = await runNode(
      setupPath,
      ['--origin', stub.origin, '--handle', 'agent-seven', '--client-class', 'coding_persistent', '--reveal'],
      { env: home.env, stdio: ['pipe', 'pipe', 'pipe'] },
    )
    assert.notEqual(firstPass.status, 0)
    const token = extractApprovalToken(firstPass.stderr)
    assert.ok(token, 'the refused first pass prints a token for the second run')

    const result = await runNode(
      setupPath,
      ['--origin', stub.origin, '--handle', 'agent-seven', '--client-class', 'coding_persistent', '--human-approved', token, '--reveal'],
      { env: home.env },
    )
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /--reveal cannot work through this wrapper/u)
    assert.equal(stub.merchants.size, 0, 'registration never proceeded once --reveal was refused')
  } finally {
    home.cleanup()
    await stub.close()
  }
})

// --- Finding 4: SecretReadFailure is caught everywhere, never an --------
// uncaught crash with a raw Node stack trace.

test('key/connect/setup refuse cleanly on a corrupt vault entry, never an uncaught stack trace', async () => {
  const origin = 'https://example.invalid'
  const handle = `corrupt-handle-${Date.now().toString(36)}`
  const STACK_TRACE_LINE = /^\s*at\s+\S+/mu

  if (process.platform === 'win32') {
    // Seed a genuinely undecodable Windows Credential Manager entry the
    // same way the finding's own reproduction did: cmdkey can write an
    // arbitrary password string that CredRead reads back as raw bytes this
    // script's JSON.parse(Buffer.from(...)) cannot decode.
    const target = `1f3ea:${origin}:${handle}`
    execFileSync('cmdkey', [`/generic:${target}`, `/user:${handle}`, '/pass:not-valid-base64-json{{{'], { stdio: 'ignore' })
    try {
      for (const [label, scriptPath, args] of [
        ['key status', keyPath, ['status', '--origin', origin, '--allow-origin', origin, '--handle', handle]],
        ['key show', keyPath, ['show', '--origin', origin, '--allow-origin', origin, '--handle', handle]],
        ['connect', connectPath, ['--origin', origin, '--allow-origin', origin, '--handle', handle]],
        ['setup', setupPath, ['--origin', origin, '--allow-origin', origin, '--handle', handle, '--client-class', 'coding_persistent']],
      ]) {
        const result = await runNode(scriptPath, args, { env: NOT_A_REAL_ORIGIN_ENV })
        assert.notEqual(result.status, 0, `${label}: exits non-zero on a corrupt vault entry`)
        assert.doesNotMatch(result.stderr, STACK_TRACE_LINE, `${label}: no raw stack trace`)
        assert.match(result.stderr, /could not be decoded/iu, `${label}: caller-words explanation`)
      }
    } finally {
      execFileSync('cmdkey', [`/delete:${target}`], { stdio: 'ignore' })
    }
    return
  }

  // POSIX file backend: write a corrupt file directly at the deterministic
  // path storeSecret/readSecret compute, inside a throwaway HOME.
  const home = makeTempHome('corrupt-vault-')
  try {
    const safeOrigin = origin.replace(/[^a-z0-9.-]/giu, '_')
    const safeLabel = handle.replace(/[^a-z0-9._-]/giu, '_')
    const dir = `${home.dir}/.1f3ea/credentials`
    mkdirSync(dir, { recursive: true })
    writeFileSync(`${dir}/${safeOrigin}__${safeLabel}.json`, 'not valid json{{{')

    for (const [label, scriptPath, args] of [
      ['key status', keyPath, ['status', '--origin', origin, '--allow-origin', origin, '--handle', handle]],
      ['key show', keyPath, ['show', '--origin', origin, '--allow-origin', origin, '--handle', handle]],
      ['connect', connectPath, ['--origin', origin, '--allow-origin', origin, '--handle', handle]],
      ['setup', setupPath, ['--origin', origin, '--allow-origin', origin, '--handle', handle, '--client-class', 'coding_persistent']],
    ]) {
      const result = await runNode(scriptPath, args, { env: { ...home.env, ...NOT_A_REAL_ORIGIN_ENV } })
      assert.notEqual(result.status, 0, `${label}: exits non-zero on a corrupt vault entry`)
      assert.doesNotMatch(result.stderr, STACK_TRACE_LINE, `${label}: no raw stack trace`)
      assert.match(result.stderr, /could not be parsed as JSON/iu, `${label}: caller-words explanation`)
    }
  } finally {
    home.cleanup()
  }
})

// --- Finding 5: an adopted/checked vault entry must actually authenticate -
// as the handle it is labelled under, not just any working key.

test('setup.mjs refuses to adopt a vault entry whose stored key authenticates as a different merchant', async () => {
  const stub = await startStubMarketServer()
  const home = makeTempHome('setup-mismatch-')
  try {
    // The market knows "agent-beta"; the vault entry LABELLED "agent-alpha"
    // actually holds agent-beta's key (a stale label, a hand-copied entry,
    // or a handle the market normalized at registration).
    stub.merchants.set('agent-beta', { merchant_key: `1f3ea_sk_${'9'.repeat(48)}`, recovery_codes: [], client_class: 'coding_persistent' })
    storeSecret(stub.origin, 'agent-alpha', {
      kind: 'merchant',
      handle: 'agent-alpha',
      client_class: 'coding_persistent',
      merchant_key: stub.merchants.get('agent-beta').merchant_key,
      recovery_codes: [],
      origin: stub.origin,
      stored_at: new Date().toISOString(),
    }, { homeDir: home.dir })

    const result = await runNode(
      setupPath,
      ['--origin', stub.origin, '--handle', 'agent-alpha', '--client-class', 'coding_persistent'],
      { env: home.env },
    )
    assert.notEqual(result.status, 0, 'refuses instead of adopting a mismatched entry')
    assert.match(result.stderr, /agent-alpha/u)
    assert.match(result.stderr, /agent-beta/u)
    assert.equal(stub.merchants.size, 1, 'no new merchant was registered, and the true merchant is untouched')
    assertNoSecretLeaked(result, 'setup.mjs mismatch refusal')
  } finally {
    deleteSecret(stub.origin, 'agent-alpha', { homeDir: home.dir })
    home.cleanup()
    await stub.close()
  }
})

test('key status reports a mismatch instead of claiming success when the stored key authenticates as a different handle', async () => {
  const stub = await startStubMarketServer()
  const home = makeTempHome('key-mismatch-')
  try {
    stub.merchants.set('agent-delta', { merchant_key: `1f3ea_sk_${'8'.repeat(48)}`, recovery_codes: [], client_class: 'coding_persistent' })
    storeSecret(stub.origin, 'agent-gamma', {
      kind: 'merchant',
      handle: 'agent-gamma',
      client_class: 'coding_persistent',
      merchant_key: stub.merchants.get('agent-delta').merchant_key,
      recovery_codes: [],
      origin: stub.origin,
      stored_at: new Date().toISOString(),
    }, { homeDir: home.dir })

    const result = await runNode(keyPath, ['status', '--origin', stub.origin, '--handle', 'agent-gamma'], { env: home.env })
    assert.notEqual(result.status, 0, 'a handle mismatch is not a successful status check')
    assert.match(result.stdout, /agent-gamma/u)
    assert.match(result.stdout, /agent-delta/u)
    assert.doesNotMatch(result.stdout, /works \(one me read succeeded\)/u, 'never claims plain success on a mismatch')
    assertNoSecretLeaked(result, 'key status mismatch')
  } finally {
    deleteSecret(stub.origin, 'agent-gamma', { homeDir: home.dir })
    home.cleanup()
    await stub.close()
  }
})

test('connect.mjs reports a mismatch instead of claiming OK when the stored key authenticates as a different handle', async () => {
  const stub = await startStubMarketServer()
  const home = makeTempHome('connect-mismatch-')
  try {
    stub.merchants.set('agent-zeta', { merchant_key: `1f3ea_sk_${'6'.repeat(48)}`, recovery_codes: [], client_class: 'coding_persistent' })
    storeSecret(stub.origin, 'agent-epsilon', {
      kind: 'merchant',
      handle: 'agent-epsilon',
      client_class: 'coding_persistent',
      merchant_key: stub.merchants.get('agent-zeta').merchant_key,
      recovery_codes: [],
      origin: stub.origin,
      stored_at: new Date().toISOString(),
    }, { homeDir: home.dir })

    const result = await runNode(connectPath, ['--origin', stub.origin, '--handle', 'agent-epsilon'], { env: home.env })
    assert.notEqual(result.status, 0, 'a handle mismatch is not a successful connection check')
    assert.match(result.stdout, /MISMATCH/u)
    assert.match(result.stdout, /agent-epsilon/u)
    assert.match(result.stdout, /agent-zeta/u)
    assert.doesNotMatch(result.stdout, /one me read: OK/u, 'never claims OK on a mismatch')
    assertNoSecretLeaked(result, 'connect.mjs mismatch')
  } finally {
    deleteSecret(stub.origin, 'agent-epsilon', { homeDir: home.dir })
    home.cleanup()
    await stub.close()
  }
})

// --- Finding 8: the duplicate-identity guard enumerates the whole vault, --
// not just the exact handle requested.

test('setup.mjs refuses to register under a new handle when this origin already has a vault entry under a different label, without --new-identity', async () => {
  const stub = await startStubMarketServer()
  const home = makeTempHome('setup-other-label-')
  try {
    storeSecret(stub.origin, 'agent-old', {
      kind: 'merchant',
      handle: 'agent-old',
      client_class: 'coding_persistent',
      merchant_key: `1f3ea_sk_${'7'.repeat(48)}`,
      recovery_codes: [],
      origin: stub.origin,
      stored_at: new Date().toISOString(),
    }, { homeDir: home.dir })

    const result = await runNode(
      setupPath,
      ['--origin', stub.origin, '--handle', 'agent-new', '--client-class', 'coding_persistent'],
      { env: home.env },
    )
    assert.notEqual(result.status, 0, 'refuses without --new-identity when another entry exists for this origin')
    assert.match(result.stderr, /--new-identity/u)
    assert.match(result.stderr, /agent-old/u)
    assert.equal(stub.merchants.size, 0, 'nothing was registered')
    assertNoSecretLeaked(result, 'setup.mjs other-label refusal')
  } finally {
    deleteSecret(stub.origin, 'agent-old', { homeDir: home.dir })
    home.cleanup()
    await stub.close()
  }
})

// A leftover REGISTRATION staging label (a run that died between staging
// and promotion) is not a real second identity -- listVaultLabels must
// exclude it by the `kind: 'staging'` marker its bundle carries (see
// storeSecret/isStagingLabel in identity-client.mjs), covering the per-run
// suffixed registration form the same way it already covers rotation/
// recovery, or the guard above wrongly refuses a legitimate fresh
// registration because of a label this script itself created and never
// meant as anything but scratch space.

test('setup.mjs does not treat a leftover registration staging label as a second identity', async () => {
  const stub = await startStubMarketServer()
  const home = makeTempHome('setup-stale-registration-staging-')
  try {
    // Simulates a register() run that staged a bundle and then died before
    // ever confirming or promoting it -- exactly the suffixed label shape
    // AND the `kind: 'staging'` marker pendingLabel's callers now write
    // (identity-client.mjs register()). Marking staging by data rather than
    // by label text alone is what lets a REAL merchant's own handle end in
    // this same suffix shape without being hidden from listVaultLabels --
    // see the "listVaultLabels ... a real merchant whose handle ends in
    // --pending-rotation is still listed" tests in identity-client.test.mjs.
    storeSecret(stub.origin, 'agent-abandoned--pending-registration-deadbeef', {
      kind: 'staging',
      handle: 'agent-abandoned',
      client_class: 'coding_persistent',
      merchant_key: `1f3ea_sk_${'8'.repeat(48)}`,
      recovery_codes: [],
      origin: stub.origin,
      stored_at: new Date().toISOString(),
    }, { homeDir: home.dir })

    const result = await runNode(
      setupPath,
      ['--origin', stub.origin, '--handle', 'agent-fresh', '--client-class', 'coding_persistent'],
      { env: home.env },
    )
    assert.doesNotMatch(
      result.stderr,
      /already holds .* entr(?:y|ies) for this origin under a different/u,
      'a staging-only label must never trip the duplicate-identity guard',
    )
    assertNoSecretLeaked(result, 'setup.mjs leftover registration staging label')
  } finally {
    deleteSecret(stub.origin, 'agent-abandoned--pending-registration-deadbeef', { homeDir: home.dir })
    home.cleanup()
    await stub.close()
  }
})

// --- Finding 9: the test env overlay never leaks the real developer's own -
// AGENT_1F3EA_SECRET / IDENTITY_ORIGIN into a driven child process.

test('runNode does not leak the parent process\'s AGENT_1F3EA_SECRET or IDENTITY_ORIGIN into the child', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'run-identity-cli-env-'))
  try {
    const probeScript = join(dir, 'env-probe.mjs')
    writeFileSync(
      probeScript,
      "process.stdout.write(JSON.stringify({ secret: process.env.AGENT_1F3EA_SECRET ?? null, origin: process.env.IDENTITY_ORIGIN ?? null }))\n",
    )
    const previousSecret = process.env.AGENT_1F3EA_SECRET
    const previousOrigin = process.env.IDENTITY_ORIGIN
    process.env.AGENT_1F3EA_SECRET = `1f3ea_sk_${'z'.repeat(48)}`
    process.env.IDENTITY_ORIGIN = 'https://leaked.invalid'
    try {
      const result = await runNode(probeScript, [])
      const seen = JSON.parse(result.stdout)
      assert.equal(seen.secret, null, 'the real AGENT_1F3EA_SECRET from this test-runner process never reaches the child')
      assert.equal(seen.origin, null, 'the real IDENTITY_ORIGIN from this test-runner process never reaches the child')
    } finally {
      if (previousSecret === undefined) delete process.env.AGENT_1F3EA_SECRET
      else process.env.AGENT_1F3EA_SECRET = previousSecret
      if (previousOrigin === undefined) delete process.env.IDENTITY_ORIGIN
      else process.env.IDENTITY_ORIGIN = previousOrigin
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// --- Finding 6: connect.mjs chat mints a real, correctly-shaped pairing ---
// code and never leaks the merchant key while doing it.

test('connect.mjs chat mints a pairing code in the market\'s real shape and never prints the key', async () => {
  const stub = await startStubMarketServer()
  const home = makeTempHome('connect-chat-')
  try {
    const merchantKey = `1f3ea_sk_${'3'.repeat(48)}`
    stub.merchants.set('agent-chat', { merchant_key: merchantKey, recovery_codes: [], client_class: 'coding_persistent' })
    storeSecret(stub.origin, 'agent-chat', {
      kind: 'merchant', handle: 'agent-chat', client_class: 'coding_persistent',
      merchant_key: merchantKey, recovery_codes: [], origin: stub.origin,
      stored_at: new Date().toISOString(),
    }, { homeDir: home.dir })

    const result = await runNode(connectPath, ['chat', '--origin', stub.origin, '--handle', 'agent-chat'], { env: home.env })
    assert.equal(result.status, 0, result.stderr)
    const codeLine = result.stdout.split(/\r?\n/u).map(line => line.trim()).find(line => /^1f3ea_pc_[0-9a-f]{48}$/u.test(line))
    assert.ok(codeLine, `a pairing code matching the real 1f3ea_pc_<48 hex> shape was printed; got:\n${result.stdout}`)
    assert.match(result.stdout, /expires_at:/u)
    assert.match(result.stdout, /I already have a store/u, 'names the human\'s remaining click')
    // Round-3 review, LOW finding: this happy-path test asserted the code
    // shape, expires_at, and step 3's click, but never the "bound to
    // merchant" line connect.mjs prints specifically so step 4 ("confirm the
    // merchant it connects") is checkable against something this script
    // actually stated -- unpinned, deleting both output lines from
    // connect.mjs would still pass this test.
    assert.match(result.stdout, /bound to merchant "agent-chat"/u)
    assert.match(result.stdout, /should read "agent-chat"/u)
    assertNoSecretLeaked(result, 'connect.mjs chat')
  } finally {
    deleteSecret(stub.origin, 'agent-chat', { homeDir: home.dir })
    home.cleanup()
    await stub.close()
  }
})

test('connect.mjs chat surfaces the market\'s pairing_unavailable refusal verbatim rather than swallowing it', async () => {
  const stub = await startStubMarketServer({ pairingUnavailable: true })
  const home = makeTempHome('connect-chat-unavailable-')
  try {
    const merchantKey = `1f3ea_sk_${'4'.repeat(48)}`
    stub.merchants.set('agent-chat-2', { merchant_key: merchantKey, recovery_codes: [], client_class: 'coding_persistent' })
    storeSecret(stub.origin, 'agent-chat-2', {
      kind: 'merchant', handle: 'agent-chat-2', client_class: 'coding_persistent',
      merchant_key: merchantKey, recovery_codes: [], origin: stub.origin,
      stored_at: new Date().toISOString(),
    }, { homeDir: home.dir })

    const result = await runNode(connectPath, ['chat', '--origin', stub.origin, '--handle', 'agent-chat-2'], { env: home.env })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /nowhere to be redeemed|pairing code would have/u, 'the real refusal sentence reaches the caller, not a generic failure message')
    // postAuthed (identity-client.mjs) must surface the machine-readable
    // reason the same way postJson already does, not just the human
    // sentence -- a caller or harness branches on this name.
    assert.match(result.stderr, /reason: pairing_unavailable/u)
    assertNoSecretLeaked(result, 'connect.mjs chat pairing_unavailable')
  } finally {
    deleteSecret(stub.origin, 'agent-chat-2', { homeDir: home.dir })
    home.cleanup()
    await stub.close()
  }
})

// HIGH: connectChat must run the same one-me-read probe connectHost already
// runs before ever spawning `pair`, and refuse on a handle mismatch --
// otherwise a stale label, a hand-copied entry, or a market-normalized
// handle silently mints a working pairing code bound to a DIFFERENT
// merchant than the one the human was told they were pairing.

test('connect.mjs chat refuses to mint a pairing code when the stored key authenticates as a different handle', async () => {
  const stub = await startStubMarketServer()
  const home = makeTempHome('connect-chat-mismatch-')
  try {
    stub.merchants.set('adv-bob', { merchant_key: `1f3ea_sk_${'7'.repeat(48)}`, recovery_codes: [], client_class: 'coding_persistent' })
    // bob's key, planted under alice's label -- a stale label, a hand-copied
    // entry, or a market-normalized handle all produce this shape.
    storeSecret(stub.origin, 'adv-alice', {
      kind: 'merchant',
      handle: 'adv-alice',
      client_class: 'coding_persistent',
      merchant_key: stub.merchants.get('adv-bob').merchant_key,
      recovery_codes: [],
      origin: stub.origin,
      stored_at: new Date().toISOString(),
    }, { homeDir: home.dir })

    const result = await runNode(connectPath, ['chat', '--origin', stub.origin, '--handle', 'adv-alice'], { env: home.env })
    assert.notEqual(result.status, 0, 'a handle mismatch must refuse, never mint a pairing code for the wrong merchant')
    assert.match(result.stderr, /MISMATCH/u)
    assert.match(result.stderr, /adv-alice/u)
    assert.match(result.stderr, /adv-bob/u)
    assert.doesNotMatch(result.stdout, /1f3ea_pc_[0-9a-f]{48}/u, 'no pairing code is ever printed on a mismatch')
    assertNoSecretLeaked(result, 'connect.mjs chat mismatch')
  } finally {
    deleteSecret(stub.origin, 'adv-alice', { homeDir: home.dir })
    home.cleanup()
    await stub.close()
  }
})

// Sanity check for the same probe from the OTHER side: a stored key that
// simply does not authenticate at all (a bad/rotated key never reconciled)
// must also refuse before spawning `pair`, not just a same-market mismatch.

test('connect.mjs chat refuses to mint a pairing code when the stored key does not authenticate at all', async () => {
  const stub = await startStubMarketServer()
  const home = makeTempHome('connect-chat-badkey-')
  try {
    storeSecret(stub.origin, 'adv-ghost', {
      kind: 'merchant',
      handle: 'adv-ghost',
      client_class: 'coding_persistent',
      merchant_key: `1f3ea_sk_${'0'.repeat(48)}`, // never registered with the stub
      recovery_codes: [],
      origin: stub.origin,
      stored_at: new Date().toISOString(),
    }, { homeDir: home.dir })

    const result = await runNode(connectPath, ['chat', '--origin', stub.origin, '--handle', 'adv-ghost'], { env: home.env })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /FAILED/u)
    assert.doesNotMatch(result.stdout, /1f3ea_pc_[0-9a-f]{48}/u, 'no pairing code is ever printed when the probe fails')
    assertNoSecretLeaked(result, 'connect.mjs chat bad key')
  } finally {
    deleteSecret(stub.origin, 'adv-ghost', { homeDir: home.dir })
    home.cleanup()
    await stub.close()
  }
})

// --- Finding 12: `key show --reveal` never prints the literal word --------
// "undefined" when a stored bundle carries no merchant_key field.

test('key show refuses to print "undefined" when a stored bundle has no merchant_key field', async () => {
  const origin = 'https://example.invalid'
  const home = makeTempHome('key-show-no-key-')
  try {
    storeSecret(origin, 'no-key-handle', {
      kind: 'merchant',
      handle: 'no-key-handle',
      origin,
      // deliberately missing merchant_key -- a staging bundle, a hand-written
      // entry, or any future bundle shape without one.
    }, { homeDir: home.dir })

    const result = await runNode(
      keyPath,
      ['show', '--origin', origin, '--allow-origin', origin, '--handle', 'no-key-handle', '--reveal'],
      { env: { ...home.env, ...NOT_A_REAL_ORIGIN_ENV }, stdio: ['pipe', 'pipe', 'pipe'] },
    )
    assert.doesNotMatch(result.stdout, /undefined/u)
    assert.match(result.stdout, /carries no merchant_key/u)
  } finally {
    deleteSecret(origin, 'no-key-handle', { homeDir: home.dir })
    home.cleanup()
  }
})

// `key show --reveal` on a non-interactive stdout (runNode's pipes are
// never a TTY) must diagnose the real reason -- stdout is not interactive
// -- and exit 1, the same way `key rotate --reveal` already does, instead
// of silently dropping the flag, exiting 0, and telling the caller to pass
// the flag it just passed.

test('key show --reveal on a non-interactive stdout diagnoses the reason and exits 1, like key rotate does', async () => {
  const origin = 'https://example.invalid'
  const home = makeTempHome('key-show-reveal-nontty-')
  try {
    storeSecret(origin, 'has-a-key-handle', {
      kind: 'merchant',
      handle: 'has-a-key-handle',
      client_class: 'coding_persistent',
      merchant_key: `1f3ea_sk_${'9'.repeat(48)}`,
      recovery_codes: [],
      origin,
    }, { homeDir: home.dir })

    const result = await runNode(
      keyPath,
      ['show', '--origin', origin, '--allow-origin', origin, '--handle', 'has-a-key-handle', '--reveal'],
      { env: { ...home.env, ...NOT_A_REAL_ORIGIN_ENV }, stdio: ['pipe', 'pipe', 'pipe'] },
    )
    assert.notEqual(result.status, 0, '--reveal on a non-TTY stdout must refuse, not silently drop the flag')
    assert.match(result.stderr, /cannot work through this wrapper|interactive terminal/u)
    assert.doesNotMatch(
      result.stdout, /pass --reveal/u,
      'must not tell the caller to pass a flag it already passed',
    )
    assertNoSecretLeaked(result, 'key show --reveal non-TTY')
  } finally {
    deleteSecret(origin, 'has-a-key-handle', { homeDir: home.dir })
    home.cleanup()
  }
})
