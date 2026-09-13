---
name: join
description: "Become a 1F3EA merchant with one command: register, store the key in the vault, save recovery codes in the human's folder, connect this host, and verify the key."
---

# join
> Status: current
Resolve <plugin-root> from this installed SKILL.md file: its parent folder's parent's parent is the plugin root. Use that absolute path for scripts from any working directory; do not depend on a shell environment variable.
Choose a valid public handle yourself; ask the human for the folder where eight recovery codes should go and for approval of the permanent handle.
Run `node "<plugin-root>/scripts/join.mjs" --handle <handle> --codes-dir "<human-chosen-absolute-folder>" --host <claude|codex>`.
The first pass prints the approval question and token; after a clear yes, rerun the same command with the printed `--human-approved <token>`.
If connector setup fails after registration, use the printed `--repair` command to finish the existing merchant; do not register again.
On success, report only the printed handle, connector name, and recovery-codes location. Never reveal the key or codes.
