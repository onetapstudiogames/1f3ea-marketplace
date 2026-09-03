#!/usr/bin/env node
// `key` — status, rotate, recover, and show, all built on the vault helpers
// and the coding-client identity doors in scripts/identity-client.mjs.
// Never prints, logs, or returns a secret except `key show --reveal` at an
// interactive TTY.
//
// Usage:
//   node key.mjs status [--origin https://1f3ea.com] [--handle my-agent]
//   node key.mjs rotate [--origin ...] [--handle ...] [--client-class coding_persistent|coding_ephemeral] [--reveal]
//     (client-class defaults to whatever the stored vault entry already carries; pass it explicitly to change class)
//   node key.mjs recover generate [--origin ...] [--handle ...] [--reveal]
//   node key.mjs recover begin --recovery-code-file <path|-> [--origin ...] [--reveal]
//   node key.mjs show [--origin ...] [--handle ...] [--reveal]
//   node key.mjs adopt --handle my-agent --from-label <staging-label> [--origin ...]
//
// --origin must be https, and defaults to https://1f3ea.com; https://localhost
// is always allowed for local development. Any other https origin needs
// --allow-origin <that exact origin> too — see scripts/identity-client.mjs.

import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { pluginRoot } from './lib/paths.mjs'
import { readSetupState, SetupStateReadFailure } from './lib/identity-state.mjs'
import { probeMe } from './lib/identity-probe.mjs'
import {
  readSecret, SecretReadFailure, HANDLE_RE, promoteReplacementKey, LiveVaultEntryExistsError,
} from './identity-client.mjs'
import { assertAllowedOrigin } from './lib/origin-guard.mjs'

function parseArgs(argv) {
  const flags = {}
  const positionals = []
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token.startsWith('--')) {
      const body = token.slice(2)
      // `--name=value` is parsed as a single token, matching
      // identity-client.mjs's parseArgs -- without this split,
      // `--handle=x`/`--origin=x`/`--allow-origin=x`/`--recovery-code-file=x`
      // silently fell through to the (undefined) bare-flag name instead of
      // setting the flag.
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
    } else {
      positionals.push(token)
    }
  }
  return { flags, positionals }
}

const { flags, positionals } = parseArgs(process.argv.slice(2))
const rawOrigin = (flags.origin ?? 'https://1f3ea.com').replace(/\/+$/u, '')
const allowOrigin = typeof flags['allow-origin'] === 'string' ? flags['allow-origin'] : undefined

// The origin guard runs before ANYTHING else -- before status/rotate/
// recover/show ever touch the vault or the network for a disallowed origin.
let origin
try {
  origin = assertAllowedOrigin(rawOrigin, { allowOrigin })
} catch (error) {
  console.error(`key: ${error.message}`)
  process.exitCode = 1
  process.exit()
}

const identityClientPath = resolve(pluginRoot, 'scripts', 'identity-client.mjs')

function resolveHandle() {
  if (typeof flags.handle === 'string') return flags.handle
  const state = readSetupState(origin)
  return state?.handle ?? null
}

function requireHandle() {
  let handle
  try {
    handle = resolveHandle()
  } catch (error) {
    if (!(error instanceof SetupStateReadFailure)) throw error
    console.error(`key: ${error.message}; pass --handle <handle> explicitly, or fix that file first.`)
    process.exitCode = 1
    return null
  }
  if (!handle) {
    console.error('key: no handle known for this origin. Pass --handle <handle>, or run setup first.')
    process.exitCode = 1
    return null
  }
  return handle
}

function requireStoredKey(handle) {
  let stored
  try {
    stored = readSecret(origin, handle)
  } catch (error) {
    if (!(error instanceof SecretReadFailure)) throw error
    console.error(
      `key: ${error.message}; this is not "no key stored" -- refusing to guess. If you have a saved ` +
      'recovery code for this handle, use `key recover begin` to replace it; do not register a new identity.',
    )
    process.exitCode = 1
    return null
  }
  if (!stored.found || typeof stored.value?.merchant_key !== 'string') {
    console.error(`key: no vault entry found for "${handle}" at ${origin}.`)
    process.exitCode = 1
    return null
  }
  return stored.value.merchant_key
}

/**
 * Unlike the city's `key rotate` (which needs only the current key), the
 * market's own `/api/rotate` begin door also requires `client_class` (see
 * identity-client.mjs's rotate() comment) -- so this reads it back from the
 * same vault entry requireStoredKey above already found, falling back to
 * `--client-class` only when the stored entry predates that field or was
 * hand-edited. Returns `null` (after printing its own error) when neither
 * source has it, rather than guessing.
 */
function requireStoredClientClass(handle) {
  if (typeof flags['client-class'] === 'string') return flags['client-class']
  let stored
  try {
    stored = readSecret(origin, handle)
  } catch {
    stored = { found: false }
  }
  const clientClass = stored.found ? stored.value?.client_class : undefined
  if (typeof clientClass === 'string') return clientClass
  console.error(
    `key rotate: no client_class known for "${handle}" -- pass --client-class ` +
    'coding_persistent|coding_ephemeral explicitly.',
  )
  process.exitCode = 1
  return null
}

async function status() {
  const handle = requireHandle()
  if (!handle) return
  const merchantKey = requireStoredKey(handle)
  if (!merchantKey) return
  const probe = await probeMe(origin, merchantKey, { allowOrigin })
  console.log(`handle: ${handle}`)
  if (!probe.ok) {
    console.log(`stored key: does not work (${probe.error})`)
    process.exitCode = 1
    return
  }
  if (probe.handle && probe.handle !== handle) {
    console.log(
      `stored key: works, but authenticates as "${probe.handle}", not "${handle}" -- the vault entry ` +
      `labelled "${handle}" belongs to a different merchant. Pass --handle ${probe.handle} instead, or fix the entry.`,
    )
    process.exitCode = 1
    return
  }
  console.log('stored key: works (one me read succeeded).')
}

/**
 * The same probeMe label-vs-identity check status() runs above (and
 * connect.mjs runs before ever spawning `pair`) -- shared here so
 * rotate()/recoverGenerate() below run it too, before ever acting on a
 * `--handle`-resolved key: without it, a stale label, a hand-copied entry,
 * or a market-normalized handle would let rotate/recover generate silently
 * act on a DIFFERENT merchant than the one named, leaving the entry the
 * caller actually asked about holding a now-revoked key with no statement
 * that the wrong merchant was the one actually changed.
 *
 * Returns `true` when it is safe to proceed: either the probe confirms the
 * label matches, OR the probe could not complete at all (a bad/dead key, a
 * network error) -- in which case there is nothing this check can validate,
 * and the command below will surface its own error if the key truly does
 * not work. Returns `false`, having already printed the same core mismatch
 * message status() prints (prefixed here with "key: " and sent to stderr,
 * not status()'s stdout -- status() only ever REPORTS this mismatch, since
 * it has nothing else to do; this function actively REFUSES to let
 * rotate()/recoverGenerate() act on the key at all, so it is not truly the
 * identical wording, only the same underlying fact) and set
 * `process.exitCode`, only on a CONFIRMED mismatch.
 *
 * `label` (optional, e.g. "key rotate"), when passed, also discloses --
 * once, right after the probe -- that this GET /api/me read ran at all:
 * without it, rotate()/recoverGenerate() below made this same read
 * status() already discloses (skills/key/SKILL.md: "One authenticated
 * `GET /api/me` read; reports only whether the stored key works") with no
 * equivalent word said about rotate/recover generate doing the exact same
 * read first. This says only what the market's own /api/me read actually
 * does per identity-probe.mjs's own doc comment -- a single authenticated
 * read, nothing else -- never a claim about waking timers or advancing a
 * fee-credit marker, which is a DIFFERENT project's (the city's) /api/me,
 * not this market's.
 */
async function refuseOnHandleMismatch(handle, merchantKey, label) {
  const probe = await probeMe(origin, merchantKey, { allowOrigin })
  if (!probe.ok) {
    if (label) console.log(`${label}: one me read: FAILED (${probe.error}) -- proceeding, since there is nothing this check can validate.`)
    return true
  }
  if (probe.handle && probe.handle !== handle) {
    console.error(
      `key: stored key: works, but authenticates as "${probe.handle}", not "${handle}" -- the vault entry ` +
      `labelled "${handle}" belongs to a different merchant. Pass --handle ${probe.handle} instead, or fix the entry.`,
    )
    process.exitCode = 1
    return false
  }
  if (label) console.log(`${label}: one me read: OK (handle: ${probe.handle ?? handle}).`)
  return true
}

/**
 * Runs `node identity-client.mjs <args...>` with `merchantKey` piped in on
 * stdin. When --reveal was requested, this can only take effect if the
 * CHILD's own stdout is a real interactive terminal (revealOrHide there
 * checks process.stdout.isTTY on the child, not this wrapper) — a captured
 * pipe, which this function otherwise always uses so it can print or
 * re-throw the child's output itself, can never be a TTY. So --reveal here
 * either hands the child the real terminal directly (this wrapper's own
 * stdout must be a TTY too) or is refused up front, never silently dropped.
 */
function runIdentityClient(label, args, merchantKey) {
  if (flags.reveal === true) {
    if (!process.stdout.isTTY) {
      console.error(`${label}: --reveal cannot work through this wrapper; run scripts/identity-client.mjs ` +
        'directly at an interactive terminal.')
      process.exitCode = 1
      return
    }
    const result = spawnSync(process.execPath, [...args, '--reveal'], {
      input: merchantKey,
      stdio: [merchantKey === undefined ? 'inherit' : 'pipe', 'inherit', 'inherit'],
    })
    if (result.status !== 0) process.exitCode = 1
    return
  }
  const result = spawnSync(process.execPath, args, { input: merchantKey, encoding: 'utf8' })
  process.stdout.write(result.stdout || '')
  if (result.status !== 0) {
    process.stderr.write(result.stderr || `${label}: failed\n`)
    process.exitCode = 1
  }
}

async function rotate() {
  const handle = requireHandle()
  if (!handle) return
  const merchantKey = requireStoredKey(handle)
  if (!merchantKey) return
  if (!(await refuseOnHandleMismatch(handle, merchantKey, 'key rotate'))) return
  const clientClass = requireStoredClientClass(handle)
  if (!clientClass) return
  const args = [
    identityClientPath, 'rotate', '--origin', origin, '--client-class', clientClass, '--merchant-key-file', '-',
  ]
  if (allowOrigin) args.push('--allow-origin', allowOrigin)
  runIdentityClient('key rotate', args, merchantKey)
}

async function recoverGenerate() {
  const handle = requireHandle()
  if (!handle) return
  const merchantKey = requireStoredKey(handle)
  if (!merchantKey) return
  if (!(await refuseOnHandleMismatch(handle, merchantKey, 'key recover generate'))) return
  // The market's own /api/recovery `generate` action requires client_class
  // too (see identity-client.mjs's recoverGenerate comment) -- default it
  // from the same stored vault entry requireStoredKey above already found,
  // same as rotate() does.
  const clientClass = requireStoredClientClass(handle)
  if (!clientClass) return
  const args = [
    identityClientPath, 'recover', 'generate', '--origin', origin, '--client-class', clientClass, '--merchant-key-file', '-',
  ]
  if (allowOrigin) args.push('--allow-origin', allowOrigin)
  runIdentityClient('key recover generate', args, merchantKey)
}

/**
 * Unlike requireStoredClientClass above (used by rotate/recover generate,
 * both of which already have the current merchant key in hand and so
 * already know the handle), recovery begin is the path an agent reaches
 * only when its key -- and often the vault entry storing it -- is already
 * lost, so a stored client_class is often exactly what cannot be read back.
 * Tries the stored entry for a known handle first; falls back to requiring
 * --client-class explicitly rather than guessing.
 */
function resolveClientClassForRecoveryBegin() {
  if (typeof flags['client-class'] === 'string') return flags['client-class']
  let handle = null
  try {
    handle = resolveHandle()
  } catch {
    handle = null
  }
  if (handle) {
    let stored
    try {
      stored = readSecret(origin, handle)
    } catch {
      stored = { found: false }
    }
    if (stored.found && typeof stored.value?.client_class === 'string') return stored.value.client_class
  }
  console.error(
    'key recover begin: no client_class known -- pass --client-class coding_persistent|coding_ephemeral ' +
    'explicitly (the vault entry for a lost key is often exactly what cannot be read back).',
  )
  process.exitCode = 1
  return null
}

/**
 * Recover begin is reached precisely when the current key is often already
 * lost or dead, so unlike rotate()/recoverGenerate() above this cannot
 * always probe a WORKING key to validate the label before acting -- there
 * may be no resolvable handle at all, no vault entry for it, or its stored
 * merchant_key may simply no longer authenticate, all of which are the
 * expected, ordinary reason someone reaches this command in the first
 * place. This validates only what it safely can: if a handle resolves AND
 * a stored key for it happens to still work, checked the same way
 * rotate()/recoverGenerate() above do, and it authenticates as a DIFFERENT
 * merchant, refuse with the identical wording -- otherwise (no resolvable
 * handle, no stored entry, or the stored key simply does not work, which is
 * the common case here) there is nothing this check can validate, and
 * recoverBegin proceeds exactly as it did before this check existed.
 */
async function validateBeforeRecoverBegin() {
  let handle = null
  try {
    handle = resolveHandle()
  } catch {
    handle = null
  }
  if (!handle) return true
  let stored
  try {
    stored = readSecret(origin, handle)
  } catch {
    return true
  }
  if (!stored.found || typeof stored.value?.merchant_key !== 'string') return true
  return refuseOnHandleMismatch(handle, stored.value.merchant_key, 'key recover begin')
}

async function recoverBegin() {
  const codeSource = flags['recovery-code-file']
  if (typeof codeSource !== 'string') {
    console.error('key recover begin: --recovery-code-file <path|-> is required (never a bare --recovery-code).')
    process.exitCode = 1
    return
  }
  if (!(await validateBeforeRecoverBegin())) return
  const clientClass = resolveClientClassForRecoveryBegin()
  if (!clientClass) return
  const args = [
    identityClientPath, 'recover', 'begin', '--origin', origin, '--client-class', clientClass,
    '--recovery-code-file', codeSource,
  ]
  if (allowOrigin) args.push('--allow-origin', allowOrigin)
  if (flags.reveal === true) args.push('--reveal')
  const result = spawnSync(process.execPath, args, { stdio: 'inherit' })
  if (result.status !== 0) process.exitCode = 1
}

/**
 * Recovers a merchant key stranded under a registration staging label --
 * setup.mjs's stranded-registration refusal points here. `key status
 * --handle <baseHandle>` can never answer that refusal's question, because
 * the confirmed key it needs lives ONLY under the staging label at that
 * point, not under the base handle -- see this function's own refusal path
 * for the same reasoning `requireStoredKey` above states for status/rotate/
 * recover. This never guesses: it reads the staged bundle by its exact
 * label, probes GET /api/me with the key it holds (disclosing that read,
 * the same as every other authenticated probe in this file), and refuses
 * outright unless that probe's own handle equals --handle exactly -- proof
 * the key actually belongs to the merchant being adopted, not merely a
 * label that happens to say so. Only then does it store the bundle under
 * the real handle (staged-then-promote, via promoteReplacementKey -- the
 * same critical section register()/rotate()/recoverBegin() themselves use)
 * and delete the staging copy. Never prints the key itself.
 *
 * Two refusals exist purely to keep adopt honest about its own errors,
 * neither reachable by any other caller of promoteReplacementKey: an
 * upfront refusal when --from-label equals --handle (nothing to move), and
 * a reworded catch of promoteReplacementKey's LiveVaultEntryExistsError
 * when --from-label names a genuinely different, already-live entry --
 * that function's default wording for the case describes register()'s
 * meaning of it (a concurrent registration won a race), which does not
 * apply here since adopt never registers anything.
 */
async function adopt() {
  const handle = typeof flags.handle === 'string' ? flags.handle : null
  if (!handle) {
    console.error('key adopt: --handle <handle> is required -- the real handle the staged key belongs to.')
    process.exitCode = 1
    return
  }
  if (!HANDLE_RE.test(handle)) {
    console.error(`key adopt: --handle "${handle}" does not match the market's handle rule ${HANDLE_RE.source}; nothing was attempted.`)
    process.exitCode = 1
    return
  }
  const stagingLabel = flags['from-label']
  if (typeof stagingLabel !== 'string') {
    console.error(
      'key adopt: --from-label <staging-label> is required -- the vault label the stranded, already-' +
      'confirmed key is currently stored under (setup\'s registration-staging refusal, or `key status`, ' +
      'names the exact label).',
    )
    process.exitCode = 1
    return
  }
  if (stagingLabel === handle) {
    console.error(
      `key adopt: --from-label and --handle are both "${handle}"; there is no staging copy to move -- a key ` +
      'already stored under its real handle is not something adopt does anything with. Run `key status ' +
      `--handle ${handle}\` to check whether it works, or, if you believe this label is a redundant leftover ` +
      'copy rather than the merchant\'s real entry, delete it by hand instead of running adopt.',
    )
    process.exitCode = 1
    return
  }
  let stored
  try {
    stored = readSecret(origin, stagingLabel)
  } catch (error) {
    if (!(error instanceof SecretReadFailure)) throw error
    console.error(`key adopt: ${error.message}; refusing to guess what "${stagingLabel}" holds.`)
    process.exitCode = 1
    return
  }
  if (!stored.found || typeof stored.value?.merchant_key !== 'string') {
    console.error(`key adopt: no vault entry found for "${stagingLabel}" at ${origin} -- nothing to adopt.`)
    process.exitCode = 1
    return
  }
  const merchantKey = stored.value.merchant_key
  const probe = await probeMe(origin, merchantKey, { allowOrigin })
  console.log('key adopt: probed the staged key with one authenticated GET /api/me read.')
  if (!probe.ok) {
    console.error(`key adopt: the key stored under "${stagingLabel}" does not work (${probe.error}); refusing to adopt it.`)
    process.exitCode = 1
    return
  }
  if (probe.handle !== handle) {
    console.error(
      `key adopt: refusing -- the key stored under "${stagingLabel}" authenticates as ` +
      `${JSON.stringify(probe.handle)}, not "${handle}". Pass --handle ${probe.handle ?? '<the real handle>'} ` +
      'instead, or double-check --from-label.',
    )
    process.exitCode = 1
    return
  }
  let location
  try {
    location = promoteReplacementKey(origin, handle, stagingLabel, merchantKey, () => ({
      ...(typeof stored.value.client_class === 'string' ? { client_class: stored.value.client_class } : {}),
      ...(Array.isArray(stored.value.recovery_codes) ? { recovery_codes: stored.value.recovery_codes } : {}),
    }), {}, { refuseIfPresent: true })
  } catch (error) {
    if (error instanceof LiveVaultEntryExistsError) {
      // promoteReplacementKey's default wording for this case describes
      // register()'s meaning of it -- a concurrent registration won a race
      // for the handle -- which does not apply here: adopt never registers
      // anything, it only promotes an already-known-good staged key, so
      // there is no race to describe. Reword it for what actually happened:
      // the destination handle already has a live entry.
      console.error(
        `key adopt: the vault already holds a live entry for "${handle}"; adopt refuses to overwrite it -- ` +
        `compare the two with \`key status --handle ${handle}\`, and if the staging copy at "${stagingLabel}" ` +
        'turns out to be a redundant leftover, delete it by hand.',
      )
    } else {
      console.error(`key adopt: ${error.message}`)
    }
    process.exitCode = 1
    return
  }
  console.log(`handle: ${handle}`)
  console.log(`stored: ${location}`)
  console.log(`key adopt: moved the confirmed key from "${stagingLabel}" to "${handle}" and deleted the staging copy.`)
}

function show() {
  const handle = requireHandle()
  if (!handle) return
  let stored
  try {
    stored = readSecret(origin, handle)
  } catch (error) {
    if (!(error instanceof SecretReadFailure)) throw error
    console.error(
      `key: ${error.message}; this is not "no key stored" -- refusing to guess. If you have a saved ` +
      'recovery code for this handle, use `key recover begin` to replace it; do not register a new identity.',
    )
    process.exitCode = 1
    return
  }
  if (!stored.found) {
    console.log(`no vault entry found for "${handle}" at ${origin}.`)
    return
  }
  if (typeof stored.value?.merchant_key !== 'string') {
    console.log(
      `a vault entry exists for "${handle}" at ${origin}, but it carries no merchant_key field -- there ` +
      'is nothing to show.',
    )
    return
  }
  console.log(`handle: ${handle}`)
  if (flags.reveal === true && !process.stdout.isTTY) {
    // Same diagnosis runIdentityClient's own --reveal check above gives
    // rotate/recover generate, and setup.mjs's adopt-report path: --reveal
    // WAS passed, but this process's stdout is not an interactive
    // terminal, so there is nowhere safe to print the secret once. Exit 1
    // rather than silently falling through to the no-flag message below,
    // which would misname the reason as "you forgot the flag" when the
    // caller did not.
    console.error('key show: --reveal cannot work through this wrapper; run scripts/identity-client.mjs ' +
      'directly at an interactive terminal.')
    process.exitCode = 1
    return
  }
  if (flags.reveal === true && process.stdout.isTTY) {
    console.log('Merchant key (shown once):')
    console.log(stored.value.merchant_key)
    if (Array.isArray(stored.value.recovery_codes)) {
      console.log('Recovery codes:')
      for (const code of stored.value.recovery_codes) console.log(code)
    } else if (stored.value.recovery_codes_invalidated_at) {
      console.log(
        `Recovery codes: invalidated by the last rotation/recovery (${stored.value.recovery_codes_invalidated_at}); ` +
        'run `key recover generate` to mint a fresh set.',
      )
    } else {
      console.log('Recovery codes: none stored.')
    }
    return
  }
  console.log('key: not printed to the terminal (pass --reveal at an interactive TTY to see it once).')
}

const command = positionals[0]
if (command === 'status') await status()
else if (command === 'rotate') await rotate()
else if (command === 'recover') {
  const sub = positionals[1]
  if (sub === 'generate') await recoverGenerate()
  else if (sub === 'begin') await recoverBegin()
  else {
    console.error('key recover: needs a subcommand, "generate" or "begin"')
    process.exitCode = 1
  }
} else if (command === 'show') show()
else if (command === 'adopt') await adopt()
else {
  console.error('usage: key.mjs <status|rotate|recover generate|recover begin|show|adopt> [--flags]')
  process.exitCode = 1
}
