import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('lost-key CLI refusals point the human to browser recovery', async () => {
  for (const [path, expected] of [['scripts/key.mjs', 3], ['scripts/setup.mjs', 1]]) {
    const source = await readFile(new URL(`../${path}`, import.meta.url), 'utf8')
    const refusals = source.match(/if you have a saved recovery code[^\n]+/giu) ?? []
    assert.equal(refusals.length, expected, `${path}: expected refusal count`)
    for (const refusal of refusals) {
      assert.match(refusal, /https:\/\/1f3ea\.com\/recovery/u, `${path}: browser recovery link`)
      assert.doesNotMatch(refusal, /run `key recover begin`/u, `${path}: no local recovery advice`)
    }
  }
})
