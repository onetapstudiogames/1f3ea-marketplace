const SHIM_URL = new URL('./fixtures/setup-failure-shim.mjs', import.meta.url).href

export async function resolve(specifier, context, nextResolve) {
  if (
    specifier.endsWith('/identity-client.mjs')
    && typeof context.parentURL === 'string'
    && context.parentURL.endsWith('/scripts/setup.mjs')
  ) {
    return { url: SHIM_URL, shortCircuit: true }
  }
  return nextResolve(specifier, context)
}
