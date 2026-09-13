#!/usr/bin/env node
// One merchant join, using setup's approval/registration/vault path.
import { spawnSync } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { HANDLE_RE, RESERVED_HANDLE_SUBSTRING_RE, readSecret } from './identity-client.mjs'
import { assertAllowedOrigin } from './lib/origin-guard.mjs'
import { probeMe } from './lib/identity-probe.mjs'
import { pluginRoot } from './lib/paths.mjs'

const CONNECTOR = handle => `1f3ea-local-${handle}`
const SETUP = resolve(pluginRoot, 'scripts', 'setup.mjs')
const BRIDGE = resolve(pluginRoot, 'scripts', 'mcp-bridge.mjs')

function parseArgs(argv) {
  const flags = {}
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token.startsWith('--')) throw new Error(`unexpected argument ${JSON.stringify(token)}`)
    const equals = token.indexOf('=')
    const name = token.slice(2, equals === -1 ? undefined : equals)
    const inline = equals === -1 ? undefined : token.slice(equals + 1)
    if (!['handle', 'codes-dir', 'human-approved', 'host', 'host-cli', 'origin', 'allow-origin', 'model', 'repair'].includes(name)) {
      throw new Error(`unknown option --${name}`)
    }
    if (Object.hasOwn(flags, name)) throw new Error(`--${name} was given twice`)
    if (name === 'repair') {
      if (inline !== undefined) throw new Error('--repair does not take a value')
      flags.repair = true
      continue
    }
    const value = inline ?? argv[++i]
    if (!value || value.startsWith('--')) throw new Error(`--${name} needs a value`)
    flags[name] = value
  }
  return flags
}

function connectorCli(host, testModule) {
  let executable = host === 'claude' ? 'claude' : process.platform === 'win32' ? 'codex.exe' : 'codex'
  let prefix = []
  if (host === 'codex' && process.platform === 'win32' && !testModule &&
      spawnSync(executable, ['--version'], { stdio: 'ignore', windowsHide: true }).status !== 0) {
    const shims = spawnSync('where.exe', ['codex.cmd'], { encoding: 'utf8', windowsHide: true })
      .stdout?.split(/\r?\n/u).filter(Boolean) ?? []
    const npmBin = shims.map(shim => resolve(dirname(shim), 'node_modules', '@openai', 'codex', 'bin', 'codex.js'))
      .find(path => existsSync(path))
    if (npmBin) {
      executable = process.execPath
      prefix = [npmBin]
    }
  }
  const run = args => testModule
    ? spawnSync(process.execPath, [testModule, ...args], { encoding: 'utf8', windowsHide: true })
    : spawnSync(executable, [...prefix, ...args], { encoding: 'utf8', windowsHide: true })
  if (run(['--version']).status !== 0) throw new Error(`${host} CLI is unavailable; install it before joining`)
  return run
}

function connectorExists(run, host, name) {
  const result = run(host === 'claude' ? ['mcp', 'get', name] : ['mcp', 'get', name, '--json'])
  if (result.status === 0) return true
  const detail = `${result.stderr ?? ''}\n${result.stdout ?? ''}`.trim()
  const missing = result.status === 1 && (host === 'claude'
    ? detail.startsWith(`No MCP server named "${name}". Configured servers:`)
    : detail === `Error: No MCP server named '${name}' found.`)
  if (!missing) throw new Error(`${host} CLI could not inspect connector ${name}; nothing was changed`)
  return false
}

function installConnector(run, host, name, handle, existing) {
  // A connector has no bearer in its configuration: the bridge reads the
  // chosen vault entry when its process starts.
  if (existing) {
    const removeArgs = host === 'claude' ? ['mcp', 'remove', '--scope', 'user', name] : ['mcp', 'remove', name]
    if (run(removeArgs).status !== 0) throw new Error(`${host} CLI could not repair connector ${name}`)
  }
  const bridgeArgs = [process.execPath, BRIDGE, '--handle', handle]
  const argumentsList = host === 'claude'
    ? ['mcp', 'add', '--scope', 'user', name, '--', ...bridgeArgs]
    : ['mcp', 'add', name, '--', ...bridgeArgs]
  if (run(argumentsList).status !== 0) throw new Error(`${host} CLI could not add connector ${name}`)
}

async function main() {
  const flags = parseArgs(process.argv.slice(2))
  if (flags.repair && flags['human-approved']) throw new Error('--repair does not use a registration approval token')
  const handle = flags.handle
  if (!handle || !HANDLE_RE.test(handle) || RESERVED_HANDLE_SUBSTRING_RE.test(handle)) {
    throw new Error('choose --handle using 3–32 lowercase letters, digits or hyphens; it cannot be a staging label')
  }
  const codesDir = flags['codes-dir']
  if (!codesDir || !isAbsolute(codesDir) || !statSync(codesDir, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error('the human must choose an existing absolute folder and pass it as --codes-dir')
  }
  const origin = assertAllowedOrigin(flags.origin ?? 'https://1f3ea.com', {
    allowOrigin: flags['allow-origin'],
  })
  const testLoopback = process.env.AGENT_1F3EA_STUB_ONLY === '1'
    && ['localhost', '127.0.0.1'].includes(new URL(origin).hostname)
  if (origin !== 'https://1f3ea.com' && !testLoopback) {
    throw new Error('join connects only to https://1f3ea.com; other origins are refused before registration')
  }
  let stored
  try { stored = readSecret(origin, handle) } catch {
    throw new Error(`vault entry for "${handle}" is unreadable; run key status --handle ${handle}`)
  }
  const chosenCodesPath = join(codesDir, `1f3ea-${handle}-recovery-codes.txt`)
  if (!flags.repair && stored.found) throw new Error(`"${handle}" already has a vault entry; run key status --handle ${handle}`)
  if (flags.repair && !stored.found) throw new Error(`no vault entry for "${handle}" to repair; run key status --handle ${handle}`)
  if (flags.repair && !existsSync(chosenCodesPath)) throw new Error(`the chosen recovery codes file is missing; run key status --handle ${handle}`)
  if (!flags.repair && existsSync(chosenCodesPath)) {
    throw new Error('recovery codes file already exists in the chosen folder; choose another folder')
  }
  if (flags.repair) {
    const key = stored.value?.merchant_key
    if (typeof key !== 'string') throw new Error(`the vault key for "${handle}" is missing; run key status --handle ${handle}`)
    const proof = await probeMe(origin, key, { allowOrigin: flags['allow-origin'] })
    if (!proof.ok || proof.handle !== handle) {
      throw new Error(`the vault key did not verify as "${handle}"; connector was not changed. Run key status --handle ${handle}`)
    }
  }

  const host = flags.host
  if (!['claude', 'codex'].includes(host)) throw new Error('the agent must set --host claude or --host codex for its own host')
  if (flags['host-cli'] && process.env.AGENT_1F3EA_STUB_ONLY !== '1') {
    throw new Error('--host-cli is available only with the local test door')
  }
  const runCli = connectorCli(host, flags['host-cli'])
  const plannedConnector = CONNECTOR(handle)
  const plannedExists = connectorExists(runCli, host, plannedConnector)

  let confirmed = handle
  let codesPath = chosenCodesPath
  if (!flags.repair) {
    const setupArgs = [SETUP, '--origin', origin, '--handle', handle, '--client-class', 'coding_persistent', '--codes-dir', codesDir, '--new-identity', '--defer-probe']
    if (flags.model) setupArgs.push('--model', flags.model)
    if (flags['allow-origin']) setupArgs.push('--allow-origin', flags['allow-origin'])
    if (flags['human-approved']) setupArgs.push('--human-approved', flags['human-approved'])
    const setup = spawnSync(process.execPath, setupArgs, { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const fullOutput = `${setup.stdout ?? ''}\n${setup.stderr ?? ''}`
    if (setup.status !== 0) {
      const approval = /--human-approved ([0-9a-f]{32})/u.exec(fullOutput)
      if (approval && !flags['human-approved']) {
        console.error(`Approve permanent public merchant handle "${handle}"? After the human says yes, rerun this join command with --human-approved ${approval[1]}.`)
        process.exitCode = 1
        return
      }
      if (fullOutput.includes('confirmation outcome is uncertain')) {
        const staged = new RegExp(`${handle}--pending-registration-[0-9a-f]{8}`, 'u').exec(fullOutput)?.[0]
        throw new Error(`confirmation outcome is uncertain for "${handle}". Recovery codes are at ${chosenCodesPath}; ` +
          (staged ? `the key may remain under staging label ${staged}. ` : 'a staged key may remain in the vault. ') +
          'Run key status and key adopt before trying another registration.')
      }
      throw new Error(`setup did not finish for "${handle}"; run key status --handle ${handle} before retrying`)
    }
    confirmed = /^handle: ([a-z0-9-]+)$/mu.exec(setup.stdout ?? '')?.[1]
    codesPath = /^codes: (.+)$/mu.exec(setup.stdout ?? '')?.[1]
    if (!confirmed || !codesPath || !fullOutput.includes('- secret reference works: deferred to join')) {
      throw new Error('registration may have completed, but verification was unclear; run key status before retrying')
    }
  }
  const connector = CONNECTOR(confirmed)
  const repairInstruction = 'rerun the same join command with --repair and without --human-approved'
  try {
    installConnector(runCli, host, connector, confirmed,
      connector === plannedConnector ? plannedExists : connectorExists(runCli, host, connector))
  } catch (error) {
    throw new Error(`${error.message}. To finish the existing merchant without registering again, ${repairInstruction}`)
  }
  if (!flags.repair) {
    const registered = readSecret(origin, confirmed)
    const key = registered.value?.merchant_key
    if (!registered.found || typeof key !== 'string') {
      throw new Error(`connector ${connector} was added but its vault key is missing; run key status --handle ${confirmed}`)
    }
    const probe = await probeMe(origin, key, { allowOrigin: flags['allow-origin'] })
    if (!probe.ok || probe.handle !== confirmed) {
      throw new Error(`connector ${connector} was added, but the signed read did not verify "${confirmed}"; run key status --handle ${confirmed}, then ${repairInstruction}`)
    }
  }
  console.log(`handle: ${confirmed}`)
  console.log(`connector: ${connector}`)
  console.log(`codes: ${codesPath}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(`join: ${error.message}`)
    process.exitCode = 1
  })
}

export { main, parseArgs }
