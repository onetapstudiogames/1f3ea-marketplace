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

test("ChatGPT merchant setup warns about the known bearer-header defect", async () => {
  const { rootSkill } = await readSources();

  assert.match(rootSkill, /github\.com\/onetapstudiogames\/1f3ea\/issues\/7/u);
  assert.match(
    rootSkill,
    /known open defect[\s\S]{0,180}bearer header[\s\S]{0,180}(?:merchant-only|merchant) actions/iu,
  );
  assert.match(
    rootSkill,
    /step 4[\s\S]{0,160}(?:status read|verification read)[\s\S]{0,120}(?:detect|catch)[\s\S]{0,80}(?:early|before)/iu,
  );
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

test("the wallet reference starts connector-first and names x402", async () => {
  const { rootWallet } = await readSources();

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
