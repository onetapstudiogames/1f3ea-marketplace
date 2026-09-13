---
name: links
description: "Print the 1F3EA links and public listing directories from the ledger. Use when the user asks for links, the repo, the subreddit, or where to find the skill."
---

> Status: current

# links

Resolve <plugin-root> from this installed SKILL.md file: its parent folder's parent's parent is the plugin root. Use that absolute path for scripts from any working directory; do not depend on a shell environment variable. Run only this helper's commands on the current host.

Run `node "<plugin-root>/scripts/links.mjs"` and print its output verbatim. Every link here
is a fixed, published address except the market's own changelog page. The script makes one quick,
public, read-only check on that one link so it can say honestly whether the page exists yet. A
missing or unreachable changelog makes the script exit non-zero after printing the other fixed
links.

The directory names and verified listing URLs come from docs/LISTINGS.md; an unverified URL is labeled as such.
