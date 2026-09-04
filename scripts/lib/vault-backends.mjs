import { execFileSync } from 'node:child_process'
import {
  chmodSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { homedir, platform } from 'node:os'
import { dirname, join } from 'node:path'
import {
  attachRegistrationStagingLabels, credentialsFilePath, isStagingLabel, readVaultIndex, updateVaultIndex,
  vaultIndexEntriesToMap, vaultTarget,
} from './vault-index.mjs'

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
 * Thrown only by promoteReplacementKey's `refuseIfPresent` re-check below,
 * when the lock-protected read finds a live vault entry that was not there
 * when the caller's own pre-flight check ran. Its default `.message` is
 * worded for register()'s specific meaning of that situation -- a
 * concurrent registration won a race for the same handle -- which is wrong
 * for a caller like `key adopt` that never registered anything and is only
 * trying to promote an already-known-good staged key. A typed class (rather
 * than matching on `.message` text) lets each caller catch this one
 * specific case and reword it for its own meaning, while every other
 * failure out of promoteReplacementKey still surfaces as a plain Error.
 */
class LiveVaultEntryExistsError extends Error {}

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
    const allLabels = [...new Set([...fromCmdkey, ...indexMap.keys()])]
    const result = allLabels.filter(label => !isStagingLabel(label, indexMap))
    return attachRegistrationStagingLabels(result, allLabels, indexMap)
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
    const allLabels = [...new Set([...fromKeychain, ...indexMap.keys()])]
    const result = allLabels.filter(label => !isStagingLabel(label, indexMap))
    if (incomplete) {
      // Non-enumerable so existing callers that treat this as a plain
      // array of labels (assert.deepEqual included) see no difference;
      // setup.mjs's duplicate-identity guard checks this flag explicitly.
      Object.defineProperty(result, 'incomplete', { value: true, enumerable: false })
    }
    return attachRegistrationStagingLabels(result, allLabels, indexMap)
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
  const result = labels.filter(label => !isStagingLabel(label, indexMap))
  return attachRegistrationStagingLabels(result, labels, indexMap)
}

export {
  storeSecret, readSecret, deleteSecret, listVaultLabels, SecretReadFailure, LiveVaultEntryExistsError,
  parseKeychainServiceNames, unescapeSecurityDumpString,
}
