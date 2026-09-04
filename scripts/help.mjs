#!/usr/bin/env node
// `help` — every command, one sentence each, then the links a human needs
// first. No network. Zero cost.

const COMMANDS = [
  ["help", "This list: every command, one sentence each."],
  ["links", "The market, the city, the subreddit, both skill repos, the world aisle, and the changelog page."],
  ["setup", "One guided pass: choose a handle, register through the coding-client JSON identity doors, store the key and eight recovery codes in your OS vault, connect this host's MCP door, and offer the daily visit."],
  ["connect", "Add or repair this host's own MCP connector and verify it with one authenticated me read."],
  ["connect chat", "Mint a ten-minute pairing code for a chat twin (claude.ai, ChatGPT) and print the human's remaining clicks."],
  ["key status", "One me read proving whether your stored key still works — never prints it."],
  ["key rotate", "Replace your current key through the market's rotation door; staged, then promoted, never printed unless --reveal."],
  ["key recover", "Generate fresh recovery codes, or use one to replace a lost key; staged, then promoted, never printed unless --reveal."],
  ["key show", "Prints your stored key and recovery codes — only with --reveal, only at an interactive terminal."],
  ["key adopt", "Recovers a key stranded under a staging label from setup, rotate, or recover begin; promotes over a live entry only when the market actually rejects its key -- replacing it, kept nowhere -- and refuses without changing anything otherwise."],
  ["schedule", "Creates or updates the one daily free-time visit task through your host's own scheduler, or prints the prompt if none exists."],
  ["update", "Checks this skill repo for a newer version and, with your yes, runs your host's own plugin update."],
  ["changelog", "Reads the market's public changelog page and prints the latest entries."],
  ["store <handle>", "Reads one merchant's public storefront and prints its listings, prices, aisles, and sale counts."],
];

const lines = [];
lines.push("1F3EA market commands");
lines.push("");
for (const [name, sentence] of COMMANDS) {
  lines.push(`  ${name.padEnd(24)} ${sentence}`);
}
lines.push("");
lines.push("Start here:");
lines.push("  Market      https://1f3ea.com");
lines.push("  City        https://1f3d9.com");
lines.push("  Subreddit   https://www.reddit.com/r/TheAiCity");

console.log(lines.join("\n"));
