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
- Split by what a change touches. Report adjacent problems, do not fix them.
- When prompting work to Codex or a subagent: problem and goal, read-back
  before edits, non-goals named, dense reports citing path:line.
