import assert from "node:assert/strict";
import { access, readdir, readFile } from "node:fs/promises";
import test from "node:test";

import { compareVersions, parseVersion } from "../scripts/lib/semver.mjs";
import { decodeEntities, readAttribute, stripTags } from "../scripts/lib/html.mjs";
import { parseChangelogEntries } from "../scripts/lib/changelog.mjs";

const COMMANDS = ["help", "links", "setup", "connect", "key", "schedule", "update", "changelog", "store"];

test("semver: parses and compares x.y.z versions", () => {
  assert.deepEqual(parseVersion("2.3.0"), [2, 3, 0]);
  assert.equal(parseVersion("not-a-version"), null);
  assert.equal(compareVersions("2.2.0", "2.3.0"), -1);
  assert.equal(compareVersions("2.3.0", "2.2.0"), 1);
  assert.equal(compareVersions("2.3.0", "2.3.0"), 0);
  assert.equal(compareVersions("x", "2.3.0"), null);
});

test("html: decodes entities and strips tags without a parser dependency", () => {
  assert.equal(decodeEntities("Solward&#39;s Wiki &amp; more"), "Solward's Wiki & more");
  assert.equal(stripTags("<p>hello <b>world</b></p>"), "hello world");
  assert.equal(readAttribute('<a href="https://example.com" rel="external">', "href"), "https://example.com");
  assert.equal(readAttribute('<a rel="external">', "href"), null);
});

test("changelog: splits versions into bullets and rejoins wrapped lines", () => {
  const sample = [
    "# Changelog",
    "",
    "## [2.3.0] - 2026-09-02",
    "",
    "- Add commands, so there is something to type.",
    "- A wrapped bullet that continues",
    "  onto a second physical line.",
    "",
    "## [2.2.0] - 2026-09-01",
    "",
    "- Older entry.",
    "",
  ].join("\n");
  const entries = parseChangelogEntries(sample);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].version, "2.3.0");
  assert.deepEqual(entries[0].bullets, [
    "Add commands, so there is something to type.",
    "A wrapped bullet that continues onto a second physical line.",
  ]);
  assert.equal(entries[1].version, "2.2.0");
  assert.deepEqual(entries[1].bullets, ["Older entry."]);
});

test("changelog: this repo's own CHANGELOG.md parses into at least the 2.3.0 and 2.2.0 entries", async () => {
  const text = await readFile(new URL("../CHANGELOG.md", import.meta.url), "utf8");
  const entries = parseChangelogEntries(text);
  const versions = entries.map((e) => e.version);
  assert.ok(versions.includes("2.3.0"));
  assert.ok(versions.includes("2.2.0"));
  for (const entry of entries) assert.ok(entry.bullets.length > 0, `${entry.version} has at least one bullet`);
});

test("every command has a scripts/<name>.mjs entry point and a skills/<name>/SKILL.md", async () => {
  for (const name of COMMANDS) {
    await assert.doesNotReject(() => access(new URL(`../scripts/${name}.mjs`, import.meta.url)), `${name}: script exists`);
    const skillPath = new URL(`../skills/${name}/SKILL.md`, import.meta.url);
    await assert.doesNotReject(() => access(skillPath), `${name}: skill folder exists`);
    const skill = await readFile(skillPath, "utf8");
    assert.match(skill, new RegExp(`^name: ${name}$`, "mu"), `${name}: frontmatter name matches folder`);
    assert.match(skill, /^description: /mu, `${name}: has a description`);
    assert.match(skill, /CLAUDE_PLUGIN_ROOT/u, `${name}: resolves the plugin root instead of a hardcoded path`);
  }
});

test("no buy, donate, follow, or live command exists in this skill", async () => {
  for (const name of ["buy", "donate", "follow", "live"]) {
    await assert.rejects(() => access(new URL(`../scripts/${name}.mjs`, import.meta.url)), `scripts/${name}.mjs must not exist`);
    await assert.rejects(() => access(new URL(`../skills/${name}/`, import.meta.url)), `skills/${name}/ must not exist`);
  }
});

test("help and SETUP.md both name setup, connect, and key as shipped commands", async () => {
  const help = await readFile(new URL("../scripts/help.mjs", import.meta.url), "utf8");
  for (const name of ["setup", "connect", "key"]) {
    assert.match(help, new RegExp(`"${name}`, "u"), `help.mjs lists ${name}`);
  }
  assert.doesNotMatch(help, /Coming in a later release/iu, "help.mjs no longer defers these commands");
  const setup = await readFile(new URL("../SETUP.md", import.meta.url), "utf8");
  assert.doesNotMatch(setup, /not in this release/u);
  for (const name of ["setup", "connect", "key"]) {
    assert.match(setup, new RegExp(`\`${name}`, "u"), `SETUP.md names ${name}`);
  }
});

test("SKILL.md carries Life here and Connector setup in the market's own words", async () => {
  const skill = await readFile(new URL("../SKILL.md", import.meta.url), "utf8");
  assert.match(skill, /^## Life here$/mu);
  assert.match(skill, /^## Connector setup$/mu);
  assert.match(skill, /real commands now/iu);
  assert.match(skill, /browser pages/iu);
  assert.match(skill, /will ever[\s\S]{0,40}(?:show|store)[\s\S]{0,80}merchant key/iu);
});

test("skills-codex mirrors skills byte-for-byte (the market has no command to omit today)", async () => {
  const listFiles = async (root, prefix = "") => {
    const entries = await readdir(new URL(prefix, root), { withFileTypes: true });
    const nested = await Promise.all(
      entries.map(async (entry) => {
        const relativePath = `${prefix}${entry.name}`;
        if (entry.isDirectory()) return listFiles(root, `${relativePath}/`);
        return [relativePath];
      }),
    );
    return nested.flat().sort();
  };

  const skillsRoot = new URL("../skills/", import.meta.url);
  const codexSkillsRoot = new URL("../skills-codex/", import.meta.url);

  const [claudeFiles, codexFiles] = await Promise.all([listFiles(skillsRoot), listFiles(codexSkillsRoot)]);
  assert.deepEqual(codexFiles, claudeFiles, "skills-codex holds exactly the same file set as skills/");

  for (const relativePath of claudeFiles) {
    const [claudeBytes, codexBytes] = await Promise.all([
      readFile(new URL(relativePath, skillsRoot)),
      readFile(new URL(relativePath, codexSkillsRoot)),
    ]);
    assert.deepEqual(codexBytes, claudeBytes, `${relativePath}: byte-identical in skills-codex/`);
  }

  const codexManifest = JSON.parse(await readFile(new URL("../.codex-plugin/plugin.json", import.meta.url), "utf8"));
  assert.equal(codexManifest.skills, "./skills-codex/", "Codex manifest selects the skills-codex/ subset");
});

test("SETUP.md documents the Commands section", async () => {
  const setup = await readFile(new URL("../SETUP.md", import.meta.url), "utf8");
  assert.match(setup, /^## Commands$/mu);
  assert.match(setup, /skills-codex/u);
  for (const name of COMMANDS) {
    assert.match(setup, new RegExp(`\`${name}`, "u"), `SETUP.md names ${name}`);
  }
});
