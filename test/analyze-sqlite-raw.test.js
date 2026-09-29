import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";

import { analyzeTranscripts } from "../src/analyze.js";
import { State } from "../src/state.js";

/**
 * The raw-transcript escape hatch for a session in a SQLite store (opencode here).
 *
 * The trace footer names a raw transcript the analysis agent may open when a claim needs
 * the full text. For a file-backed store that is the session's own file; an opencode
 * session's path is the store's one database, holding every session of every repository.
 * This drives the real CLI against a fake acpx that reads the analysis prompt, follows
 * the footer, and records what it found there: the analysis must name a file holding
 * this one session's events, and that file must be gone once the call has returned.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(ROOT, "bin", "backpass.js");

const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-sqlite-raw-bin-"));
const fakePi = path.join(binDir, "pi");
const fakeAcpx = path.join(binDir, "acpx");
const seenLog = path.join(binDir, "seen.json");

fs.writeFileSync(fakePi, `#!${process.execPath}\nprocess.exit(0);\n`);
fs.chmodSync(fakePi, 0o755);
fs.writeFileSync(
  fakeAcpx,
  `#!${process.execPath}
const fs = require("node:fs");
const argv = process.argv.slice(2);
if (argv.includes("config") && argv.includes("show")) {
  process.stdout.write(JSON.stringify({ agents: {} }) + "\\n");
  process.exit(0);
}
if (argv.includes("--file")) {
  const prompt = fs.readFileSync(argv[argv.indexOf("--file") + 1], "utf8");
  const rawPath = /^raw transcript: (.+)$/m.exec(prompt)[1];
  const seen = { rawPath, exists: fs.existsSync(rawPath), mode: fs.statSync(rawPath).mode & 0o777, lines: [] };
  if (seen.exists) seen.lines = fs.readFileSync(rawPath, "utf8").trim().split("\\n").map((line) => JSON.parse(line));
  fs.writeFileSync(${JSON.stringify(seenLog)}, JSON.stringify(seen));
  if (process.env.RAW_TEST_SIGNAL && (!process.env.RAW_TEST_SIGNAL_MATCH || rawPath.includes(process.env.RAW_TEST_SIGNAL_MATCH))) {
    process.kill(process.ppid, process.env.RAW_TEST_SIGNAL);
    setTimeout(() => process.exit(0), 100);
  } else {
    process.stdout.write(process.env.RAW_TEST_INVALID ? "not JSON" : JSON.stringify({ positive: [], negative: [], gaps: [] }));
    process.exit(0);
  }
} else {
  process.exit(0);
}
`,
);
fs.chmodSync(fakeAcpx, 0o755);

function git(args, cwd) {
  spawnSync("git", args, { cwd, stdio: "ignore" });
}

function initRepo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "backpass-sqlite-raw-repo-")));
  git(["init", "--quiet", "-b", "main"], dir);
  git(["config", "user.email", "test@example.com"], dir);
  git(["config", "user.name", "test"], dir);
  fs.writeFileSync(path.join(dir, "AGENTS.md"), "# Agent instructions\n\n- Run `make build` before every push.\n");
  git(["add", "-A"], dir);
  git(["commit", "-q", "-m", "memory"], dir);
  return dir;
}

/** An opencode 1.x store with this repo's session and one from somewhere else. */
function writeStore(home, repoDir, sessionDir = repoDir) {
  const store = path.join(home, ".local", "share", "opencode");
  fs.mkdirSync(store, { recursive: true });
  const db = new DatabaseSync(path.join(store, "opencode.db"));
  db.exec(`
    CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT NOT NULL);
    CREATE TABLE session (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, parent_id TEXT, directory TEXT NOT NULL,
      title TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL
    );
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, data TEXT NOT NULL);
    CREATE TABLE part (
      id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL, data TEXT NOT NULL
    );
  `);
  const now = Date.now();
  const sessions = [
    { id: "ses_here", directory: sessionDir, turns: ["Please build the project.", "Now run the tests too."] },
    { id: "ses_elsewhere", directory: "/somewhere/else", turns: ["An unrelated secret plan."] },
  ];
  db.prepare("INSERT INTO project (id, worktree) VALUES ('p1', ?)").run(repoDir);
  for (const session of sessions) {
    db.prepare(
      "INSERT INTO session (id, project_id, directory, title, time_created, time_updated) VALUES (?, 'p1', ?, ?, ?, ?)",
    ).run(session.id, session.directory, session.id, now, now);
    session.turns.forEach((text, index) => {
      const turns = [
        { id: `${session.id}_u${index}`, role: "user", parts: [{ type: "text", text }] },
        {
          id: `${session.id}_a${index}`,
          role: "assistant",
          parts: [
            { type: "text", text: `Done: ${text}` },
            {
              type: "tool",
              tool: "bash",
              state: { status: "completed", input: { command: "make build" }, output: "ok" },
            },
          ],
        },
      ];
      turns.forEach((turn, offset) => {
        const at = now + index * 10 + offset;
        db.prepare("INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)").run(
          turn.id,
          session.id,
          at,
          JSON.stringify({ role: turn.role }),
        );
        turn.parts.forEach((part, partIndex) => {
          db.prepare("INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)").run(
            `${turn.id}_p${partIndex}`,
            turn.id,
            session.id,
            at,
            JSON.stringify(part),
          );
        });
      });
    });
  }
  db.close();
  return path.join(store, "opencode.db");
}

function analyze(dir, home, env = {}, extraArgs = []) {
  return spawnSync(
    process.execPath,
    [
      CLI,
      "analyze",
      "--harness",
      "opencode",
      "--since",
      "all",
      "--analysis-agent",
      "pi",
      "--jobs",
      "1",
      "--json",
      ...extraArgs,
    ],
    {
      cwd: dir,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
        BACKPASS_ACPX_BIN: fakeAcpx,
        NO_COLOR: "1",
        ...env,
      },
      encoding: "utf8",
      timeout: 20000,
    },
  );
}

test("a SQLite session's escape hatch is a file of its own events, removed after the call", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-sqlite-raw-home-"));
  const dir = initRepo();
  const database = writeStore(home, dir);
  const result = analyze(dir, home);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.equal(JSON.parse(result.stdout).summary.analyzed, 1);

  const seen = JSON.parse(fs.readFileSync(seenLog, "utf8"));
  assert.notEqual(seen.rawPath, database, "the footer never names the whole database");
  assert.equal(path.dirname(seen.rawPath), path.join(dir, ".backpass", "raw"));
  assert.equal(seen.exists, true, "the file is there for the length of the call");
  if (process.platform !== "win32") assert.equal(seen.mode, 0o600);
  const [header, ...events] = seen.lines;
  assert.deepEqual(header, { harness: "opencode", session: "ses_here", model: null });
  assert.deepEqual(
    events.filter((event) => event.kind === "message" && event.role === "user").map((event) => event.text),
    ["Please build the project.", "Now run the tests too."],
  );
  assert.ok(!JSON.stringify(seen.lines).includes("unrelated secret"), "no other session reaches the agent");
  assert.equal(fs.existsSync(seen.rawPath), false, "the file is removed once the call has returned");

  fs.rmSync(seenLog);
  fs.rmdirSync(path.dirname(seen.rawPath));
  const cached = analyze(dir, home);
  assert.equal(cached.status, 0, `${cached.stdout}${cached.stderr}`);
  assert.equal(JSON.parse(cached.stdout).summary.cached, 1);
  assert.equal(fs.existsSync(seenLog), false);
  assert.equal(fs.existsSync(path.dirname(seen.rawPath)), false);
});

for (const signal of ["SIGINT", "SIGTERM", "SIGKILL"]) {
  for (const nested of [false, true]) {
    test(
      `a SQLite raw file is ${signal === "SIGKILL" ? "retained" : "removed"} when ${nested ? "nested" : "root"} analysis receives ${signal}`,
      { skip: process.platform === "win32" },
      () => {
        const home = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-sqlite-raw-home-"));
        const dir = initRepo();
        const sessionDir = nested ? path.join(dir, "apps", "api") : dir;
        if (nested) {
          fs.mkdirSync(sessionDir, { recursive: true });
          fs.writeFileSync(path.join(sessionDir, "AGENTS.md"), "# API instructions\n\n- Run API tests.\n");
          fs.writeFileSync(
            path.join(dir, ".backpassrc.json"),
            JSON.stringify({ nestedMemoryFiles: ["apps/api/AGENTS.md"] }),
          );
        }
        const database = writeStore(home, dir, sessionDir);
        fs.rmSync(seenLog, { force: true });
        const result = analyze(dir, home, {
          RAW_TEST_SIGNAL: signal,
          RAW_TEST_SIGNAL_MATCH: nested ? path.join(".backpass", "nested") : "",
        });
        if (signal === "SIGKILL") {
          assert.equal(result.signal, "SIGKILL", `${result.stdout}${result.stderr}`);
        } else {
          assert.equal(result.status, signal === "SIGINT" ? 130 : 143, `${result.stdout}${result.stderr}`);
        }
        const seen = JSON.parse(fs.readFileSync(seenLog, "utf8"));
        assert.equal(seen.exists, true);
        assert.equal(seen.rawPath.includes(path.join(".backpass", "nested")), nested);
        if (signal === "SIGKILL") {
          assert.equal(fs.existsSync(seen.rawPath), true, "SIGKILL cannot run exit cleanup");
          const activeFile = path.join(path.dirname(seen.rawPath), `${process.pid}-${randomUUID()}.jsonl`);
          fs.writeFileSync(activeFile, "live analysis events\n", { mode: 0o600 });
          fs.utimesSync(activeFile, new Date(0), new Date(0));
          fs.rmSync(database);
          const recovered = analyze(dir, home);
          assert.equal(recovered.status, 0, `${recovered.stdout}${recovered.stderr}`);
          assert.equal(JSON.parse(recovered.stdout).summary, null);
          assert.equal(fs.readFileSync(activeFile, "utf8"), "live analysis events\n");
        }
        assert.equal(fs.existsSync(seen.rawPath), signal === "SIGKILL", "only catchable exits can clean up safely");
      },
    );
  }
}

test("cached analysis leaves other runs' raw files alone", { skip: process.platform === "win32" }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-sqlite-raw-home-"));
  const dir = initRepo();
  writeStore(home, dir);
  const initial = analyze(dir, home);
  assert.equal(initial.status, 0, `${initial.stdout}${initial.stderr}`);
  const killed = analyze(dir, home, { RAW_TEST_SIGNAL: "SIGKILL" }, ["--force"]);
  assert.equal(killed.signal, "SIGKILL", `${killed.stdout}${killed.stderr}`);
  const seen = JSON.parse(fs.readFileSync(seenLog, "utf8"));
  assert.equal(fs.existsSync(seen.rawPath), true);
  fs.rmSync(seenLog);
  const cached = analyze(dir, home);
  assert.equal(cached.status, 0, `${cached.stdout}${cached.stderr}`);
  assert.equal(JSON.parse(cached.stdout).summary.cached, 1);
  assert.equal(fs.existsSync(seenLog), false, "a cache hit must not require another model call");
  assert.equal(fs.existsSync(seen.rawPath), true);
});

test("analysis preserves another namespace's root and nested raw files with the same PID", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-sqlite-raw-home-"));
  const dir = initRepo();
  const preload = path.join(binDir, "shared-pid.mjs");
  const liveLog = path.join(binDir, "live-files.json");
  fs.writeFileSync(
    preload,
    `import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
if (process.argv[1] === ${JSON.stringify(CLI)}) {
  const files = ["raw", "nested/previous/raw"].map((subdir) => {
    const rawDir = path.join(process.cwd(), ".backpass", subdir);
    fs.mkdirSync(rawDir, { recursive: true });
    const file = path.join(rawDir, process.pid + "-" + randomUUID() + ".jsonl");
    fs.writeFileSync(file, "live analysis events\\n", { mode: 0o600 });
    return file;
  });
  fs.writeFileSync(${JSON.stringify(liveLog)}, JSON.stringify(files));
}
`,
  );
  const result = analyze(dir, home, {
    NODE_OPTIONS: `${process.env.NODE_OPTIONS || ""} --import=${JSON.stringify(pathToFileURL(preload).href)}`,
  });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.equal(JSON.parse(result.stdout).summary, null);
  const files = JSON.parse(fs.readFileSync(liveLog, "utf8"));
  assert.equal(files.length, 2);
  for (const file of files) {
    assert.equal(fs.existsSync(file), true, `same-PID analysis deleted ${file}`);
    assert.equal(fs.readFileSync(file, "utf8"), "live analysis events\n");
  }
});

for (const nested of [false, true]) {
  test(`concurrent analysis preserves this process's active ${nested ? "nested" : "root"} raw file`, async (t) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-sqlite-raw-home-"));
    const dir = initRepo();
    const database = writeStore(home, dir);
    t.mock.method(os, "homedir", () => home);
    const rootStateDir = path.join(dir, ".backpass");
    const stateDir = nested ? path.join(rootStateDir, "nested", "active") : rootStateDir;
    const state = new State(dir, { stateDir: path.relative(process.cwd(), stateDir), exclude: false }).ensure();
    let activeFile;
    const summary = await analyzeTranscripts({
      transcripts: [{ harness: "opencode", id: "ses_here", nativeId: "ses_here", path: database }],
      memoryFile: { path: "AGENTS.md", units: [] },
      memoryHash: "test-memory",
      repo: { root: dir },
      config: {
        state,
        jobs: 1,
        discovery: { minUserTurns: 2 },
        agents: {
          resolve: async () => ({ agent: "pi" }),
          withFallthrough: async () => {
            const files = fs.readdirSync(path.join(stateDir, "raw"));
            assert.equal(files.length, 1);
            activeFile = path.join(stateDir, "raw", files[0]);
            const before = fs.readFileSync(activeFile, "utf8");
            for (const root of [rootStateDir, stateDir, state.root]) {
              const concurrent = await analyzeTranscripts({
                transcripts: [],
                memoryFile: { path: "AGENTS.md", units: [] },
                memoryHash: "test-memory",
                repo: { root: dir },
                config: { state: new State(dir, { stateDir: root, exclude: false }), jobs: 1 },
              });
              assert.equal(concurrent.total, 0);
              assert.equal(fs.readFileSync(activeFile, "utf8"), before);
            }
            return { text: JSON.stringify({ positive: [], negative: [], gaps: [] }) };
          },
        },
      },
    });
    assert.equal(summary.analyzed, 1);
    assert.equal(summary.failed, 0);
    assert.ok(activeFile);
    assert.equal(fs.existsSync(activeFile), false);
  });
}

test("trivial SQLite sessions never materialize raw events", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-sqlite-raw-home-"));
  const dir = initRepo();
  writeStore(home, dir);
  fs.writeFileSync(path.join(dir, ".backpassrc.json"), JSON.stringify({ discovery: { minUserTurns: 3 } }));
  fs.rmSync(seenLog, { force: true });
  const result = analyze(dir, home);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.equal(JSON.parse(result.stdout).summary.skipped, 2);
  assert.equal(fs.existsSync(seenLog), false);
  assert.equal(fs.existsSync(path.join(dir, ".backpass", "raw")), false);
});

test("a SQLite raw file is removed when the analysis response is invalid", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-sqlite-raw-home-"));
  const dir = initRepo();
  writeStore(home, dir);
  fs.rmSync(seenLog, { force: true });
  const result = analyze(dir, home, { RAW_TEST_INVALID: "1" });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.equal(JSON.parse(result.stdout).summary.failed, 1);
  const seen = JSON.parse(fs.readFileSync(seenLog, "utf8"));
  assert.equal(fs.existsSync(seen.rawPath), false);
});
