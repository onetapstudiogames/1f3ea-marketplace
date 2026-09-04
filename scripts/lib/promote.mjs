import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { LiveVaultEntryExistsError, deleteSecret, readSecret, storeSecret } from './vault-backends.mjs'
import { VAULT_INDEX_LOCK_MAX_WAIT_MS, promoteLockPath, withFileLock } from './vault-locks.mjs'

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
function promoteReplacementKey(origin, handle, stagingLabel, merchantKey, mergeFields, deps = {}, {
  refuseIfPresent = false,
  // Caller-supplied noun phrase for the key this call is promoting, used in
  // every failure message below instead of a hardcoded "replacement" --
  // round-2's item-2 finding was a first-time registration told an agent
  // "the old key ... no longer works" when there was no old key and
  // nothing was replaced. Every caller names its own truth:
  //   register():                  'the confirmed merchant key from this registration'
  //   rotate():                     'the confirmed replacement key from this rotation'
  //   recoverBegin():               'the confirmed replacement key from this recovery'
  //   adopt() into an empty slot:   'the already-authenticated key this adopt is moving'
  //   adopt() over a dead live entry: 'the already-authenticated replacement key this adopt is moving'
  keyNoun = 'the already-confirmed key',
  // Non-null only for callers where the entry at `handle` held a key the
  // market has already invalidated server-side by the time this runs
  // (rotate(), recoverBegin(), and adopt() when it proved the live entry
  // dead) -- used only in the storeSecret-failure message below, which
  // must not claim an "old key... no longer works" for register() or for
  // adopt() promoting into a handle with no prior entry.
  oldKeyNoun = null,
  // The leading clause of the storeSecret-failure message, spoken only when
  // oldKeyNoun is non-null. Defaults to the rotate()/recoverBegin() shape
  // ("the rotation/recovery already CONFIRMED, so ..."), since those are
  // the two callers that always held this default before adopt() started
  // calling this function too. adopt() passes its own clause -- it neither
  // rotated nor recovered anything, so the default would misstate what
  // happened (round-3 LOW finding).
  deadKeyClause = 'the rotation/recovery already CONFIRMED',
  // Names the callers a lock-timeout message enumerates as possibly holding
  // the lock concurrently. Defaults to the three callers that held this
  // function's lock before adopt() became a fourth (round-3 LOW finding) --
  // adopt() passes its own phrase so the enumeration names every real
  // caller instead of silently omitting itself.
  concurrentCallersPhrase = 'another registration, rotation, or recovery',
  // adopt() alone, and only when it found a live entry at `handle` and
  // proved it dead (or malformed) with its OWN outer read and probe --
  // both of which run OUTSIDE this function's lock, before it is ever
  // called. That gap is a real window (round-4 LOW finding): it spans a
  // full network round trip (the live probe's own timeout budget) plus a
  // vault read, not something sub-millisecond. Passing the exact
  // merchant_key adopt already read and probed (or `null` when the live
  // entry it saw held none) lets this call re-verify, under the lock, with
  // no extra network call: string-compare it against what a fresh
  // readSecret sees right here, in the same locked section as the write
  // below. undefined (the default) means "no such check" -- every other
  // caller, and adopt() promoting into a slot it found genuinely empty
  // (refuseIfPresent:true instead), never sets this.
  expectPreviousKey = undefined,
} = {}) {
  const capitalizedKeyNoun = keyNoun.charAt(0).toUpperCase() + keyNoun.slice(1)
  const lockPath = promoteLockPath(origin, handle, deps.homeDir)
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 })
  const result = withFileLock(lockPath, () => {
    let previous
    try {
      previous = readSecret(origin, handle, deps)
    } catch (error) {
      throw new Error(
        `refusing to overwrite the existing vault entry for "${handle}": ${error.message}. ` +
        `${capitalizedKeyNoun} was NOT lost -- it is still stored under the ` +
        `staging label "${stagingLabel}". Resolve the unreadable entry, then run ` +
        `\`key adopt --handle ${handle} --from-label ${stagingLabel}\` to move it -- or, if that is not ` +
        `available, read it back from "${stagingLabel}" yourself and store it under ` +
        `"${handle}" by hand.`,
      )
    }
    if (expectPreviousKey !== undefined) {
      // Re-verify, under the lock, with no extra network call: the entry
      // this call is about to overwrite must still be byte-identical to
      // the one the caller already read and proved dead OUTSIDE the lock.
      // A mismatch means a concurrent write to this exact handle landed in
      // the window between that outer check and this one -- round-4 LOW
      // finding: adopt used to promote unconditionally past this point,
      // silently destroying whatever a concurrent register/rotate/recover/
      // adopt had just written, and blaming the overwrite on a rejection of
      // an entry that no longer existed at write time.
      const actualKey = previous.found && typeof previous.value?.merchant_key === 'string'
        ? previous.value.merchant_key
        : null
      if (actualKey !== expectPreviousKey) {
        let stagingStillPresent
        try {
          stagingStillPresent = readSecret(origin, stagingLabel, deps).found
        } catch {
          stagingStillPresent = false
        }
        // Round-5 LOW finding: this message used to always assert that a
        // concurrent WRITE landed and tell the caller to compare "which of
        // the two entries" they want -- but a mismatch also fires when the
        // live entry was simply DELETED in this same window. That leaves
        // only ONE entry (the staging copy, if it is still there) and
        // nothing to compare it against, so the "which of the two" wording
        // asserts something untrue in that case. Branch the whole message,
        // not just its lead clause: a vanished entry gets its own honest
        // wording, with its own remedy -- a plain re-run promotes into the
        // now-empty slot -- and never mentions a second entry that does not
        // exist; an entry that is still present but holds a different key
        // keeps the original "concurrent write, compare the two" wording.
        if (!previous.found) {
          const deletedNote = stagingStillPresent
            ? `${capitalizedKeyNoun} is still stored under the staging label "${stagingLabel}" and nowhere else.`
            : `${capitalizedKeyNoun} is NO LONGER at its staging label "${stagingLabel}" either -- it cannot be ` +
              'recovered from this vault. Check whatever recorded the merchant_key when it was first confirmed ' +
              '(terminal scrollback, a captured --reveal run) before concluding it is gone for good.'
          throw new LiveVaultEntryExistsError(
            `refusing to overwrite the vault entry for "${handle}": the entry that was there when this adopt's ` +
            'own check ran has since been deleted -- there is nothing left to compare, and nothing was ' +
            `overwritten. Re-run this exact adopt command to promote ${keyNoun} into the now-empty handle. ` +
            deletedNote,
          )
        }
        const stagingNote = stagingStillPresent
          ? `${capitalizedKeyNoun} was NOT lost -- it is still stored under the ` +
            `staging label "${stagingLabel}" and nowhere else. Work out which of the two entries is the one ` +
            `you actually want (for example \`key status --handle ${handle}\`), then store the key from ` +
            `"${stagingLabel}" under "${handle}" yourself if it turns out to be the one that should have won.`
          : `${capitalizedKeyNoun} is NO LONGER at its staging label "${stagingLabel}" ` +
            '-- it cannot be recovered from this vault. Check whatever recorded the merchant_key when it was ' +
            'first confirmed (terminal scrollback, a captured --reveal run) before concluding it is gone for good.'
        throw new LiveVaultEntryExistsError(
          `refusing to overwrite the vault entry for "${handle}": it changed between this adopt's own check ` +
          'and this write -- a concurrent write to this same handle on this host must have landed in between, ' +
          `so nothing was overwritten. ${stagingNote}`,
        )
      }
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
        ? `${capitalizedKeyNoun} was NOT lost -- it is still stored under the ` +
          `staging label "${stagingLabel}" and nowhere else. Work out which of the two entries is the one ` +
          `you actually want (for example \`key status --handle ${handle}\`), then store the key from ` +
          `"${stagingLabel}" under "${handle}" yourself if it turns out to be the one that should have won.`
        : `${capitalizedKeyNoun} is NO LONGER at its staging label "${stagingLabel}" ` +
          '-- it cannot be recovered from this vault. Check whatever recorded the merchant_key when it was ' +
          'first confirmed (terminal scrollback, a captured --reveal run) before concluding it is gone for good.'
      throw new LiveVaultEntryExistsError(
        `refusing to overwrite the vault entry for "${handle}" that now exists: it was not there when this ` +
        'call started, so a concurrent write to this same handle on this host must have won the race. ' +
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
        (oldKeyNoun
          ? `${deadKeyClause}, so ${oldKeyNoun} for "${handle}" no longer works: ${error.message}. `
          : `storing ${keyNoun} under "${handle}" failed: ${error.message}. `) +
        `${capitalizedKeyNoun} is stored under "${stagingLabel}" and nowhere else -- run ` +
        `\`key adopt --handle ${handle} --from-label ${stagingLabel}\` to move it, or, if that is not ` +
        `available, read it back from "${stagingLabel}" yourself and store it under "${handle}" before doing ` +
        'anything else.',
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
      `${VAULT_INDEX_LOCK_MAX_WAIT_MS}ms: ${concurrentCallersPhrase} for the same handle ` +
      `appears to still be running concurrently on this host. ${capitalizedKeyNoun} was NOT ` +
      `lost -- it is still stored under the staging label "${stagingLabel}" and nowhere else. Retry once the ` +
      `other run finishes -- either the original command, or \`key adopt --handle ${handle} --from-label ` +
      `${stagingLabel}\` -- or, if that is not available, read the key back from "${stagingLabel}" and store ` +
      `it under "${handle}" yourself.`,
    )
  }
  return result
}

export { promoteReplacementKey }
