# The working standard

Read this before changing anything. This repo is the market skill — the text
an agent installs to trade on 1F3EA. Its only failure mode that matters: **the
skill describing a market that no longer exists.**

## Definition of done

1. **Every mechanical claim matches the live market.** Routes, tool names,
   parameters, limits, prices, and flows are checked against https://1f3ea.com
   and https://1f3ea.com/llms.txt — not against memory of them. A claim you
   did not verify is a claim you may be republishing wrong.
2. **`npm test` passes.** It enforces that the root files and their packaged
   copies under skills/1f3ea-marketplace/ stay byte-identical, and that the
   five manifest files agree on the version. Edit the root file, mirror it
   exactly, never let the copies drift.
3. **Version bumps ride content changes.** If the skill's meaning changed,
   every manifest's version changes with it, together.
4. **PRs only, CI green.** Same as every repo in this project.

## How work runs here

- The market repo (onetapstudiogames/1f3ea) is the source of truth for
  mechanics; this repo only describes them. When they disagree, this repo is
  wrong.
- This skill is listed in many external venues (see the city repo's owner
  notes) — a content change here usually means those listings need refreshing
  too; say so in the PR body rather than assuming someone remembers.
- **Fix the class, never just the instance.** A stale claim found here means
  sweeping this whole skill for the same class, checking the sibling skill,
  and asking whether the sites' own surfaces carry it too. One corrected
  sentence with its class unswept is how drift returns.
- Split by what a change touches. Report adjacent problems, do not fix them.
- When prompting work to Codex or a subagent: problem and goal, read-back
  before edits, non-goals named, dense reports citing path:line.

Quality gates live in CI and the release gate; there are no repo-local agent hooks, by design (owner decision, 2026-08-26).

Identity client concerns live under `scripts/lib/`: `identity-input.mjs` owns validation, argument and secret I/O; `identity-http.mjs` owns the guarded HTTP helpers; `vault-backends.mjs` owns Windows Credential Manager, macOS Keychain, and the 0600 file backend; `vault-index.mjs` owns labels and the non-secret index; `vault-locks.mjs` owns index and per-handle locks; `promote.mjs` owns staged promotion; `register.mjs` owns registration; and `rotate-recover.mjs` owns rotation, recovery, and pairing. `scripts/identity-client.mjs` remains the CLI and public export facade.
