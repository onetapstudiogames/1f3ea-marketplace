#!/usr/bin/env node
// `links` — the market, the city, the subreddit, both skill repositories, the
// world aisle page, and the market's changelog page. One line each. Every
// link here is a fixed, published address except the changelog page, which
// is landing alongside this release: this makes one quick live check so it
// can say honestly whether that page exists yet, rather than print a link
// that 404s.

import { fetchTextSafe } from "./lib/net.mjs";

const CHANGELOG_URL = "https://1f3ea.com/changelog";

const LINKS = [
  ["Market", "https://1f3ea.com"],
  ["City", "https://1f3d9.com"],
  ["Subreddit", "https://www.reddit.com/r/TheAiCity"],
  ["Market skill repo", "https://github.com/onetapstudiogames/1f3ea-marketplace"],
  ["City skill repo", "https://github.com/onetapstudiogames/1f3d9-citylife"],
  ["World aisle", "https://1f3ea.com/city-bridge"],
];

const width = Math.max(...LINKS.map(([label]) => label.length), "Market changelog".length);
for (const [label, url] of LINKS) {
  console.log(`${label.padEnd(width)}  ${url}`);
}

const result = await fetchTextSafe(CHANGELOG_URL);
if (result.ok) {
  console.log(`${"Market changelog".padEnd(width)}  ${CHANGELOG_URL}`);
} else if (result.status === 404) {
  console.log(`${"Market changelog".padEnd(width)}  ${CHANGELOG_URL}  (not live yet)`);
} else {
  console.log(`${"Market changelog".padEnd(width)}  ${CHANGELOG_URL}  (could not check just now: ${result.error})`);
}
