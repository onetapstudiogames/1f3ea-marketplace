import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const rootSkillPath = new URL("../SKILL.md", import.meta.url);
const packagedSkillPath = new URL(
  "../skills/1f3ea-marketplace/SKILL.md",
  import.meta.url,
);
const rootWalletPath = new URL("../references/wallet.md", import.meta.url);
const packagedWalletPath = new URL(
  "../skills/1f3ea-marketplace/references/wallet.md",
  import.meta.url,
);

async function readSources() {
  const [readme, rootSkill, packagedSkill, rootWallet, packagedWallet] =
    await Promise.all([
      readFile(new URL("../README.md", import.meta.url), "utf8"),
      readFile(rootSkillPath, "utf8"),
      readFile(packagedSkillPath, "utf8"),
      readFile(rootWalletPath, "utf8"),
      readFile(packagedWalletPath, "utf8"),
    ]);

  return { readme, rootSkill, packagedSkill, rootWallet, packagedWallet };
}

test("canonical and packaged instructions stay byte-for-byte identical", async () => {
  const { rootSkill, packagedSkill, rootWallet, packagedWallet } =
    await readSources();

  assert.equal(packagedSkill, rootSkill);
  assert.equal(packagedWallet, rootWallet);
});

test("ChatGPT setup uses the hosted connector without exposing the permanent key", async () => {
  const { readme, rootSkill } = await readSources();

  for (const source of [readme, rootSkill]) {
    assert.match(source, /https:\/\/1f3ea\.com\/mcp\/connect/);
    assert.match(source, /https:\/\/1f3ea\.com\/mcp[^/]/);
    assert.match(source, /never.+(?:ChatGPT|chat|tool argument|URL|log)/is);
  }

  assert.match(rootSkill, /existing merchant/i);
  assert.match(rootSkill, /browser approval page/i);
  assert.match(rootSkill, /reconnect/i);
  assert.match(rootSkill, /disconnect|revoke/i);
  assert.match(rootSkill, /wrong address|remove.+re-add/is);
  assert.match(rootSkill, /register.+(?:ordinary|non-chat|JSON)/is);
  assert.doesNotMatch(rootSkill, /Never print, paste, log/);
});

test("direct payment guidance requires a fresh bound proof", async () => {
  const { rootSkill, rootWallet } = await readSources();

  for (const source of [rootSkill, rootWallet]) {
    assert.match(source, /10 minutes/i);
    assert.match(source, /intent_id/);
    assert.match(source, /tx_hash/);
    assert.match(source, /payer_signature/);
    assert.match(source, /personal_sign/);
    assert.match(source, /buyer/i);
    assert.match(source, /listing/i);
    assert.match(source, /payer/i);
    assert.match(source, /seller|treasury/i);
    assert.match(source, /Base USDC/i);
    assert.match(source, /minimum amount/i);
    assert.match(source, /issued|expires/i);
    assert.match(source, /single-use|never reuse/i);
  }
});
