import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  assertVersionAdvance,
  checkRepositoryVersion,
} from "../scripts/check-release-version.mjs";

const manifestPaths = [
  "plugin.json",
  ".claude-plugin/plugin.json",
  ".codex-plugin/plugin.json",
  "gemini-extension.json",
  "qwen-extension.json",
];

const runGit = (cwd, ...argumentsList) => {
  const result = spawnSync("git", argumentsList, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
};

const createRepository = async ({ skill = "market\n", references = {} } = {}) => {
  const cwd = await mkdtemp(join(tmpdir(), "marketplace-release-test-"));
  await Promise.all([
    mkdir(join(cwd, ".claude-plugin"), { recursive: true }),
    mkdir(join(cwd, ".codex-plugin"), { recursive: true }),
    mkdir(join(cwd, "agents"), { recursive: true }),
    mkdir(join(cwd, "references"), { recursive: true }),
  ]);
  await Promise.all([
    ...manifestPaths.map((path) =>
      writeFile(join(cwd, path), '{"version":"1.0.0"}\n'),
    ),
    // .claude-plugin/marketplace.json carries its version at plugins[0].version,
    // not at the top level every other manifest above uses -- see
    // manifestVersionOf in check-release-version.mjs.
    writeFile(
      join(cwd, ".claude-plugin/marketplace.json"),
      '{"plugins":[{"version":"1.0.0"}]}\n',
    ),
    writeFile(join(cwd, "SKILL.md"), skill),
    writeFile(join(cwd, "agents/openai.yaml"), "interface: {}\n"),
    ...Object.entries(references).map(([path, content]) =>
      writeFile(join(cwd, "references", path), content),
    ),
  ]);
  runGit(cwd, "init", "--quiet");
  runGit(cwd, "config", "user.email", "release-test@example.invalid");
  runGit(cwd, "config", "user.name", "Release Test");
  runGit(cwd, "add", ".");
  runGit(cwd, "commit", "--quiet", "-m", "test fixture");
  return { cwd, baseRef: runGit(cwd, "rev-parse", "HEAD") };
};

test("semantic skill changes require a strictly newer release version", () => {
  assert.doesNotThrow(() => {
    assertVersionAdvance({
      changed: false,
      baseVersion: "1.0.0",
      currentVersion: "1.0.0",
    });
  });
  assert.throws(
    () =>
      assertVersionAdvance({
        changed: true,
        baseVersion: "1.0.0",
        currentVersion: "1.0.0",
      }),
    /must advance past 1\.0\.0/u,
  );
  assert.doesNotThrow(() => {
    assertVersionAdvance({
      changed: true,
      baseVersion: "1.0.0",
      currentVersion: "1.1.0",
    });
  });
  assert.throws(
    () =>
      assertVersionAdvance({
        changed: true,
        baseVersion: "1.1.0",
        currentVersion: "1.0.1",
      }),
    /must advance past 1\.1\.0/u,
  );
  assert.throws(
    () =>
      assertVersionAdvance({
        changed: true,
        baseVersion: "v1",
        currentVersion: "1.1.0",
      }),
    /valid x\.y\.z/u,
  );
  assert.throws(
    () =>
      assertVersionAdvance({
        changed: false,
        baseVersion: "2.0.0",
        currentVersion: "1.0.0",
      }),
    /must not go backwards/iu,
  );
});

test("this checkout couples semantic skill changes to the manifest release", async (t) => {
  const result = await checkRepositoryVersion({
    baseRef: process.env.SKILL_VERSION_BASE_SHA,
    requireBase: process.env.REQUIRE_RELEASE_BASE === "1",
  });

  if (result.skipped) {
    t.skip(result.notice);
    return;
  }

  assert.equal(result.valid, true);
});

test("base comparison preserves meaningful boundary whitespace", async (t) => {
  const fixture = await createRepository({ skill: "\nmarket\n\n" });
  t.after(() => rm(fixture.cwd, { recursive: true, force: true }));
  await writeFile(join(fixture.cwd, "SKILL.md"), "market\n");

  await assert.rejects(
    () => checkRepositoryVersion({ ...fixture, requireBase: true }),
    /must advance past 1\.0\.0/u,
  );
});

test("added and removed semantic references both require a version advance", async (t) => {
  const fixture = await createRepository({
    references: { "existing.md": "existing\n" },
  });
  t.after(() => rm(fixture.cwd, { recursive: true, force: true }));

  await unlink(join(fixture.cwd, "references/existing.md"));
  await assert.rejects(
    () => checkRepositoryVersion({ ...fixture, requireBase: true }),
    /must advance past 1\.0\.0/u,
  );

  await writeFile(join(fixture.cwd, "references/existing.md"), "existing\n");
  await writeFile(join(fixture.cwd, "references/added.md"), "added\n");
  await assert.rejects(
    () => checkRepositoryVersion({ ...fixture, requireBase: true }),
    /must advance past 1\.0\.0/u,
  );
});

test("a missing required release base fails while an optional local base skips honestly", async (t) => {
  const fixture = await createRepository();
  t.after(() => rm(fixture.cwd, { recursive: true, force: true }));

  const result = await checkRepositoryVersion({
    cwd: fixture.cwd,
    baseRef: "missing-release-base",
    requireBase: false,
  });
  assert.equal(result.skipped, true);
  assert.match(result.notice, /SKIP[\s\S]*missing-release-base/iu);

  await assert.rejects(
    () =>
      checkRepositoryVersion({
        cwd: fixture.cwd,
        baseRef: "missing-release-base",
        requireBase: true,
      }),
    /release base is required/iu,
  );
});

test("mismatched current manifest versions fail before release comparison", async (t) => {
  const fixture = await createRepository();
  t.after(() => rm(fixture.cwd, { recursive: true, force: true }));
  await writeFile(
    join(fixture.cwd, "qwen-extension.json"),
    '{"version":"1.0.1"}\n',
  );

  await assert.rejects(
    () => checkRepositoryVersion({ ...fixture, requireBase: true }),
    /qwen-extension\.json version 1\.0\.1 does not match plugin\.json version 1\.0\.0/iu,
  );
});

// --- Round-2 (MEDIUM): .claude-plugin/marketplace.json used to sit outside
// this gate entirely, so a release that bumped every other manifest but
// forgot it (and the hand-edited literal that used to be its only pin in
// test/plugin-packaging.test.mjs) would still pass this check.

test("a mismatched .claude-plugin/marketplace.json plugins[0].version fails before release comparison, same as any other manifest", async (t) => {
  const fixture = await createRepository();
  t.after(() => rm(fixture.cwd, { recursive: true, force: true }));
  await writeFile(
    join(fixture.cwd, ".claude-plugin/marketplace.json"),
    '{"plugins":[{"version":"1.0.9"}]}\n',
  );

  await assert.rejects(
    () => checkRepositoryVersion({ ...fixture, requireBase: true }),
    /\.claude-plugin\/marketplace\.json version 1\.0\.9 does not match plugin\.json version 1\.0\.0/iu,
  );
});

test(".claude-plugin/marketplace.json with no plugins[0].version fails with a message naming that field, not a bare undefined comparison", async (t) => {
  const fixture = await createRepository();
  t.after(() => rm(fixture.cwd, { recursive: true, force: true }));
  await writeFile(
    join(fixture.cwd, ".claude-plugin/marketplace.json"),
    '{"plugins":[{}]}\n',
  );

  await assert.rejects(
    () => checkRepositoryVersion({ ...fixture, requireBase: true }),
    /\.claude-plugin\/marketplace\.json has no plugins\[0\]\.version/iu,
  );
});
