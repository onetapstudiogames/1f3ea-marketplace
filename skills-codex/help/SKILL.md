---
name: help
description: "List every installed 1F3EA command, then read the market's live tools and mark which require a key. Use when the user asks what this skill can do, wants a command list, or types /1f3ea-marketplace:help."
---

> Status: current

# help

Run `node "$CLAUDE_PLUGIN_ROOT/scripts/help.mjs"` (the plugin root env var is set for both Claude
Code and Codex) and print its output verbatim. It makes one public read of the market's live help,
then prints the installed commands and live tools together. End by asking if the human wants to
try one of the listed commands.
