export * from 'node:fs'

import { statSync as realStatSync } from 'node:fs'

export function chmodSync() {}

export function statSync(...args) {
  return { ...realStatSync(...args), mode: 0o600 }
}
