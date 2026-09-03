#!/usr/bin/env node
// Reference client: a dependency-free Node script that
// registers, rotates, or recovers a 1F3EA merchant through the coding-client
// JSON identity doors (POST /api/register, POST /api/rotate,
// POST /api/recovery). It writes the merchant key and recovery codes to the
// operating system's secure credential store -- Windows Credential Manager
// via the Win32 CredWrite/CredRead API (reached through a small PowerShell
// shim; `cmdkey` itself is used only to delete, which needs no secret),
// macOS Keychain via `security -i` interactive mode, and a 0600 file under
// the user's home everywhere else -- then prints only the merchant's handle
// and where its secrets were stored. Every secret bundle reaches these tools
// over stdin, never as a process argument, so it never sits in a process
// listing (`ps`, Task Manager) or in a failed command's own error message. A
// secret value reaches the terminal only when the caller passes --reveal at
// an interactive TTY; by default this script never prints, logs, or returns
// one. The one deliberate exception is the pairing code from `pair`: it is
// single-use, expires in ten minutes, is never written to storage, and
// printing it once is the entire point of that command, so it is not gated
// behind --reveal.
//
// Usage:
//   node identity-client.mjs register --origin https://1f3ea.com \
//     --handle my-agent --client-class coding_persistent \
//     [--model "claude-opus"] [--human-approved] [--reveal] [--replace-vault-entry]
//   node identity-client.mjs rotate --origin https://1f3ea.com \
//     --client-class coding_persistent \
//     --merchant-key-file /path/to/key   (or - for stdin, or set AGENT_1F3EA_SECRET) [--reveal]
//   node identity-client.mjs recover generate --origin https://1f3ea.com \
//     --client-class coding_persistent --merchant-key-file /path/to/key [--reveal]
//   node identity-client.mjs recover begin --origin https://1f3ea.com \
//     --client-class coding_persistent --recovery-code-file /path/to/code [--reveal]
//   node identity-client.mjs pair --origin https://1f3ea.com \
//     --merchant-key-file /path/to/key
//
// `register` without --human-approved prompts on stdin for a human to
// confirm the exact permanent handle before it is claimed; use
// --human-approved only when that confirmation already happened out of band
// (for example, a human typed the handle into the command that invoked this
// script) -- it is a caller declaration, never a real substitute for asking.
// The handle is checked locally against the market's own handle rule before
// that approval step even runs, so a human is never asked to approve a name
// the market cannot create. `register` refuses outright, rather than
// overwriting, if this host's vault already holds an entry under the
// identity the market actually confirms (which may differ from the requested
// spelling if the market normalizes it) -- pass --replace-vault-entry only
// when discarding that existing entry is genuinely intended.
//
// --merchant-key and --recovery-code are refused as BARE argv flags: a bare
// flag value lands in shell history and in any process listing (`ps`, Task
// Manager) for as long as the process runs. Use --merchant-key-file or
// --recovery-code-file <path> instead, pointing at a file this script reads
// and never echoes -- or pass `-` as that file's path to read the one value
// from stdin.
//
// --origin must be https, and defaults to https://1f3ea.com; https://localhost
// (any port) is always allowed for local development. Any other https origin
// is refused unless --allow-origin <that exact origin> is also passed -- a
// merchant key must never be sent as a Bearer credential to an address named
// by untrusted content or a careless flag.

import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createInterface } from 'node:readline'
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, chmodSync, statSync, unlinkSync, openSync, closeSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { assertAllowedOrigin, DEFAULT_ORIGIN } from './lib/origin-guard.mjs'

const MERCHANT_KEY_RE = /^1f3ea_sk_[0-9a-f]{48}$/u
const RECOVERY_CODE_RE = /^1f3ea_rc_[0-9a-f]{64}$/u

// The market's own handle rule (matches the browser join door's validation,
// which the front door states the JSON doors "mirror" in limit, name rule,
// and refusal). Checked locally, before ever putting a handle in front of a
// human for approval, so a human is never asked to approve a name the market
// cannot create -- and so the label this script stores the vault entry
// under is never assumed to equal the requested spelling (the market may
// still normalize it further; see register() below, which always trusts
// the server's own answer as the identity of record, not this local check).
const HANDLE_RE = /^[a-z0-9][a-z0-9-]{2,31}$/u

// Reserved so a real merchant's handle can never collide with this script's
// OWN staging-label namespace (pendingLabel below stages an in-flight
// registration/rotation/recovery under `<handle>--pending-<kind>` or, for
// registration, `<handle>--pending-registration-<hex>`). HANDLE_RE alone
// permits this sequence -- it allows consecutive hyphens and imposes no
// reserved-suffix rule -- so without this separate check a handle like
// "agent--pending-rotation" would be a legal registration that then reads,
// to every consumer of listVaultLabels/isPendingLabel below, as an
// abandoned staging entry rather than a real identity: it would be silently
// filtered out of setup.mjs's duplicate-identity guard, which exists
// specifically to stop a second, permanent, unrecoverable merchant from
// being registered next to one that already exists. Checked at every point
// a handle is validated in this file (both the requested spelling and the
// market's own confirmed spelling), so the reservation holds regardless of
// what the market itself would otherwise accept.
const RESERVED_HANDLE_SUBSTRING_RE = /--pending-/u

// Mirrors the market's own identityModelValue (src/market-identity-fields.ts
// on the market server): at most 120 CODE POINTS (not UTF-16 units) after
// trimming, and no control or directional-override marks. Checked here,
// before register() ever stages a registration, so a model the market was
// always going to refuse never burns a two-pass human-approval round trip --
// setup.mjs mirrors this same rule locally too, even earlier, for the exact
// same reason (and the stub market server in test/helpers/stub-market-server.mjs
// carries its own matching copy, so a test can pin the divergence closed on
// both sides).
const DISALLOWED_MODEL_CHARACTERS_RE =
  new RegExp('[\u0000-\u001f\u007f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]', 'u')

function isValidModel(model) {
  const trimmed = model.trim()
  return Array.from(trimmed).length <= 120 && !DISALLOWED_MODEL_CHARACTERS_RE.test(trimmed)
}

// The one legal (letter-first) environment variable name used everywhere a
// merchant key is read from the host's own secret store -- by the printed
// `claude mcp add` / `codex mcp add` commands (scripts/connect.mjs,
// scripts/setup.mjs) and by this script's own rotate/recover/pair fallback
// below. A single consistent name means a caller exports it once. Every
// env-var name this repo prints or reads must match
// /^[A-Za-z_][A-Za-z0-9_]*$/ -- `1F3EA_...` forms do not, because POSIX
// shells refuse `export NAME=value` (and `${NAME}` expansion) when NAME
// starts with a digit.
const AGENT_SECRET_ENV_VAR = 'AGENT_1F3EA_SECRET'

function fail(message) {
  console.error(`identity-client: ${message}`)
  process.exitCode = 1
  return null
}

function parseArgs(argv) {
  const flags = {}
  const positionals = []
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token.startsWith('--')) {
      const body = token.slice(2)
      // `--name=value` is parsed as a single token so a caller cannot defeat
      // the bare-secret-flag refusal below by writing --merchant-key=...
      // instead of --merchant-key ... (both still land in shell history and
      // process listings the exact same way).
      const equalsIndex = body.indexOf('=')
      if (equalsIndex !== -1) {
        flags[body.slice(0, equalsIndex)] = body.slice(equalsIndex + 1)
        continue
      }
      const name = body
      const next = argv[index + 1]
      if (next === undefined || next.startsWith('--')) {
        flags[name] = true
      } else {
        flags[name] = next
        index += 1
      }
    } else {
      positionals.push(token)
    }
  }
  return { flags, positionals }
}

function requireFlag(flags, name) {
  const value = flags[name]
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`--${name} is required`)
  }
  return value
}

function originOf(flags) {
  const raw = flags.origin ?? process.env.IDENTITY_ORIGIN ?? DEFAULT_ORIGIN
  const trimmed = raw.replace(/\/+$/u, '')
  const allowOrigin = typeof flags['allow-origin'] === 'string' ? flags['allow-origin'] : undefined
  return assertAllowedOrigin(trimmed, { allowOrigin })
}

async function askYesNo(question) {
  if (!process.stdin.isTTY) return false
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = await new Promise(resolve => rl.question(`${question} [y/N] `, resolve))
    return /^y(es)?$/iu.test(answer.trim())
  } finally {
    rl.close()
  }
}

// --- Secret input: argv is refused, a file path or stdin is required ------

// argv-flag name -> the -file flag that must supply it instead. Both values
// here can authenticate a request or consume a one-use credential, so
// neither may ever be a bare argv flag.
const SECRET_ARGV_FLAGS = {
  'merchant-key': 'merchant-key-file',
  'recovery-code': 'recovery-code-file',
}

async function readStdinText() {
  process.stdin.setEncoding('utf8')
  let text = ''
  for await (const chunk of process.stdin) text += chunk
  return text
}

async function readSecretFromPathOrStdin(source) {
  const raw = source === '-' ? await readStdinText() : readFileSync(source, 'utf8')
  const value = raw.trim()
  if (!value) throw new Error(`no value read from ${source === '-' ? 'stdin' : source}`)
  return value
}

/**
 * Refuses --merchant-key or --recovery-code as a bare flag and resolves the
 * matching --*-file flag (a path, or `-` for stdin) into the plain secret
 * value the caller below expects. Falls back to the given environment
 * variables only when neither argv form is present -- an environment
 * variable is not visible in a process listing the way argv is, so it stays
 * allowed as before.
 */
async function resolveSecretArg(flags, bareName, envNames = []) {
  const fileName = SECRET_ARGV_FLAGS[bareName]
  if (bareName in flags) {
    throw new Error(
      `--${bareName} is refused as a bare flag (this also catches --${bareName}=VALUE): it would land ` +
      `in shell history and process listings. If you just typed it either way, treat that value as ` +
      `exposed now and rotate it. Use --${fileName} <path> (or --${fileName} - to read one value from ` +
      'stdin) instead.',
    )
  }
  if (fileName in flags) {
    const source = flags[fileName]
    if (typeof source !== 'string') throw new Error(`--${fileName} requires a path or -`)
    return readSecretFromPathOrStdin(source)
  }
  for (const envName of envNames) {
    if (process.env[envName]) return process.env[envName]
  }
  return null
}

// --- Secret output: hidden unless the caller opts in at a real TTY --------

/**
 * The pure predicate revealOrHide below is built on -- exported separately
 * so a test can exercise all four combinations of (reveal flag) x (TTY)
 * directly, without needing to fork a subprocess whose own stdout can never
 * be a real TTY either way (which is exactly why the naive version of that
 * test could not actually reach or fail on the reveal branch at all).
 */
function shouldReveal(flags, isTty) {
  return flags.reveal === true && isTty === true
}

/**
 * Prints `values` only when the caller passed --reveal AND stdout is an
 * interactive TTY (never a pipe, redirect, or captured subprocess output --
 * exactly where a secret could land in a log or another program's memory).
 * Otherwise prints only a pointer to where the value already went.
 */
function revealOrHide(flags, label, values) {
  if (shouldReveal(flags, process.stdout.isTTY)) {
    console.log(`${label} (shown once):`)
    for (const value of values) console.log(value)
    return
  }
  console.log(
    `${label}: not printed to the terminal (pass --reveal at an interactive TTY to see it ` +
    'once); read it back from storage instead.',
  )
}

// --- Secure storage -----------------------------------------------------

function vaultTarget(origin, handleOrLabel) {
  return `1f3ea:${origin}:${handleOrLabel}`
}

// homeDir is injectable (defaults to the real home directory) so tests can
// round-trip storeSecret/readSecret against a temp directory instead of the
// caller's real ~/.1f3ea/credentials.
function credentialsFilePath(origin, handleOrLabel, homeDir = homedir()) {
  const safeOrigin = origin.replace(/[^a-z0-9.-]/giu, '_')
  const safeLabel = handleOrLabel.replace(/[^a-z0-9._-]/giu, '_')
  return join(homeDir, '.1f3ea', 'credentials', `${safeOrigin}__${safeLabel}.json`)
}

/**
 * The staging label a replacement credential is written under before it is
 * confirmed.
 *
 * `kind === 'registration'` gets a short random suffix, making the label
 * unique PER RUN rather than a pure function of `handle` alone. Without
 * this, two concurrent `register` invocations racing the SAME requested
 * handle would stage their bundles under the identical label; the winner's
 * own cleanup (promoteReplacementKey's final `deleteSecret`, once its write
 * actually lands) would then delete whatever the LOSER had just staged
 * there -- even though the loser's merchant was itself confirmed
 * server-side and is now permanent. With the suffix, each run's staging
 * entry is exclusively its own: nothing but that run's own successful
 * promotion (or its own error-path cleanup) ever deletes it.
 *
 * `rotate()`/`recoverBegin()` do not get a suffix: their staging label is
 * scoped to a handle the caller already owns and confirms via a valid
 * merchant key/recovery code, and promoteReplacementKey's per-(origin,
 * handle) file lock already serializes concurrent runs for that handle
 * end to end -- there is no legitimate way for two DIFFERENT callers to
 * even reach that code path for the same handle at once the way two
 * `register` calls can both request the same not-yet-owned handle.
 */
function pendingLabel(handle, kind) {
  if (kind === 'registration') {
    return `${handle}--pending-registration-${randomBytes(4).toString('hex')}`
  }
  return `${handle}--pending-${kind}`
}

/**
 * A LABEL-TEXT heuristic for "this looks like a staging label" -- covers
 * every kind `pendingLabel` above can produce, including the per-run
 * suffixed registration form. Used by listVaultLabels below ONLY as a
 * fallback for an entry it cannot otherwise decode (a bare `cmdkey /list`
 * scrape on win32, or a stored bundle this run's platform cannot read back).
 * It is deliberately NOT the primary source of truth: HANDLE_RE alone would
 * allow a real merchant to register a handle that happens to end in one of
 * these suffixes (e.g. "agent--pending-rotation"), and
 * RESERVED_HANDLE_SUBSTRING_RE above closes that off going forward, but this
 * function must still cope with any handle already in the wild -- so
 * listVaultLabels prefers the `kind: 'staging'` marker storeSecret writes
 * into the bundle itself (pendingLabel's three callers all pass it) wherever
 * the backend lets it read that marker back, and falls back to this suffix
 * test only when it cannot.
 */
function isPendingLabel(label) {
  return /--pending-(?:rotation|recovery|registration(?:-[0-9a-f]+)?)$/u.test(label)
}

// --- Non-secret vault index (macOS and Windows) -----------------------------
//
// macOS Keychain has no reliable, non-interactive way for this script to
// enumerate every entry it owns: `security dump-keychain` prints every
// stored secret in the user's whole login keychain, not just this plugin's
// entries, so using it here to answer "does ANY entry already exist for
// this origin" would mean reading (and having to filter through) secrets
// this script has no business touching at all. Windows has a different
// problem with the same shape: `cmdkey /list` is this script's only
// non-interactive way to enumerate entries, but its output is localized --
// on a non-English Windows install the literal "Target:" label this script
// parses for never appears, so scraping it alone silently returns nothing,
// language-dependently. Instead, storeSecret and deleteSecret below keep a
// small non-secret index file -- ~/.1f3ea/vault-index.json, labels plus a
// `staging` marker, never a key or recovery code -- that setup.mjs's
// duplicate-identity guard reads through listVaultLabels. It is a
// heuristic, not a source of truth: it can go stale if an entry is removed
// by some other tool (Keychain Access.app, Windows Credential Manager's own
// UI, `security`/`cmdkey` by hand), and listVaultLabels below treats that as
// fine to err toward, since the whole point is only ever to make setup ask
// for --new-identity one time too many, never to silently register a real
// duplicate merchant. On win32, listVaultLabels unions this index with
// whatever `cmdkey /list` scraping does find, rather than depending on the
// index alone -- the index is best-effort too (a write failure here is
// never fatal), so neither source alone is trusted as complete. The
// `staging` marker on each entry is what listVaultLabels prefers over
// isPendingLabel's label-text guess (see its own doc comment) -- it comes
// from the bundle's own `kind` field, recorded here at write time so
// listVaultLabels never has to decode the secret itself just to tell a real
// merchant from an in-flight staging copy.

function vaultIndexPath(homeDir = homedir()) {
  return join(homeDir, '.1f3ea', 'vault-index.json')
}

function readVaultIndex(homeDir) {
  try {
    const parsed = JSON.parse(readFileSync(vaultIndexPath(homeDir), 'utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * Normalizes one origin's raw vault-index.json entries -- an array that may
 * mix legacy bare-string entries (written before this index carried a
 * `staging` marker) with the current `{ label, staging }` object form --
 * into a Map from label to `{ staging }`. A legacy string entry's staging
 * status is unknown (`staging: undefined`), which listVaultLabels below
 * treats as "fall back to the isPendingLabel suffix guess for this one",
 * exactly like an entry it cannot decode at all.
 */
function vaultIndexEntriesToMap(entries) {
  const map = new Map()
  for (const entry of entries) {
    if (typeof entry === 'string') {
      map.set(entry, { staging: undefined })
    } else if (entry && typeof entry === 'object' && typeof entry.label === 'string') {
      // A malformed or absent `staging` field must stay unknown, not be
      // read as a definite "not staging" -- only a real boolean this
      // version itself wrote is trustworthy either way (see this
      // function's own comment above and isStagingLabel).
      map.set(entry.label, { staging: typeof entry.staging === 'boolean' ? entry.staging : undefined })
    }
  }
  return map
}

// updateVaultIndex is a read-modify-write over one shared file with no
// built-in locking of its own -- two runs updating it at nearly the same
// moment (a rotate and a register from two different sessions, or just two
// tests in this repo's own suite) can each read the same starting state,
// mutate their own copy, and write it back, with the second write silently
// discarding the first's change. lockWithRetry below closes that window
// with a plain `wx`-mode (O_EXCL) lockfile next to vault-index.json: only
// one process can ever hold that name at once, so a second one either waits
// briefly or, if the lock looks abandoned, breaks it and proceeds.
const VAULT_INDEX_LOCK_STALE_MS = 5_000
const VAULT_INDEX_LOCK_MAX_WAIT_MS = 2_000
const VAULT_INDEX_LOCK_RETRY_MS = 20

function sleepSyncMs(ms) {
  // A real, blocking sleep with no busy-spin -- Atomics.wait blocks this
  // thread without burning CPU, unlike a `while (Date.now() < until) {}`
  // spin loop would. Safe here because this whole file is synchronous,
  // single-threaded CLI code with no event loop work that a spin (or this)
  // would otherwise starve.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * Runs `fn` (synchronous) while holding a short-lived lockfile at `lockPath`,
 * retrying with backoff for up to VAULT_INDEX_LOCK_MAX_WAIT_MS if another
 * process already holds it. A lock older than VAULT_INDEX_LOCK_STALE_MS is
 * treated as abandoned (the process that created it crashed, was killed, or
 * otherwise never reached its own cleanup) and broken rather than honored
 * forever -- this file's own contents are always small and held only for the
 * few synchronous fs calls inside `fn`, so a real holder is never actually
 * still working after that long. Returns `undefined` (running `fn` not at
 * all) if the wait budget is exhausted without ever acquiring the lock,
 * rather than blocking indefinitely -- callers here already treat the whole
 * operation as best effort.
 */
function withFileLock(lockPath, fn) {
  const deadline = Date.now() + VAULT_INDEX_LOCK_MAX_WAIT_MS
  for (;;) {
    try {
      closeSync(openSync(lockPath, 'wx'))
      break
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      let staleEnough = false
      try {
        staleEnough = Date.now() - statSync(lockPath).mtimeMs > VAULT_INDEX_LOCK_STALE_MS
      } catch {
        // The lock disappeared between the EEXIST above and this stat --
        // another process's own cleanup won that race; just retry.
      }
      if (staleEnough) {
        try {
          unlinkSync(lockPath)
        } catch {
          // Another process may have broken (or re-created) it first; retry
          // either way rather than treating that as this call's failure.
        }
        continue
      }
      if (Date.now() >= deadline) return undefined
      sleepSyncMs(VAULT_INDEX_LOCK_RETRY_MS)
    }
  }
  try {
    return fn()
  } finally {
    try {
      unlinkSync(lockPath)
    } catch {
      // Best effort -- see the module comment above.
    }
  }
}

/** Compares two label->{staging} Maps (as built by vaultIndexEntriesToMap / mutated in place below). */
function labelMapsEqual(a, b) {
  if (a.size !== b.size) return false
  for (const [label, meta] of a) {
    const otherMeta = b.get(label)
    if (!otherMeta) return false
    if (Boolean(otherMeta.staging) !== Boolean(meta.staging)) return false
  }
  return true
}

/**
 * Best effort: the index is a heuristic, so a write failure here is never
 * fatal. Also a no-op, on purpose, when `mutate` would not actually change
 * anything -- most commonly deleteSecret's own cleanup of a label this
 * particular homeDir's index never held in the first place (a mismatched
 * homeDir between the storeSecret and deleteSecret call that wrote/read
 * it, or simply deleting something already gone). Without this check,
 * every such call would still create ~/.1f3ea and (re)write
 * vault-index.json purely to record the same empty state it already had --
 * which is exactly how a caller that forgets to pass the SAME `homeDir` a
 * test used elsewhere quietly starts writing into the operator's real
 * home. This is a defense-in-depth backstop, not a substitute for passing
 * `homeDir` correctly at every call site -- see
 * test/*.test.mjs and scripts/run-tests-with-home-guard.mjs.
 *
 * A cheap, unlocked peek decides first whether anything would change at
 * all; only when it would does this go on to create the directory, take
 * the lock, and re-check under it (a concurrent writer could have changed
 * things between the peek and the lock) before actually writing.
 */
function updateVaultIndex(origin, label, homeDir, mutate) {
  try {
    const path = vaultIndexPath(homeDir)

    const peekIndex = readVaultIndex(homeDir)
    const peekLabels = vaultIndexEntriesToMap(Array.isArray(peekIndex[origin]) ? peekIndex[origin] : [])
    const probeLabels = new Map(peekLabels)
    mutate(probeLabels, label)
    if (labelMapsEqual(probeLabels, peekLabels)) return

    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    withFileLock(`${path}.lock`, () => {
      const index = readVaultIndex(homeDir)
      const labels = vaultIndexEntriesToMap(Array.isArray(index[origin]) ? index[origin] : [])
      const before = new Map(labels)
      mutate(labels, label)
      if (labelMapsEqual(labels, before)) return
      // Preserve unknown-ness on rewrite: a label whose staging status this
      // version never learned (a legacy bare-string entry this run did not
      // itself touch with a boolean) must be written back as the same bare
      // string, not upgraded to `staging: false` -- doing so would assert a
      // fact this version never actually observed. Only a label this
      // version itself set `{ staging }` for (via storeSecret's own boolean
      // above) gets the object form.
      index[origin] = [...labels].map(([entryLabel, meta]) =>
        meta.staging === undefined ? entryLabel : { label: entryLabel, staging: meta.staging === true },
      )
      writeFileSync(path, `${JSON.stringify(index, null, 2)}\n`, { mode: 0o600 })
    })
  } catch {
    // Best effort -- see the module comment above.
  }
}

/**
 * The PowerShell/.NET shim that writes one credential through the real
 * Win32 CredWrite API. The secret bundle travels to this process over
 * stdin, as base64-encoded JSON -- never as a command-line argument, so it
 * is never visible in a process listing (`ps`, Task Manager) and never
 * appears in this command's own failure message. Mirrors the CredRead shim
 * in readSecret below.
 */
const WINDOWS_CRED_WRITE_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class CredW1F3EA {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL {
    public int Flags; public int Type; public IntPtr TargetName; public IntPtr Comment;
    public long LastWritten; public int CredentialBlobSize; public IntPtr CredentialBlob;
    public int Persist; public int AttributeCount; public IntPtr Attributes;
    public IntPtr TargetAlias; public IntPtr UserName;
  }
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern bool CredWrite(ref CREDENTIAL credential, int flags);
}
'@
$payload = [Console]::In.ReadToEnd() | ConvertFrom-Json
$blobBytes = [Convert]::FromBase64String($payload.blob)
$targetPtr = [Runtime.InteropServices.Marshal]::StringToHGlobalUni($payload.target)
$userPtr = [Runtime.InteropServices.Marshal]::StringToHGlobalUni($payload.username)
$blobPtr = [Runtime.InteropServices.Marshal]::AllocHGlobal([Math]::Max($blobBytes.Length, 1))
if ($blobBytes.Length -gt 0) {
  [Runtime.InteropServices.Marshal]::Copy($blobBytes, 0, $blobPtr, $blobBytes.Length)
}
$cred = New-Object CredW1F3EA+CREDENTIAL
$cred.Flags = 0
$cred.Type = 1
$cred.TargetName = $targetPtr
$cred.Comment = [IntPtr]::Zero
$cred.CredentialBlobSize = $blobBytes.Length
$cred.CredentialBlob = $blobPtr
$cred.Persist = 2
$cred.AttributeCount = 0
$cred.Attributes = [IntPtr]::Zero
$cred.TargetAlias = [IntPtr]::Zero
$cred.UserName = $userPtr
$ok = [CredW1F3EA]::CredWrite([ref]$cred, 0)
[Runtime.InteropServices.Marshal]::FreeHGlobal($targetPtr)
[Runtime.InteropServices.Marshal]::FreeHGlobal($userPtr)
[Runtime.InteropServices.Marshal]::FreeHGlobal($blobPtr)
if (-not $ok) { exit 1 }
`

/** Never include the caught error's own message/output: it may echo stdin back. */
function secretFreeStorageError(where, target) {
  return new Error(`could not write to ${where} (target "${target}"); no secret was included in this error`)
}

function writeWindowsCredential(execImpl, target, username, base64Blob) {
  const payload = JSON.stringify({ target, username, blob: base64Blob })
  try {
    execImpl('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_CRED_WRITE_SCRIPT], {
      input: payload,
      stdio: ['pipe', 'ignore', 'pipe'],
    })
  } catch {
    throw secretFreeStorageError('Windows Credential Manager', target)
  }
}

function shellQuoteForSecurityInteractive(value) {
  return `'${String(value).replace(/'/gu, "'\\''")}'`
}

function writeMacKeychainCredential(execImpl, service, account, base64Blob) {
  const script = [
    `add-generic-password -a ${shellQuoteForSecurityInteractive(account)}`,
    `-s ${shellQuoteForSecurityInteractive(service)}`,
    `-w ${shellQuoteForSecurityInteractive(base64Blob)} -U`,
    'quit',
    '',
  ].join('\n')
  try {
    // Interactive mode (`-i`) reads its subcommands from stdin, so the
    // password never becomes a `security` process argument the way a direct
    // `add-generic-password -w <value>` invocation would.
    execImpl('security', ['-i'], { input: script, stdio: ['pipe', 'ignore', 'pipe'] })
  } catch {
    throw secretFreeStorageError('macOS Keychain', service)
  }
}

/**
 * Undoes `security dump-keychain`'s own escaping of ONE already-unquoted
 * attribute value (the capture group of the quoted-string regex below,
 * never including the surrounding `"..."` themselves): `\"` for an embedded
 * quote, `\\` for a literal backslash, and any other non-printable byte as
 * a 3-digit OCTAL escape -- per BYTE, not per character. A multi-byte UTF-8
 * character (anything outside ASCII) is therefore printed as a separate
 * `\NNN` escape for each of its bytes, e.g. "é" (U+00E9, UTF-8 C3 A9) as
 * `\303\251` -- decoding each escape with String.fromCharCode (a UTF-16
 * code UNIT, not a byte) would turn that into two mojibake characters
 * (U+00C3, U+00A9) instead of recombining the two bytes into one UTF-8
 * character. This decodes every escape into a raw byte first (an
 * unescaped, already-printable-ASCII literal character is always exactly
 * one byte -- everything else is what `security` itself always escapes)
 * and only turns the whole byte sequence into a string, as UTF-8, once, at
 * the very end.
 */
function unescapeSecurityDumpString(quoted) {
  const bytes = []
  let i = 0
  while (i < quoted.length) {
    const ch = quoted[i]
    if (ch === '\\') {
      const octal = /^[0-7]{3}/u.exec(quoted.slice(i + 1, i + 4))
      if (octal) {
        bytes.push(parseInt(octal[0], 8) & 0xff)
        i += 4
        continue
      }
      const next = quoted[i + 1]
      if (next === '"' || next === '\\') {
        bytes.push(next.charCodeAt(0))
        i += 2
        continue
      }
      // Not an escape form `security` itself ever emits (per the doc
      // comment above) -- keep the backslash literally rather than
      // silently eating a character that turns out not to start one.
      bytes.push(0x5c)
      i += 1
      continue
    }
    // `security` only ever leaves a printable-ASCII byte unescaped, so a
    // literal character here is always exactly one byte.
    bytes.push(ch.charCodeAt(0) & 0xff)
    i += 1
  }
  return Buffer.from(bytes).toString('utf8')
}

/**
 * Parses `security dump-keychain`'s own metadata-only listing (never `-d`,
 * which would ALSO dump every item's secret data) into the "svce" (service)
 * attribute value of every generic-password item it printed. Real output
 * for one item looks like:
 *
 *   keychain: "/Users/agent/Library/Keychains/login.keychain-db"
 *   version: 512
 *   class: "genp"
 *   attributes:
 *       0x00000007 <blob>="1f3ea:https://1f3ea.com:alice"
 *       0x00000008 <blob>=<NULL>
 *       "acct"<blob>="alice"
 *       ...
 *       "svce"<blob>="1f3ea:https://1f3ea.com:alice"
 *       "sync"<sint32>=0x00000000
 *       "tomb"<sint32>=0x00000000
 *       "type"<uint32>=<NULL>
 *
 * -- the `"svce"<blob>="..."` line is the one this reads, undone by
 * unescapeSecurityDumpString above. `security` also has a SECOND form for a
 * value that needs escaping, printing the raw bytes as hex ahead of the
 * same escaped-quoted rendering: `"svce"<blob>=0x<HEX>  "escaped"` -- the
 * quoted-string match below tolerates an optional `0x<hex>` prefix so that
 * form is read too (the hex itself is redundant with the quoted form once
 * unescaped, so this only ever reads the quoted half). A line whose value
 * is `<NULL>` (no service name at all) is skipped. This repo's own darwin
 * backend cannot run on a non-macOS CI runner, so this parser is pinned in
 * test/identity-client.test.mjs against a captured, documented sample of
 * real `security dump-keychain` output, never against a live `security`
 * binary.
 */
function parseKeychainServiceNames(dumpOutput) {
  const services = []
  const serviceLineRe = /^\s*"svce"<blob>=(.*)$/gmu
  let match
  while ((match = serviceLineRe.exec(dumpOutput)) !== null) {
    const raw = match[1].trim()
    if (raw === '<NULL>') continue
    const quoted = /^(?:0x[0-9A-Fa-f]+\s+)?"((?:\\.|[^"\\])*)"/u.exec(raw)
    if (!quoted) continue
    services.push(unescapeSecurityDumpString(quoted[1]))
  }
  return services
}

/**
 * Writes one secret bundle to the OS credential store and returns a
 * human-readable, secret-free description of where it went. Store one JSON
 * blob per identity (key + recovery codes together) so a caller resuming
 * later reads them back from the same place with the same tool. The secret
 * bundle is always base64-encoded JSON delivered over stdin to whichever
 * tool writes it, never a process argument -- see writeWindowsCredential and
 * writeMacKeychainCredential above. `deps.homeDir` is consulted on macOS
 * and Windows (the non-secret vault index) and on the plain-file path (the
 * credentials directory); it never changes where the OS credential store
 * itself keeps the secret entry.
 */
function storeSecret(origin, label, payload, deps = {}) {
  const execImpl = deps.execFileSync ?? execFileSync
  const os = deps.platform ?? platform()
  const serialized = JSON.stringify(payload)
  const encoded = Buffer.from(serialized, 'utf8').toString('base64')
  // Recorded into the non-secret index below so listVaultLabels can tell a
  // staging entry from a real merchant without decoding the secret store
  // itself -- see the "Non-secret vault index" comment above.
  const staging = payload?.kind === 'staging'
  if (os === 'win32') {
    const target = vaultTarget(origin, label)
    writeWindowsCredential(execImpl, target, label, encoded)
    updateVaultIndex(origin, label, deps.homeDir, (labels, thisLabel) => labels.set(thisLabel, { staging }))
    return `Windows Credential Manager (target "${target}", value base64-encoded JSON)`
  }
  if (os === 'darwin') {
    const service = vaultTarget(origin, label)
    writeMacKeychainCredential(execImpl, service, label, encoded)
    updateVaultIndex(origin, label, deps.homeDir, (labels, thisLabel) => labels.set(thisLabel, { staging }))
    return `macOS Keychain (service "${service}", account "${label}")`
  }
  const filePath = credentialsFilePath(origin, label, deps.homeDir)
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 })
  // writeFileSync's `mode` option is ignored when the file already exists
  // (it only applies to a newly created file), so an existing world/group
  // readable file would silently keep its old permissions. chmodSync after
  // the write is what actually narrows an existing file, and it can fail
  // silently on filesystems without POSIX permission bits (e.g. FAT/exFAT)
  // -- so verify the mode actually landed instead of trusting either call.
  writeFileSync(filePath, `${serialized}\n`, { mode: 0o600 })
  if (os === 'win32') {
    // POSIX mode bits do not apply on Windows; the file already went
    // through the win32 branch above, so this path is unreachable in
    // practice, but keep the message accurate if it is ever reached.
    return `local file ${filePath} (POSIX mode bits do not apply on this platform)`
  }
  try {
    chmodSync(filePath, 0o600)
  } catch {
    // Best effort on filesystems that do not support POSIX permissions;
    // fall through to the stat check below, which will catch the case
    // where the file ended up group/world readable.
  }
  let observedMode
  try {
    observedMode = statSync(filePath).mode & 0o777
  } catch {
    throw secretFreeStorageError('local credentials file', filePath)
  }
  if ((observedMode & 0o077) !== 0) {
    try {
      unlinkSync(filePath)
    } catch {
      // Best effort: the file could not be removed either, but we still
      // must not report success or leave the caller believing the secret
      // is safely stored.
    }
    throw secretFreeStorageError('local credentials file', filePath)
  }
  // Recorded in the same non-secret vault index the win32/darwin backends
  // use, so listVaultLabels below can tell a staging entry from a real
  // merchant without ever opening or parsing a credentials bundle -- see
  // the "Non-secret vault index" comment above.
  updateVaultIndex(origin, label, deps.homeDir, (labels, thisLabel) => labels.set(thisLabel, { staging }))
  return `local file ${filePath} (mode ${observedMode.toString(8).padStart(3, '0')})`
}

/**
 * Raised by readSecret when the vault reports a target/service/file exists
 * but its content could not be decoded back into the JSON bundle storeSecret
 * writes. Kept distinct from "nothing is stored there" (readSecret returns
 * `{ found: false }` for that case) so a caller can tell "there was never a
 * prior entry" -- fine, nothing to carry forward -- apart from "a prior
 * entry exists but this read cannot recover it" -- never safe to silently
 * treat as empty, because doing so is exactly how rotation and recovery used
 * to overwrite a live vault entry and drop the recovery codes and
 * client_class it carried.
 */
class SecretReadFailure extends Error {}

/**
 * The counterpart to storeSecret: reads back the JSON bundle this script
 * wrote for `label`. Returns `{ found: false, value: null }` when nothing is
 * stored there. Returns `{ found: true, value }` when the stored entry was
 * read and decoded successfully -- a write followed by a read must return
 * exactly what was written, on every supported platform. Throws
 * SecretReadFailure when the vault reports an entry exists but this read
 * could not decode it, so a caller can refuse to promote over it rather than
 * silently treating "could not read" the same as "nothing there". Used by
 * rotate/recoverBegin below to carry forward fields -- recovery codes,
 * client_class -- that the replacement key alone does not carry.
 */
function readSecret(origin, label, deps = {}) {
  const execImpl = deps.execFileSync ?? execFileSync
  const os = deps.platform ?? platform()
  if (os === 'win32') {
    const target = vaultTarget(origin, label)
    const escapedTarget = target.replaceAll("'", "''")
    // cmdkey itself has no way to print a stored password back out -- by
    // design it only lists the account name. Reading it back needs the real
    // Win32 Credential Manager API (CredRead), reached here through a small
    // inline PowerShell/.NET shim.
    const script = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class Cred1F3EA {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL {
    public int Flags; public int Type; public IntPtr TargetName; public IntPtr Comment;
    public long LastWritten; public int CredentialBlobSize; public IntPtr CredentialBlob;
    public int Persist; public int AttributeCount; public IntPtr Attributes;
    public IntPtr TargetAlias; public IntPtr UserName;
  }
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern bool CredRead(string target, int type, int flags, out IntPtr credential);
  [DllImport("advapi32.dll", SetLastError = true)]
  public static extern void CredFree(IntPtr credential);
}
'@
$ptr = [IntPtr]::Zero
$ok = [Cred1F3EA]::CredRead('${escapedTarget}', 1, 0, [ref]$ptr)
if (-not $ok) { exit 1 }
$cred = [System.Runtime.InteropServices.Marshal]::PtrToStructure($ptr, [type][Cred1F3EA+CREDENTIAL])
$bytes = New-Object byte[] $cred.CredentialBlobSize
[System.Runtime.InteropServices.Marshal]::Copy($cred.CredentialBlob, $bytes, 0, $cred.CredentialBlobSize)
[Cred1F3EA]::CredFree($ptr)
# writeWindowsCredential above stores the exact raw bytes CredWrite was given
# (the UTF-8 bytes of the JSON payload, decoded from the base64 wire form
# sent over stdin) -- never UTF-16. Re-encode those same raw bytes back to
# base64 here so the Node side's Buffer.from(encoded, 'base64') below
# recovers the exact original bytes, with no text-encoding step in between
# that could corrupt them. (A prior version of this script decoded the
# CredentialBlob as UTF-16LE here, which does not match how it was written
# and made every read return null after a successful write.)
[Console]::Out.Write([Convert]::ToBase64String($bytes))
`
    // A non-zero exit here means CredRead found nothing at this target (the
    // `if (-not $ok) { exit 1 }` above) -- that is "not found", not a read
    // failure, so it maps to { found: false }, not a thrown error.
    let encoded
    try {
      encoded = execImpl(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', script],
        { encoding: 'utf8' },
      )
    } catch {
      return { found: false, value: null }
    }
    if (!encoded) return { found: false, value: null }
    // Past this point CredRead reported an entry and returned bytes: any
    // decode failure here is a corrupt or unrecoverable entry, not a missing
    // one, so it throws instead of returning { found: false }.
    try {
      return { found: true, value: JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) }
    } catch {
      throw new SecretReadFailure(
        `the Windows Credential Manager entry for "${label}" exists but could not be decoded back into ` +
        'the expected JSON bundle',
      )
    }
  }
  if (os === 'darwin') {
    const service = vaultTarget(origin, label)
    // A non-zero exit here means `security` found no matching keychain item
    // -- "not found", not a read failure.
    let serialized
    try {
      serialized = execImpl(
        'security',
        ['find-generic-password', '-a', label, '-s', service, '-w'],
        { encoding: 'utf8' },
      )
    } catch {
      return { found: false, value: null }
    }
    // writeMacKeychainCredential above stores the base64-encoded JSON
    // payload as the keychain password (`-w base64Blob`), matching what it
    // sends -- so this must decode that same base64 back before parsing.
    // (A prior version of this script parsed the raw retrieved text as JSON
    // directly, without ever base64-decoding it, so it never matched what
    // was actually stored and every read failed.)
    try {
      return { found: true, value: JSON.parse(Buffer.from(serialized.trim(), 'base64').toString('utf8')) }
    } catch {
      throw new SecretReadFailure(
        `the macOS Keychain entry for "${label}" exists but could not be decoded back into the expected ` +
        'JSON bundle',
      )
    }
  }
  const filePath = credentialsFilePath(origin, label, deps.homeDir)
  let raw
  try {
    raw = (deps.readFileSync ?? readFileSync)(filePath, 'utf8')
  } catch {
    return { found: false, value: null }
  }
  try {
    return { found: true, value: JSON.parse(raw) }
  } catch {
    throw new SecretReadFailure(`the credentials file "${filePath}" exists but could not be parsed as JSON`)
  }
}

/**
 * Lock path for promoteReplacementKey's critical section below, scoped to
 * one (origin, handle) pair -- deliberately not to the caller (register,
 * rotate, recoverBegin) or to the specific staging label, since what this
 * must serialize against is any OTHER promotion racing for the same live
 * vault entry on this host, whichever command started it. Lives in the
 * same ~/.1f3ea directory as vault-index.json and reuses the exact same
 * withFileLock mechanism (short-retry, stale-aware) defined above.
 */
function promoteLockPath(origin, handle, homeDir) {
  const safeOrigin = origin.replace(/[^a-z0-9.-]/giu, '_')
  const safeHandle = handle.replace(/[^a-z0-9._-]/giu, '_')
  return join(homeDir ?? homedir(), '.1f3ea', `promote-lock__${safeOrigin}__${safeHandle}.lock`)
}

/**
 * Shared by register()/rotate()/recoverBegin() after their server-side
 * confirm has already succeeded (so the replacement merchant_key is
 * already the live one on the server -- only where it lives in the local
 * vault is still being settled here). Reads back the live entry to carry
 * forward fields the replacement key alone does not carry (via
 * `mergeFields`), then overwrites that live entry and deletes the staging
 * copy.
 *
 * The read, the refuseIfPresent re-check, and the write all run inside one
 * withFileLock critical section keyed by (origin, handle) (see
 * promoteLockPath above): two promotions for the SAME handle on THIS host
 * -- two concurrent `register` invocations racing the same requested
 * handle is the case that matters in practice -- are serialized end to
 * end, so the second one's read can never observe the stale "not found"
 * the first one already read past. This closes the same-HOST race
 * completely; it closes nothing across hosts (two different machines
 * racing the same handle are decided by the market's own confirm, not by
 * anything this client does locally -- see register()'s own comment).
 * `refuseIfPresent` below is what actually decides who wins on a single
 * host once that ordering is fixed; the lock is what makes the ordering
 * trustworthy to decide from in the first place.
 *
 * If the read-back reports the live entry exists but cannot be decoded
 * (SecretReadFailure), this refuses to promote: the live entry is left
 * completely untouched, and -- critically -- the staging copy is also left
 * in place rather than deleted, because it is the only place the already-
 * confirmed replacement key currently lives. The caller sees exactly where
 * to recover it and what to fix before retrying.
 *
 * The write that follows can fail too (a locked keychain, a permission
 * error, a full disk) -- and by the time this function runs, the server
 * already confirmed the rotation/recovery, so the OLD key is already dead
 * there. A write failure here must never surface as a bare "could not
 * write" with no context: the caller needs to know the old key no longer
 * works AND that the only copy of the new one currently lives at
 * `stagingLabel` and nowhere else. The staging copy is left in place (it is
 * only deleted after storeSecret below actually succeeds), so nothing is
 * lost -- but it must be recovered by hand.
 *
 * `refuseIfPresent` (default false): when true, refuses to overwrite an
 * entry the readSecret call just above found -- register() passes this,
 * since (unlike rotate/recoverBegin, which intentionally replace the live
 * entry for the SAME already-owned handle) register() must never silently
 * overwrite a DIFFERENT registration that came to exist for this handle
 * after register()'s own pre-flight check ran and before this, its last
 * chance to check again immediately before the write -- now made safe to
 * trust by the lock above, rather than merely narrowing the window the way
 * an unlocked re-check would. Same "staging copy kept, caller-worded
 * message" shape as the SecretReadFailure case above.
 */
function promoteReplacementKey(origin, handle, stagingLabel, merchantKey, mergeFields, deps = {}, { refuseIfPresent = false } = {}) {
  const lockPath = promoteLockPath(origin, handle, deps.homeDir)
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 })
  const result = withFileLock(lockPath, () => {
    let previous
    try {
      previous = readSecret(origin, handle, deps)
    } catch (error) {
      throw new Error(
        `refusing to overwrite the existing vault entry for "${handle}": ${error.message}. ` +
        'The already-confirmed replacement key was NOT lost -- it is still stored under the ' +
        `staging label "${stagingLabel}". Resolve the unreadable entry, read the replacement key back ` +
        `from "${stagingLabel}", then store it under "${handle}" yourself.`,
      )
    }
    if (refuseIfPresent && previous.found) {
      // With the lock above held for this entire read-check-write section,
      // this re-check is no longer merely narrowing a TOCTOU window -- it
      // is the actual, trustworthy last word on whether this handle is
      // free on THIS host: no other promoteReplacementKey call for the
      // same (origin, handle) can be reading or writing concurrently while
      // this one holds the lock. `previous` above was read inside that
      // same locked section, immediately before the write below.
      //
      // Whether the staging entry is STILL there is a separate question
      // from whether the live entry now exists, and this refusal must not
      // assert an answer to it without checking: re-read `stagingLabel`
      // itself, inside this same locked section, rather than repeating the
      // fixed "it is still stored under the staging label" claim
      // unconditionally. Since pendingLabel() now mints a per-run-unique
      // label for registration (see its own doc comment), nothing but
      // THIS run's own successful promotion could have deleted it -- and
      // this run has not reached that point -- so in practice this reads
      // found:true; the explicit check exists so the message never lies if
      // that ever stops being true, and says plainly when it is gone
      // instead.
      let stagingStillPresent
      try {
        stagingStillPresent = readSecret(origin, stagingLabel, deps).found
      } catch {
        // An unreadable staging entry is not the same as "confirmed
        // present" -- word the refusal as not-verifiable rather than
        // asserting something this call cannot actually stand behind.
        stagingStillPresent = false
      }
      const stagingNote = stagingStillPresent
        ? `The confirmed merchant key from THIS registration was NOT lost -- it is still stored under the ` +
          `staging label "${stagingLabel}" and nowhere else. Work out which of the two entries is the one ` +
          `you actually want (for example \`key status --handle ${handle}\`), then store the key from ` +
          `"${stagingLabel}" under "${handle}" yourself if it turns out to be the one that should have won.`
        : `The confirmed merchant key from THIS registration is NO LONGER at its staging label "${stagingLabel}" ` +
          '-- it cannot be recovered from this vault. Check whatever recorded the merchant_key when this ' +
          'registration confirmed (terminal scrollback, a captured --reveal run) before concluding it is ' +
          'gone for good.'
      throw new Error(
        `refusing to overwrite the vault entry for "${handle}" that now exists: it was not there when this ` +
        'registration started, so a concurrent run on this host must have won the race for this handle. ' +
        stagingNote,
      )
    }
    let location
    try {
      location = storeSecret(origin, handle, {
        kind: 'merchant',
        handle,
        ...mergeFields(previous.found ? previous.value : null),
        merchant_key: merchantKey,
        origin,
        stored_at: new Date().toISOString(),
      }, deps)
    } catch (error) {
      throw new Error(
        `the rotation/recovery already CONFIRMED, so the old key for "${handle}" no longer works: ${error.message}. ` +
        `The replacement key is stored under "${stagingLabel}" and nowhere else -- read it back from ` +
        `"${stagingLabel}", then store it under "${handle}" yourself before doing anything else.`,
      )
    }
    deleteSecret(origin, stagingLabel, deps)
    return location
  })
  if (result === undefined) {
    // withFileLock returns undefined, without ever running the critical
    // section above, only when it could not acquire the lock within its
    // own wait budget -- meaning another promoteReplacementKey call for
    // this exact (origin, handle) is apparently still running on this
    // host. Silently returning undefined here (as a caller-visible
    // "location") would be worse than the race this lock exists to close:
    // it would report success without ever having read, checked, or
    // written anything.
    throw new Error(
      `could not acquire the per-handle vault lock for "${handle}" on this host within ` +
      `${VAULT_INDEX_LOCK_MAX_WAIT_MS}ms: another registration, rotation, or recovery for the same handle ` +
      'appears to still be running concurrently on this host. The already-confirmed replacement key was NOT ' +
      `lost -- it is still stored under the staging label "${stagingLabel}" and nowhere else. Retry once the ` +
      `other run finishes, or read the key back from "${stagingLabel}" and store it under "${handle}" yourself.`,
    )
  }
  return result
}

/** Removes a stored secret bundle. Best effort: a missing entry is not an error. */
function deleteSecret(origin, label, deps = {}) {
  const execImpl = deps.execFileSync ?? execFileSync
  const os = deps.platform ?? platform()
  if (os === 'win32') {
    try {
      execImpl('cmdkey', [`/delete:${vaultTarget(origin, label)}`], { stdio: 'ignore' })
    } catch {
      // Best effort: nothing to delete, or cmdkey already reports failure loudly enough elsewhere.
    }
    updateVaultIndex(origin, label, deps.homeDir, (labels, thisLabel) => labels.delete(thisLabel))
    return
  }
  if (os === 'darwin') {
    try {
      execImpl(
        'security',
        ['delete-generic-password', '-a', label, '-s', vaultTarget(origin, label)],
        { stdio: 'ignore' },
      )
    } catch {
      // Best effort, same as above.
    }
    updateVaultIndex(origin, label, deps.homeDir, (labels, thisLabel) => labels.delete(thisLabel))
    return
  }
  try {
    rmSync(credentialsFilePath(origin, label, deps.homeDir), { force: true })
  } catch {
    // Best effort, same as above.
  }
  updateVaultIndex(origin, label, deps.homeDir, (labels, thisLabel) => labels.delete(thisLabel))
}

/**
 * True when `label` should be excluded from listVaultLabels' result --
 * i.e. it is a staging copy, not a real registered identity. Prefers the
 * `staging` marker `indexMap` carries for this label (set from the bundle's
 * own `kind` field at write time -- see storeSecret above), since that is
 * data, not a guess about what the label text looks like: a real merchant
 * whose handle happens to end in "--pending-rotation" or similar has
 * `staging: false` recorded for it and is never dropped this way. Falls
 * back to the isPendingLabel suffix heuristic only when `indexMap` has no
 * entry for this label at all, or its staging status is unknown (a legacy
 * index entry written before this marker existed, or -- on win32 -- a label
 * `cmdkey /list` found that the index never recorded).
 */
function isStagingLabel(label, indexMap) {
  const meta = indexMap.get(label)
  if (meta && typeof meta.staging === 'boolean') return meta.staging
  return isPendingLabel(label)
}

/**
 * Lists every label this host's vault currently holds for `origin`,
 * excluding staging labels -- never the exact-handle lookup readSecret
 * already does, but a genuine enumeration of "does anything else already
 * exist here", so setup.mjs's duplicate-identity guard can refuse a fresh
 * registration under a different handle instead of silently creating a
 * second, permanent, unrecoverable merchant next to one that already
 * exists. Never throws: an enumeration failure (no `cmdkey` on PATH, an
 * unreadable directory, a missing index) is treated as "found nothing", the
 * same fail-open behavior that guard already accepts for a missing
 * setup-state.json -- the guard exists to catch the common case (state
 * lost, vault intact), not to be a perfect audit.
 */
function listVaultLabels(origin, deps = {}) {
  const execImpl = deps.execFileSync ?? execFileSync
  const os = deps.platform ?? platform()
  if (os === 'win32') {
    const prefix = vaultTarget(origin, '')
    // cmdkey's own output is localized -- on a non-English Windows install
    // the literal "Target:" label below never appears, so this alone can
    // silently return nothing. Union it with the non-secret vault index
    // (language-independent, maintained by storeSecret/deleteSecret above)
    // instead of trusting either source alone: a failed or empty cmdkey
    // scrape still leaves the index, and a stale/incomplete index still
    // leaves whatever cmdkey actually found.
    const fromCmdkey = []
    try {
      const output = execImpl('cmdkey', ['/list'], { encoding: 'utf8' })
      for (const match of output.matchAll(/Target:\s*(.+)\s*$/gmu)) {
        // Real `cmdkey /list` output prefixes the target this script wrote
        // with its own credential-type marker -- observed as
        // "LegacyGeneric:target=1f3ea:<origin>:<label>", not the bare target
        // -- so search for the prefix anywhere in the line rather than
        // requiring it at the very start.
        const target = match[1].trim()
        const index = target.indexOf(prefix)
        if (index !== -1) fromCmdkey.push(target.slice(index + prefix.length))
      }
    } catch {
      // cmdkey unavailable or failed -- fall through to the index below
      // rather than reporting an empty result outright.
    }
    const vaultIndex = readVaultIndex(deps.homeDir)
    const indexMap = vaultIndexEntriesToMap(Array.isArray(vaultIndex[origin]) ? vaultIndex[origin] : [])
    const labels = new Set([...fromCmdkey, ...indexMap.keys()])
    return [...labels].filter(label => !isStagingLabel(label, indexMap))
  }
  if (os === 'darwin') {
    const index = readVaultIndex(deps.homeDir)
    const indexMap = vaultIndexEntriesToMap(Array.isArray(index[origin]) ? index[origin] : [])
    // `security dump-keychain` (metadata only -- NEVER `-d`, which would
    // also dump every item's SECRET data) is what actually enumerates the
    // Keychain itself, unioned with the non-secret index below the exact
    // same way the win32 branch above unions `cmdkey /list`. Without this,
    // listVaultLabels on darwin trusted the HOME-resident index alone -- and
    // the index lives under the same HOME a lost/reset profile or a
    // corrupted vault-index.json can make disappear while the Keychain
    // entries themselves are still intact, which is exactly the precondition
    // setup.mjs's duplicate-identity guard exists to catch (state file gone,
    // vault intact): with the index alone, that guard fails open and lets a
    // fresh registration create a second, permanent, unrecoverable merchant
    // right next to one that already exists.
    const prefix = vaultTarget(origin, '')
    const fromKeychain = []
    // A normal developer login Keychain (Safari, wifi, certificate, and app
    // tokens) can print well past Node's 1 MiB execFileSync default, which
    // throws ENOBUFS -- and a bare catch below could not tell that apart
    // from "no `security` binary on PATH", so an incomplete dump silently
    // read as "found nothing", reopening the exact fail-open this union
    // exists to close. maxBuffer/timeout give a large dump room to finish;
    // when it still cannot, `incomplete` is set so the caller below can
    // return that signal rather than an empty result.
    let incomplete = false
    try {
      const output = execImpl('security', ['dump-keychain'], {
        encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 10_000,
      })
      for (const service of parseKeychainServiceNames(output)) {
        if (service.startsWith(prefix)) fromKeychain.push(service.slice(prefix.length))
      }
    } catch (error) {
      // ENOBUFS (dump exceeded maxBuffer) and ETIMEDOUT (dump exceeded
      // timeout) mean the dump STARTED but did not finish -- the
      // enumeration is incomplete, not empty. Anything else (ENOENT: no
      // `security` binary on PATH; a genuine dump-keychain failure) really
      // does mean nothing was found, and falls through to the index alone
      // below, same as win32's cmdkey fallback above.
      if (error?.code === 'ENOBUFS' || error?.code === 'ETIMEDOUT') incomplete = true
    }
    const labels = new Set([...fromKeychain, ...indexMap.keys()])
    const result = [...labels].filter(label => !isStagingLabel(label, indexMap))
    if (incomplete) {
      // Non-enumerable so existing callers that treat this as a plain
      // array of labels (assert.deepEqual included) see no difference;
      // setup.mjs's duplicate-identity guard checks this flag explicitly.
      Object.defineProperty(result, 'incomplete', { value: true, enumerable: false })
    }
    return result
  }
  const dir = join(deps.homeDir ?? homedir(), '.1f3ea', 'credentials')
  const safeOrigin = origin.replace(/[^a-z0-9.-]/giu, '_')
  const prefix = `${safeOrigin}__`
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return []
  }
  const labels = entries
    .filter(name => name.startsWith(prefix) && name.endsWith('.json'))
    .map(name => name.slice(prefix.length, -'.json'.length))
  // Same non-secret vault index the win32/darwin backends read above --
  // storeSecret/deleteSecret now maintain it for the file backend too, so
  // this enumeration stays label-only and never opens or parses a
  // credentials bundle just to answer "does this exist", matching the
  // "Non-secret vault index" comment's promise. A label this version never
  // indexed (a pre-index bundle, or an index entry lost to a crash) has no
  // entry here and falls back to the isPendingLabel suffix guess via
  // isStagingLabel, same as win32/darwin.
  const index = readVaultIndex(deps.homeDir)
  const indexMap = vaultIndexEntriesToMap(Array.isArray(index[origin]) ? index[origin] : [])
  return labels.filter(label => !isStagingLabel(label, indexMap))
}

// --- HTTP -----------------------------------------------------------------

/**
 * Wraps a fetch failure (DNS, connection refused, timeout, TLS -- anything
 * before a response ever arrives) into a caller-facing message that names
 * the origin, says nothing was created, and suggests a next step, instead of
 * letting the bare engine error ("fetch failed") escape unexplained. Kept as
 * a byte-identical copy of the market's own reference client
 * (scripts/identity-client.mjs); if this file ever diverges from that
 * upstream copy, port the fix there too.
 */
async function fetchOrExplain(url, init) {
  try {
    // redirect: 'error' overrides anything a caller passed in `init` -- a
    // real identity door has no reason to redirect any of these calls, and
    // without this, a 307/308 response from the (validated) named origin
    // could carry a secret request body to an entirely different host on
    // the next hop, a hop assertAllowedOrigin (called only against the
    // first-hop origin, in originOf above) never gets a chance to check.
    return await fetch(url, { ...init, redirect: 'error' })
  } catch (error) {
    // Node's fetch wraps the real failure in `error.cause`, which for a
    // connection failure is itself an AggregateError with an EMPTY top-level
    // message and the useful text one level deeper in `.errors[0].message`
    // (or just a `.code` like ECONNREFUSED/ENOTFOUND when even that is
    // absent) -- so fall through several levels rather than printing a bare
    // "(network error: )" with nothing after the colon.
    const cause = error?.cause
    const detail =
      cause?.message
      || cause?.errors?.[0]?.message
      || cause?.code
      || error?.message
      || String(error)
    throw new Error(
      `could not reach ${url} (network error: ${detail}); nothing was created -- check the address and ` +
      'your connection, then retry',
    )
  }
}

async function postJson(origin, path, body) {
  const response = await fetchOrExplain(`${origin}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  let parsed = null
  try {
    parsed = await response.json()
  } catch {
    // Non-JSON response falls through with parsed === null below.
  }
  if (!response.ok || !parsed) {
    const error = parsed?.error ?? `HTTP ${response.status} with no readable JSON body`
    // The market's own refusal envelope is exactly {error, reason} (and the
    // same `reason` on the X-1F3EA-Reason header) -- never `next_step`,
    // which no door here returns. Surface the machine-readable reason the
    // market actually publishes instead of a field that can never fire.
    const reason = typeof parsed?.reason === 'string' ? ` reason: ${parsed.reason}` : ''
    throw new Error(`${path} refused: ${error}.${reason}`)
  }
  return parsed
}

async function postAuthed(origin, path, merchantKey, body) {
  const response = await fetchOrExplain(`${origin}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${merchantKey}`,
    },
    body: JSON.stringify(body ?? {}),
  })
  let parsed = null
  try {
    parsed = await response.json()
  } catch {
    // handled below
  }
  if (!response.ok || !parsed) {
    const error = parsed?.error ?? `HTTP ${response.status} with no readable JSON body`
    // Same reason-surfacing tail as postJson above -- the market's refusal
    // envelope on an authed door (e.g. /api/pair) is the same {error, reason}
    // shape, and a caller or harness relies on the machine-readable name to
    // decide what to do next (auth_required, unexpected_fields,
    // pairing_unavailable, rate_limited, storage_unavailable).
    const reason = typeof parsed?.reason === 'string' ? ` reason: ${parsed.reason}` : ''
    throw new Error(`${path} refused: ${error}.${reason}`)
  }
  return parsed
}

// --- Commands ---------------------------------------------------------

/**
 * Best effort: tells the market to release a stage it will otherwise just
 * let expire on its own. Unlike the city's single `stage_token`, the
 * market's own confirm/cancel shape is a `session` + `csrf` PAIR (see the
 * served front door's coding-client doors section: every action other than
 * `recovery generate` accepts `{"action":"cancel","session","csrf"}`) -- so
 * this takes both rather than one opaque token.
 */
async function cancelStage(origin, path, session, csrf) {
  try {
    await postJson(origin, path, { action: 'cancel', session, csrf })
  } catch {
    // Best effort -- the stage expires on its own either way, and the
    // caller above is already reporting the real failure.
  }
}

async function register(flags) {
  const origin = originOf(flags)
  const handle = requireFlag(flags, 'handle')
  if (!HANDLE_RE.test(handle)) {
    throw new Error(
      `--handle "${handle}" does not match the market's handle rule ${HANDLE_RE.source} (lowercase letters, ` +
      'digits, and hyphens, 3-32 characters, must start with a letter or digit); nothing was created -- ' +
      'choose a handle that already matches this rule before asking a human to approve it',
    )
  }
  if (RESERVED_HANDLE_SUBSTRING_RE.test(handle)) {
    throw new Error(
      `--handle "${handle}" contains "--pending-", which this script reserves for its own in-flight ` +
      'staging labels; nothing was created -- choose a handle that does not contain that sequence',
    )
  }
  const clientClass = requireFlag(flags, 'client-class')
  if (clientClass !== 'coding_persistent' && clientClass !== 'coding_ephemeral') {
    throw new Error('--client-class must be coding_persistent or coding_ephemeral')
  }
  const model = typeof flags.model === 'string' ? flags.model : ''
  // Checked locally, before ever asking for human approval, against the
  // exact rule the market itself enforces (identityModelValue) -- so an
  // approval nonce is never spent on a registration the market was always
  // going to refuse for its model label alone.
  if (!isValidModel(model)) {
    throw new Error(
      '--model must be at most 120 characters after trimming, with no control or directional-override ' +
      'marks (the market\'s own validator refuses the same); nothing was created -- fix the model label ' +
      'before asking a human to approve this registration',
    )
  }
  const replaceVaultEntry = flags['replace-vault-entry'] === true

  let humanApproved = flags['human-approved'] === true
  if (!humanApproved) {
    humanApproved = await askYesNo(
      `Confirm the permanent public handle "${handle}" was chosen with a human's approval. Register it now?`,
    )
  }
  if (!humanApproved) {
    throw new Error(
      'registration needs human approval of the permanent public name; re-run with a "y" answer or pass --human-approved only after that approval already happened',
    )
  }

  const staged = await postJson(origin, '/api/register', {
    action: 'stage',
    handle,
    // model must always be PRESENT in the body -- the market's own
    // validator (requireHandleAndModel) requires the field to be present
    // ("" is accepted, an absent key is not); sending it conditionally used
    // to refuse every model-less registration with 400 invalid_identity.
    model,
    client_class: clientClass,
    human_approved: true,
  })
  // The market may normalize the requested handle at staging time -- from
  // here on ITS answer is the identity of record, never the spelling this
  // call was invoked with (see the module comment on HANDLE_RE above).
  const stagedHandle = typeof staged.handle === 'string' ? staged.handle : handle

  // Same discipline rotate()/recoverBegin() already apply, extended to
  // register() itself: never overwrite whatever the vault already holds
  // under the identity of record without an explicit, deliberate override.
  // Without this, a stale or normalized label collision would let the
  // storeSecret call below silently destroy an existing key and its
  // recovery codes -- exactly the failure mode a dropped/ambiguous probe
  // result (setup.mjs's own vault-adopt guard cannot always tell "rejected"
  // from "could not tell") could otherwise walk straight into.
  if (!replaceVaultEntry) {
    let existing
    try {
      existing = readSecret(origin, stagedHandle)
    } catch (error) {
      await cancelStage(origin, '/api/register', staged.session, staged.csrf)
      throw new Error(
        `refusing to register over a vault entry for "${stagedHandle}" that could not be read back: ` +
        `${error.message}. The staged registration was cancelled; nothing was created. Resolve the ` +
        'unreadable entry first, then retry -- or pass --replace-vault-entry only if you are certain that ' +
        'entry should be discarded.',
      )
    }
    if (existing.found) {
      await cancelStage(origin, '/api/register', staged.session, staged.csrf)
      throw new Error(
        `refusing to register over the vault entry that already exists for "${stagedHandle}": the staged ` +
        'registration was cancelled and nothing was created. Pass --replace-vault-entry only if you are ' +
        'certain that entry should be discarded -- doing so destroys whatever key and recovery codes it ' +
        'currently holds.',
      )
    }
  }

  // Stage the new bundle under a DISTINCT vault label first, exactly like
  // rotate()/recoverBegin() below -- never write to the live label before
  // confirm actually succeeds.
  const stagingLabel = pendingLabel(stagedHandle, 'registration')
  storeSecret(origin, stagingLabel, {
    kind: 'staging',
    handle: stagedHandle,
    client_class: clientClass,
    merchant_key: staged.merchant_key,
    recovery_codes: staged.recovery_codes,
    origin,
    stored_at: new Date().toISOString(),
  })

  let confirmed
  try {
    confirmed = await postJson(origin, '/api/register', {
      action: 'confirm',
      session: staged.session,
      csrf: staged.csrf,
      merchant_key: staged.merchant_key,
    })
  } catch (error) {
    deleteSecret(origin, stagingLabel)
    await cancelStage(origin, '/api/register', staged.session, staged.csrf)
    throw error
  }

  // The identity of record is the market's CONFIRMED answer, falling back to
  // the staged one only if the response is somehow missing it -- never the
  // originally requested spelling. promoteReplacementKey moves the staged
  // bundle to that label and deletes the staging copy only once it has
  // actually landed there.
  const finalHandle = typeof confirmed.handle === 'string' ? confirmed.handle : stagedHandle

  // Validated here, before finalHandle is ever used as a vault label,
  // printed, or (via setup.mjs's regex parse of the "handle: " line below)
  // written into setup-state.json -- the same discipline every OTHER
  // handle in this file gets before use. The registration already happened
  // server-side by this point, so this is defense in depth against the
  // market's own confirmed spelling somehow failing the rule this script
  // otherwise enforces before ever asking a human to approve a handle, not
  // an expected path.
  if (!HANDLE_RE.test(finalHandle) || RESERVED_HANDLE_SUBSTRING_RE.test(finalHandle)) {
    // Best effort: the stage is already confirmed server-side, so this call
    // is unlikely to change anything beyond what confirming already did --
    // it costs nothing to attempt, and matches every other early exit in
    // this function that cancels the stage before refusing.
    await cancelStage(origin, '/api/register', staged.session, staged.csrf)
    throw new Error(
      // finalHandle is JSON.stringify'd (not wrapped in manual quotes) because
      // it has, by definition in this branch, just failed HANDLE_RE -- it may
      // contain a newline or quote that could otherwise fabricate an extra
      // line in output the key skill instructs the agent to relay verbatim.
      `refusing to store or print the handle ${JSON.stringify(finalHandle)} the market confirmed for this ` +
      `registration: it does not match the local handle rule ${HANDLE_RE.source}, or contains the reserved ` +
      '"--pending-" sequence this script uses for its own in-flight staging labels. The merchant was already ' +
      'created server-side under that exact spelling, and its confirmed merchant key and recovery codes were ' +
      `NOT lost -- they are still stored under the staging label "${stagingLabel}" and nowhere else. Read ` +
      `them back from "${stagingLabel}" and store them under a label of your choosing yourself; this script ` +
      'will not do so automatically for a handle that fails its own naming rule.',
    )
  }

  // refuseIfPresent: register() must never silently overwrite a DIFFERENT
  // registration that came to exist for this exact handle after the
  // pre-flight check further up this function ran (see promoteReplacementKey's
  // own doc comment) -- unlike rotate()/recoverBegin() below, which
  // intentionally replace the live entry for the same already-owned handle.
  // Only when the caller passed --replace-vault-entry is that overwrite
  // actually intended -- the same flag the pre-flight check above already
  // honors, so the final write must honor it identically rather than
  // refusing what the caller explicitly asked to replace.
  const location = promoteReplacementKey(origin, finalHandle, stagingLabel, staged.merchant_key, () => ({
    client_class: clientClass,
    recovery_codes: staged.recovery_codes,
  }), {}, { refuseIfPresent: !replaceVaultEntry })

  revealOrHide(flags, 'Merchant key', [staged.merchant_key])
  revealOrHide(flags, 'Recovery codes (all eight)', staged.recovery_codes)
  console.log(`handle: ${finalHandle}`)
  console.log(`merchant_id: ${confirmed.merchant_id}`)
  console.log(`stored: ${location}`)
}

async function rotate(flags) {
  const origin = originOf(flags)
  const merchantKey = await resolveSecretArg(
    flags, 'merchant-key', [AGENT_SECRET_ENV_VAR],
  )
  if (!merchantKey || !MERCHANT_KEY_RE.test(merchantKey)) {
    throw new Error(`--merchant-key-file (or ${AGENT_SECRET_ENV_VAR}) must point to the current, valid merchant key`)
  }
  // Unlike the city's rotate (which only ever needs the current key), the
  // market's own door requires client_class on `begin` too (served front
  // door: `POST /api/rotate {"action":"begin", "client_class", "merchant_key"}`)
  // -- so a caller can change client class at rotation time, not only at
  // registration. Callers that keep the same class (the common case) pass
  // it back unchanged; key.mjs's own `rotate` defaults this from the vault
  // entry's stored client_class so a caller rarely has to think about it.
  const clientClass = requireFlag(flags, 'client-class')
  if (clientClass !== 'coding_persistent' && clientClass !== 'coding_ephemeral') {
    throw new Error('--client-class must be coding_persistent or coding_ephemeral')
  }

  const staged = await postJson(origin, '/api/rotate', {
    action: 'begin',
    client_class: clientClass,
    merchant_key: merchantKey,
  })

  // Validated here, before staged.handle is ever used as a vault label --
  // for the staging copy immediately below, and later for the live
  // promotion -- the same discipline register() applies to its own
  // confirmed handle. This is defense in depth against the market's own
  // response somehow failing the rule this script otherwise enforces before
  // ever registering a handle in the first place (reachable only through a
  // compromised 1f3ea.com or an --allow-origin the operator passed, never
  // through an honest server): without it, a wrong or hostile `handle` in
  // the begin response would be used to stage AND later overwrite whatever
  // vault entry already sits under that label. Nothing has been written to
  // this vault yet at this point, so the rotation is simply cancelled and
  // refused -- the OLD key is untouched and still the live, valid one.
  if (!HANDLE_RE.test(staged.handle) || RESERVED_HANDLE_SUBSTRING_RE.test(staged.handle)) {
    await cancelStage(origin, '/api/rotate', staged.session, staged.csrf)
    throw new Error(
      // staged.handle is JSON.stringify'd (not wrapped in manual quotes)
      // because it has, by definition in this branch, just failed HANDLE_RE
      // -- it may contain a newline or quote that could otherwise fabricate
      // an extra line in output the key skill instructs the agent to relay
      // verbatim.
      `refusing to act on the handle ${JSON.stringify(staged.handle)} this rotation's begin call named: it ` +
      `does not match the local handle rule ${HANDLE_RE.source}, or contains the reserved "--pending-" ` +
      'sequence this script uses for its own in-flight staging labels. The rotation was cancelled before ' +
      'anything was written to this vault; the OLD key is still the live, valid one.',
    )
  }

  // Stage the replacement under a DISTINCT vault target first -- never
  // overwrite the live entry before confirm succeeds. If confirm below
  // fails for any reason, the live entry (still the OLD, still-valid key)
  // is never touched; only this staging copy exists, and it is deleted.
  const stagingLabel = pendingLabel(staged.handle, 'rotation')
  storeSecret(origin, stagingLabel, {
    kind: 'staging',
    handle: staged.handle,
    client_class: clientClass,
    merchant_key: staged.merchant_key,
    origin,
    stored_at: new Date().toISOString(),
  })

  let confirmed
  try {
    confirmed = await postJson(origin, '/api/rotate', {
      action: 'confirm',
      session: staged.session,
      csrf: staged.csrf,
      merchant_key: staged.merchant_key,
    })
  } catch (error) {
    deleteSecret(origin, stagingLabel)
    await cancelStage(origin, '/api/rotate', staged.session, staged.csrf)
    throw error
  }

  // Promote: merge the now-confirmed replacement key with the (possibly
  // just-changed) client_class this rotation requested, so rotation never
  // silently drops that field. recovery_codes are deliberately NOT carried
  // forward: the market invalidates every recovery code the moment a
  // rotation confirms (front door: "Confirmation ... invalidates ... every
  // ... recovery code atomically"), so copying the old set forward would
  // leave the vault claiming eight codes that are already dead. A
  // recovery_codes_invalidated_at marker records that fact instead, so
  // `key show` can refuse to print them (see revealOrHide's caller in
  // key.mjs) and point at `recover generate`. Only now does the live entry
  // change; the staging copy is then deleted -- unless the read-back of the
  // live entry fails, in which case promoteReplacementKey refuses to
  // overwrite it and leaves the staging copy in place. See
  // promoteReplacementKey's own doc comment above.
  const location = promoteReplacementKey(origin, staged.handle, stagingLabel, staged.merchant_key, () => ({
    client_class: clientClass,
    recovery_codes_invalidated_at: new Date().toISOString(),
  }))

  // Print the already-validated staged.handle -- the label this rotation
  // actually just wrote to, two lines up -- never the confirm response's own
  // (unvalidated) `handle` field. Unlike staged.handle above, `confirmed`
  // here has never been checked against HANDLE_RE at all, so printing it raw
  // would both let an embedded newline fabricate extra `handle:`/`stored:`
  // lines in output the key skill relays verbatim, AND -- even when it is a
  // well-formed handle -- risk naming a merchant that was never actually
  // touched, if a server names one handle on begin and a different one on
  // confirm. The write already happened under staged.handle by the time this
  // runs, so a mismatch can only be reported, never undone; JSON.stringify
  // keeps that report itself from being another injection vector.
  if (typeof confirmed.handle === 'string' && confirmed.handle !== staged.handle) {
    throw new Error(
      `this rotation's confirm call named a different handle (${JSON.stringify(confirmed.handle)}) than its ` +
      `own begin call staged (${JSON.stringify(staged.handle)}). The replacement key and invalidated-codes ` +
      `marker are already written -- that cannot be undone -- under the STAGED handle, at "${location}". ` +
      `Nothing was written under ${JSON.stringify(confirmed.handle)}. Verify the vault entry at "${location}" ` +
      'by hand before trusting it, and treat this rotation as unconfirmed until you do.',
    )
  }

  revealOrHide(flags, 'Replacement merchant key', [staged.merchant_key])
  console.log(`handle: ${staged.handle}`)
  console.log(`stored: ${location}`)
  console.log(
    'your recovery codes were invalidated by this rotation (the market invalidates every recovery code on ' +
    'confirm) -- run `recover generate` (or `key recover generate`) now to mint a fresh set.',
  )
  console.log(
    'this rotation also revoked every connector session, authorization code, and delegated grant this ' +
    `merchant had (the market invalidates them atomically with the key) -- update whatever host secret ` +
    `${AGENT_SECRET_ENV_VAR} reads and re-run \`connect\`, and re-pair any chat twin with a fresh ` +
    '`connect chat` code; both will otherwise start failing with no obvious cause.',
  )
}

async function recoverGenerate(flags) {
  const origin = originOf(flags)
  const merchantKey = await resolveSecretArg(
    flags, 'merchant-key', [AGENT_SECRET_ENV_VAR],
  )
  if (!merchantKey || !MERCHANT_KEY_RE.test(merchantKey)) {
    throw new Error(`--merchant-key-file (or ${AGENT_SECRET_ENV_VAR}) must point to the current, valid merchant key`)
  }
  // The market's own /api/recovery `generate` action requires client_class
  // (RECOVERY_GENERATE_FIELDS = ['action', 'client_class', 'merchant_key']) --
  // omitting it is refused 400 invalid_client_class before the key is ever
  // checked. key.mjs's own `recover generate` defaults this from the vault
  // entry's stored client_class so a caller rarely has to think about it.
  const clientClass = requireFlag(flags, 'client-class')
  if (clientClass !== 'coding_persistent' && clientClass !== 'coding_ephemeral') {
    throw new Error('--client-class must be coding_persistent or coding_ephemeral')
  }
  const generated = await postJson(origin, '/api/recovery', {
    action: 'generate', client_class: clientClass, merchant_key: merchantKey,
  })

  // Validated here, before generated.handle is ever used as a vault label
  // below -- same discipline as register()/rotate() (see rotate()'s own
  // comment above). Nothing about this action can be cancelled the way a
  // stage/begin ceremony can (there is no session/csrf here to cancel), so
  // this refusal only means the codes the market just minted server-side
  // are never written to this vault -- it cannot undo the server-side
  // generation itself.
  if (!HANDLE_RE.test(generated.handle) || RESERVED_HANDLE_SUBSTRING_RE.test(generated.handle)) {
    throw new Error(
      // generated.handle is JSON.stringify'd (not wrapped in manual quotes)
      // because it has, by definition in this branch, just failed HANDLE_RE
      // -- it may contain a newline or quote that could otherwise fabricate
      // an extra line in output the key skill instructs the agent to relay
      // verbatim.
      `refusing to store the recovery codes the market minted under the handle ${JSON.stringify(generated.handle)}: ` +
      `it does not match the local handle rule ${HANDLE_RE.source}, or contains the reserved "--pending-" ` +
      'sequence this script uses for its own in-flight staging labels. The market already generated new ' +
      'codes server-side for that handle -- this refusal only means they were never written to this vault.',
    )
  }

  // Same per-(origin, handle) lock promoteReplacementKey takes for
  // register()/rotate()/recoverBegin() above (see promoteLockPath/
  // withFileLock), and the same read-inside-the-lock discipline: without
  // it, a concurrent rotation or recovery for this SAME handle could
  // confirm and change the live entry's key WHILE this call's own network
  // round trip to /api/recovery generate is still in flight. Naively
  // writing back the `merchantKey` this call authenticated with -- read
  // from the caller's flag/secret BEFORE that round trip, never re-checked
  // after it -- would then silently REVERT the vault to a key the market
  // has already revoked, while also storing the recovery codes this call
  // just minted, which that other confirm already invalidated (the market
  // invalidates every recovery code atomically on any such change). So the
  // live entry is re-read INSIDE this lock, and its merchant_key -- not the
  // pre-network `merchantKey` variable -- is compared against what this
  // call actually authenticated with; a mismatch means exactly that race
  // happened, and this refuses to write rather than guess which key is
  // really live.
  const lockPath = promoteLockPath(origin, generated.handle)
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 })
  const location = withFileLock(lockPath, () => {
    // Write the fresh codes into the LIVE `handle` entry, not a sibling
    // `${handle}-recovery` label: a caller resuming later (rotate, recover
    // begin, key show) reads back the vault entry for `handle` and only
    // that entry, so a set stored anywhere else is invisible to them and
    // the live entry keeps claiming whatever (possibly invalidated) codes
    // it already had. If the live entry cannot be read back, this refuses
    // to guess at its other fields (client_class) rather than silently
    // dropping them -- the market already holds the new codes as the only
    // valid set regardless.
    let previous
    try {
      previous = readSecret(origin, generated.handle)
    } catch (error) {
      throw new Error(
        `the market already generated new recovery codes for "${generated.handle}", but the existing vault ` +
        `entry could not be read back to merge them in: ${error.message}. Resolve the unreadable entry, ` +
        'then re-run this command; it is safe to run again.',
      )
    }
    if (previous.found && typeof previous.value?.merchant_key === 'string' && previous.value.merchant_key !== merchantKey) {
      throw new Error(
        `the market minted new recovery codes for "${generated.handle}", but the live vault entry's key ` +
        'changed WHILE this call was in flight -- a concurrent rotation or recovery for this same handle ' +
        'must have confirmed on this host at the same time. The just-minted codes are already invalidated by ' +
        'that other confirm (the market invalidates every recovery code atomically on any such change), so ' +
        'nothing was written here. The live vault entry was left exactly as that other, already-confirmed ' +
        'change left it; run `recover generate` again now that the race is over.',
      )
    }
    return storeSecret(origin, generated.handle, {
      kind: 'merchant',
      handle: generated.handle,
      ...(previous.found && previous.value?.client_class ? { client_class: previous.value.client_class } : {}),
      merchant_key: merchantKey,
      recovery_codes: generated.recovery_codes,
      origin,
      stored_at: new Date().toISOString(),
    })
  })
  if (location === undefined) {
    // withFileLock returns undefined, without ever running the critical
    // section above, only when it could not acquire the lock within its
    // own wait budget -- see promoteReplacementKey's own identical throw
    // above for why silently returning here would be worse than the race
    // this lock exists to close.
    throw new Error(
      `could not acquire the per-handle vault lock for "${generated.handle}" on this host within ` +
      `${VAULT_INDEX_LOCK_MAX_WAIT_MS}ms: another registration, rotation, or recovery for the same handle ` +
      'appears to still be running concurrently on this host. The market already minted new recovery codes ' +
      'for this handle server-side; nothing was written to this vault here. Retry once the other run finishes.',
    )
  }
  // Best-effort cleanup of the sibling-label location a prior version of
  // this command used to write to, so a stale duplicate never lingers.
  deleteSecret(origin, `${generated.handle}-recovery`)
  revealOrHide(flags, 'New recovery codes (replace every earlier set)', generated.recovery_codes)
  console.log(`handle: ${generated.handle}`)
  console.log(`stored: ${location}`)
}

async function recoverBegin(flags) {
  const origin = originOf(flags)
  const recoveryCode = await resolveSecretArg(flags, 'recovery-code')
  if (!recoveryCode || !RECOVERY_CODE_RE.test(recoveryCode)) {
    throw new Error('--recovery-code-file must point to a valid, unused recovery code')
  }
  // The market's own /api/recovery `begin` action requires client_class too
  // (RECOVERY_BEGIN_FIELDS = ['action', 'client_class', 'recovery_code']) --
  // omitting it is refused 400 invalid_client_class before the code is ever
  // checked. Unlike rotate/recover-generate, this is the emergency path an
  // agent reaches only when its key -- and often its vault entry -- is
  // already lost, so this script cannot always default it from a stored
  // entry the way key.mjs's own `recover begin` tries to; it is required
  // explicitly here.
  const clientClass = requireFlag(flags, 'client-class')
  if (clientClass !== 'coding_persistent' && clientClass !== 'coding_ephemeral') {
    throw new Error('--client-class must be coding_persistent or coding_ephemeral')
  }

  const staged = await postJson(origin, '/api/recovery', {
    action: 'begin', client_class: clientClass, recovery_code: recoveryCode,
  })

  // Same validation, at the same point (before staged.handle is ever used
  // as a vault label), and for the same reason as rotate() above -- see its
  // own comment. Nothing has been written to this vault yet, so this simply
  // cancels the recovery and refuses.
  if (!HANDLE_RE.test(staged.handle) || RESERVED_HANDLE_SUBSTRING_RE.test(staged.handle)) {
    await cancelStage(origin, '/api/recovery', staged.session, staged.csrf)
    throw new Error(
      // staged.handle is JSON.stringify'd (not wrapped in manual quotes)
      // because it has, by definition in this branch, just failed HANDLE_RE
      // -- it may contain a newline or quote that could otherwise fabricate
      // an extra line in output the key skill instructs the agent to relay
      // verbatim.
      `refusing to act on the handle ${JSON.stringify(staged.handle)} this recovery's begin call named: it ` +
      `does not match the local handle rule ${HANDLE_RE.source}, or contains the reserved "--pending-" ` +
      'sequence this script uses for its own in-flight staging labels. The recovery was cancelled before ' +
      'anything was written to this vault; the OLD key is still the live, valid one.',
    )
  }

  // Same staging discipline as rotate() above, and for the same reason: the
  // old key still works until confirm below actually succeeds, so the live
  // vault entry must not be touched before that.
  const stagingLabel = pendingLabel(staged.handle, 'recovery')
  storeSecret(origin, stagingLabel, {
    kind: 'staging',
    handle: staged.handle,
    merchant_key: staged.merchant_key,
    origin,
    stored_at: new Date().toISOString(),
  })

  let confirmed
  try {
    confirmed = await postJson(origin, '/api/recovery', {
      action: 'confirm',
      session: staged.session,
      csrf: staged.csrf,
      merchant_key: staged.merchant_key,
    })
  } catch (error) {
    deleteSecret(origin, stagingLabel)
    await cancelStage(origin, '/api/recovery', staged.session, staged.csrf)
    throw error
  }

  // Same promote-or-refuse discipline as rotate() above -- see
  // promoteReplacementKey's doc comment. Recovery codes are dropped here
  // too and replaced with an invalidation marker, for the same reason as
  // rotate(): the front door confirms that using one recovery code
  // invalidates every sibling code atomically, not just the one spent.
  const location = promoteReplacementKey(origin, staged.handle, stagingLabel, staged.merchant_key, previous => ({
    ...(previous?.client_class ? { client_class: previous.client_class } : {}),
    recovery_codes_invalidated_at: new Date().toISOString(),
  }))

  // Print the already-validated staged.handle -- the label this recovery
  // actually just wrote to, two lines up -- never the confirm response's own
  // (unvalidated) `handle` field. See rotate()'s identical check above for
  // why: `confirmed` here has never been checked against HANDLE_RE, so
  // printing it raw would both let an embedded newline fabricate extra
  // output lines and, even when well-formed, risk naming a merchant that was
  // never actually touched. The write already happened under staged.handle
  // by the time this runs, so a mismatch can only be reported, never undone.
  if (typeof confirmed.handle === 'string' && confirmed.handle !== staged.handle) {
    throw new Error(
      `this recovery's confirm call named a different handle (${JSON.stringify(confirmed.handle)}) than its ` +
      `own begin call staged (${JSON.stringify(staged.handle)}). The replacement key and invalidated-codes ` +
      `marker are already written -- that cannot be undone -- under the STAGED handle, at "${location}". ` +
      `Nothing was written under ${JSON.stringify(confirmed.handle)}. Verify the vault entry at "${location}" ` +
      'by hand before trusting it, and treat this recovery as unconfirmed until you do.',
    )
  }

  revealOrHide(flags, 'Replacement merchant key', [staged.merchant_key])
  console.log(`handle: ${staged.handle}`)
  console.log(`stored: ${location}`)
  console.log(
    'every remaining recovery code was invalidated by this recovery (the market invalidates every sibling ' +
    'code on confirm) -- run `recover generate` (or `key recover generate`) now to mint a fresh set.',
  )
  console.log(
    'this recovery also revoked every connector session, authorization code, and delegated grant the old ' +
    `key had (the market invalidates them atomically with the key) -- update whatever host secret ` +
    `${AGENT_SECRET_ENV_VAR} reads and re-run \`connect\`, and re-pair any chat twin with a fresh ` +
    '`connect chat` code; both will otherwise start failing with no obvious cause.',
  )
}

async function pair(flags) {
  const origin = originOf(flags)
  const merchantKey = await resolveSecretArg(
    flags, 'merchant-key', [AGENT_SECRET_ENV_VAR],
  )
  if (!merchantKey || !MERCHANT_KEY_RE.test(merchantKey)) {
    throw new Error(`--merchant-key-file (or ${AGENT_SECRET_ENV_VAR}) must point to the current, valid merchant key`)
  }
  const minted = await postAuthed(origin, '/api/pair', merchantKey, {})
  // The pairing code is meant to be read by a human, not stored -- it is
  // single-use, expires in ten minutes, and never substitutes for the key.
  // Printing it is the entire point of this command, so it is not gated
  // behind --reveal the way the merchant key and recovery codes are above.
  console.log('Pairing code (shown once, give it to the human completing hosted-chat sign-in):')
  console.log(minted.pairing_code)
  console.log(`expires_at: ${minted.expires_at}`)
}

async function main() {
  const [command, ...rest] = process.argv.slice(2)
  const { flags, positionals } = parseArgs(rest)
  if (command === 'register') return register(flags)
  if (command === 'rotate') return rotate(flags)
  if (command === 'pair') return pair(flags)
  if (command === 'recover') {
    const sub = positionals[0]
    if (sub === 'generate') return recoverGenerate(flags)
    if (sub === 'begin') return recoverBegin(flags)
    throw new Error('recover needs a subcommand: "generate" or "begin"')
  }
  throw new Error('usage: identity-client.mjs <register|rotate|recover generate|recover begin|pair> [--flags]')
}

const isMainModule = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href

if (isMainModule) {
  main().catch(error => {
    fail(error instanceof Error ? error.message : String(error))
  })
}

// Exported for setup.mjs/connect.mjs/key.mjs (the vault helpers and
// SecretReadFailure) and for tests (all of the below); the CLI above never
// uses this import path itself, so importing this module never runs main().
export {
  storeSecret, readSecret, deleteSecret, listVaultLabels, promoteReplacementKey, SecretReadFailure, shouldReveal,
  HANDLE_RE, RESERVED_HANDLE_SUBSTRING_RE, isValidModel, parseKeychainServiceNames, unescapeSecurityDumpString,
}
