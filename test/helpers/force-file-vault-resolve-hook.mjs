const OS_SHIM_URL = new URL('./fixtures/file-vault-os-shim.mjs', import.meta.url).href
const FS_SHIM_URL = new URL('./fixtures/file-vault-fs-shim.mjs', import.meta.url).href
const MATCH_STATE_SPECIFIER = 'force-file-vault:match-state'

let matchedOs = false
let matchedFs = false
export let matched = false

export async function resolve(specifier, context, nextResolve) {
  if (specifier === MATCH_STATE_SPECIFIER) {
    if (!matched) {
      throw new Error('force-file-vault loader did not match vault-backends.mjs; update the loader for its new location')
    }
    return { url: 'data:text/javascript,export const matched=true', shortCircuit: true }
  }

  if (
    (specifier === 'node:os' || specifier === 'node:fs')
    && typeof context.parentURL === 'string'
    && context.parentURL.endsWith('/scripts/lib/vault-backends.mjs')
  ) {
    if (specifier === 'node:os') matchedOs = true
    else matchedFs = true
    matched = matchedOs && matchedFs
    return { url: specifier === 'node:os' ? OS_SHIM_URL : FS_SHIM_URL, shortCircuit: true }
  }
  return nextResolve(specifier, context)
}
