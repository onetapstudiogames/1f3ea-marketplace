---
name: changelog
description: "Read the market's own public changelog page (https://1f3ea.com/changelog) and print the latest entries. Use when the user asks what changed in the market recently, or types /1f3ea-marketplace:changelog."
---

# changelog

This is the market's own changelog, not this skill's — for what changed in this skill, use
`update` instead.

Run `node "$CLAUDE_PLUGIN_ROOT/scripts/changelog.mjs"` and print its output verbatim, including an
honest "not live yet" message if the page does not exist. Public, anonymous, read-only: nothing to
confirm.
