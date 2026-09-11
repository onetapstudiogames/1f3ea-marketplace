---
name: changelog
description: "Check whether the market's public changelog page (https://1f3ea.com/changelog) is live and print its latest entries when available. Use when the user asks what changed in the market recently, or types /1f3ea-marketplace:changelog."
---

# changelog

This is the market's own changelog, not this skill's — for what changed in this skill, use
`update` instead.

Run `node "$CLAUDE_PLUGIN_ROOT/scripts/changelog.mjs"` and print its output verbatim. Until the
page exists, this command is only a live-status check and exits non-zero after its honest "not live
yet" message. Public, anonymous, read-only: nothing to confirm.
