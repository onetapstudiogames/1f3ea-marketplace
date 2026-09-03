// Test-only shim for the "setup.mjs refuses on an incomplete vault
// enumeration" end-to-end test (round-7 review, LOW finding). Re-exports
// everything from the real scripts/identity-client.mjs EXCEPT
// listVaultLabels, which this replaces with a version that always reports
// an incomplete enumeration -- the same non-enumerable `incomplete: true`
// signal the real darwin branch attaches after a genuine ENOBUFS/ETIMEDOUT
// from `security dump-keychain` (see identity-client.mjs's own doc comment
// on that branch).
//
// This exists because reproducing that signal for real requires an actual
// macOS host with a truncated Keychain dump: CI never runs the full
// identity-command subprocess suite on macOS at all (only ubuntu-latest and
// a trimmed windows-latest leg -- see .github/workflows/ci.yml), and on
// win32/linux listVaultLabels' own code never sets `incomplete` in the
// first place (only the darwin branch does). test/identity-client.test.mjs
// already pins listVaultLabels' own `incomplete` flag directly (via
// injectable `deps`) for exactly this reason; this shim is what lets a
// SEPARATE test drive setup.mjs itself, as a real subprocess, through the
// refusal branch that flag is supposed to trigger -- see
// force-incomplete-vault-resolve-hook.mjs, which redirects setup.mjs's own
// import of identity-client.mjs to this file, and only that import.
export * from '../../../scripts/identity-client.mjs'

export function listVaultLabels() {
  const forced = []
  Object.defineProperty(forced, 'incomplete', { value: true, enumerable: false })
  return forced
}
