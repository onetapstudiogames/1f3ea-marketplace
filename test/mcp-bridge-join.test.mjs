import assert from 'node:assert/strict'
import test from 'node:test'

import { MCP_ORIGIN, MCP_URL, createMcpBridge, parseBridgeArgs } from '../scripts/lib/mcp-bridge.mjs'

test('local bridge selects the explicit merchant handle and keeps the vault key out of responses', async () => {
  const merchantKey = `1f3ea_sk_${'a'.repeat(48)}`
  const calls = []
  const bridge = await createMcpBridge({
    selectedHandle: 'quiet-merchant',
    readSetupStateImpl: () => ({ handle: 'other-merchant' }),
    readVaultIndexImpl: () => ({}),
    readSecretImpl: (origin, handle) => {
      calls.push([origin, handle])
      return { found: true, value: { merchant_key: merchantKey } }
    },
    fetchImpl: async (url, request) => {
      assert.equal(url, MCP_URL)
      assert.equal(request.headers.authorization, `Bearer ${merchantKey}`)
      return new Response(JSON.stringify({
        jsonrpc: '2.0', id: 7,
        result: { content: [{ type: 'text', text: `upstream echoed ${merchantKey}` }] },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    },
  })
  const output = await bridge.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: {} }))
  assert.deepEqual(calls, [[MCP_ORIGIN, 'quiet-merchant'], [MCP_ORIGIN, 'quiet-merchant']])
  assert.match(output, /\[REDACTED\]/u)
  assert.doesNotMatch(output, /1f3ea_sk_/u)
})

test('bridge refuses staging labels as connector handles', () => {
  assert.deepEqual(parseBridgeArgs(['--handle', 'quiet-merchant']), { handle: 'quiet-merchant' })
  assert.throws(() => parseBridgeArgs(['--handle', 'quiet-merchant--pending-registration-ffff']), /staging label/u)
  assert.throws(() => parseBridgeArgs(['--handle', 'quiet-merchant', '--origin', 'https://localhost:4123']), /usage/u)
})

test('bridge reloads a rotated vault key on the next call', async () => {
  let currentKey = `1f3ea_sk_${'a'.repeat(48)}`
  const seenKeys = []
  const bridge = await createMcpBridge({
    selectedHandle: 'quiet-merchant',
    readSetupStateImpl: () => null,
    readVaultIndexImpl: () => ({}),
    readSecretImpl: (readOrigin, handle) => {
      assert.equal(readOrigin, MCP_ORIGIN)
      assert.equal(handle, 'quiet-merchant')
      return { found: true, value: { merchant_key: currentKey } }
    },
    fetchImpl: async (url, request) => {
      assert.equal(url, MCP_URL)
      seenKeys.push(request.headers.authorization)
      const parsed = JSON.parse(request.body)
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: parsed.id, result: {} }))
    },
  })
  await bridge.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }))
  currentKey = `1f3ea_sk_${'b'.repeat(48)}`
  await bridge.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }))
  assert.deepEqual(seenKeys, [`Bearer 1f3ea_sk_${'a'.repeat(48)}`, `Bearer 1f3ea_sk_${'b'.repeat(48)}`])
})
