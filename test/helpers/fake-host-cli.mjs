// Test-only host CLI. It records public connector arguments, never secrets.
import { appendFileSync } from 'node:fs'

if (process.env.AGENT_1F3EA_STUB_ONLY !== '1' || !process.env.JOIN_CONNECTOR_LOG) {
  // Node's test discovery may load helper files as standalone modules.
} else if (process.argv[2] === '--version') {
  console.log('stub 1.0')
} else if (process.argv[2] === 'mcp' && process.argv[3] === 'get') {
  if (process.env.JOIN_CLI_GET_ERROR === '1') {
    console.error('raw-cli-error-marker')
    process.exitCode = 2
  } else {
    const name = process.argv[4]
    if (process.argv.includes('--json')) {
      console.error(`Error: No MCP server named '${name}' found.`)
    } else {
      console.log(`No MCP server named "${name}". Configured servers: none`)
    }
    process.exitCode = 1
  }
} else if (process.argv[2] === 'mcp' && process.argv[3] === 'add') {
  if (process.env.JOIN_CLI_FAIL_ADD === '1') {
    process.exitCode = 1
  } else {
    appendFileSync(process.env.JOIN_CONNECTOR_LOG, `${JSON.stringify(process.argv.slice(2))}\n`)
  }
} else {
  process.exitCode = 1
}
