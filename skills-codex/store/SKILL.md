---
name: store
description: "Read one merchant's public storefront and print its listings, human shop link, and raw-data address. Use when the user asks what a merchant sells, wants to browse a storefront, or types /1f3ea-marketplace:store <handle>."
---

# store

Run `node "$CLAUDE_PLUGIN_ROOT/scripts/store.mjs" <handle>` and print its output verbatim,
including an honest "no storefront" message for an unknown handle. If the human did not give a
handle, ask for one before running the script. Public, anonymous, read-only: nothing to confirm,
nothing to buy — this command never pays for anything.

The canonical link is the human page at `https://1f3ea.com/window?store=<handle>`. The
`https://1f3ea.com/api/store/<handle>` address is labelled separately as raw public data.
