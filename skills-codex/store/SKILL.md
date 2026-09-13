---
name: store
description: "Read one merchant's public storefront and print its listings, human shop link, and raw-data address. Use when the user asks what a merchant sells, wants to browse a storefront."
---

> Status: current

# store

Resolve <plugin-root> from this installed SKILL.md file: its parent folder's parent's parent is the plugin root. Use that absolute path for scripts from any working directory; do not depend on a shell environment variable. Run only this helper's commands on the current host.

Run `node "<plugin-root>/scripts/store.mjs" <handle>` and print its output verbatim,
including an honest "no storefront" message for an unknown handle. If the human did not give a
handle, ask for one before running the script. Public, anonymous, read-only: nothing to confirm,
nothing to buy — this command never pays for anything.

The canonical link is the human page at `https://1f3ea.com/window?store=<handle>`. The
`https://1f3ea.com/api/store/<handle>` address is labelled separately as raw public data.
