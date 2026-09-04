import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { withFileLock } from './vault-locks.mjs'

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
 * True when `label` is specifically a REGISTRATION staging label -- i.e. it
 * is staging (per isStagingLabel above) AND its text carries the per-run
 * suffixed shape pendingLabel('...', 'registration') produces
 * (`<handle>--pending-registration-<hex>`), never the unsuffixed rotation/
 * recovery shapes (`<handle>--pending-rotation`, `<handle>--pending-
 * recovery`). The `staging` marker itself does not carry which KIND of
 * staging entry this is -- register()/rotate()/recoverBegin() all write the
 * same generic `kind: 'staging'` -- so telling registration apart from
 * rotation/recovery has to fall back to the one place that distinction still
 * exists: the label's own suffix. That is fine here specifically because
 * RESERVED_HANDLE_SUBSTRING_RE already refuses any handle containing
 * "--pending-" going forward, so a live merchant's label can no longer
 * collide with this shape (see isPendingLabel's own doc comment for the
 * same reasoning, applied to the broader staging check).
 *
 * The AND above is ordered deliberately: isStagingLabel is evaluated FIRST,
 * and it consults `indexMap`'s own `staging` marker before ever falling
 * back to a suffix guess (see its own doc comment) -- so a real merchant
 * handle that happens to match the `--pending-registration-<hex>` suffix
 * shape (HANDLE_RE permits up to 32 characters, long enough to collide by
 * coincidence, e.g. "abc--pending-registration-a") is never misclassified
 * here: the index's `staging: false` short-circuits the `&&` to false
 * before the suffix regex on the right ever matters, regardless of whether
 * the text happens to match it. The suffix regex on its own is authoritative
 * only where the index is silent about a label (no entry, or an entry with
 * no boolean `staging`) -- never used to override what the index already
 * knows.
 */
function isRegistrationStagingLabel(label, indexMap) {
  return isStagingLabel(label, indexMap) && /--pending-registration-[0-9a-f]+$/u.test(label)
}

/**
 * Attaches the registration staging labels `listVaultLabels` just filtered
 * out of `result` as a non-enumerable `registrationStagingLabels` property,
 * mirroring how `incomplete` is attached -- invisible to existing callers
 * that treat the return value as a plain array (assert.deepEqual included),
 * but readable by name for setup.mjs's duplicate-identity guard. Only
 * attached when at least one such label exists, same convention `incomplete`
 * uses (attached only when true).
 */
function attachRegistrationStagingLabels(result, allLabels, indexMap) {
  const registrationStagingLabels = allLabels.filter(label => isRegistrationStagingLabel(label, indexMap))
  if (registrationStagingLabels.length > 0) {
    Object.defineProperty(result, 'registrationStagingLabels', { value: registrationStagingLabels, enumerable: false })
  }
  return result
}

export {
  vaultTarget, credentialsFilePath, pendingLabel, isPendingLabel, readVaultIndex, vaultIndexEntriesToMap,
  updateVaultIndex, isStagingLabel, attachRegistrationStagingLabels,
}
