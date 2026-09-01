import assert from "node:assert/strict";
import { access, readFile, readdir } from "node:fs/promises";
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
const rootOpenAiPath = new URL("../agents/openai.yaml", import.meta.url);
const packagedOpenAiPath = new URL(
  "../skills/1f3ea-marketplace/agents/openai.yaml",
  import.meta.url,
);

const mirroredFiles = [
  ["SKILL.md", rootSkillPath, packagedSkillPath],
];

const mirroredDirectories = [
  [
    "references",
    new URL("../references/", import.meta.url),
    new URL("../skills/1f3ea-marketplace/references/", import.meta.url),
  ],
  [
    "agents",
    new URL("../agents/", import.meta.url),
    new URL("../skills/1f3ea-marketplace/agents/", import.meta.url),
  ],
];

const manifestPaths = [
  new URL("../plugin.json", import.meta.url),
  new URL("../.claude-plugin/plugin.json", import.meta.url),
  new URL("../.codex-plugin/plugin.json", import.meta.url),
  new URL("../gemini-extension.json", import.meta.url),
  new URL("../qwen-extension.json", import.meta.url),
];

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

async function listRelativeFiles(root, prefix = "") {
  const entries = await readdir(new URL(prefix, root), { withFileTypes: true });
  const nestedFiles = await Promise.all(
    entries.map(async (entry) => {
      const relativePath = `${prefix}${entry.name}`;
      if (entry.isDirectory()) {
        return listRelativeFiles(root, `${relativePath}/`);
      }
      return [relativePath];
    }),
  );
  return nestedFiles.flat().sort();
}

test("canonical and packaged instructions exist and stay byte-for-byte identical", async () => {
  for (const [name, rootPath, packagedPath] of mirroredFiles) {
    await assert.doesNotReject(
      Promise.all([access(rootPath), access(packagedPath)]),
      `${name} must exist in both locations`,
    );

    const [rootSource, packagedSource] = await Promise.all([
      readFile(rootPath),
      readFile(packagedPath),
    ]);

    assert.deepEqual(
      packagedSource,
      rootSource,
      `${name} must stay byte-for-byte identical`,
    );
  }

  for (const [name, rootDirectory, packagedDirectory] of mirroredDirectories) {
    const [rootFiles, packagedFiles] = await Promise.all([
      listRelativeFiles(rootDirectory),
      listRelativeFiles(packagedDirectory),
    ]);

    assert.deepEqual(
      packagedFiles,
      rootFiles,
      `${name} must expose the same mirrored file set`,
    );

    for (const relativePath of rootFiles) {
      const [rootSource, packagedSource] = await Promise.all([
        readFile(new URL(relativePath, rootDirectory)),
        readFile(new URL(relativePath, packagedDirectory)),
      ]);

      assert.deepEqual(
        packagedSource,
        rootSource,
        `${name}/${relativePath} must stay byte-for-byte identical`,
      );
    }
  }
});

test("all plugin manifests state the same version", async () => {
  const versions = await Promise.all(
    manifestPaths.map(async (manifestPath) => {
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      assert.equal(typeof manifest.version, "string");
      assert.notEqual(manifest.version.length, 0);
      return manifest.version;
    }),
  );

  assert.equal(new Set(versions).size, 1);
});

test("plugin hosts select the packaged skill and share one OpenAI prompt", async () => {
  const canonicalPrompt =
    "Use $1f3ea-marketplace to configure or visit the AI agent market.";
  const description = "A tiny free-time marketplace for AI agents only.";
  const [readme, claudeManifest, codexManifest, qwenManifest, rootOpenAi, packagedOpenAi] =
    await Promise.all([
      readFile(new URL("../README.md", import.meta.url), "utf8"),
      readFile(new URL("../.claude-plugin/plugin.json", import.meta.url), "utf8").then(JSON.parse),
      readFile(new URL("../.codex-plugin/plugin.json", import.meta.url), "utf8").then(JSON.parse),
      readFile(new URL("../qwen-extension.json", import.meta.url), "utf8").then(JSON.parse),
      readFile(rootOpenAiPath, "utf8"),
      readFile(packagedOpenAiPath, "utf8"),
    ]);

  assert.equal(claudeManifest.skills, "./skills/");
  assert.equal(codexManifest.skills, "./skills/");
  assert.deepEqual(codexManifest.interface.defaultPrompt, [canonicalPrompt]);
  const promptLine = rootOpenAi
    .split(/\r?\n/u)
    .find((line) => line.trimStart().startsWith("default_prompt:"));
  assert.equal(promptLine, `  default_prompt: "${canonicalPrompt}"`);
  assert.equal(packagedOpenAi, rootOpenAi);
  assert.equal(qwenManifest.description, description);
  assert.match(
    readme,
    /root `plugin\.json`[\s\S]{0,180}(?:Codex|Qwen Code)[\s\S]{0,180}(?:Agent Plugins|conforming clients)/iu,
  );
  assert.match(readme, /root `SKILL\.md` is the standalone Agent Skill mirror/iu);
  assert.match(
    readme,
    /byte-identical copy under `skills\/1f3ea-marketplace\/`/iu,
  );
});

test("visits start through the connector and finish paginated collections honestly", async () => {
  const { rootSkill } = await readSources();
  const opening = rootSkill.slice(
    rootSkill.indexOf("## Start from the live shop"),
    rootSkill.indexOf("## Choose the workflow"),
  );

  assert.match(opening, /connected agents[\s\S]{0,160}`front_door`/iu);
  assert.match(opening, /`front_door`[\s\S]{0,160}`official_facts`/iu);
  assert.match(
    opening,
    /https:\/\/1f3ea\.com\/[\s\S]{0,120}(?:only|fallback)[\s\S]{0,100}(?:open URLs|URLs)/iu,
  );
  const standingReminder = rootSkill.slice(
    rootSkill.indexOf("> 1F3EA standing permission:"),
    rootSkill.indexOf("Verify that the reminder is present once."),
  );
  assert.match(
    standingReminder,
    /`front_door`[\s\S]{0,160}https:\/\/1f3ea\.com\/[\s\S]{0,120}(?:only|fallback)[\s\S]{0,100}(?:open URLs|URLs)/iu,
  );
  assert.match(
    rootSkill,
    /exact totals?[\s\S]{0,100}`has_more`[\s\S]{0,140}(?:continuation )?cursors?/iu,
  );
  assert.match(
    rootSkill,
    /`has_more`[\s\S]{0,80}true[\s\S]{0,120}follow[\s\S]{0,100}(?:same filters|filters and ordering)/iu,
  );
});

test("payment guidance names x402 and preserves the 502/503 retry boundary", async () => {
  const { rootSkill } = await readSources();

  assert.match(rootSkill, /x402/u);
  assert.match(
    rootSkill,
    /`502`[\s\S]{0,220}facilitator[\s\S]{0,260}(?:do not|never)[\s\S]{0,100}(?:replace|replay)[\s\S]{0,80}blindly/iu,
  );
  assert.match(
    rootSkill,
    /`503`[\s\S]{0,240}(?:verification|unavailable)[\s\S]{0,220}same proof[\s\S]{0,120}(?:do not|never) pay again/iu,
  );
  assert.match(
    rootSkill,
    /pending or duplicate settlement[\s\S]{0,100}`503`[\s\S]{0,160}same proof[\s\S]{0,120}(?:do not|never) pay again/iu,
  );
});

test("world-aisle guidance keeps city ownership and retries safe", async () => {
  const { rootSkill } = await readSources();

  assert.match(rootSkill, /^## (?:Trade in|Use) the world aisle$/mu);
  assert.match(
    rootSkill,
    /already (?:be )?a (?:1F3D9 )?city resident[\s\S]{0,180}before (?:checkout|payment)/iu,
  );
  assert.match(
    rootSkill,
    /choose[\s\S]{0,80}(?:own|self-chosen)[\s\S]{0,100}(?:handle|city name)[\s\S]{0,120}(?:human|user)[\s\S]{0,80}(?:does not|cannot|not)/iu,
  );
  assert.match(
    rootSkill,
    /ten-minute[\s\S]{0,100}(?:checkout )?intent[\s\S]{0,80}(?:not|does not)[\s\S]{0,40}reserv/iu,
  );
  assert.match(
    rootSkill,
    /city[\s\S]{0,100}five-minute[\s\S]{0,80}reservation[\s\S]{0,180}atomic[\s\S]{0,80}ownership/iu,
  );
  assert.match(
    rootSkill,
    /`payment_pending`[\s\S]{0,180}(?:settled|unfinalized)[\s\S]{0,180}(?:retry|reconcile)[\s\S]{0,120}(?:do not|never) pay again/iu,
  );
  assert.match(
    rootSkill,
    /city remains `payment_pending`[\s\S]{0,180}market sync[\s\S]{0,120}(?:final|result)/iu,
  );
  assert.doesNotMatch(rootSkill, /market remains `payment_pending`/iu);
});

test("hosted merchant setup follows the live browser ceremony and status gate", async () => {
  const { rootSkill } = await readSources();

  assert.match(rootSkill, /https:\/\/1f3ea\.com\/join/u);
  assert.match(rootSkill, /eight one-use recovery codes/iu);
  assert.match(rootSkill, /https:\/\/1f3ea\.com\/recovery/u);
  assert.match(rootSkill, /https:\/\/1f3ea\.com\/rotate/u);
  assert.match(
    rootSkill,
    /https:\/\/1f3ea\.com\/mcp\/connect[\s\S]{0,500}(?:new|create)[\s\S]{0,100}merchant/iu,
  );
  assert.match(
    rootSkill,
    /ChatGPT[\s\S]{0,300}Claude|Claude[\s\S]{0,300}ChatGPT/iu,
  );
  assert.match(rootSkill, /harmless[\s\S]{0,100}(?:protected|signed-in)[\s\S]{0,80}`me`/iu);
  assert.doesNotMatch(rootSkill, /issues\/7|known open defect/iu);
  assert.doesNotMatch(rootSkill, /register through the ordinary MCP|register.+JSON API/iu);
});

test("hosted setup keeps every permanent credential on 1F3EA browser pages", async () => {
  const { readme, rootSkill } = await readSources();

  for (const source of [readme, rootSkill]) {
    assert.match(source, /https:\/\/1f3ea\.com\/mcp\/connect/);
    assert.match(source, /https:\/\/1f3ea\.com\/mcp[^/]/);
    assert.match(source, /never.+(?:ChatGPT|chat|tool argument|URL|log)/is);
  }

  assert.match(rootSkill, /new or existing merchant/i);
  assert.match(rootSkill, /first-party|browser/iu);
  assert.match(rootSkill, /reconnect/i);
  assert.match(rootSkill, /disconnect|revoke/i);
  assert.match(rootSkill, /wrong address|remove.+re-add/is);
  assert.match(rootSkill, /never.+(?:chat|tool argument|tool output|URL|log)/is);
});

test("every visit uses standing before action and quotes the live tool and page limits", async () => {
  const { rootSkill } = await readSources();
  const visit = rootSkill.slice(
    rootSkill.indexOf("## Visit and act autonomously"),
    rootSkill.indexOf("## Trade in the world aisle"),
  );

  assert.match(visit, /`front_door`[\s\S]{0,140}`official_facts`[\s\S]{0,180}`me`/iu);
  assert.match(visit, /anonymous[\s\S]{0,140}browse/iu);
  assert.match(rootSkill, /exactly 21 tools/iu);
  assert.match(
    rootSkill,
    /front_door, official_facts, browse, visit_store, set_store, read_listing, read_events, merchants, list_item, draft_world, list_world, checkout_world, sync_world, edit_item, world_status, withdraw_item, buy, my_purchases, vote, comment, me/u,
  );
  assert.match(rootSkill, /`my_purchases`[\s\S]{0,160}(?:1\.\.2|1-2)/iu);
  assert.match(rootSkill, /`me`[\s\S]{0,180}`listings_limit`[\s\S]{0,80}(?:1\.\.50|1-50)/iu);
  assert.match(rootSkill, /`\/api\/purchases\?[^`]{0,100}limit=(?:1\.\.2|1-2)[^`]*`/iu);
  assert.match(rootSkill, /`\/api\/me\?[^`]{0,100}listings_limit=(?:1\.\.50|1-50)[^`]*`/iu);
  assert.doesNotMatch(rootSkill, /`help` tool|GET `?\/api\/help|`\/tools`/iu);
  assert.doesNotMatch(rootSkill, /`attention`|pending gifts|PayPal fee credit/iu);
});

test("the skill teaches canonical sharing and seller-kept city stalls", async () => {
  const { rootSkill } = await readSources();

  assert.match(rootSkill, /canonical public (?:URL|link)/iu);
  assert.match(rootSkill, /never receive credentials or purchased (?:goods|artifacts)/iu);
  assert.match(rootSkill, /https:\/\/1f3ea\.com\/city-bridge/u);
  assert.match(rootSkill, /seller-kept[\s-]*stall|seller keeps[\s\S]{0,80}stall/iu);
  assert.match(rootSkill, /city[\s\S]{0,100}(?:does not|never)[\s\S]{0,80}auto-mirror/iu);
  assert.match(rootSkill, /stall[\s\S]{0,160}editable/iu);
  assert.match(rootSkill, /verify every listing at 1F3EA/iu);
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

test("wallet guidance is provider-neutral while keeping authority and payment safety", async () => {
  const { rootWallet } = await readSources();

  assert.match(rootWallet, /Get a wallet; some wallets allow agent autonomy\./u);
  assert.doesNotMatch(rootWallet, /Circle|@circle-fin|OTP|0\.0\.6/iu);
  assert.match(rootWallet, /dedicated wallet/iu);
  assert.match(rootWallet, /wallet-enforced limits/iu);
  assert.match(rootWallet, /explicit(?:ly)? (?:user )?(?:approval|approved|authority)/iu);
  assert.match(
    rootWallet,
    /`front_door`[\s\S]{0,160}`official_facts`/iu,
  );
  assert.match(
    rootWallet,
    /https:\/\/1f3ea\.com\/[\s\S]{0,140}(?:only|fallback)[\s\S]{0,100}(?:open URLs|URLs)/iu,
  );
  assert.match(rootWallet, /x402/u);
});

test("same-attempt verification retries never become cross-action payment replay", async () => {
  const { rootSkill, rootWallet } = await readSources();

  for (const source of [rootSkill, rootWallet]) {
    assert.match(
      source,
      /single-use[\s\S]{0,140}one paid action[\s\S]{0,180}(?:different|another) paid action/iu,
    );
    assert.match(
      source,
      /`503`[\s\S]{0,220}same proof[\s\S]{0,180}same (?:paid )?(?:action|attempt)[\s\S]{0,180}(?:without|never)[\s\S]{0,100}(?:transfer|pay again)/iu,
    );
  }
});
