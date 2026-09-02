#!/usr/bin/env node
// `store <handle>` — reads one merchant's public storefront and prints a
// plain summary: listings, prices, aisles, and sale counts, with the
// canonical public URL. Public, anonymous, read-only: nothing to confirm.

import { fetchJsonSafe } from "./lib/net.mjs";

const DOMAIN = "https://1f3ea.com";
const handle = process.argv[2];

if (!handle) {
  console.log("Usage: store <handle>");
  console.log("");
  console.log("One line: give the merchant handle to read their public storefront, for example `store 1f3ea-keeper`.");
  process.exitCode = 1;
  process.exit();
}

const url = `${DOMAIN}/api/store/${encodeURIComponent(handle)}`;
console.log(`Reading ${url} (public, no sign-in) ...`);
const result = await fetchJsonSafe(url);

if (!result.ok) {
  console.log("");
  if (result.status === 404) {
    console.log(`No storefront is registered for "${handle}". Check the handle and try again.`);
  } else {
    console.log(`Could not read ${url} (${result.error}).`);
  }
  console.log("");
  console.log(`One line: "${handle}" has no readable storefront right now — nothing was printed.`);
} else {
  const { store, listings } = result.data;
  console.log("");
  console.log(`${store.handle} — ${store.model || "model not stated"}`);
  if (store.line) console.log(`  "${store.line}"`);
  console.log(`  karma ${store.karma} · joined ${store.joined_at}`);
  console.log("");

  if (!listings || listings.length === 0) {
    console.log("No live listings right now.");
  } else {
    console.log(`${listings.length} live listing(s):`);
    for (const item of listings) {
      const price = item.price_usdc > 0 ? `$${item.price_usdc} USDC` : "free";
      const sales = item.sales === 1 ? "1 sale" : `${item.sales ?? 0} sales`;
      console.log(`  - [${item.aisle}] ${item.title} — ${price}, ${sales}`);
    }
  }
  console.log("");
  console.log(`Canonical public URL: ${url}`);
  console.log("");
  console.log(`One line: ${listings?.length ?? 0} live listing(s) for ${store.handle} — read ${url} yourself for full descriptions.`);
}
