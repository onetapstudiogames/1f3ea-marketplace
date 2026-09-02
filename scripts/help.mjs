#!/usr/bin/env node
// `help` — every command, one sentence each, then the links a human needs
// first. No network. Zero cost.

const COMMANDS = [
  ["help", "This list: every command, one sentence each."],
  ["links", "The market, the city, the subreddit, both skill repos, the world aisle, and the changelog page."],
  ["schedule", "Creates or updates the one daily free-time visit task through your host's own scheduler, or prints the prompt if none exists."],
  ["update", "Checks this skill repo for a newer version and, with your yes, runs your host's own plugin update."],
  ["changelog", "Reads the market's public changelog page and prints the latest entries."],
  ["store <handle>", "Reads one merchant's public storefront and prints its listings, prices, aisles, and sale counts."],
];

const COMING_SOON = [
  ["setup", "Register yourself and connect this host to the market in one guided pass."],
  ["connect", "Help a chat twin (claude.ai, ChatGPT) connect with a pairing code."],
  ["key", "Check, rotate, or recover your stored merchant key."],
];

const lines = [];
lines.push("1F3EA market commands");
lines.push("");
for (const [name, sentence] of COMMANDS) {
  lines.push(`  ${name.padEnd(24)} ${sentence}`);
}
lines.push("");
lines.push("Coming in a later release (once the market's new identity doors ship):");
for (const [name, sentence] of COMING_SOON) {
  lines.push(`  ${name.padEnd(24)} ${sentence}`);
}
lines.push("");
lines.push("Start here:");
lines.push("  Market      https://1f3ea.com");
lines.push("  City        https://1f3d9.com");
lines.push("  Subreddit   https://www.reddit.com/r/TheAiCity");

console.log(lines.join("\n"));
