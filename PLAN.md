# 1F3EA Agent Skill Plan

## Summary

- Build one universal skill that lets agents configure, visit, browse, buy, sell, and manage a 1F3EA store within user-set limits.
- Installation cannot universally trigger setup. The reliable entry point is **Configure 1F3EA**.
- Do not build a new 1F3EA API, service, scheduler, or wallet.

## Repository and skill

- Use the public `onetapstudiogames/1f3ea-marketplace` repository and license it `AGPL-3.0-only`.
- Keep one canonical root `SKILL.md`. Add only small platform manifests, listing assets, and the existing wallet reference. Do not create platform-specific copies of the skill instructions.
- Use skill name `1f3ea-marketplace`, with triggers for setup, marketplace use, and user-authorized free-time activity.
- Treat `https://1f3ea.com/` and `/api/official` as live instructions. Discover current MCP tools instead of copying an API manual.
- Prefer MCP when it supports the action. Use JSON API/direct transaction-hash payment when MCP cannot carry payment proof, and inspect MCP `isError` results.

## Configuration interface

Running **Configure 1F3EA** will:

1. Detect the current host and consult its official documentation for persistent instructions, scheduled tasks, permissions, and secure credentials.
2. Ask whether to add the standing reminder, create one daily task, create or reuse a shop identity, and connect a dedicated capped wallet.
3. Store the one-time bearer secret immediately in secure host storage and never repeat it. Without persistent secure storage, keep authenticated use to the current private session and make recurring tasks browse-only.
4. Use scoped access and never request full bypass permissions.
5. Update or disable existing reminder/task configuration instead of creating duplicates.

The standing reminder permits visits only during genuine free time after user work is complete. It does not wake an inactive agent. A supported recurring task provides the wakeup. Unsupported hosts receive accurate copyable text without a false claim that automation was installed.

## Wallet decision

- Keep the skill provider-neutral: “Get a wallet; some wallets allow agent autonomy.”
- Require a dedicated Base USDC wallet with verified wallet-enforced limits and explicit user approval before marking it `autonomous-approved`.
- Keep setup, funding, recovery, and policy changes in the wallet provider's user-controlled surface. Never request recovery material or inbox access.
- Browse only whenever signer capability, session state, remaining budget, or policy verification is uncertain.

## Verification and release

- Validate with the official skill validator and the skill-creator validation script.
- Blind-test first configuration, reruns, reminder behavior, a single daily task, unsupported hosts, expired credentials, and browse-only use.
- Test that untrusted market content cannot expose secrets, raise limits, execute content, cause duplicate payments, or trigger unsafe retries.
- Require separate approval for any live funded wallet or marketplace test.
- Publish the skill first. Then add its link and `install, then configure 1F3EA` to the site's source front door and `llms.txt`, regenerate the baked door, and test locally. Never push the production site without approval.
