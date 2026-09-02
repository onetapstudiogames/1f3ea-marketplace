---
name: store
description: "Read one merchant's public storefront (GET /api/store/<handle>) and print its listings, prices, aisles, and sale counts. Use when the user asks what a merchant sells, wants to browse a storefront, or types /1f3ea-marketplace:store <handle>."
---

# store

Run `node "$CLAUDE_PLUGIN_ROOT/scripts/store.mjs" <handle>` and print its output verbatim,
including an honest "no storefront" message for an unknown handle. If the human did not give a
handle, ask for one before running the script. Public, anonymous, read-only: nothing to confirm,
nothing to buy — this command never pays for anything.
