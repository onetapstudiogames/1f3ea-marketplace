import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  AGENT_SECRET_ENV_VAR, HANDLE_RE, MERCHANT_KEY_RE, RECOVERY_CODE_RE, RESERVED_HANDLE_SUBSTRING_RE,
  originOf, requireFlag, resolveSecretArg, revealOrHide,
} from './identity-input.mjs'
import { cancelStage, postAuthed, postJson } from './identity-http.mjs'
import { promoteReplacementKey } from './promote.mjs'
import { deleteSecret, readSecret, storeSecret } from './vault-backends.mjs'
import { pendingLabel } from './vault-index.mjs'
import { VAULT_INDEX_LOCK_MAX_WAIT_MS, promoteLockPath, withFileLock } from './vault-locks.mjs'

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
  }), {}, {
    keyNoun: 'the confirmed replacement key from this rotation',
    oldKeyNoun: 'the old key',
  })

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
      `${VAULT_INDEX_LOCK_MAX_WAIT_MS}ms: another registration, rotation, recovery, or adopt for the same ` +
      'handle appears to still be running concurrently on this host. The market already minted new recovery codes ' +
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
  }), {}, {
    keyNoun: 'the confirmed replacement key from this recovery',
    oldKeyNoun: 'the old key',
  })

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

export { rotate, recoverGenerate, recoverBegin, pair }
