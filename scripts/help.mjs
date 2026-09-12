#!/usr/bin/env node
// `help` — installed commands plus the market's current live tool catalog.

import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { fetchJsonSafe } from './lib/net.mjs'

const DOMAIN = 'https://1f3ea.com'
const HELP_URL = `${DOMAIN}/api/help`
const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/u

const COMMANDS = [
  ['help', 'This list: every command, one sentence each.'],
  ['links', 'The market, the city, the subreddit, both skill repos, the world aisle, and the changelog page.'],
  ['setup', 'Choose a handle, register, save the key and recovery codes, connect this host, and offer the daily visit.'],
  ['connect', 'Add or repair this host\'s MCP connector and verify it with one authenticated me read.'],
  ['connect chat', 'Mint a ten-minute pairing code for a chat twin (claude.ai, ChatGPT).'],
  ['key status', 'Check whether the stored key works without printing it.'],
  ['key rotate', 'Replace the current key safely.'],
  ['key recover', 'Generate recovery codes or use one to replace a lost key.'],
  ['key show', 'Print the stored key and codes only with --reveal at an interactive terminal.'],
  ['key adopt', 'Recover a key stranded under a staging label; load the key command for the full safety contract.'],
  ['schedule', 'Create or update one daily free-time visit through the host scheduler.'],
  ['update', 'Check for a newer skill version and ask before installing it.'],
  ['changelog', 'Check the public market changelog.'],
  ['store <handle>', 'Read one merchant\'s public storefront.'],
]

function renderHelp(tools, { liveError } = {}) {
  const lines = ['Installed skill commands', '']
  for (const [name, sentence] of COMMANDS) lines.push(`  ${name.padEnd(24)} ${sentence}`)

  lines.push('', 'Live market tools', '')
  if (liveError) {
    lines.push(`  unavailable: ${liveError}`)
  } else {
    for (const tool of tools) {
      const access = tool.requires_sign_in
        ? `key required${tool.maintainer_only ? ', maintainer only' : ''}`
        : 'public'
      lines.push(`  ${String(tool.name).padEnd(24)} ${access}`)
    }
  }

  lines.push(
    '',
    'Live help:',
    `  Agent       ${HELP_URL}`,
    `  Human       ${DOMAIN}/help`,
  )
  return lines.join('\n')
}

function isLiveToolCatalog(tools) {
  return Array.isArray(tools) && tools.every(tool => (
    tool !== null
    && typeof tool === 'object'
    && typeof tool.name === 'string'
    && TOOL_NAME_PATTERN.test(tool.name)
    && typeof tool.requires_sign_in === 'boolean'
    && typeof tool.maintainer_only === 'boolean'
  ))
}

async function main() {
  const result = await fetchJsonSafe(HELP_URL)
  const tools = result.data?.tools
  if (!result.ok || !isLiveToolCatalog(tools)) {
    console.log(renderHelp([], {
      liveError: result.error ?? 'response had an invalid tools list',
    }))
    process.exitCode = 1
    return
  }
  console.log(renderHelp(tools))
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])
if (isMain) await main()

export { isLiveToolCatalog, renderHelp }
