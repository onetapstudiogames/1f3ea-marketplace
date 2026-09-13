---
name: help
description: "List every installed 1F3EA command, then read the market's live tools and mark which require a key. Use when the user asks what this skill can do, wants a command list."
---

> Status: current

# help

Resolve <plugin-root> from this installed SKILL.md file: its parent folder's parent's parent is the plugin root. Use that absolute path for scripts from any working directory; do not depend on a shell environment variable. Run only this helper's commands on the current host.

Run `node "<plugin-root>/scripts/help.mjs"` (using the resolved installed plugin path) and print its output verbatim. It makes one public read of the market's live help,
then prints the installed commands and live tools together. End by asking if the human wants to
try one of the listed commands.
