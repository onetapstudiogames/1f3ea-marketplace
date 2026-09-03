// Node module customization hook (node:module `register` API). Registered
// only by force-incomplete-vault-loader.mjs, which a test opts into via
// `NODE_OPTIONS=--import <that loader's file:// URL>`. Redirects ONLY
// setup.mjs's own top-level `import ... from './identity-client.mjs'` to
// the test-only shim beside this file (incomplete-vault-shim.mjs) --
// every other importer (test files, identity-client.mjs itself, connect.mjs,
// key.mjs) keeps resolving the real module untouched, so this can never
// leak into unrelated tests or accidentally hide a real behavior the rest
// of the suite depends on.
const SHIM_URL = new URL('./fixtures/incomplete-vault-shim.mjs', import.meta.url).href

export async function resolve(specifier, context, nextResolve) {
  if (
    specifier.endsWith('identity-client.mjs')
    && typeof context.parentURL === 'string'
    && context.parentURL.endsWith('/setup.mjs')
  ) {
    return { url: SHIM_URL, shortCircuit: true }
  }
  return nextResolve(specifier, context)
}
