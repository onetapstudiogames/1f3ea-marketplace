const OS_SHIM_URL = new URL('./fixtures/file-vault-os-shim.mjs', import.meta.url).href

export async function resolve(specifier, context, nextResolve) {
  if (
    specifier === 'node:os'
    && typeof context.parentURL === 'string'
    && context.parentURL.endsWith('/scripts/lib/vault-backends.mjs')
  ) {
    return { url: OS_SHIM_URL, shortCircuit: true }
  }
  return nextResolve(specifier, context)
}
