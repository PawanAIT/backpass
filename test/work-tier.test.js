import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { passesStrict } from "../src/discovery/association.js";
import { discoverTranscripts } from "../src/discovery/index.js";
import { workPaths, workTier } from "../src/discovery/work.js";
import { loadConfig } from "../src/config.js";
import { resolveRepo } from "../src/repo.js";

/**
 * Tier 2.5: a session that started in no checkout is placed by where its tool calls
 * worked. The fixtures are real git checkouts: this repo, another repo, an undiscovered
 * clone of this repo, and a scratch folder that is no checkout at all.
 */

function git(args, cwd) {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function checkout(dir, remote) {
  fs.mkdirSync(dir, { recursive: true });
  git(["init", "-q", "-b", "main"], dir);
  if (remote) git(["remote", "add", "origin", remote], dir);
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "app.ts"), "export {};\n");
  return fs.realpathSync(dir);
}

function layout() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "backpass-work-")));
  const repoRoot = checkout(path.join(base, "demo"), "https://github.com/acme/demo.git");
  const otherRoot = checkout(path.join(base, "other"), "https://github.com/acme/other.git");
  const cloneRoot = checkout(path.join(base, "elsewhere", "demo-copy"), "git@github.com:acme/demo.git");
  const scratch = path.join(base, "scratch");
  fs.mkdirSync(scratch);
  return { base, repoRoot, otherRoot, cloneRoot, scratch, repo: resolveRepo(repoRoot) };
}

test("a session is a candidate only when it started in a live directory inside no checkout", () => {
  const { repo, otherRoot, scratch } = layout();
  const tier = workTier(repo, { wsl: null });
  assert.equal(tier.isCandidate({ cwd: scratch }), true);
  assert.equal(tier.isCandidate({ cwd: otherRoot }), false, "a checkout of another repo owns its sessions");
  assert.equal(tier.isCandidate({ cwd: path.join(otherRoot, "src") }), false);
  assert.equal(tier.isCandidate({ cwd: scratch, gitRoot: otherRoot }), false, "so does a recorded root inside one");
  assert.equal(
    tier.isCandidate({ cwd: scratch, remotes: ["https://github.com/acme/other.git"] }),
    false,
    "a recorded remote names the session's repository",
  );
  assert.equal(tier.isCandidate({ cwd: path.join(scratch, "gone") }), false, "a dead cwd is tier 3 territory");
  assert.equal(tier.isCandidate({ cwd: "scratch" }), false, "a relative cwd names nothing");
  assert.equal(tier.isCandidate({ cwd: "C:\\Users\\me\\setup" }), false, "neither does a Windows path off WSL");
});

test("the session belongs here when this repo's checkouts hold most of its checkout paths", () => {
  const { repo, repoRoot, otherRoot, cloneRoot, scratch } = layout();
  const tier = workTier(repo, { wsl: null });
  const here = (...names) => names.map((name) => path.join(repoRoot, name));

  const worked = tier.associate([...here("src/app.ts", "src/new.ts", "README.md"), path.join(otherRoot, "src/app.ts")]);
  assert.equal(worked.tier, 2.5);
  assert.equal(worked.confidence, "work");
  assert.equal(worked.reason, `tool calls worked in ${repoRoot} (3 of 4 paths in a checkout)`);
  assert.equal(passesStrict(worked, true), true, "deterministic, so --strict keeps it");

  assert.equal(
    tier.associate([...here("src/app.ts"), path.join(otherRoot, "a.ts"), path.join(otherRoot, "b.ts")]),
    null,
    "most of the work was in another repository",
  );
  assert.equal(tier.associate([...here("src/app.ts"), path.join(otherRoot, "a.ts")]), null, "a tie is no majority");
  assert.equal(
    tier.associate([path.join(scratch, "notes.md"), "/tmp/backpass-work-scratch.txt"]),
    null,
    "paths in no checkout place nothing",
  );
  assert.equal(
    tier.associate([...here("src/app.ts"), path.join(scratch, "a"), path.join(scratch, "b")])?.tier,
    2.5,
    "scratch paths count for neither side",
  );
  assert.equal(
    tier.associate([path.join(cloneRoot, "src/app.ts")])?.tier,
    2.5,
    "a checkout that shares a remote with this repo is this repo, discovered or not",
  );
  assert.equal(
    tier.associate(here("src/deleted/since.ts"))?.tier,
    2.5,
    "a file deleted since still lies in its checkout",
  );
});

test("work paths are the structured tool-call paths, resolved the way nested attribution resolves them", () => {
  const { repoRoot, scratch } = layout();
  const unc = `\\\\wsl.localhost\\Ubuntu${repoRoot.replaceAll("/", "\\")}`;
  const events = [
    { kind: "tool", name: "read", input: { path: `${unc}\\src\\app.ts` } },
    { kind: "tool", name: "edit", input: { filePath: "notes.md" } },
    { kind: "tool", name: "grep", input: { path: "src", workdir: repoRoot } },
    {
      kind: "tool",
      name: "apply_patch",
      input: `*** Begin Patch\n*** Add File: ${repoRoot}/src/new.ts\n*** End Patch`,
    },
    { kind: "tool", name: "shell", input: { command: `cd ${repoRoot} && npm test` } },
    { kind: "tool", name: "read", input: { path: "~/secrets.txt" } },
    { kind: "message", role: "user", text: `look at ${repoRoot}/README.md` },
  ];
  const wsl = { distro: "Ubuntu", drives: new Map() };
  assert.deepEqual(workPaths({ cwd: scratch }, events, { wsl }).sort(), [
    path.join(repoRoot, "src"),
    path.join(repoRoot, "src", "app.ts"),
    path.join(repoRoot, "src", "new.ts"),
    path.join(scratch, "notes.md"),
  ]);
});

function writePiSession(home, { id, cwd, paths }) {
  const dir = path.join(home, ".pi", "agent", "sessions", `-${cwd.replaceAll("/", "-")}--`);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `2026-09-29T10-00-00-000Z_${id}.jsonl`);
  const lines = [
    { type: "session", version: 3, id, timestamp: "2026-09-29T10:00:00.000Z", cwd },
    { type: "message", message: { role: "user", content: [{ type: "text", text: `Do the ${id} work.` }] } },
    {
      type: "message",
      message: {
        role: "assistant",
        content: paths.map((p, index) => ({ type: "toolCall", id: `t${index}`, name: "edit", arguments: { path: p } })),
      },
    },
  ];
  fs.writeFileSync(file, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
  return file;
}

test("discovery keeps a session that worked here from outside every checkout, and nothing else it did not", async () => {
  const { base, repo, repoRoot, otherRoot, scratch } = layout();
  const home = path.join(base, "home");
  const orchestrator = writePiSession(home, {
    id: "orchestrator",
    cwd: scratch,
    paths: [`${repoRoot}/src/app.ts`, `${repoRoot}/src/new.ts`, `${otherRoot}/src/app.ts`, `${scratch}/plan.md`],
  });
  writePiSession(home, { id: "unrelated", cwd: scratch, paths: [`${otherRoot}/src/app.ts`, `${scratch}/plan.md`] });
  writePiSession(home, { id: "other-repo", cwd: otherRoot, paths: [`${repoRoot}/src/app.ts`] });
  writePiSession(home, { id: "plain", cwd: repoRoot, paths: [] });

  const previousHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const config = loadConfig(repoRoot, { discovery: { harnesses: ["pi"], since: "all" } });
    let stored = { version: 1, entries: {} };
    config.state = {
      root: path.join(repoRoot, ".backpass"),
      readScanCache: () => stored,
      writeScanCache: (cache) => {
        stored = structuredClone(cache);
      },
    };

    const first = await discoverTranscripts({ repo, config, strict: true });
    const tiers = Object.fromEntries(first.transcripts.map((t) => [t.nativeId, t.association.tier]));
    assert.deepEqual(tiers, { orchestrator: 2.5, plain: 1 });
    const worked = first.transcripts.find((t) => t.nativeId === "orchestrator");
    assert.equal(worked.association.confidence, "work");
    assert.equal(first.perHarness.pi.matched, 2);
    assert.equal(first.perHarness.pi.skipped, 2, "the unrelated and other-repo sessions are not this repo's");
    assert.equal(Object.keys(stored.work).length, 2, "both scratch-folder sessions' work paths are cached");

    // Same content signature: the cached work paths stand without reading the file again.
    if (process.getuid?.() !== 0) {
      fs.chmodSync(orchestrator, 0o000);
      try {
        const second = await discoverTranscripts({ repo, config, strict: true });
        assert.equal(second.transcripts.find((t) => t.nativeId === "orchestrator")?.association.tier, 2.5);
      } finally {
        fs.chmodSync(orchestrator, 0o644);
      }
    }
  } finally {
    process.env.HOME = previousHome;
  }
});
