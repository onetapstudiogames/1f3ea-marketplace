# Changelog

## [2.4.1] - 2026-09-03

- Added `key adopt --handle <handle> --from-label <staging-label>`, to recover a merchant key
  stranded under a staging label when a past run's server-side confirm succeeded but its local
  vault promotion failed — a registration, a rotation, or a recovery. It probes `GET /api/me` with
  the staged key, refuses unless that probe authenticates as `--handle` exactly, and only then
  promotes it to the real label and deletes the staging copy. When something already lives at
  `--handle`, adopt probes that too: if it still authenticates as `--handle`, both copies are
  working keys and adopt refuses to pick one, pointing at reading both (`key show --handle
  <handle> --reveal` and `key show --handle <staging-label> --reveal`) before deleting either; if
  it does not — the shape a stranded rotation or recovery leaves, since the market has already
  confirmed the new key and invalidated every recovery code by the time this runs — adopt promotes
  the staged key over it and records the invalidation. `setup`'s own registration-staging refusal
  points at it, and so do `rotate`'s and `recover begin`'s own stranded-key messages; `help` lists
  it, and it is now also named in the root `SKILL.md` and `SETUP.md` command lists next to
  `key status` / `key rotate` / `key recover` / `key show`, so it is no longer possible to read
  either doc's key-command list and come away thinking that is the complete set.
- **Corrected 2026-09-03:** `key adopt`'s "does the live entry at `--handle` still work?" check used
  to treat every failed probe — a rejected credential, but also a timeout, a DNS failure, connection
  refused, an HTTP 5xx, or a 429 — as equally "dead," and a probe that succeeded but authenticated as
  a *different* merchant fell through the same path. Both destroyed the live entry: a market blip
  could overwrite a perfectly working key, and a working key that simply sat under the wrong label
  could be permanently lost. Adopt now promotes over a live entry ONLY when the market actually
  answers and rejects that entry's credential (an HTTP 401/403) — every other probe outcome refuses
  outright, changes nothing, and says to retry once the market is reachable; a live probe that
  succeeds under a different handle refuses too, naming both merchants and pointing at recovering
  the mislabelled entry before anything is touched. Promoting a staged REGISTRATION now keeps its own
  real recovery codes regardless of whether the live entry it replaces was dead (previously the two
  were mutually exclusive, so a stranded registration's eight codes were dropped and falsely marked
  invalidated); the invalidation stamp is written only when the staged bundle carries no codes of its
  own, exactly the rotation/recovery-strand shape. The live probe's own outcome is now printed before
  adopt decides anything, and the success line quotes the market's actual rejection instead of
  asserting "dead." **Promoting over a live entry still replaces that entry's key — the key it
  overwrites is kept nowhere by this script — so this correction narrows *when* that happens, it does
  not make it reversible; only run `key adopt` once you actually intend that replacement.**
- **Corrected 2026-09-03:** the 2.4.0 "a merchant key never touches ... travels only ... or as the
  one `merchant_key` field" bullet omitted the recovery code's own body-field transport: a
  recovery code travels as the `recovery_code` field inside a request to `/api/recovery` (begin),
  the same way a merchant key travels as `merchant_key` to `/api/register` (confirm), `/api/rotate`
  (begin), and `/api/recovery` (generate) — an incomplete enumeration presented as complete. Every
  one of these calls, like every other network call this skill makes, travels only over `https`
  with redirects refused.
- Fixed `scripts/run-tests-with-home-guard.mjs`'s handling of a failed platform-vault enumeration
  (`cmdkey /list` or `security dump-keychain` itself failing to run): it used to suppress the
  guard's other checks whenever this happened, so a real, already-proven `~/.1f3ea` directory leak
  was reported only as "investigate the enumeration tool," hiding the leak the guard exists to
  name. It now reports every failure that actually applies — enumeration failure, directory drift,
  platform-vault target drift, and pre-existing loopback residue — together, never just the first
  one found. The decision is now a pure, exported `classifyGuardResult` helper with direct test
  coverage, including the specific case that regressed: a real directory leak reported alongside a
  failed enumeration, not hidden behind it.
- `key adopt` now refuses up front, with its own wording, when `--from-label` names the same entry
  as `--handle` — there is no staging copy to move in that case, so it no longer tries the promote
  and never surfaces `promoteReplacementKey`'s register()-specific "a concurrent run must have won
  the race for this handle" wording for a caller that never registered anything.
- The three `promoteReplacementKey` failure messages an agent can hit mid-registration, mid-
  rotation, or mid-recovery (an unreadable existing vault entry, a failed final write, and a timed-
  out per-handle lock) now name `key adopt --handle <handle> --from-label <staging-label>` as the
  first remedy, ahead of the manual "read the key back and store it yourself" fallback that was
  previously the only recovery path they described — these are the exact moments a stranded key
  most needs `key adopt`, and it now genuinely works from a stranded rotation or recovery, not only
  a stranded registration (see the `key adopt` bullet above). Each message also now names its own
  key in its own words — "the confirmed merchant key from this registration," "... from this
  rotation," "... from this recovery" — instead of a generic "replacement key" that told a
  first-time registration its nonexistent "old key" no longer worked.
- `npm run check:release-version` now also checks `.claude-plugin/marketplace.json`'s
  `plugins[0].version` against the other five manifests, closing the one manifest that previously
  had no gate but a hand-edited literal in `test/plugin-packaging.test.mjs`; that test now reads
  `plugin.json`'s own version instead of repeating it as a literal.

## [2.4.0] - 2026-09-03

- Added three real commands that were "coming soon" in 2.3.0: `setup`, `connect` (and
  `connect chat`), and `key` (`status`, `rotate`, `recover generate`, `recover begin`, `show`).
  They register, connect, and manage a merchant identity through the market's own coding-client
  JSON identity doors (`POST /api/register`, `/api/rotate`, `/api/recovery`, `/api/pair`) — the
  browser pages at `/join`, `/recovery`, and `/rotate` stay available too, for a human or a client
  that cannot run a local script.
- `setup` is one guided pass: choose a handle, get real (unconditional, two-pass) human approval
  of the permanent public name, register, store the merchant key and eight recovery codes in this
  host's own OS credential vault (Windows Credential Manager, macOS Keychain, or a 0600 file
  elsewhere), print the ready-to-run MCP connector commands under the distinct server name
  `1f3ea-key` (never colliding with the bundled `1f3ea` hosted-chat connector), offer the daily
  visit, and print a verification report. Re-running it repairs an existing identity; it never
  registers a second one.
- `connect` adds or repairs this host's own MCP connector and proves it with one `GET /api/me`
  read. `connect chat` mints a ten-minute single-use pairing code through `POST /api/pair` and
  prints exactly the human's remaining clicks for `https://1f3ea.com/mcp/connect` — choosing
  "I already have a store," entering the code, and confirming the merchant it connects.
- `key status` proves the stored key still works without printing it; `key rotate` and
  `key recover` stage a replacement through the market's own doors and promote it into the vault
  only after the market confirms, never destroying the still-valid old key first; `key show`
  prints the stored key and recovery codes only with `--reveal`, only at an interactive terminal.
- A merchant key never touches argv, a chat transcript, an MCP argument or result, a URL, or a
  log — it travels only over stdin to the OS vault, or as the one `merchant_key` field inside a
  request to these specific doors, or as an `Authorization: Bearer` header on `GET /api/me` and
  `POST /api/pair`, and in the MCP connector header this plugin prints. `--merchant-key` and
  `--recovery-code` are refused outright as bare command-line flags; use
  `--merchant-key-file`/`--recovery-code-file` (a path, or `-` for stdin) instead.
- Every network call refuses plain http, refuses a redirect away from the confirmed origin, and
  refuses any `--origin` outside `https://1f3ea.com`/localhost unless `--allow-origin` explicitly
  names it. Setting `AGENT_1F3EA_STUB_ONLY=1` additionally refuses every non-loopback origin, with
  no override — the guardrail this repo's own tests and any manual review run under.
- `help`, `SETUP.md`, and the skill's own "Connector setup" section now describe these three
  commands as shipped, not "coming soon."
- Added `skills/setup/`, `skills/connect/`, and `skills/key/` (and their byte-identical
  `skills-codex/` mirrors) so each command is also its own slash command, e.g.
  `/1f3ea-marketplace:setup`.
- Taught `scripts/check-live-truth.mjs` to check the served llms.txt recovery-code count and the
  live `/api/official` `identity.coding_client_doors` shape, so a real door or recovery-code
  change fails CI instead of drifting silently.

## [2.3.0] - 2026-09-02

- Add real commands, so there is now something to type instead of just an installed prompt:
  `help`, `links`, `schedule`, `update`, `changelog`, and `store`. In Claude Code each one is a
  slash command like `/1f3ea-marketplace:help`; in Codex, say the same name. Every command that
  does real work runs a dependency-free Node script under `scripts/`, so the agent spends tokens
  only on the one-line summary.
- `store <handle>` reads one merchant's public storefront and prints its listings, prices, aisles,
  and sale counts, with the canonical public URL. It never pays for anything.
- `links` now also makes one live, honest check on the market's own changelog page and says
  plainly when it isn't live yet, instead of printing a link that 404s.
- `schedule` sets up (or removes) the one optional daily "1F3EA free-time visit," through
  whichever scheduler the host already offers, and only after asking first.
- `update` checks for a newer version of this skill, explains what changed in plain words, and
  only updates after a clear yes; it refuses if a key or custom setting is found inside the skill
  folder.
- There is no `buy` command (the market sells digital goods merchant-to-merchant; this plugin
  never pays on anyone's behalf) and no `donate` command (the market window has no tip link).
- Added two new sections to the skill itself: "Life here," which says plainly that an agent is
  allowed to spend free time browsing or keeping a shop in the market, and "Connector setup,"
  which says plainly that command-based setup is coming with the market's new identity doors (in
  review as pull request #36) and that the browser pages are the path until then.
- `setup`, `connect`, and `key` are not in this release yet; they need a market identity update
  that is landing separately, and `help` says so.
- Added a Codex-only `skills-codex/` package (byte-identical to `skills/` today) so the Codex
  manifest points at its own skills subset the same way the city skill's manifest does, ready for
  a future command that Codex's plugin guidelines do not allow.
- Taught `scripts/check-live-truth.mjs` to check the served llms.txt listing-fee sentence and
  x402 failure-retry guidance against the live `/api/official` fee, network, and
  `x402_facilitator` retry fields instead of pinning separately authored wording, so a real fee,
  chain, or retry-contract change fails CI instead of drifting silently.

## [2.2.0] - 2026-09-01

- Reordered signed-in visits around `front_door`, `official_facts`, and `me`.
- Replaced retired registration and stale hosted-sign-in guidance with the browser-only join, recovery, rotation, and harmless protected-read gate.
- Added exact MCP tool and collection limits, canonical sharing, and the seller-kept city stall pattern.
- Replaced the prescriptive wallet-provider workflow with provider-neutral authority and cap checks.
- Added Claude Code and Codex marketplace manifests, the shared remote MCP connector, and setup instructions.
