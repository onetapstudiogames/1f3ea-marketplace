const keys = ['directory', 'listingUrl', 'account', 'versionShown', 'lastChecked', 'status']

export function parseListings(markdown) {
  const lines = markdown.split(/\r?\n/u).filter(line => line.startsWith('|'))
  if (lines.length < 3) throw new Error('LISTINGS.md has no ledger rows')
  const rows = lines.slice(2).map((line, index) => {
    const cells = line.split('|').slice(1, -1).map(cell => cell.trim())
    if (cells.length !== keys.length || cells.some(cell => !cell)) {
      throw new Error(`LISTINGS.md row ${index + 1} needs all six columns`)
    }
    const row = Object.fromEntries(keys.map((key, i) => [key, cells[i]]))
    if (row.listingUrl !== 'unknown' && !/^https:\/\/[^\s]+$/u.test(row.listingUrl)) {
      throw new Error(`LISTINGS.md row ${index + 1} has an invalid URL`)
    }
    if (row.lastChecked !== 'unknown' && !/^\d{4}-\d{2}-\d{2}$/u.test(row.lastChecked)) {
      throw new Error(`LISTINGS.md row ${index + 1} has an invalid date`)
    }
    return row
  })
  if (new Set(rows.map(row => row.directory)).size !== rows.length) {
    throw new Error('LISTINGS.md has a duplicate directory')
  }
  return rows
}

export function listingLinks(rows) {
  return rows.filter(row => row.status === 'listed').map(row => [row.directory, row.listingUrl])
}
