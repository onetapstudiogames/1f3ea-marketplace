// Preload module for `NODE_OPTIONS=--import <this file's file:// URL>`.
// Registers force-incomplete-vault-resolve-hook.mjs as a module
// customization hook for THIS one child process only -- never affects any
// other test, since it is opted into per-subprocess via env, never loaded
// by the test runner's own main process.
import { register } from 'node:module'

register('./force-incomplete-vault-resolve-hook.mjs', import.meta.url)
