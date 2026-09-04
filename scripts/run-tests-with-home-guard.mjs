// npm test's actual entry point. Runs `node --test` as a child process, but
// wraps it with a snapshot-before/snapshot-after check of the operator's
// REAL ~/.1f3ea (existence, file list, byte sizes -- never file contents,
// so a real credential is never read or printed by this guard) -- and fails
// the run if that directory changed at all.
//
// This exists because test/identity-commands.test.mjs, test/identity-client.test.mjs,
// and test/vault-roundtrip-windows.test.mjs drive scripts/identity-client.mjs's
// storeSecret/readSecret/deleteSecret/promoteReplacementKey/listVaultLabels
// functions, all of which accept an injectable `homeDir` (see identity-client.mjs)
// so a test can point the vault at a throwaway temp directory instead of the
// real one -- but every one of those call sites has to actually pass it for
// that to matter. A single missed `{ homeDir }` (as happened in the wave
// this guard was added for -- roughly twenty call sites across two files)
// silently grows the operator's real vault-index.json on every `npm test`
// run, in a way no assertion inside any individual test would ever catch,
// because each test only ever inspects the temp homeDir it itself created,
// never the real one sitting untouched beside it.
//
// A single directory-tree diff around the WHOLE suite is deliberately the
// last line of defense, not a replacement for passing `homeDir` correctly
// at each call site: it cannot say WHICH test leaked, only THAT one did.

import { execFileSync, spawnSync } from 'node:child_process'
import { readdirSync, statSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseKeychainServiceNames } from './identity-client.mjs'

const VAULT_DIR_NAME = '.1f3ea'

// The plugin's own OS-vault target/service prefix (identity-client.mjs's own
// vaultTarget: `1f3ea:${origin}:${label}`) -- used below to scan the REAL
// platform vault by NAME only, never by value.
const VAULT_TARGET_PREFIX = '1f3ea:'

/**
 * A deterministic, content-free snapshot of `dir`: every regular file's
 * path (relative to `dir`, forward-slash normalized so this compares the
 * same on win32 and POSIX) and byte size, sorted for a stable diff. Never
 * reads file contents -- vault-index.json is non-secret labels only, but
 * this guard has no business assuming that of every file that could ever
 * appear here, so it stays content-blind on principle.
 */
function snapshotDir(dir) {
  const entries = []
  const walk = (current) => {
    let names
    try {
      names = readdirSync(current, { withFileTypes: true })
    } catch {
      return // unreadable or vanished between calls -- treat as empty here
    }
    for (const entry of names) {
      const fullPath = join(current, entry.name)
      if (entry.isDirectory()) {
        walk(fullPath)
        continue
      }
      let size = null
      try {
        size = statSync(fullPath).size
      } catch {
        // Vanished between readdir and stat -- record as unreadable rather
        // than silently omitting it from the snapshot.
        size = 'unreadable'
      }
      entries.push({ path: relative(dir, fullPath).split('\\').join('/'), size })
    }
  }
  let existed = true
  try {
    statSync(dir)
  } catch {
    existed = false
  }
  if (existed) walk(dir)
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return { existed, entries }
}

function diffSnapshots(before, after) {
  const beforeByPath = new Map(before.entries.map(entry => [entry.path, entry.size]))
  const afterByPath = new Map(after.entries.map(entry => [entry.path, entry.size]))
  const added = [...afterByPath.keys()].filter(path => !beforeByPath.has(path))
  const removed = [...beforeByPath.keys()].filter(path => !afterByPath.has(path))
  const changed = [...beforeByPath.keys()]
    .filter(path => afterByPath.has(path) && beforeByPath.get(path) !== afterByPath.get(path))
  return { added, removed, changed, existedChanged: before.existed !== after.existed }
}

function isDrift(diff) {
  return diff.existedChanged || diff.added.length > 0 || diff.removed.length > 0 || diff.changed.length > 0
}

function formatDiff(diff, before, after) {
  const lines = [`real ~/.1f3ea changed during this test run (existed before: ${before.existed}, after: ${after.existed})`]
  for (const path of diff.added) lines.push(`  + ${path} (new, ${after.entries.find(entry => entry.path === path)?.size} bytes)`)
  for (const path of diff.removed) lines.push(`  - ${path} (removed, was ${before.entries.find(entry => entry.path === path)?.size} bytes)`)
  for (const path of diff.changed) {
    const beforeSize = before.entries.find(entry => entry.path === path)?.size
    const afterSize = after.entries.find(entry => entry.path === path)?.size
    lines.push(`  * ${path} (${beforeSize} -> ${afterSize} bytes)`)
  }
  lines.push(
    'This means some test called storeSecret/readSecret/deleteSecret/promoteReplacementKey/listVaultLabels ' +
    'without passing { homeDir } for a throwaway temp directory, so it hit the real vault instead of a ' +
    'sandboxed one. Find the call site (search test/*.test.mjs for a vault function call missing homeDir) ' +
    'and fix it there -- this guard only proves that a leak happened, not which test caused it.',
  )
  return lines.join('\n')
}

/**
 * A deterministic, NAME-ONLY snapshot of this host's real OS credential
 * vault entries carrying the plugin's own `1f3ea:` target/service prefix --
 * via `cmdkey /list` on win32, the same `security dump-keychain` metadata
 * scan identity-client.mjs's own listVaultLabels uses on darwin (never `-d`,
 * which would also dump every item's secret data). This exists for exactly
 * the reason the directory snapshot above does not cover: on win32 and
 * darwin, storeSecret writes the SECRET itself to the machine-wide platform
 * vault regardless of an injected `homeDir` -- only the non-secret
 * vault-index.json under `homeDir` is redirected by that override -- so a
 * test that stores a real credential without stubbing out the platform
 * vault call entirely can leak a secret bundle into the operator's real
 * Credential Manager or Keychain while the directory snapshot above sees
 * nothing at all.
 *
 * Returns two independent flags, not one: `supported` is false on any
 * platform other than win32/darwin -- there is no vault tool to ask at all,
 * a genuine and successful "nothing to enumerate here." `ok` is false ONLY
 * when a supported platform's own enumeration tool (`cmdkey`/`security`)
 * actually failed to run -- distinct from "found nothing," the same
 * distinction identity-client.mjs's own listVaultLabels/
 * KeychainEnumerationIncomplete already has to make for these exact same
 * calls. Collapsing the two (an earlier version of this function returned
 * `{ supported: false }` for both "nothing to check" and "the tool itself
 * failed") is wrong in either direction a caller could then fail to
 * distinguish: a tool failure only on the AFTER read would be read as
 * "nothing added" (hiding a real leak this whole guard exists to catch),
 * and a tool failure only on the BEFORE read would report every
 * legitimately-found AFTER entry as spurious drift. The caller (runGuard
 * below) refuses to compare -- and fails the run outright -- whenever `ok`
 * is false, rather than guessing which of those two wrong answers to give.
 */
function snapshotPlatformVaultTargets() {
  const os = platform()
  if (os === 'win32') {
    let output
    try {
      output = execFileSync('cmdkey', ['/list'], { encoding: 'utf8' })
    } catch {
      return { supported: true, ok: false, names: [] }
    }
    const names = []
    for (const match of output.matchAll(/Target:\s*(.+)\s*$/gmu)) {
      // Real `cmdkey /list` output prefixes the target this script wrote
      // with its own credential-type marker (observed as
      // "LegacyGeneric:target=1f3ea:<origin>:<label>", not the bare target)
      // -- same as identity-client.mjs's own listVaultLabels win32 branch --
      // so search for the prefix anywhere in the line rather than requiring
      // it at the very start.
      const target = match[1].trim()
      const index = target.indexOf(VAULT_TARGET_PREFIX)
      if (index !== -1) names.push(target.slice(index))
    }
    names.sort()
    return { supported: true, ok: true, names }
  }
  if (os === 'darwin') {
    let output
    try {
      output = execFileSync('security', ['dump-keychain'], {
        encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 10_000,
      })
    } catch {
      return { supported: true, ok: false, names: [] }
    }
    const names = parseKeychainServiceNames(output)
      .filter(name => name.startsWith(VAULT_TARGET_PREFIX))
      .sort()
    return { supported: true, ok: true, names }
  }
  // No vault tool this guard knows how to ask on this platform at all -- a
  // genuine, successful "nothing to enumerate here," never a failure.
  return { supported: false, ok: true, names: [] }
}

function formatEnumerationFailure(before, after) {
  const tool = platform() === 'win32' ? 'cmdkey /list' : 'security dump-keychain'
  const failedOn = before.ok === false ? 'BEFORE' : 'AFTER'
  return (
    `the platform vault could not be enumerated, this run proves nothing about it (${tool} failed on the ` +
    `${failedOn} read). A failed enumeration is never silently treated as "found nothing" -- doing that ` +
    'could either hide a real leak or report every pre-existing entry as spurious drift, depending on ' +
    'which call failed. Investigate why the enumeration tool failed on this host, then re-run.'
  )
}

function diffTargetNames(before, after) {
  const beforeSet = new Set(before.names)
  const afterSet = new Set(after.names)
  return {
    added: after.names.filter(name => !beforeSet.has(name)),
    removed: before.names.filter(name => !afterSet.has(name)),
  }
}

function isTargetDrift(diff) {
  return diff.added.length > 0 || diff.removed.length > 0
}

function formatTargetDiff(diff) {
  const lines = [`this host's real OS credential vault entries under the "${VAULT_TARGET_PREFIX}" prefix changed during this test run`]
  for (const name of diff.added) lines.push(`  + ${name}`)
  for (const name of diff.removed) lines.push(`  - ${name}`)
  lines.push(
    'This means some test wrote to (or deleted from) the REAL platform vault -- Windows Credential Manager or ' +
    'macOS Keychain -- instead of a sandboxed one: on these platforms an injected `homeDir` redirects only the ' +
    'non-secret vault-index.json, never the secret bundle itself, so a call that skips stubbing the platform ' +
    'vault call entirely leaks a real credential even though the directory diff above sees nothing. Find the ' +
    'call site (search test/*.test.mjs for a vault function call that reaches the real platform backend) and ' +
    'fix it there. Names only, above and in this message -- never values.',
  )
  return lines.join('\n')
}

// The before/after diff above (isTargetDrift/formatTargetDiff) only ever
// catches a leak that happens DURING this run -- it diffs two snapshots
// taken by this same process, so a credential that was already sitting in
// the real platform vault before this run even started is present in BOTH
// snapshots and the diff sees nothing. A developer whose run failed this
// guard, who then re-runs to check whether they fixed it, would see this
// guard report green while the leaked credential is still in Credential
// Manager or Keychain. Everything below inspects targetsBefore alone (never
// targetsAfter, and never a diff) to catch exactly that residue.
//
// Only a TEST can ever create a `1f3ea:` vault target under a loopback
// origin (localhost or 127.0.0.1) -- the real market this plugin talks to
// lives at a real hostname (see AGENT_1F3EA_STUB_ONLY / origin-guard.mjs),
// so a real merchant's own vault entry is always `1f3ea:https://1f3ea.com:
// <handle>` or similar, never loopback. That asymmetry is what lets this
// classifier fail on leaked test residue while never refusing on a real,
// legitimately registered merchant that happens to already be in the vault
// when `npm test` starts.
const VAULT_TARGET_PATTERN = /^1f3ea:(https?:\/\/[^:/]+(?::\d+)?)(?:\/[^:]*)?:(.+)$/u

/**
 * Splits a `1f3ea:<origin>:<label>` platform-vault target name (the exact
 * shape identity-client.mjs's own vaultTarget writes) into its origin and
 * label. Origin itself contains colons (`http://localhost:41234`), so this
 * cannot just split on ":" -- it anchors on the scheme://host[:port] shape
 * an origin always has instead. Returns null for anything that does not
 * match that shape at all (should never happen for a name already filtered
 * to the `1f3ea:` prefix by snapshotPlatformVaultTargets, but this stays
 * defensive rather than throwing on a target text this guard cannot parse).
 */
function parseVaultTargetName(name) {
  const match = VAULT_TARGET_PATTERN.exec(name)
  if (!match) return null
  return { origin: match[1], label: match[2] }
}

/** True only for a loopback host -- never for a real, non-loopback merchant origin. */
function isLoopbackOrigin(origin) {
  let hostname
  try {
    hostname = new URL(origin).hostname
  } catch {
    return false
  }
  return hostname === 'localhost' || hostname === '127.0.0.1'
}

/**
 * The `1f3ea:` vault target names in `targetsBefore` (a snapshotPlatformVaultTargets()
 * result) that name a loopback origin -- test residue that was already in the real
 * platform vault before this run started. `{ supported: false }` (nothing to enumerate
 * on this platform) or `{ ok: false }` (the enumeration tool itself failed -- names is
 * already empty in that case, so this never false-flags, but runGuard below still fails
 * the whole run separately rather than trusting this empty result as "found nothing")
 * yields an empty result rather than a false positive.
 */
function findPreexistingLoopbackLeaks(targetsBefore) {
  if (!targetsBefore.supported || targetsBefore.ok === false) return []
  return targetsBefore.names.filter(name => {
    const parsed = parseVaultTargetName(name)
    return parsed !== null && isLoopbackOrigin(parsed.origin)
  })
}

function formatPreexistingLeakDiff(leaks) {
  const noun = leaks.length === 1 ? 'entry' : 'entries'
  const lines = [
    `this host's real OS credential vault already held ${leaks.length} loopback-origin "${VAULT_TARGET_PREFIX}" ${noun} ` +
    'BEFORE this run started',
  ]
  for (const name of leaks) lines.push(`  ! ${name}`)
  lines.push(
    'Only a test ever creates a `1f3ea:` vault target under a loopback origin (localhost or 127.0.0.1) -- a ' +
    'real merchant\'s own entry always names a real hostname, so this can only be residue a PREVIOUS run ' +
    'leaked into the real platform vault and never cleaned up. The before/after diff above cannot see this: ' +
    'it only catches a leak that happens during THIS run, so a developer re-running after "fixing" a leak ' +
    'would see this guard report green while the leaked credential is still sitting in Credential Manager or ' +
    'Keychain. Remove it by name (never by value, and never any other `1f3ea:` entry -- a real merchant ' +
    'registered at a real hostname on this host must never be touched) and find the call site that leaked ' +
    'it. Names only, above and in this message -- never values.',
  )
  return lines.join('\n')
}

/**
 * The pure decision core of the guard: given the before/after directory
 * snapshots and the before/after platform-vault target snapshots, decides
 * which of this guard's four independent failure conditions apply --
 * enumeration failure, a real directory drift, a real platform-vault target
 * drift, and pre-existing loopback residue -- and returns a message for
 * EVERY one that does, never just the first. These conditions are
 * independent of each other: in particular, a failed enumeration
 * (`targetsBefore.ok === false` or `targetsAfter.ok === false`) says
 * nothing about whether the DIRECTORY snapshot (`before`/`after`, taken
 * independently of the platform-vault enumeration tool) shows a real leak
 * -- `diff`/`isDrift` above already proves or disproves that on its own,
 * with or without a working `cmdkey`/`security`. Treating enumeration
 * failure as if it made every other check meaningless (an earlier version
 * of this function did, via an exclusive if/else chain) silently hid a
 * real, already-proven `~/.1f3ea` leak behind "investigate the enumeration
 * tool" whenever that tool happened to fail on the same run. This function
 * takes no action and touches nothing -- it only classifies -- so it can be
 * exercised directly by a test with hand-built snapshot objects, never a
 * real home directory or a real `node --test` subprocess.
 */
function classifyGuardResult({ before, after, targetsBefore, targetsAfter }) {
  const diff = diffSnapshots(before, after)
  const enumerationFailed = targetsBefore.ok === false || targetsAfter.ok === false
  const targetsComparable = targetsBefore.supported && targetsAfter.supported && !enumerationFailed
  const targetDiff = targetsComparable ? diffTargetNames(targetsBefore, targetsAfter) : { added: [], removed: [] }
  const preexistingLoopbackLeaks = findPreexistingLoopbackLeaks(targetsBefore)

  const messages = []
  if (enumerationFailed) messages.push(formatEnumerationFailure(targetsBefore, targetsAfter))
  if (isDrift(diff)) messages.push(formatDiff(diff, before, after))
  if (isTargetDrift(targetDiff)) messages.push(formatTargetDiff(targetDiff))
  if (preexistingLoopbackLeaks.length > 0) messages.push(formatPreexistingLeakDiff(preexistingLoopbackLeaks))

  return { messages, failed: messages.length > 0 }
}

function runGuard() {
  const vaultDir = join(homedir(), VAULT_DIR_NAME)
  const before = snapshotDir(vaultDir)
  const targetsBefore = snapshotPlatformVaultTargets()

  const result = spawnSync(process.execPath, ['--test', ...process.argv.slice(2)], {
    stdio: 'inherit',
  })

  const after = snapshotDir(vaultDir)
  const targetsAfter = snapshotPlatformVaultTargets()
  const { messages, failed } = classifyGuardResult({ before, after, targetsBefore, targetsAfter })

  for (const message of messages) {
    console.error(`\nidentity-vault-home-guard: ${message}`)
  }

  if (failed) {
    process.exitCode = 1
  } else if (result.status !== 0) {
    process.exitCode = result.status ?? 1
  } else if (result.signal) {
    process.exitCode = 1
  } else {
    process.exitCode = 0
  }
}

const isMainModule = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href

if (isMainModule) {
  runGuard()
}

// Exported for tests only -- the CLI entry point above never uses this
// import path itself, so importing this module never runs the guard (and
// never spawns `node --test` recursively).
export {
  findPreexistingLoopbackLeaks, isLoopbackOrigin, parseVaultTargetName,
  snapshotPlatformVaultTargets, classifyGuardResult,
}
