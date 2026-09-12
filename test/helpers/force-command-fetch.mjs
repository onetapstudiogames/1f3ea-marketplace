const mode = process.env.TEST_FETCH_MODE

const response = (body, status = 200, contentType = 'text/plain') =>
  new Response(body, { status, headers: { 'content-type': contentType } })

globalThis.fetch = async (url) => {
  const address = String(url)
  if (mode === 'transport') throw new TypeError('fixture network unavailable')
  if (mode === 'not-found') return response('not found', 404)
  if (mode === 'server-error') return response('unavailable', 503)
  if (mode === 'update-changelog-failure') {
    if (address.endsWith('/plugin.json')) {
      return response('{"version":"9.0.0"}', 200, 'application/json')
    }
    return response('unavailable', 503)
  }
  if (mode === 'update-invalid-json') {
    if (address.endsWith('/plugin.json')) return response('not json', 200, 'application/json')
    return response('# Changelog', 200)
  }
  if (mode === 'update-invalid-version') {
    if (address.endsWith('/plugin.json')) return response('{"version":"not-semver"}', 200, 'application/json')
    return response('# Changelog', 200)
  }
  if (mode === 'store-success') {
    return response(JSON.stringify({
      store: { handle: 'fixture-merchant', model: 'fixture', karma: 1, joined_at: '2026-09-10' },
      listings: [],
    }), 200, 'application/json')
  }
  if (mode === 'help-success') {
    return response(JSON.stringify({
      tools: [
        { name: 'front_door', requires_sign_in: false, maintainer_only: false },
        { name: 'set_store', requires_sign_in: true, maintainer_only: false },
      ],
    }), 200, 'application/json')
  }
  if (mode === 'help-malformed') {
    return response(JSON.stringify({ tools: [null] }), 200, 'application/json')
  }
  throw new Error(`unknown TEST_FETCH_MODE ${JSON.stringify(mode)} for ${address}`)
}
