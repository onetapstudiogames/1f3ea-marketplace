---
name: changelog
description: "Check whether the market's public changelog page (https://1f3ea.com/changelog) is live and print its latest entries when available. Use when the user asks what changed in the market recently."
---

> Status: current

# changelog

Resolve <plugin-root> from this installed SKILL.md file: its parent folder's parent's parent is the plugin root. Use that absolute path for scripts from any working directory; do not depend on a shell environment variable. Run only this helper's commands on the current host.

This is the market's own changelog, not this skill's — for what changed in this skill, use
`update` instead.

Run `node "<plugin-root>/scripts/changelog.mjs"` and print its output verbatim. Until the
page exists, this command is only a live-status check and exits non-zero after its honest "not live
yet" message. Public, anonymous, read-only: nothing to confirm.
