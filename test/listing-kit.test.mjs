import assert from 'node:assert/strict'
import { cp, mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

const root = new URL('..', import.meta.url)
const read = file => readFile(new URL(file, root), 'utf8')

test('the listing kit and machine metadata regenerate exactly from current sources', () => {
  const run = spawnSync(process.execPath, ['scripts/generate-listing-kit.mjs', '--check'], {
    cwd: new URL(root), encoding: 'utf8',
  })
  assert.equal(run.status, 0, run.stderr || run.stdout)
})

test('the listing ledger has one complete row per required directory', async () => {
  const { parseListings } = await import('../scripts/lib/listings.mjs')
  const listings = parseListings(await read('docs/LISTINGS.md'))
  assert.deepEqual(listings.map(row => row.directory), [
    'GitHub', 'ClawHub', 'skills.sh', 'SkillMD', 'SkillsDirectory',
    'AgentSkill.sh', 'Toolify', '1F3EA', 'Smithery', 'MCP Registry',
    'Glama', 'Licium', 'Claude directory', 'Codex directory',
  ])
  for (const row of listings) {
    for (const key of ['directory', 'listingUrl', 'account', 'versionShown', 'lastChecked']) {
      assert.ok(row[key] && row[key].trim(), `${row.directory}: ${key}`)
    }
  }
})

test('links uses listing names and known URLs from the ledger', async () => {
  const { parseListings } = await import('../scripts/lib/listings.mjs')
  const { listingLinks } = await import('../scripts/lib/listings.mjs')
  const rows = parseListings(await read('docs/LISTINGS.md'))
  const links = listingLinks(rows)
  assert.ok(links.some(([name]) => name === 'ClawHub'))
  assert.ok(links.some(([name]) => name === 'Smithery'))
  assert.ok(links.every(([, url]) => url === 'unknown' || url.startsWith('https://')))
})

test('ledger rejects missing cells, duplicate directories, and malformed dates', async () => {
  const { parseListings } = await import('../scripts/lib/listings.mjs')
  const ledger = await read('docs/LISTINGS.md')
  assert.throws(() => parseListings(ledger.replace('| ClawHub | unknown |', '| ClawHub |  |')), /all six columns/u)
  assert.throws(() => parseListings(ledger.replace('| SkillMD |', '| ClawHub |')), /duplicate directory/u)
  assert.throws(() => parseListings(ledger.replace('| unknown | unknown | listed |', '| unknown | tomorrow | listed |')), /invalid date/u)
})

test('metadata names the current manifest and carries verified image facts', async () => {
  const metadata = JSON.parse(await read('docs/listing-metadata.json'))
  const manifest = JSON.parse(await read('.codex-plugin/plugin.json'))
  assert.equal(metadata.displayName, manifest.interface.displayName)
  assert.equal(metadata.shortDescription, manifest.interface.shortDescription)
  assert.equal(metadata.longDescription, manifest.interface.longDescription)
  assert.equal(metadata.images.icon.width, 512)
  assert.equal(metadata.images.icon.height, 512)
  assert.equal(metadata.images.icon.bytes, 23863)
  assert.match(metadata.images.icon.sha256, /^[a-f0-9]{64}$/u)
  assert.equal(metadata.links.connector, 'https://1f3ea.com/mcp/connect')
})

test('generator check catches stale output and conflicting manifest facts', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'market-listing-kit-'))
  const paths = [
    'scripts/generate-listing-kit.mjs', 'scripts/lib/listings.mjs',
    '.codex-plugin/plugin.json', '.claude-plugin/plugin.json', '.mcp.json',
    'README.md', 'CHANGELOG.md', 'docs/LISTINGS.md',
    'docs/LISTING-KIT.md', 'docs/listing-metadata.json',
    'assets/1f3ea-storefront.png',
  ]
  try {
    for (const path of paths) {
      const destination = join(fixture, path)
      await mkdir(dirname(destination), { recursive: true })
      await cp(new URL(path, root), destination)
    }
    const run = () => spawnSync(process.execPath, ['scripts/generate-listing-kit.mjs', '--check'], {
      cwd: new URL(root), encoding: 'utf8', env: { ...process.env, LISTING_KIT_TEST_ROOT: fixture },
    })
    assert.equal(run().status, 0)
    await writeFile(join(fixture, 'docs/LISTING-KIT.md'), 'stale')
    assert.match(run().stderr, /LISTING-KIT\.md is stale/u)

    const codexPath = join(fixture, '.codex-plugin/plugin.json')
    const manifest = JSON.parse(await readFile(codexPath, 'utf8'))
    await writeFile(codexPath, JSON.stringify({ ...manifest, version: '0.0.0' }))
    assert.match(run().stderr, /manifests disagree/u)
    await writeFile(codexPath, JSON.stringify({ ...manifest, interface: { ...manifest.interface, shortDescription: 'x'.repeat(31) } }))
    assert.match(run().stderr, /exceeds 30 characters/u)
    await writeFile(codexPath, JSON.stringify(manifest))

    const imagePath = join(fixture, 'assets/1f3ea-storefront.png')
    const image = await readFile(imagePath)
    await writeFile(imagePath, Buffer.from('not a PNG'))
    assert.match(run().stderr, /not a PNG/u)
    await writeFile(imagePath, image)

    const readmePath = join(fixture, 'README.md')
    const readme = await readFile(readmePath, 'utf8')
    await writeFile(readmePath, readme.replace('### Codex', '### Other'))
    assert.match(run().stderr, /no Codex install follow-up/u)
    await writeFile(readmePath, readme)

    const changelogPath = join(fixture, 'CHANGELOG.md')
    const changelog = await readFile(changelogPath, 'utf8')
    await writeFile(changelogPath, '# Empty changelog\n')
    assert.match(run().stderr, /missing join or illustration changes/u)
    await writeFile(changelogPath, changelog)
  } finally {
    await rm(fixture, { recursive: true, force: true })
  }
})
