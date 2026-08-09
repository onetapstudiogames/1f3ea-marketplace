# Wallet reference

Last reviewed: 2026-08-09

Read the linked official documentation again before setup. Wallet products, limits, and prices can change.

## Current status

Circle Agent Wallet CLI is the leading candidate for 1F3EA, but it is **not yet certified by this project**. Do not describe it as proven free or fully tested until the proof gate below passes on Base mainnet.

Autonomous spending status: **disabled**. Treat Circle as `proof-test-only`; all scheduled visits remain browse-only.

Until then, offer either:

1. browse-only operation; or
2. guided Circle setup with an explicit explanation that the project has verified the documentation, not the live product behavior.

Do not perform a funded proof test without the user's separate approval.

## Why Circle is the leading candidate

Circle's official documentation states that Agent Wallet CLI:

- works from any agent framework without custom integration code;
- creates user-controlled wallets whose MPC key shares are not exposed to the agent;
- supports arbitrary USDC transfers on Base and returns a confirmed `data.txHash`;
- supports mainnet per-transaction, daily, weekly, and monthly limits protected by a second email OTP;
- sponsors gas under a capped fair-use policy.

Official sources:

- Overview and custody model: https://developers.circle.com/agent-stack/agent-wallets
- Base setup and seven-day sessions: https://developers.circle.com/agent-stack/agent-wallets/quickstart
- Confirmed transfer and transaction-hash response: https://developers.circle.com/agent-stack/agent-wallets/wallet-operations/transfer
- Spending policies: https://developers.circle.com/agent-stack/agent-wallets/wallet-operations/custom-policies
- Fees: https://developers.circle.com/agent-stack/agent-wallets/fees
- Terms and policy limitations: https://agents.circle.com/terms-of-use

## Cost statement

The Agent Wallet fee page currently lists:

- gas: `$0`, sponsored and subject to a fair-use cap and future change;
- same-chain x402: no protocol fee;
- cross-chain x402: `0.5 bps`;
- swaps: `2 bps`;
- bridging: variable fees plus a `$0.05` forwarding fee.

1F3EA normally needs same-chain Base transfers, not bridging or swapping. The USDC an agent chooses to spend is not a wallet fee.

The docs do not clearly prove that creating and keeping one Agent Wallet CLI account has no subscription, API, or billing requirement. Confirm that during the proof test. Do not use Circle's general Wallets pricing as proof that the Agent Wallet CLI is free.

## Safe setup

1. Re-read the official quickstart, transfer, policy, fee, and terms pages.
2. Let the user authenticate by email OTP and accept Circle's terms. Do not request inbox access or enter the OTP on the user's behalf.
3. Use a dedicated Base wallet. Suggest funding no more than `2 USDC` for the first setup; the user chooses the actual amount.
4. Ask the user to set and verify wallet-enforced limits. A conservative starting suggestion is a `2 USDC` per-transaction, daily, weekly, and monthly maximum.
5. Record only the public address, a non-secret session reference, and a plain-language policy summary in host-native configuration.

Circle sessions expire after seven days. Default to weekly human OTP reauthentication. When a session expires, browse only; do not grant the agent access to the user's inbox.

Changing wallet policies requires another user OTP. The agent must never ask to raise limits during autonomous activity.

Circle documents local logout, but this review found no documented remote revoke-all command. Keep only the leisure balance in the wallet and disclose this limitation.

## Payment use after certification

Before every transfer:

1. Read the live 1F3EA front door, listing, and `/api/official` response.
2. Verify Base, the official USDC contract, recipient, amount, and wallet policy.
3. Run the current documented Circle transfer command.
4. Require terminal state `CONFIRMED` and capture `data.txHash`.
5. Submit the hash through the live 1F3EA claim or listing flow, then verify the shop state.

Never retry a transfer merely because the shop response failed. Check the transaction and shop state first.

## Proof gate

Circle becomes the recommended wallet only after all of these pass:

1. Create and retain one wallet without entering billing information or accepting a subscription.
2. Set a tiny Base-mainnet per-transaction and rolling cap using a human-entered OTP, then read the policy back.
3. Send one user-approved, low-value Base USDC transfer and receive a confirmed `data.txHash` with no Circle charge beyond the USDC sent.
4. Attempt an over-cap transfer and confirm it is rejected before funds move.
5. Confirm local logout, session expiry behavior, and safe browse-only recovery; separately document whether remote revocation exists.

Test x402 separately before claiming it is protected by the same limits. 1F3EA can use the direct transaction-hash route without x402.

After every proof passes, update this reference's review date and status in a reviewed release. Only then may configuration record `autonomous-approved`, and only after the user separately approves the wallet and exact limits. A test run must never enable autonomous spending automatically.

## Fallback

If Circle fails the proof gate, evaluate **Coinbase Agentic Wallet CLI**, not its MCP alone, against the same requirements.

Official sources:

- CLI overview: https://docs.cdp.coinbase.com/agentic-wallet/cli/welcome
- Send USDC: https://docs.cdp.coinbase.com/agentic-wallet/cli/skills/send
- MCP tool limits: https://docs.cdp.coinbase.com/agentic-wallet/mcp/mcp-tools/overview
- Wallet pricing: https://docs.cdp.coinbase.com/wallets/pricing-and-rewards/overview

Coinbase's documentation currently shows Base USDC sends and JSON output, but this review did not find proof that user-set limits cover arbitrary CLI sends or a documented returned transaction-hash schema. Its MCP cannot send arbitrary transfers. Do not promote it until those gaps pass a real proof test.

If neither candidate passes, keep the skill wallet-neutral and browse-only. Reliability is more important than claiming autonomous spending support.
