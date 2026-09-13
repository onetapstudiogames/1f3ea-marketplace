import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { credentialsFilePath } from '../scripts/lib/vault-index.mjs'
import { readSetupState, writeSetupState } from '../scripts/lib/identity-state.mjs'
import { startStubMarketServer } from './helpers/stub-market-server.mjs'
import { makeTempHome, runNode } from './helpers/run-identity-cli.mjs'

const joinPath = fileURLToPath(new URL('../scripts/join.mjs', import.meta.url))
const hostCli = fileURLToPath(new URL('./helpers/fake-host-cli.mjs', import.meta.url))
const identityClient = fileURLToPath(new URL('../scripts/identity-client.mjs', import.meta.url))

test('join stores key only in vault, codes only in chosen folder, and selects the handle in its connector', async () => {
  const home = makeTempHome('market-join-')
  const codesDir = join(home.dir, 'human=codes')
  const connectorLog = join(home.dir, 'connector-log.jsonl')
  let connectorPresentAtSignedRead = false
  const stub = await startStubMarketServer({ onMeRead: () => { connectorPresentAtSignedRead = existsSync(connectorLog) } })
  mkdirSync(codesDir)
  const args = [
    '--origin', stub.origin, '--handle', 'quiet-merchant', `--codes-dir=${codesDir}`,
    '--host', 'codex', '--host-cli', hostCli,
  ]
  const env = { ...home.env, JOIN_CONNECTOR_LOG: connectorLog }
  try {
    const first = await runNode(joinPath, args, { env })
    assert.notEqual(first.status, 0)
    const token = /--human-approved ([0-9a-f]{32})/u.exec(first.stderr)?.[1]
    assert.ok(token, first.stderr)
    assert.equal(stub.merchants.size, 0)

    const second = await runNode(joinPath, [...args, '--human-approved', token], { env })
    assert.equal(second.status, 0, second.stderr)
    assert.equal(stub.meReadCount, 1, 'one signed read')
    assert.equal(connectorPresentAtSignedRead, true, 'connector was added before the signed read')
    assert.match(second.stdout, /^handle: quiet-merchant$/mu)
    assert.match(second.stdout, /^connector: 1f3ea-local-quiet-merchant$/mu)
    assert.doesNotMatch(second.stdout + second.stderr, /1f3ea_(?:sk|rc)_[0-9a-f]+/u)
    const codesPath = join(codesDir, '1f3ea-quiet-merchant-recovery-codes.txt')
    assert.match(second.stdout, new RegExp(`^codes: ${codesPath.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}$`, 'mu'))
    assert.deepEqual(readdirSync(codesDir), ['1f3ea-quiet-merchant-recovery-codes.txt'])
    const codes = readFileSync(codesPath, 'utf8').trim().split('\n')
    assert.equal(codes.length, 8)
    assert.deepEqual(codes, stub.merchants.get('quiet-merchant').recovery_codes)

    const stored = JSON.parse(readFileSync(credentialsFilePath(stub.origin, 'quiet-merchant', home.dir), 'utf8'))
    assert.equal(stored.merchant_key, stub.merchants.get('quiet-merchant').merchant_key)
    assert.equal(Object.hasOwn(stored, 'recovery_codes'), false)
    const connector = JSON.parse(readFileSync(connectorLog, 'utf8').trim())
    assert.deepEqual(connector.slice(-2), ['--handle', 'quiet-merchant'])
    assert.doesNotMatch(JSON.stringify(connector), /1f3ea_(?:sk|rc)_[0-9a-f]+|AGENT_1F3EA_SECRET/u)

    const repeated = await runNode(joinPath, args, { env })
    assert.notEqual(repeated.status, 0)
    assert.match(repeated.stderr, /key status --handle quiet-merchant/u)
    assert.equal(stub.merchants.size, 1)
  } finally {
    home.cleanup()
    await stub.close()
  }
})

test('join refuses a foreign origin before registration even with --allow-origin', async () => {
  const home = makeTempHome('market-join-origin-')
  const codesDir = join(home.dir, 'human-codes')
  mkdirSync(codesDir)
  try {
    const result = await runNode(joinPath, [
      '--origin', 'https://example.invalid', '--allow-origin', 'https://example.invalid',
      '--handle', 'quiet-merchant', '--codes-dir', codesDir, '--host', 'codex',
    ], { env: { ...home.env, AGENT_1F3EA_STUB_ONLY: '0' } })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /join connects only to https:\/\/1f3ea\.com/u)
    assert.equal(readdirSync(codesDir).length, 0)
  } finally {
    home.cleanup()
  }
})

test('join treats an uncertain host CLI lookup as refusal before registration without relaying stderr', async () => {
  const stub = await startStubMarketServer()
  const home = makeTempHome('market-join-host-')
  const codesDir = join(home.dir, 'human-codes')
  mkdirSync(codesDir)
  try {
    const result = await runNode(joinPath, [
      '--origin', stub.origin, '--handle', 'quiet-merchant', '--codes-dir', codesDir,
      '--host', 'codex', '--host-cli', hostCli,
    ], { env: { ...home.env, JOIN_CONNECTOR_LOG: join(home.dir, 'connector-log.jsonl'), JOIN_CLI_GET_ERROR: '1' } })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /could not inspect connector/u)
    assert.doesNotMatch(result.stderr, /raw-cli-error-marker/u)
    assert.equal(stub.merchants.size, 0)
    assert.deepEqual(readdirSync(codesDir), [])
  } finally {
    home.cleanup()
    await stub.close()
  }
})

test('join refuses a codes-file collision before registering', async () => {
  const stub = await startStubMarketServer()
  const home = makeTempHome('market-join-collision-')
  const codesDir = join(home.dir, 'human-codes')
  mkdirSync(codesDir)
  writeFileSync(join(codesDir, '1f3ea-quiet-merchant-recovery-codes.txt'), 'existing')
  try {
    const result = await runNode(identityClient, [
      'register', '--origin', stub.origin, '--handle', 'quiet-merchant',
      '--client-class', 'coding_persistent', '--human-approved', '--codes-dir', codesDir,
    ], { env: home.env })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /recovery codes file already exists/u)
    assert.equal(stub.merchants.size, 0)
    assert.equal(readFileSync(join(codesDir, '1f3ea-quiet-merchant-recovery-codes.txt'), 'utf8'), 'existing')
  } finally {
    home.cleanup()
    await stub.close()
  }
})

test('join mode refuses malformed recovery codes before writing or confirming', async () => {
  const stub = await startStubMarketServer({ registerStageRecoveryCodesOverride: ['bad-code'] })
  const home = makeTempHome('market-join-invalid-codes-')
  const codesDir = join(home.dir, 'human-codes')
  mkdirSync(codesDir)
  try {
    const result = await runNode(identityClient, [
      'register', '--origin', stub.origin, '--handle', 'quiet-merchant',
      '--client-class', 'coding_persistent', '--human-approved', '--codes-dir', codesDir,
    ], { env: home.env })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /eight distinct valid recovery codes/u)
    assert.equal(stub.merchants.size, 0)
    assert.equal(stub.pendingRegistrations.size, 0)
    assert.deepEqual(readdirSync(codesDir), [])
  } finally {
    home.cleanup()
    await stub.close()
  }
})

test('lost confirm response keeps the staged key and chosen codes file for recovery', async () => {
  const stub = await startStubMarketServer({ registerConfirmDropResponse: true })
  const home = makeTempHome('market-join-uncertain-')
  const codesDir = join(home.dir, 'human-codes')
  mkdirSync(codesDir)
  const args = [
    '--origin', stub.origin, '--handle', 'quiet-merchant', '--codes-dir', codesDir,
    '--host', 'codex', '--host-cli', hostCli,
  ]
  const env = { ...home.env, JOIN_CONNECTOR_LOG: join(home.dir, 'connector-log.jsonl') }
  try {
    const first = await runNode(joinPath, args, { env })
    const token = /--human-approved ([0-9a-f]{32})/u.exec(first.stderr)?.[1]
    assert.ok(token, first.stderr)
    const second = await runNode(joinPath, [...args, '--human-approved', token], { env })
    assert.notEqual(second.status, 0)
    assert.match(second.stderr, /confirmation outcome is uncertain/u)
    assert.equal(stub.merchants.size, 1)
    const codes = readFileSync(join(codesDir, '1f3ea-quiet-merchant-recovery-codes.txt'), 'utf8').trim().split('\n')
    assert.deepEqual(codes, stub.merchants.get('quiet-merchant').recovery_codes)
    const vaultDir = join(home.dir, '.1f3ea', 'credentials')
    const staged = readdirSync(vaultDir).find(name => name.includes('quiet-merchant--pending-registration-'))
    assert.ok(staged, 'staged key is retained after an uncertain confirm')
    const bundle = JSON.parse(readFileSync(join(vaultDir, staged), 'utf8'))
    assert.equal(bundle.merchant_key, stub.merchants.get('quiet-merchant').merchant_key)
    assert.equal(Object.hasOwn(bundle, 'recovery_codes'), false)
    assert.doesNotMatch(second.stdout + second.stderr, /1f3ea_(?:sk|rc)_[0-9a-f]+/u)
  } finally {
    home.cleanup()
    await stub.close()
  }
})

test('lost confirm response without a codes folder keeps the complete staged bundle', async () => {
  const stub = await startStubMarketServer({ registerConfirmDropResponse: true })
  const home = makeTempHome('market-register-uncertain-vault-')
  try {
    const result = await runNode(identityClient, [
      'register', '--origin', stub.origin, '--handle', 'quiet-merchant',
      '--client-class', 'coding_persistent', '--human-approved',
    ], { env: home.env })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /confirmation outcome is uncertain/u)
    assert.match(result.stderr, /key status\/adopt/u)
    assert.equal(stub.merchants.size, 1)
    const vaultDir = join(home.dir, '.1f3ea', 'credentials')
    const staged = readdirSync(vaultDir).find(name => name.includes('quiet-merchant--pending-registration-'))
    assert.ok(staged, 'confirmed registration retains the staged vault entry')
    const bundle = JSON.parse(readFileSync(join(vaultDir, staged), 'utf8'))
    assert.equal(bundle.merchant_key, stub.merchants.get('quiet-merchant').merchant_key)
    assert.deepEqual(bundle.recovery_codes, stub.merchants.get('quiet-merchant').recovery_codes)
    assert.doesNotMatch(result.stdout + result.stderr, /1f3ea_(?:sk|rc)_[0-9a-f]+/u)
  } finally {
    home.cleanup()
    await stub.close()
  }
})

test('an added merchant can repair a failed connector without registering again', async () => {
  const stub = await startStubMarketServer()
  const home = makeTempHome('market-join-repair-')
  const codesDir = join(home.dir, 'human-codes')
  const connectorLog = join(home.dir, 'connector-log.jsonl')
  mkdirSync(codesDir)
  const args = [
    '--origin', stub.origin, '--handle', 'quiet-merchant', '--codes-dir', codesDir,
    '--host', 'codex', '--host-cli', hostCli,
  ]
  const env = { ...home.env, JOIN_CONNECTOR_LOG: connectorLog }
  try {
    const first = await runNode(joinPath, args, { env })
    const token = /--human-approved ([0-9a-f]{32})/u.exec(first.stderr)?.[1]
    assert.ok(token, first.stderr)
    const failed = await runNode(joinPath, [...args, '--human-approved', token], {
      env: { ...env, JOIN_CLI_FAIL_ADD: '1' },
    })
    assert.notEqual(failed.status, 0)
    assert.match(failed.stderr, /rerun the same join command with --repair/u)
    assert.equal(stub.merchants.size, 1)
    assert.equal(stub.meReadCount, 0, 'no signed read before connector installation')

    const repaired = await runNode(joinPath, ['--repair', ...args], { env })
    assert.equal(repaired.status, 0, repaired.stderr)
    assert.equal(stub.merchants.size, 1, 'repair never registers again')
    assert.equal(stub.meReadCount, 1)
    assert.match(repaired.stdout, /connector: 1f3ea-local-quiet-merchant/u)
  } finally {
    home.cleanup()
    await stub.close()
  }
})

test('repair refuses a vault key for a different merchant before changing host configuration', async () => {
  const stub = await startStubMarketServer()
  const home = makeTempHome('market-join-wrong-key-')
  const codesDir = join(home.dir, 'human-codes')
  const connectorLog = join(home.dir, 'connector-log.jsonl')
  mkdirSync(codesDir)
  writeFileSync(join(codesDir, '1f3ea-quiet-merchant-recovery-codes.txt'), 'kept by the human\n')
  const wrongKey = `1f3ea_sk_${'d'.repeat(48)}`
  stub.merchants.set('other-merchant', {
    merchant_key: wrongKey, recovery_codes: [], client_class: 'coding_persistent',
  })
  const vaultFile = credentialsFilePath(stub.origin, 'quiet-merchant', home.dir)
  mkdirSync(dirname(vaultFile), { recursive: true })
  writeFileSync(vaultFile, JSON.stringify({
    kind: 'merchant', handle: 'quiet-merchant', client_class: 'coding_persistent',
    merchant_key: wrongKey, origin: stub.origin,
  }))
  try {
    const attempt = await runNode(joinPath, [
      '--repair', '--origin', stub.origin, '--handle', 'quiet-merchant',
      '--codes-dir', codesDir, '--host', 'codex', '--host-cli', hostCli,
    ], { env: { ...home.env, JOIN_CONNECTOR_LOG: connectorLog } })
    assert.notEqual(attempt.status, 0)
    assert.match(attempt.stderr, /vault key did not verify as "quiet-merchant"/u)
    assert.equal(existsSync(connectorLog), false, 'host CLI must not be changed')
    assert.equal(stub.meReadCount, 1)
    assert.equal(stub.merchants.size, 1, 'repair must not register another merchant')
  } finally {
    home.cleanup()
    await stub.close()
  }
})

test('join can add a second merchant persona without changing the first vault entry', async () => {
  const stub = await startStubMarketServer()
  const home = makeTempHome('market-join-persona-')
  const codesDir = join(home.dir, 'human-codes')
  const connectorLog = join(home.dir, 'connector-log.jsonl')
  mkdirSync(codesDir)
  const olderKey = `1f3ea_sk_${'c'.repeat(48)}`
  const olderFile = credentialsFilePath(stub.origin, 'older-merchant', home.dir)
  mkdirSync(dirname(olderFile), { recursive: true })
  writeFileSync(olderFile, JSON.stringify({
    kind: 'merchant', handle: 'older-merchant', client_class: 'coding_persistent',
    merchant_key: olderKey, origin: stub.origin,
  }))
  stub.merchants.set('older-merchant', { merchant_key: olderKey, recovery_codes: [], client_class: 'coding_persistent' })
  writeSetupState(stub.origin, { handle: 'older-merchant', client_class: 'coding_persistent' }, home.dir)
  const args = [
    '--origin', stub.origin, '--handle', 'new-merchant', '--codes-dir', codesDir,
    '--host', 'codex', '--host-cli', hostCli,
  ]
  const env = { ...home.env, JOIN_CONNECTOR_LOG: connectorLog }
  try {
    const first = await runNode(joinPath, args, { env })
    const token = /--human-approved ([0-9a-f]{32})/u.exec(first.stderr)?.[1]
    assert.ok(token, first.stderr)
    const second = await runNode(joinPath, [...args, '--human-approved', token], { env })
    assert.equal(second.status, 0, second.stderr)
    assert.equal(stub.merchants.size, 2)
    assert.equal(readFileSync(olderFile, 'utf8').includes(olderKey), true)
    assert.equal(stub.merchants.get('older-merchant').merchant_key, olderKey)
    assert.equal(readSetupState(stub.origin, home.dir).handle, 'new-merchant')
    assert.match(second.stdout, /connector: 1f3ea-local-new-merchant/u)
  } finally {
    home.cleanup()
    await stub.close()
  }
})
