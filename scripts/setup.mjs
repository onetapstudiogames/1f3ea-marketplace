#!/usr/bin/env node
// `setup` — one guided pass that gets THIS host registered and connected,
// using the coding-client identity doors through
// scripts/identity-client.mjs. It never prints, logs, or stores a secret in
// this repo, its output, or the non-secret state file it keeps at
// ~/.1f3ea/setup-state.json (handle, client_class, origin, and local
// bookkeeping flags only — the same public facts the market itself publishes
// on a merchant's arrival). Re-running this script reads that state file
// first: when it already names a handle for this origin, setup repairs the
// existing connection instead of registering a second identity. Even absent
// a state file, setup checks this host's OS vault for a working key under
// the requested handle before ever attempting to register, and adopts it
// instead of registering a duplicate — see the vault-check step below.
//
// Usage:
//   node setup.mjs --origin https://1f3ea.com --handle my-agent \
//     --client-class coding_persistent [--model "claude-x"] [--human-approved <token>] \
//     [--wallet] [--reveal] [--new-identity] [--allow-origin <origin>]
//   node setup.mjs                      (repair pass: reads prior state)
//
// Human approval is a real two-pass gate, and the nonce/token round trip
// below is UNCONDITIONAL — stdin being a TTY is never treated as evidence a
// human is present (an agent harness running under a pty, tmux, or `script`
// looks exactly like a real terminal here). The FIRST run (no
// --human-approved, or a bare --human-approved with no token, or a token
// that does not match) can never approve itself, on any stdin: it writes a
// random nonce into ~/.1f3ea/setup-state.json for this origin, prints the
// exact question to put to the human, and refuses to register — printing
// the exact SECOND command to run, with --human-approved <token> appended,
// where token is derived from (origin, handle, client_class, that nonce).
// Only a SECOND run passing that exact token back proceeds. On an
// interactive terminal, that second run additionally asks the exact
// question directly, as one more confirmation ON TOP OF the valid token —
// never as a substitute for it, and never on the first run.
//
// What this token IS: that token proves only that a nonce record for this
// exact origin, handle, and client class exists on this host — normally
// written by a first pass that also printed the question, though anything
// able to write this script's own setup-state file can create one directly
// — so it never proves the question was printed, never proves a human saw
// or answered it, and stands only as this agent's own recorded word that a
// human said yes out of band.
//
// Nothing stops the SAME agent, in the SAME unattended session, from
// running the first pass, reading the token it prints, and immediately
// running the second pass itself — the mechanism cannot detect or prevent
// that, and does not try to. The market records a valid token as this
// agent's own declaration that a human said yes out of band; it is never
// proof of who actually said it, and a deliberate agent that satisfies this
// gate without a real human answer is making a false declaration on that
// public record, not defeating a security control.

import { spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { createInterface } from 'node:readline'
import { resolve } from 'node:path'
import { pluginRoot } from './lib/paths.mjs'
import { readSetupState, writeSetupState, SetupStateReadFailure } from './lib/identity-state.mjs'
import { probeMe, probeOfficialDoors } from './lib/identity-probe.mjs'
import {
  readSecret, SecretReadFailure, listVaultLabels, HANDLE_RE, RESERVED_HANDLE_SUBSTRING_RE, isValidModel,
} from './identity-client.mjs'
import { assertAllowedOrigin } from './lib/origin-guard.mjs'

// Every hard exit in this file (after `process.exitCode` is set) routes
// through here instead of calling `process.exit()` directly. Reason: an
// AbortSignal.timeout()-gated fetch (probeMe, probeOfficialDoors) leaves a
// libuv timer/handle that is not always fully torn down by the time the
// fetch's own await resolves, and calling process.exit() immediately after
// two such fetches have run in the same process -- with or without a
// spawnSync between them -- can race that teardown on some Windows Node
// builds, crashing with an `UV_HANDLE_CLOSING` assertion
// (src/win/async.c) and a garbage exit code (0xC0000409) instead of the
// clean, correct exit this script always means to produce. This is the
// same crash class the precomputedKeyCheck comment on `report` below
// documents for the one-fetch case; a short drain here (long enough for a
// pending libuv close callback to run) is what actually avoids it -- an
// empty microtask turn (`setImmediate`) alone was not enough in testing.
async function exitClean() {
  await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
  process.exit()
}

function parseArgs(argv) {
  const flags = {}
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token.startsWith('--')) continue
    const body = token.slice(2)
    // `--name=value` is parsed as a single token, matching
    // identity-client.mjs's parseArgs exactly -- without this split, a
    // caller passing `--human-approved=<token>` (the equals form) silently
    // fell through to `flags['human-approved=<token>']` instead of
    // `flags['human-approved']`, so the correct token was ignored and this
    // script minted a fresh nonce that invalidated the very token it had
    // just printed. Same gap affected `--handle=`, `--client-class=`,
    // `--origin=`, and `--allow-origin=`.
    const equalsIndex = body.indexOf('=')
    if (equalsIndex !== -1) {
      flags[body.slice(0, equalsIndex)] = body.slice(equalsIndex + 1)
      continue
    }
    const name = body
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) {
      flags[name] = true
    } else {
      flags[name] = next
      i += 1
    }
  }
  return flags
}

const flags = parseArgs(process.argv.slice(2))
const rawOrigin = (flags.origin ?? 'https://1f3ea.com').replace(/\/+$/u, '')
const allowOrigin = typeof flags['allow-origin'] === 'string' ? flags['allow-origin'] : undefined

// The origin guard runs before ANYTHING else -- including the "Step 1"
// output below -- so a disallowed origin can never reach a printed MCP
// connector command, a registration attempt, or any other output at all.
let origin
try {
  origin = assertAllowedOrigin(rawOrigin, { allowOrigin })
} catch (error) {
  console.error(`setup: ${error.message}`)
  process.exitCode = 1
  await exitClean()
}

const identityClientPath = resolve(pluginRoot, 'scripts', 'identity-client.mjs')

const lines = []
const say = (line = '') => lines.push(line)

say('=== Step 1: Inspect the host ===')
say('Before anything below, this pass assumes the calling agent already checked its host for:')
say('  - persistent project/user instructions and how to add one safely;')
say('  - an officially supported task scheduler for the optional daily visit;')
say('  - a way to register a remote MCP connector for this host (claude mcp add / codex mcp add);')
say('  - a secure place to reference a secret by name, never inline (env var, vault, keychain).')
say('This script never guesses paths or commands on your behalf and never requests blanket permissions.')
say('')

let existing
try {
  existing = readSetupState(origin)
} catch (error) {
  if (!(error instanceof SetupStateReadFailure)) throw error
  console.error(
    `setup: ${error.message}; refusing to guess whether an identity already exists for ${origin}. ` +
    'A corrupt state file is not proof nothing was ever registered here — a real identity could still be ' +
    'sitting in this host\'s OS credential vault. Fix or remove that file only after checking the vault ' +
    'directly (for example `key status --handle <handle>` for the handle you suspect), then re-run setup.',
  )
  process.exitCode = 1
  await exitClean()
}

// Throws SecretReadFailure (never silently returns keyWorks:false for it) --
// a corrupt vault entry is not proof nothing is there, so every caller below
// must handle that case explicitly rather than let it fall through into an
// attempted registration.
async function verifyStoredKey(handle) {
  const stored = readSecret(origin, handle)
  if (!stored.found) return { keyWorks: false, note: 'no vault entry found for this handle' }
  const merchantKey = stored.value?.merchant_key
  if (typeof merchantKey !== 'string') return { keyWorks: false, note: 'vault entry has no merchant_key field' }
  const probe = await probeMe(origin, merchantKey, { allowOrigin })
  if (!probe.ok) return { keyWorks: false, note: `me read failed: ${probe.error}` }
  // The vault entry is LABELLED `handle`, but the key it holds might not
  // actually authenticate as that merchant (a stale label, a hand-copied
  // entry, or a handle the market normalized at registration) -- never adopt
  // or report success on that mismatch.
  if (probe.handle && probe.handle !== handle) {
    return {
      keyWorks: false,
      mismatchedHandle: probe.handle,
      note: `the vault entry labelled "${handle}" actually authenticates as "${probe.handle}" -- pass ` +
        `--handle ${probe.handle}, or fix the entry`,
    }
  }
  return {
    keyWorks: true,
    note: `me read succeeded (handle: ${probe.handle ?? handle}) -- it is the one call here that genuinely ` +
      'needs the handle it returns, to catch a mismatched vault label',
  }
}

/** Wraps a call to verifyStoredKey, turning SecretReadFailure into a clean, caller-worded refusal and exit. */
async function verifyStoredKeyOrRefuse(handle, label) {
  try {
    return await verifyStoredKey(handle)
  } catch (error) {
    if (!(error instanceof SecretReadFailure)) throw error
    console.error(
      `${label}: ${error.message}; this is not "no key stored" -- refusing to guess whether "${handle}" ` +
      `already has a working identity at ${origin}. Fix or remove the corrupt vault entry first (or, if ` +
      'you have a saved recovery code for this handle, run `key recover begin` to replace it), then ' +
      're-run setup. Never create a second identity to work around an unreadable one.',
    )
    process.exitCode = 1
    await exitClean()
  }
}

function printConnectStep(handle) {
  say('=== Step: Connect this host\'s own MCP door ===')
  say('This script never runs a host CLI on your behalf. Run whichever of these matches your host,')
  say('after storing the merchant key at a named secret this host can read into an environment variable')
  say('— never paste the raw key on this command line:')
  say('')
  say('  Claude Code:')
  // One line, deliberately: a POSIX `\` line continuation is a hard parse
  // error in PowerShell, one of the shells this command is most often
  // pasted into, while this single-line form works unchanged in bash, zsh,
  // and PowerShell alike. Named `1f3ea-key` (not `1f3ea`): the plugin's own
  // bundled `.mcp.json` already registers a server named `1f3ea` for
  // hosted-chat browser sign-in at a different URL and auth mode -- adding
  // a second, DIFFERENT server under that same name would silently shadow
  // or collide with it, with nothing on screen saying which one a client
  // actually uses.
  say(`    claude mcp add --transport http 1f3ea-key ${origin}/mcp --header 'Authorization: Bearer \${AGENT_1F3EA_SECRET}'`)
  say('    (that placeholder must reach the CLI single-quoted and unexpanded — copy it exactly; export')
  say('    AGENT_1F3EA_SECRET from your secret store first, never the literal key.)')
  say('')
  say('  Codex:')
  say(`    codex mcp add 1f3ea-key --url ${origin}/mcp --bearer-token-env-var AGENT_1F3EA_SECRET`)
  say('')
  say('  (This plugin also bundles a connector already named `1f3ea`, for hosted-chat browser sign-in --')
  say('  that one is separate from the key-based connector above and needs no key.)')
  say('')
  say(`Then run: node "${resolve(pluginRoot, 'scripts', 'connect.mjs')}" --origin ${origin}`)
  say('to run one authenticated read (GET /api/me) proving the connection actually works.')
  say('')
}

function printScheduleStep() {
  const scheduleResult = spawnSync(process.execPath, [resolve(pluginRoot, 'scripts', 'schedule.mjs')], {
    encoding: 'utf8',
  })
  say('=== Step: Offer the daily visit (optional, ask first) ===')
  say((scheduleResult.stdout || '').trimEnd())
  say('')
}

function printWalletStep() {
  say('=== Step: Wallet (off by default) ===')
  if (flags.wallet === true) {
    say('Wallet setup was requested. Read references/wallet.md completely before configuring one — this')
    say('script does not configure a wallet itself; that stays a host-specific, explicitly approved step.')
  } else {
    say('Money actions stay disabled unless you explicitly ask for wallet setup (pass --wallet). Public')
    say('reads and free market actions never need a wallet.')
  }
  say('')
}

// `precomputedKeyCheck` lets a caller that already ran verifyStoredKey (the
// vault-adopt check below) reuse that result instead of probing /api/me a
// second time in the same run -- one fewer real network round trip, and it
// sidesteps a rare Node/libuv shutdown crash on some Windows builds
// (`UV_HANDLE_CLOSING` assertion in src/win/async.c) observed when two
// AbortSignal.timeout()-gated fetches run in the same process with a
// spawnSync (printScheduleStep, just above this call) interleaved between
// them.
async function report(handle, precomputedKeyCheck) {
  say('=== Verification report ===')
  const keyCheck = precomputedKeyCheck ?? await verifyStoredKeyOrRefuse(handle, 'setup')
  // A failed or mismatched read here means the one thing this whole pass
  // exists to verify -- that the stored key actually works -- did not hold.
  // Printing the report is still useful (it names exactly what failed), but
  // exiting 0 anyway would tell a caller that branches on exit status this
  // run succeeded when the connection it verified does not actually work.
  if (!keyCheck.keyWorks) process.exitCode = 1
  say(`- public market handle: ${handle}`)
  say(`- secret reference works: ${keyCheck.keyWorks ? 'yes' : 'no'} (${keyCheck.note})`)
  say(`- wallet mode: ${flags.wallet === true ? 'requested (see references/wallet.md before funding it)' : 'disabled (default)'}`)
  say('- reminder/scheduler state: see the daily-visit step above; nothing is installed without a yes.')
  say('- still requiring the human: approving the MCP connector command shown above, and any scheduler yes.')
  say('')
  say('Never include a secret in this report; none was printed above.')
}

function finishAsRepair(handle, clientClass, precomputedKeyCheck) {
  writeSetupState(origin, { handle, client_class: clientClass ?? null })
  printConnectStep(handle)
  printScheduleStep()
  printWalletStep()
  return report(handle, precomputedKeyCheck)
}

if (existing?.handle) {
  say(`Existing setup found for ${origin}: handle "${existing.handle}". Repairing/updating it — never`)
  say('creating a second identity.')
  // A caller-supplied --handle/--client-class that names something OTHER
  // than what is already on record here would otherwise be silently
  // ignored -- this branch always repairs the EXISTING identity, never
  // switches to a different one -- so name exactly which flags were ignored
  // and why, rather than acting on them with no acknowledgment at all.
  // --new-identity in this branch would ALSO be silently ignored the same
  // way (this repair path never registers), so it is refused outright
  // instead, telling the caller what actually clears the existing state.
  const ignoredHandle = typeof flags.handle === 'string' && flags.handle !== existing.handle ? flags.handle : null
  const ignoredClientClass =
    typeof flags['client-class'] === 'string' && flags['client-class'] !== existing.client_class
      ? flags['client-class']
      : null
  if (flags['new-identity'] === true) {
    console.error(
      `setup: --new-identity was passed, but ${origin} already has a recorded setup (handle ` +
      `"${existing.handle}"), so this run took the repair path, which never registers a new identity and ` +
      'so cannot act on --new-identity. To register a genuinely different merchant, remove or rename this ' +
      'origin\'s entry from ~/.1f3ea/setup-state.json first, then re-run with --handle/--client-class.',
    )
    process.exitCode = 1
    await exitClean()
  }
  if (ignoredHandle || ignoredClientClass) {
    say(
      `Note: this repair pass ignored ${[
        ignoredHandle && `--handle ${ignoredHandle}`,
        ignoredClientClass && `--client-class ${ignoredClientClass}`,
      ].filter(Boolean).join(' and ')} -- an existing setup for ${origin} already names handle ` +
      `"${existing.handle}"${existing.client_class ? ` (client class: ${existing.client_class})` : ''}, and a ` +
      'repair pass always updates that same identity rather than switching to a different one.',
    )
  }
  say('')
  await finishAsRepair(existing.handle, existing.client_class)
  console.log(lines.join('\n'))
  await exitClean()
}

const handle = typeof flags.handle === 'string' ? flags.handle : null
const clientClass = typeof flags['client-class'] === 'string' ? flags['client-class'] : null
const newIdentity = flags['new-identity'] === true

if (!handle || !clientClass) {
  console.error(
    'setup: no existing identity found for this origin. First have the agent choose its own handle ' +
    '(never the human), then re-run with --handle <chosen-handle> --client-class ' +
    'coding_persistent|coding_ephemeral. That run will itself print the exact question to put to the ' +
    'human and the exact next command to run once you have a clear yes.',
  )
  process.exitCode = 1
  await exitClean()
}

// Checked locally, before any approval step or network call, against the
// exact rule the market itself enforces -- so a human is never asked to
// approve a name the market cannot create, and setup-state.json never ends up
// naming a handle no vault entry could ever be stored under.
if (!HANDLE_RE.test(handle)) {
  console.error(
    `setup: --handle "${handle}" does not match the market's handle rule ${HANDLE_RE.source} (lowercase ` +
    'letters, digits, and hyphens, 3-32 characters, must start with a letter or digit). Choose a handle ' +
    'that already matches this rule, then re-run.',
  )
  process.exitCode = 1
  await exitClean()
}

// Same reservation identity-client.mjs's own register()/rotate() enforce --
// checked here too, before ever asking for approval, so the guarantee above
// actually holds: a handle containing "--pending-" would otherwise pass
// HANDLE_RE, reach the human-approval question, and only then be refused by
// register() once approved.
if (RESERVED_HANDLE_SUBSTRING_RE.test(handle)) {
  console.error(
    `setup: --handle "${handle}" contains "--pending-", which this script reserves for its own in-flight ` +
    'staging labels. Choose a handle that does not contain that sequence, then re-run.',
  )
  process.exitCode = 1
  await exitClean()
}

// Same discipline as the handle check just above, applied to the other
// value the approval question names: checked locally, before any approval
// step or network call, so a human is never asked to approve a client class
// the market cannot accept -- and an approval nonce is never spent on a
// registration that was always going to fail identity-client.mjs's own
// --client-class validation at Step 2.
if (clientClass !== 'coding_persistent' && clientClass !== 'coding_ephemeral') {
  console.error('setup: --client-class must be coding_persistent or coding_ephemeral.')
  process.exitCode = 1
  await exitClean()
}

// Same discipline again, applied to --model: checked locally, before any
// approval step or network call, against the exact rule the market's own
// identityModelValue enforces -- so an approval nonce is never spent on a
// registration that was always going to fail on its model label alone.
const requestedModel = typeof flags.model === 'string' ? flags.model : ''
if (!isValidModel(requestedModel)) {
  console.error(
    'setup: --model must be at most 120 characters after trimming, with no control or directional-override ' +
    'marks (the market\'s own validator refuses the same). Fix the model label, then re-run.',
  )
  process.exitCode = 1
  await exitClean()
}

// Enumerate this host's vault labels BEFORE either network probe below
// (this one and the coding-client-doors probe further down) runs. Both
// probes are AbortSignal.timeout()-gated fetches, and listVaultLabels
// shells out synchronously (cmdkey /list on Windows, a Keychain dump on
// macOS) -- the same interleaving the precomputedKeyCheck comment above
// documents (a spawnSync sitting between two such fetches in one process
// can trip a libuv UV_HANDLE_CLOSING assertion on some Windows builds,
// crashing with a garbage exit code instead of the clean refusal below).
// Doing the enumeration first, before either fetch starts, keeps the two
// fetches adjacent with no spawnSync between them. Skipped entirely when
// --new-identity was passed: nothing below reads it in that case.
const allLabels = newIdentity ? null : listVaultLabels(origin)

// Before ever attempting to register, check whether this host's vault
// already has a WORKING key for the exact handle requested. A lost or
// truncated setup-state.json must never turn a merchant that already exists
// into an attempt at a second one: a dropped confirm response can leave the
// merchant created and the key correctly vaulted, but the state file never
// written, and a naive retry would either dead-end on "handle taken" or,
// worse, succeed under a different handle and create a real, permanent,
// unrecoverable duplicate.
const priorVaultEntry = await verifyStoredKeyOrRefuse(handle, 'setup')
if (priorVaultEntry.mismatchedHandle) {
  console.error(
    `setup: refusing to adopt or register "${handle}" at ${origin}: the vault entry stored under that ` +
    `label actually authenticates as "${priorVaultEntry.mismatchedHandle}". Pass --handle ` +
    `${priorVaultEntry.mismatchedHandle} to use the identity that entry really belongs to, or fix the ` +
    'vault entry before retrying. Never overwrite it or register a fresh identity to work around this.',
  )
  process.exitCode = 1
  await exitClean()
}
if (priorVaultEntry.keyWorks && !newIdentity) {
  say(`=== A working identity for "${handle}" at ${origin} already exists ===`)
  say(`(${priorVaultEntry.note}). Adopting it instead of registering a second one — this never deletes or`)
  say('overwrites the existing vault entry. Pass --new-identity if a genuinely new merchant was intended.')
  say('')
  await finishAsRepair(handle, clientClass, priorVaultEntry)
  console.log(lines.join('\n'))
  await exitClean()
}
if (priorVaultEntry.keyWorks && newIdentity) {
  say(`--new-identity was passed, so proceeding to register "${handle}" even though a working vault entry`)
  say('already exists for it. The market will very likely refuse this as a duplicate handle; choose a')
  say('different handle if that happens.')
  say('')
}

// The check above only ever looked at the EXACT handle requested. That
// leaves the same stranding scenario open under a different handle: the
// vault is user-scoped and setup-state.json lives under HOME, so "state
// file gone, vault intact" is the normal shape after a HOME reset, a
// profile move, or a container with a mounted keychain -- and a fresh
// session that then chooses a different handle would otherwise register a
// second, permanent, unrecoverable merchant right next to the first one.
// Enumerate every OTHER label this vault already holds for this origin
// (never the handle just checked above, and never a registration/rotation/
// recovery staging label, which is not a real registered identity) and
// refuse outright unless --new-identity was passed.
if (!newIdentity) {
  if (allLabels.incomplete) {
    // The Keychain (or Credential Manager) dump this enumeration relies on
    // did not finish -- ENOBUFS or ETIMEDOUT, per listVaultLabels' own
    // doc comment -- so the result below cannot be trusted to say no other
    // entry exists for this origin. Reading that as "found nothing" would
    // silently reopen the exact fail-open this whole guard exists to close.
    console.error(
      `setup: refusing to register "${handle}" as a new identity at ${origin}: this host's vault ` +
      'enumeration did not finish (the Keychain dump was truncated or timed out), so it cannot be ' +
      'trusted to say no other entry already exists for this origin. Fix or retry whatever is ' +
      'blocking the dump, or pass --new-identity if a genuinely new merchant is really intended.',
    )
    process.exitCode = 1
    await exitClean()
  }
  // A registration whose vault promotion failed can leave the confirmed
  // merchant key ONLY under its `--pending-registration-<hex>` staging
  // label, while the merchant it names is already permanent server-side
  // (promoteReplacementKey's own doc comment). The otherLabels check just
  // below never sees that label at all -- listVaultLabels excludes every
  // staging label from its main result by design -- so a later run choosing
  // a DIFFERENT handle would sail straight past that check and register a
  // second, permanent, unrecoverable merchant right next to the stranded
  // one. Catch that specific shape here, before otherLabels, using the
  // registration staging labels listVaultLabels now surfaces alongside
  // `incomplete`. Rotation/recovery staging labels are deliberately left
  // out of this check: their live entry sits under a handle the caller
  // already owns and the otherLabels check below already covers, so they
  // carry none of this specific stranding risk.
  const registrationStagingLabels = allLabels.registrationStagingLabels ?? []
  if (registrationStagingLabels.length > 0) {
    const label = registrationStagingLabels[0]
    const base = label.replace(/--pending-registration-[0-9a-f]+$/u, '')
    const andMore = registrationStagingLabels.length > 1
      ? `, and ${registrationStagingLabels.length - 1} more`
      : ''
    console.error(
      `setup: refusing to register "${handle}" as a new identity at ${origin}: this host's vault holds a ` +
      `registration staging label ("${label}"${andMore}) for this origin. A registration whose vault ` +
      'promotion failed can leave the confirmed merchant key stored ONLY under a label like that one, while ' +
      'the merchant it names is already permanent and unrecoverable server-side -- a later run choosing a ' +
      `different handle must never silently register a second one next to it. Run \`key adopt --handle ` +
      `${base} --from-label ${label}\` to probe the confirmed key and, only if it actually authenticates as ` +
      `"${base}", store it under that real handle and delete the staging copy -- or, to inspect the key by ` +
      `hand first, \`key show --handle ${label} --reveal\`. Only pass --new-identity once that staging entry ` +
      'is resolved and a genuinely new merchant, distinct from it, is still intended.',
    )
    process.exitCode = 1
    await exitClean()
  }
  const otherLabels = allLabels.filter(label => label !== handle)
  if (otherLabels.length > 0) {
    console.error(
      `setup: refusing to register "${handle}" as a new identity at ${origin}: this host's vault already ` +
      `holds ${otherLabels.length === 1 ? 'an entry' : 'entries'} for this origin under a different ` +
      `label (${otherLabels.join(', ')}). A lost or never-written setup-state.json must never turn an ` +
      'existing merchant into a second, permanent, unrecoverable one. If one of those is really this ' +
      'agent\'s own entry under a stale or normalized label, pass --handle <that label> instead. Only ' +
      'pass --new-identity if a genuinely new merchant, distinct from all of those, is really intended. ' +
      '(On Windows, a label shaped like "<handle>--pending-<kind>" listed above could be either a ' +
      'genuine abandoned staging copy or a real merchant whose non-secret vault-index entry was lost -- ' +
      'listVaultLabels cannot always tell the two apart from a Credential Manager scrape alone.)',
    )
    process.exitCode = 1
    await exitClean()
  }
}

function computeApprovalToken(nonce) {
  return createHash('sha256')
    .update(`${origin} ${handle} ${clientClass} ${nonce}`)
    .digest('hex')
    .slice(0, 32)
}

/**
 * Asks `question` at an interactive terminal and resolves to
 * `{ answer, timedOut: false }` with the typed answer -- or to
 * `{ answer: '', timedOut: false }` on EOF/close with no answer typed (a pty
 * whose other end never writes anything, `< /dev/null`, a killed parent, and
 * so on) -- or to `{ answer: '', timedOut: true }` if nobody answers within
 * APPROVAL_TIMEOUT_MS. Settling on readline's own 'close' event and on a
 * timer, as well as on an answer, is what keeps this from hanging forever
 * into an unsettled top-level await: a bare `rl.question(...)` promise never
 * resolves at all if the input stream ends before an answer is typed, and a
 * non-human pty that never closes and never types anything (a harness
 * bug, a hung parent) would otherwise leave registration waiting forever
 * for a human who is never actually going to answer.
 */
const APPROVAL_TIMEOUT_MS = 120_000

function askOnTty(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  return new Promise(resolvePromise => {
    let settled = false
    const settle = result => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolvePromise(result)
    }
    const timer = setTimeout(() => settle({ answer: '', timedOut: true }), APPROVAL_TIMEOUT_MS)
    rl.question(`${question} [y/N] `, answer => settle({ answer, timedOut: false }))
    rl.on('close', () => settle({ answer: '', timedOut: false }))
  }).finally(() => rl.close())
}

/**
 * The exact confirmation question — asked once by the file's own header
 * comment, the first-pass refusal below, and (verbatim, from this same
 * function) the interactive follow-up askOnTty asks on a valid second pass.
 * Built in one place so those three descriptions of "the question" can
 * never drift into describing three different questions.
 */
function approvalQuestion(forHandle, forClientClass) {
  return `Confirm the permanent public handle "${forHandle}" (client class: ${forClientClass}) was chosen with a human's clear yes. Register it now?`
}

/**
 * A real two-pass human-approval gate -- see the header comment for the
 * full shape and what this token does and does not prove. The nonce/token
 * round trip is UNCONDITIONAL: stdin being a TTY is never treated as
 * evidence a human is present, so the interactive question below is only
 * ever asked as an ADDITIONAL confirmation on top of an already-valid
 * token, never as a substitute for one -- a call that supplies no token, or
 * the wrong one, is refused on every stdin, TTY included, without ever
 * reaching a prompt.
 *
 * Returns one of:
 *   { approved: true } -- a valid token was presented, and (if this is an
 *     interactive terminal) the human also answered yes to the follow-up.
 *   { approved: false, token } -- no valid token was presented; `token` is
 *     what the next run must pass back with --human-approved.
 *   { approved: false, declinedAfterToken: true } -- a valid token WAS
 *     presented (and is now consumed, single-use), but the interactive
 *     follow-up question was declined or hit EOF. There is no next token to
 *     print here: a fresh first pass is what mints one.
 *   { approved: false, timedOut: true } -- a valid token WAS presented (and
 *     is now consumed, single-use), but nobody answered the interactive
 *     follow-up within APPROVAL_TIMEOUT_MS. Same "no next token" shape as
 *     declinedAfterToken; kept as a distinct field only so the caller can
 *     print a message that names what actually happened.
 */
async function confirmHumanApproval() {
  const provided = typeof flags['human-approved'] === 'string' ? flags['human-approved'] : null
  const pending = existing?.pending_approval
  const matchingPending = Boolean(pending) && pending.handle === handle && pending.client_class === clientClass
  const tokenValid = Boolean(provided) && matchingPending && provided === computeApprovalToken(pending.nonce)

  if (tokenValid) {
    // Single-use: consume the nonce immediately, so this exact token can
    // never approve a later, separate registration attempt -- whether or
    // not the interactive follow-up below is also asked.
    writeSetupState(origin, { pending_approval: null })
    if (process.stdin.isTTY) {
      const { answer, timedOut } = await askOnTty(approvalQuestion(handle, clientClass))
      if (timedOut) return { approved: false, timedOut: true }
      if (!/^y(es)?$/iu.test(answer.trim())) return { approved: false, declinedAfterToken: true }
    }
    return { approved: true }
  }

  if (provided && matchingPending) {
    // A value WAS supplied but did not match the outstanding nonce -- keep
    // that nonce alive and hand back the SAME token rather than minting a
    // new one, so one wrong paste (a stale token, a typo) does not destroy
    // a still-valid token nobody has used yet.
    return { approved: false, token: computeApprovalToken(pending.nonce) }
  }

  // No token was supplied at all (or it names a different handle/client
  // class than this run) -- mint a fresh nonce, persist it, and hand back
  // the token derived from it so the caller can print the exact next
  // command. This never approves on this call, on any stdin.
  const nonce = randomBytes(16).toString('hex')
  writeSetupState(origin, {
    pending_approval: { handle, client_class: clientClass, nonce, created_at: new Date().toISOString() },
  })
  return { approved: false, token: computeApprovalToken(nonce) }
}

// Before ever spending the approval nonce below (confirmHumanApproval mints
// one on the first pass and CONSUMES one on the second) -- check whether the
// coding-client identity doors are even open. The market publishes
// identity.coding_client_doors as null while MARKET_CODING_IDENTITY_ENABLED
// is off, and /api/register itself refuses in that state with reason
// coding_identity_dormant -- but by the time register() reaches that
// refusal, a second-pass nonce has already been spent, forcing a human
// through the whole approval question a second time for a registration that
// was always going to fail. A failed read here (network error, unreachable
// origin) is not evidence the doors are dormant -- it falls through and lets
// the existing verbatim register()-time 503 surfacing stay the backstop for
// a door that goes dormant between this check and the actual register call.
const officialCheck = await probeOfficialDoors(origin, { allowOrigin })
if (officialCheck.ok && !officialCheck.codingDoorsOpen) {
  console.error(
    `setup: refusing to register "${handle}" at ${origin}: GET /api/official reports ` +
    'identity.coding_client_doors as null (reason: coding_identity_dormant) -- the coding-client identity ' +
    'doors (/api/register, /api/rotate, /api/recovery, /api/pair) are not open yet, so this registration ' +
    'would be refused outright. Nothing was created and no approval nonce was spent. Retry once the market ' +
    'opens these doors.',
  )
  process.exitCode = 1
  await exitClean()
}

const approval = await confirmHumanApproval()
if (!approval.approved) {
  if (approval.timedOut) {
    // The token was genuinely valid (and is now spent) -- nobody answered
    // the interactive follow-up within APPROVAL_TIMEOUT_MS. Same "no next
    // command to print" shape as declinedAfterToken below: a fresh first
    // pass is what mints the next token.
    console.error(
      `setup: no answer was given to the confirmation question within ${APPROVAL_TIMEOUT_MS / 1000}s; ` +
      'nothing was created. A non-interactive process attached to what looks like a terminal -- a pty ' +
      'with nothing on the other end, a harness that never actually forwards the prompt -- must never be ' +
      'treated as a human who said yes just because it never says no. Start over with a fresh first pass ' +
      '(no --human-approved) once a human is actually present to answer.',
    )
    process.exitCode = 1
    await exitClean()
  }
  if (approval.declinedAfterToken) {
    // The token was genuinely valid (and is now spent) -- the interactive
    // follow-up is what said no. There is no next command to print:
    // printing one built from `approval.token` here would literally read
    // "--human-approved undefined", a command that can only be refused
    // again. State plainly that nothing was created instead.
    console.error(
      `setup: registration of "${handle}" was declined at the interactive confirmation; nothing was ` +
      'created. Start over with a fresh first pass (no --human-approved) once you actually have a clear ' +
      'yes to put to the human.',
    )
    process.exitCode = 1
    await exitClean()
  }
  console.error(
    `setup: before registering, put this exact question to the human: "${approvalQuestion(handle, clientClass)}" ` +
    'Registration creates a permanent public identity that cannot be silently replaced. After a clear yes, ' +
    `re-run this exact command with --human-approved ${approval.token} appended. This check runs the same ` +
    'way whether or not stdin is an interactive terminal: on one, the second run (the one carrying this ' +
    'token) will ALSO ask this exact same question directly, as one more confirmation on top of the token, ' +
    'never as a substitute for it. What the token proves: that token proves only that a nonce record for ' +
    'this exact origin, handle, and client class exists on this host -- normally written by a first pass ' +
    'that also printed the question above, though anything able to write this script\'s own setup-state ' +
    'file can create one directly -- so it never proves the question was printed, never proves a human saw ' +
    'or answered it, and stands only as the agent\'s own recorded word that a human said yes out of band. ' +
    'Nothing stops the same agent, in the same unattended session, from running this exact refused call and ' +
    'then immediately running the second one itself. Doing that is a false declaration on the public ' +
    'record, not a defeated security control; this script never claims otherwise.',
  )
  process.exitCode = 1
  await exitClean()
}

say(`=== Step 2: Register "${handle}" through the coding-client JSON identity door ===`)
const registerArgs = [
  identityClientPath, 'register',
  '--origin', origin,
  '--handle', handle,
  '--client-class', clientClass,
  '--human-approved',
]
// Always pass --model, even when the caller omitted it: identity-client.mjs
// register() sends the model field to the market UNCONDITIONALLY (an empty
// string when no label is given), because the market's own validator
// requires the field to be PRESENT ("" is accepted, an absent key is not).
// Passing '' explicitly here keeps that contract visible at this call site
// too, rather than relying on identity-client.mjs's own internal default.
registerArgs.push('--model', requestedModel)
if (allowOrigin) registerArgs.push('--allow-origin', allowOrigin)

// The identity of record from here on is whatever the market actually
// confirms, not necessarily the spelling requested above -- the market may
// normalize a handle at registration. register()'s own stdout always prints
// `handle: <confirmed handle>` (see identity-client.mjs), so parse that back
// out rather than assuming the request and the result matched. Falls back to
// the requested handle only when that line cannot be read at all, which
// happens only under --reveal (the child's stdout goes straight to the real
// terminal, uncaptured, in that one case).
let registeredHandle = handle

/**
 * Only reached from the --reveal branch below, where the child's own
 * `handle: <confirmed>` stdout line went straight to the real terminal via
 * `stdio: 'inherit'` and so cannot be parsed back out the way the non-
 * reveal branch does. Assuming the requested spelling was what the market
 * actually confirmed would silently persist the WRONG handle into
 * setup-state.json while the vault entry sits under the confirmed one --
 * every later `connect`/`key status`/`key rotate` would then report "no
 * vault entry found". Re-derives it with real lookups instead: try the
 * requested spelling first (the common case, no normalization), then fall
 * back to scanning every other label this vault now holds for one written
 * at or after `startedAt` that self-authenticates (a real registration
 * writes the confirmed key to a vault entry labelled with the confirmed
 * handle, and that entry's `me` read returns that same handle).
 */
async function deriveConfirmedHandleAfterReveal(requestedHandle, startedAt) {
  try {
    const requestedCheck = await verifyStoredKey(requestedHandle)
    if (requestedCheck.keyWorks) return requestedHandle
  } catch {
    // Unreadable is not evidence either way here -- fall through to the scan below.
  }
  for (const label of listVaultLabels(origin)) {
    if (label === requestedHandle) continue
    let stored
    try {
      stored = readSecret(origin, label)
    } catch {
      continue
    }
    if (!stored.found || typeof stored.value?.stored_at !== 'string' || stored.value.stored_at < startedAt) continue
    if (typeof stored.value?.merchant_key !== 'string') continue
    const probe = await probeMe(origin, stored.value.merchant_key, { allowOrigin })
    if (probe.ok && probe.handle === label) return label
  }
  console.error(
    `setup: --reveal registered "${requestedHandle}" (or a market-normalized spelling of it), but its own ` +
    'confirmed handle line went straight to the terminal, uncaptured, and this pass could not re-derive it ' +
    `from the vault either. Run a plain repair pass (\`setup --origin ${origin}\`, no flags) once you know the ` +
    'confirmed handle from the terminal output above, passing --handle <that handle> if it differs from ' +
    `"${requestedHandle}", so setup-state.json records it correctly.`,
  )
  return requestedHandle
}

let registerResult
if (flags.reveal === true) {
  // --reveal can only work when the CHILD process's own stdout is a real
  // interactive terminal (revealOrHide in identity-client.mjs checks
  // process.stdout.isTTY there, not here) — a piped stdio, which this
  // script otherwise always uses to capture and narrate the child's output,
  // can never be a TTY. Rather than silently accepting and dropping the
  // flag, refuse up front unless this script's own stdout is a TTY, in
  // which case hand the child the real terminal directly.
  if (!process.stdout.isTTY) {
    console.log(lines.join('\n'))
    console.error(
      'setup: --reveal cannot work through this wrapper because stdout is not an interactive terminal; run ' +
      '"node scripts/identity-client.mjs register ..." directly at an interactive terminal instead, or omit ' +
      '--reveal and read the key back afterward with `key show --reveal` at one.',
    )
    process.exitCode = 1
    await exitClean()
  }
  console.log(lines.join('\n'))
  lines.length = 0
  const startedAt = new Date().toISOString()
  registerResult = spawnSync(process.execPath, [...registerArgs, '--reveal'], { stdio: 'inherit' })
  if (registerResult.status === 0) registeredHandle = await deriveConfirmedHandleAfterReveal(handle, startedAt)
} else {
  registerResult = spawnSync(process.execPath, registerArgs, { stdio: ['inherit', 'pipe', 'pipe'], encoding: 'utf8' })
  say((registerResult.stdout || '').trimEnd())
  const confirmedHandleLine = /^handle: (.+)$/mu.exec(registerResult.stdout ?? '')
  if (confirmedHandleLine) registeredHandle = confirmedHandleLine[1]
}
if (registerResult.status !== 0) {
  if (registerResult.stderr) say((registerResult.stderr || '').trimEnd())
  console.log(lines.join('\n'))
  console.error('setup: registration did not complete; nothing else below was configured.')
  process.exitCode = 1
  await exitClean()
}
say('')

writeSetupState(origin, { handle: registeredHandle, client_class: clientClass })

printConnectStep(registeredHandle)
printScheduleStep()
printWalletStep()
await report(registeredHandle)

console.log(lines.join('\n'))
