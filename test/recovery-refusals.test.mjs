import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import test from 'node:test'

const scriptsDir = new URL('../scripts/', import.meta.url)

// The refusal sentence is copied into several CLI commands. An earlier
// version of this test named the two files that happened to be fixed first,
// which is exactly how the two copies in scripts/connect.mjs stayed wrong
// while the suite stayed green. Discover the copies instead of listing them:
// any new or missed copy is then held to the same rule automatically.
const REFUSAL = /if you have a saved recovery code[^\n]+/giu

async function collectScripts(dir) {
  const entries = await readdir(dir, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const child = new URL(`${entry.name}${entry.isDirectory() ? '/' : ''}`, dir)
    if (entry.isDirectory()) files.push(...(await collectScripts(child)))
    else if (entry.name.endsWith('.mjs')) files.push(child)
  }
  return files
}

test('every lost-key CLI refusal points the human to browser recovery', async () => {
  const scripts = await collectScripts(scriptsDir)
  assert.ok(scripts.length > 0, 'expected to find CLI scripts under scripts/')

  let found = 0
  for (const script of scripts) {
    const where = script.pathname.slice(script.pathname.indexOf('/scripts/') + 1)
    const source = await readFile(script, 'utf8')
    for (const refusal of source.match(REFUSAL) ?? []) {
      found += 1
      assert.match(refusal, /https:\/\/1f3ea\.com\/recovery/u, `${where}: browser recovery page not named`)
      assert.doesNotMatch(refusal, /run `key recover begin`/u, `${where}: still sends recovery-code entry to the local command`)
    }
  }

  // Guards the discovery itself: if the sentence is reworded past this
  // pattern, the scan would silently check nothing and pass.
  assert.ok(found > 0, 'expected at least one lost-key refusal sentence under scripts/')
})
