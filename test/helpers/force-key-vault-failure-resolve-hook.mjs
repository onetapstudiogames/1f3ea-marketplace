const IDENTITY_SHIM_URL = new URL('./fixtures/key-vault-failure-shim.mjs', import.meta.url).href
const PROBE_SHIM_URL = new URL('./fixtures/key-probe-success-shim.mjs', import.meta.url).href

export async function resolve(specifier, context, nextResolve) {
  const isKeyCommand = typeof context.parentURL === 'string' && context.parentURL.endsWith('/scripts/key.mjs')
  if (isKeyCommand && specifier.endsWith('/identity-client.mjs')) {
    return { url: IDENTITY_SHIM_URL, shortCircuit: true }
  }
  if (isKeyCommand && specifier.endsWith('/lib/identity-probe.mjs')) {
    return { url: PROBE_SHIM_URL, shortCircuit: true }
  }
  return nextResolve(specifier, context)
}
