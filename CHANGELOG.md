# Changelog

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
