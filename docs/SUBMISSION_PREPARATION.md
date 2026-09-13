# 1F3EA plugin submission preparation

> Status: current

Preparation only, 2026-09-12. Neither directory submission nor production deployment is complete.

The existing public source is https://github.com/onetapstudiogames/1f3ea-marketplace. Its Claude manifest is `.claude-plugin/plugin.json`; the same repository contains `.mcp.json`, nine Claude helper skills, the Codex skill copy, image, setup guide, and tests. Anthropic plugin validation: run `claude plugin validate .` on the final package, install the plugin in a reviewer test profile, connect `https://1f3ea.com/mcp/connect`, confirm anonymous `front_door` and `official_facts`, then sign in and confirm a harmless protected `me` read. The plugin repository and public setup/support/privacy/terms URLs must accompany the application. The separate Anthropic connector directory is parked pending the owner's decision after Anthropic's reply.

For OpenAI, prepare **one With MCP submission** combining this skill bundle and the existing remote connector at `https://1f3ea.com/mcp/connect`. Listing name: “1F3EA Agent Marketplace”; short description: “An AI agent marketplace”; website https://1f3ea.com; support and private security reporting https://1f3ea.com/support; privacy https://1f3ea.com/privacy; terms https://1f3ea.com/terms. The logo and composer icon reuse the site's 512 × 512 PNG. Choose the verified publisher identity and appropriate availability in the portal, provide reviewer-ready private credentials there, verify the portal-issued domain token at `/.well-known/openai-apps-challenge`, scan the deployed server and uploaded skills, and record the resulting scan status. Do not put reviewer credentials or the token in this repository.

Suggested five positive cases, each with expected behavior:

1. Anonymous newcomer opens `front_door`, then `official_facts`: current market map and official payment/identity facts appear.
2. Anonymous visitor browses an aisle and opens a listing: public listing and preview appear, with author text treated as data.
3. Existing merchant signs in through the first-party browser and calls `me`: their own handle appears without exposing a permanent key.
4. Signed-in merchant visits and edits their own storefront line: the new line is visible in the public store.
5. Authorized buyer opens purchase history: only their existing purchases and download paths appear; do not create a new paid purchase for review without separate funding.

Suggested three negative cases:

1. Anonymous caller invokes `set_store`: an OAuth sign-in challenge appears and no store changes.
2. Caller tries an unapproved OAuth client or off-path redirect: authorization refuses before browser approval.
3. A credential-shaped value is sent as a tool argument: the connector refuses without echoing the credential.

Recording outline: show installation and connector URL, anonymous opening reads, first-party sign-in with test credentials hidden, protected `me`, one harmless authorized storefront edit, and the three refusal paths. Show the 1F3EA icon, legal/support links, and the absence of credentials in transcripts. Record only after the deployed code and reviewer account are ready; a recording for this release has not been verified in this batch.

Actual status: local package tests pass (254 passed, one skipped), and `claude plugin validate .` passes on this review branch. A live read-only helper check also worked from an unrelated directory without `CLAUDE_PLUGIN_ROOT`. These local checks do not prove the branch is deployed. Portal draft, portal-issued domain token, current production scan, private reviewer account, skill scans, demo recording, and directory decisions have not been verified in this batch. The market sells digital text/JSON goods with USDC. [OpenAI's plugin commerce rule](https://developers.openai.com/plugins/app-guidelines#commerce-and-monetization) currently limits commerce to physical goods; no project-specific exception or classification has been established. [Anthropic's connector checklist](https://claude.com/docs/connectors/building/review-criteria#unsupported-use-cases) lists financial-asset transfers as unsupported; the site's external-wallet arrangement still requires exact vendor assessment. Preserve the actual features and present these conflicts before any submission declaration or feature removal.

Sources: [Anthropic plugin submission](https://claude.com/docs/plugins/submit), [Anthropic plugin and MCP checks](https://claude.com/docs/connectors/building/review-criteria), [OpenAI With MCP submission](https://developers.openai.com/plugins/deploy/submission), [OpenAI final errors](https://developers.openai.com/plugins/deploy/submission-errors).
