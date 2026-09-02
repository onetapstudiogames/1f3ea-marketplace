import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const readJson = async (path) =>
  JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));

test("Claude and Codex package the hosted remote MCP connector", async () => {
  const [mcp, claudeManifest, codexManifest] = await Promise.all([
    readJson("../.mcp.json"),
    readJson("../.claude-plugin/plugin.json"),
    readJson("../.codex-plugin/plugin.json"),
  ]);

  assert.deepEqual(mcp, {
    mcpServers: {
      "1f3ea": {
        type: "http",
        url: "https://1f3ea.com/mcp/connect",
      },
    },
  });
  assert.equal(claudeManifest.mcpServers, "./.mcp.json");
  assert.equal(codexManifest.mcpServers, "./.mcp.json");
});

test("both marketplaces expose the repository-root plugin at version 2.3.0", async () => {
  const [claudeMarketplace, codexMarketplace] = await Promise.all([
    readJson("../.claude-plugin/marketplace.json"),
    readJson("../.agents/plugins/marketplace.json"),
  ]);

  assert.equal(claudeMarketplace.name, "1f3ea-marketplace");
  assert.equal(claudeMarketplace.plugins.length, 1);
  assert.deepEqual(
    {
      name: claudeMarketplace.plugins[0].name,
      source: claudeMarketplace.plugins[0].source,
      version: claudeMarketplace.plugins[0].version,
    },
    { name: "1f3ea-marketplace", source: "./", version: "2.3.0" },
  );

  assert.equal(codexMarketplace.name, "1f3ea-marketplace");
  assert.deepEqual(codexMarketplace.plugins, [
    {
      name: "1f3ea-marketplace",
      source: { source: "local", path: "./" },
      policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
      category: "Productivity",
    },
  ]);
});

test("release files describe installation and setup without publishing", async () => {
  await Promise.all([
    access(new URL("../SETUP.md", import.meta.url)),
    access(new URL("../CHANGELOG.md", import.meta.url)),
  ]);
  const [readme, setup, changelog] = await Promise.all([
    readFile(new URL("../README.md", import.meta.url), "utf8"),
    readFile(new URL("../SETUP.md", import.meta.url), "utf8"),
    readFile(new URL("../CHANGELOG.md", import.meta.url), "utf8"),
  ]);

  assert.match(readme, /\.claude-plugin\/marketplace\.json/u);
  assert.match(readme, /\.agents\/plugins\/marketplace\.json/u);
  assert.match(setup, /https:\/\/1f3ea\.com\/mcp\/connect/u);
  assert.match(setup, /`front_door`[\s\S]{0,120}`official_facts`[\s\S]{0,160}`me`/iu);
  assert.match(setup, /ChatGPT/iu);
  assert.match(setup, /Claude/iu);
  assert.match(setup, /harmless[\s\S]{0,100}(?:protected|signed-in)[\s\S]{0,80}`me`/iu);
  assert.match(changelog, /^## \[2\.3\.0\]/mu);
});
