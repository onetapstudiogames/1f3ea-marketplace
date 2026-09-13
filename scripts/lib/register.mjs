import {
  HANDLE_RE, RESERVED_HANDLE_SUBSTRING_RE, askYesNo, isValidModel, originOf, requireFlag, revealOrHide,
} from './identity-input.mjs'
import { cancelStage, postJson } from './identity-http.mjs'
import { promoteReplacementKey } from './promote.mjs'
import { deleteSecret, readSecret, storeSecret } from './vault-backends.mjs'
import { pendingLabel } from './vault-index.mjs'
import { existsSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

const RECOVERY_CODE_RE = /^1f3ea_rc_[0-9a-f]{64}$/u

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
  const codesDir = flags['codes-dir']
  if (codesDir !== undefined && (typeof codesDir !== 'string' || !isAbsolute(codesDir))) {
    throw new Error('--codes-dir must name an existing absolute folder chosen by the human')
  }
  if (codesDir !== undefined && (!statSync(codesDir, { throwIfNoEntry: false })?.isDirectory())) {
    throw new Error('--codes-dir must name an existing folder chosen by the human')
  }
  if (codesDir !== undefined && existsSync(join(codesDir, `1f3ea-${handle}-recovery-codes.txt`))) {
    throw new Error('the recovery codes file already exists in --codes-dir; choose another folder before registering')
  }

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
  if (codesDir !== undefined && (
    !Array.isArray(staged.recovery_codes)
    || staged.recovery_codes.length !== 8
    || staged.recovery_codes.some(code => typeof code !== 'string' || !RECOVERY_CODE_RE.test(code))
    || new Set(staged.recovery_codes).size !== 8
  )) {
    await cancelStage(origin, '/api/register', staged.session, staged.csrf)
    throw new Error('the registration door did not return eight distinct valid recovery codes; nothing was stored or confirmed')
  }

  // Validated here, before stagedHandle is ever used as a vault label -- for
  // the pre-flight existing-entry check immediately below, the staging
  // copy, and later the live promotion -- the same discipline rotate()/
  // recoverBegin() apply to their own staged handles, and this function
  // already applies to its own CONFIRMED handle further down. Defense in
  // depth against the market's own stage response somehow normalizing the
  // requested handle (already validated above) into something that fails
  // this same rule (reachable only through a compromised 1f3ea.com or an
  // --allow-origin the operator passed, never through an honest server):
  // without it, a wrong or hostile normalized handle in the stage response
  // would be used to look up, and later write, a vault entry under that
  // label. Nothing has been written to this vault yet at this point, so the
  // registration is simply cancelled and refused.
  if (!HANDLE_RE.test(stagedHandle) || RESERVED_HANDLE_SUBSTRING_RE.test(stagedHandle)) {
    await cancelStage(origin, '/api/register', staged.session, staged.csrf)
    throw new Error(
      // stagedHandle is JSON.stringify'd (not wrapped in manual quotes)
      // because it has, by definition in this branch, just failed
      // HANDLE_RE -- it may contain a newline or quote that could
      // otherwise fabricate an extra line in output the key skill
      // instructs the agent to relay verbatim.
      `refusing to act on the handle ${JSON.stringify(stagedHandle)} this registration's stage call named: it ` +
      `does not match the local handle rule ${HANDLE_RE.source}, or contains the reserved "--pending-" ` +
      'sequence this script uses for its own in-flight staging labels. The staged registration was ' +
      'cancelled before anything was written to this vault; nothing was created.',
    )
  }

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
    ...(codesDir === undefined ? { recovery_codes: staged.recovery_codes } : {}),
    origin,
    stored_at: new Date().toISOString(),
  })

  // The codes reach only the human's chosen folder. Reserve the file before
  // confirm, so a file failure cannot leave a confirmed identity without its
  // recovery codes. The staged vault entry contains the key, never the codes.
  let codesPath
  if (codesDir !== undefined) {
    codesPath = join(codesDir, `1f3ea-${stagedHandle}-recovery-codes.txt`)
    try {
      writeFileSync(codesPath, `${staged.recovery_codes.join('\n')}\n`, { flag: 'wx', mode: 0o600 })
    } catch (error) {
      deleteSecret(origin, stagingLabel)
      await cancelStage(origin, '/api/register', staged.session, staged.csrf)
      throw new Error(`recovery codes could not be written to the chosen folder; registration was cancelled. ${error.message}`)
    }
  }

  let confirmed
  try {
    confirmed = await postJson(origin, '/api/register', {
      action: 'confirm',
      session: staged.session,
      csrf: staged.csrf,
      merchant_key: staged.merchant_key,
    })
  } catch (error) {
    if (/^\/api\/register refused with HTTP 409: .*\. reason: handle_taken$/u.test(error.message)) {
      deleteSecret(origin, stagingLabel)
      throw error
    }
    const location = codesPath === undefined
      ? `the key and recovery codes remain under staging label "${stagingLabel}"`
      : `the key remains under staging label "${stagingLabel}" and recovery codes remain at "${codesPath}"`
    throw new Error(`confirmation outcome is uncertain; ${location}. Run key status/adopt before retrying. ${error.message}`)
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
      'created server-side under that exact spelling, and its confirmed merchant key was not lost: ' +
      `it is stored under the staging label "${stagingLabel}". ` +
      (codesPath ? `Recovery codes are at "${codesPath}". ` : 'Recovery codes remain in that staged vault bundle. ') +
      'This ' +
      'script will not store them automatically for a handle that fails its own naming rule; `key show ' +
      `--handle ${stagingLabel} --reveal\` reads them back by hand, and \`key adopt\` has no use here since ` +
      'it also refuses a handle that fails this same rule -- whatever label you choose must satisfy it too.',
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
    ...(codesDir === undefined ? { recovery_codes: staged.recovery_codes } : {}),
  }), {}, {
    refuseIfPresent: !replaceVaultEntry,
    keyNoun: 'the confirmed merchant key from this registration',
  })

  revealOrHide(flags, 'Merchant key', [staged.merchant_key])
  revealOrHide(flags, 'Recovery codes (all eight)', staged.recovery_codes)
  console.log(`handle: ${finalHandle}`)
  console.log(`merchant_id: ${confirmed.merchant_id}`)
  console.log(`stored: ${location}`)
  if (codesPath) console.log(`codes: ${codesPath}`)
}


export { register }

