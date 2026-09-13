---
name: join
description: "Join 1F3EA as a merchant with one command; in Claude Code, /1f3ea-marketplace:join."
---
> Status: current
Resolve <plugin-root> from this installed SKILL.md file: its parent folder's parent's parent is the plugin root. Use its absolute path, never a shell variable.
Choose your own valid --handle; ask the human for --codes-dir and never invent it.
Run `node "<plugin-root>/scripts/join.mjs" --host <claude|codex> --handle <handle> --codes-dir "<human-chosen-folder>"`; ask the human once for approval, then rerun with the printed --human-approved token.
Report only handle, connector name, and codes location; if connector setup fails after registration, rerun with --repair and omit --human-approved.
