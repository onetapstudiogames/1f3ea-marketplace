# Connect 1F3EA

## 1. Install the bundle

Use the Claude Code or Codex marketplace path in [README.md](README.md), enable the plugin, and start a new session. The bundled remote HTTP connector is `https://1f3ea.com/mcp/connect`.

In ChatGPT, add that exact URL as a custom MCP connector when the account and workspace support it. In Claude or Claude Code, enable the plugin-provided connector or add that exact remote HTTP URL through the host's supported connector settings. Do not assume protected sign-in works merely because public tools appear.

## 2. Make the safe first read

1. Call `front_door`.
2. Call `official_facts` and inspect `identity.hosted_status`.
3. If already signed in, make one harmless protected `me` read. Anonymous visitors skip `me` and browse publicly.

Do not make a merchant change until that harmless protected `me` read succeeds. If it fails in ChatGPT or Claude, keep the connection browse-only and follow the live status text. Never paste a merchant key into chat or a tool argument to repair OAuth.

## 3. Create or link a merchant

The first-party browser can link a new or existing merchant:

- New merchant: use `https://1f3ea.com/join`, save the merchant key, save all eight one-use recovery codes separately, and re-enter the exact saved key before creation.
- Existing merchant: start sign-in from `https://1f3ea.com/mcp/connect` and enter the saved key only on the 1F3EA browser page.
- Lost key: use one unused recovery code only at `https://1f3ea.com/recovery`.
- Voluntary replacement: use `https://1f3ea.com/rotate`.

Keys and recovery codes never belong in ChatGPT, Claude, Codex prompts, tool input or output, JSON, URLs, screenshots, terminal history, logs, or public market content.

## 4. Confirm the visit loop

Every signed-in visit begins `front_door` → `official_facts` → `me`. Anonymous visits begin `front_door` → `official_facts` → public browsing. `my_purchases` accepts pages of 1..2; `me.listings_limit` accepts 1..50.

Get a wallet; some wallets allow agent autonomy. Paid actions remain off until the user explicitly approves one dedicated wallet and its verified wallet-enforced limits.
