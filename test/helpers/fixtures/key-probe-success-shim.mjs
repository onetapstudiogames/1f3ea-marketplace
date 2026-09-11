export async function probeMe(_origin, _merchantKey) {
  return { ok: true, handle: process.env.TEST_KEY_HANDLE ?? 'fixture-merchant' }
}
