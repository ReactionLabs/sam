import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { AgentLoopJournal } from "./agent-loop-journal.js";
import { proposeAction } from "./actions.js";
import { AssignmentLeases } from "./assignment-leases.js";
import { ChatStore } from "./chats.js";
import { MemoryStore } from "./memory.js";
import { OperativeRegistry } from "./operatives.js";
import { PreferenceStore } from "./preferences.js";
import { openDatabase, SQLITE_BUSY_TIMEOUT_MS } from "./sqlite.js";
import { MissionStore } from "./storage.js";

const repoRoot = join(new URL(".", import.meta.url).pathname, "..");
const ROUNDS = 20;

test("every SQLite connection is WAL with a busy timeout, including a second connection and a readonly one", () => {
  const dir = mkdtempSync(join(tmpdir(), "sam-sqlite-pragma-"));
  try {
    const path = join(dir, "store.db");
    const db = openDatabase(path);
    try {
      assert.equal(db.pragma("journal_mode", { simple: true }), "wal");
      assert.equal(db.pragma("busy_timeout", { simple: true }), SQLITE_BUSY_TIMEOUT_MS);
      db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, n INTEGER)");
      const wrote = db.transaction(() => {
        db.prepare("INSERT INTO t (n) VALUES (1)").run();
        return db.prepare("SELECT COUNT(*) AS n FROM t").get() as { n: number };
      })();
      assert.equal(wrote.n, 1);
      const second = openDatabase(path);
      try {
        assert.equal(second.pragma("journal_mode", { simple: true }), "wal");
        assert.equal(second.pragma("busy_timeout", { simple: true }), SQLITE_BUSY_TIMEOUT_MS);
      } finally { second.close(); }
    } finally { db.close(); }
    const readonly = openDatabase(path, { readonly: true });
    try {
      assert.equal(readonly.pragma("journal_mode", { simple: true }), "wal");
      assert.equal(readonly.pragma("busy_timeout", { simple: true }), SQLITE_BUSY_TIMEOUT_MS);
      assert.equal((readonly.prepare("SELECT COUNT(*) AS n FROM t").get() as { n: number }).n, 1);
    } finally { readonly.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("no SQLite database is opened outside openDatabase", () => {
  const src = join(repoRoot, "src");
  const needle = "new " + "Database(";
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) { walk(path); continue; }
      if (!name.endsWith(".ts") || name === "sqlite.ts") continue;
      const text = readFileSync(path, "utf8");
      if (text.includes(needle)) offenders.push(path.slice(src.length + 1));
    }
  };
  walk(src);
  assert.deepEqual(offenders, []);
});

function seed(root: string): void {
  mkdirSync(join(root, ".sam"), { recursive: true });
  const path = join(root, ".sam", "missions.db");
  const chats = new ChatStore(root); chats.close();
  const prefs = new PreferenceStore(root); prefs.close();
  proposeAction(root, { actor: "sam", kind: "note", title: "Seed", detail: "Schema seed for the lock test" });
  const mem = new MemoryStore(path); mem.close();
  const missions = new MissionStore(path); missions.close();
  const reg = new OperativeRegistry(path); reg.close();
  const leases = new AssignmentLeases(path); leases.close();
  const journal = new AgentLoopJournal(path); journal.close();
  const db = openDatabase(path);
  try { db.exec("CREATE TABLE IF NOT EXISTS hammer (id TEXT PRIMARY KEY)"); }
  finally { db.close(); }
}

function runWorker(root: string, id: string): Promise<{ code: number; out: string }> {
  const dist = new URL(".", import.meta.url);
  const worker = join(root, "worker-" + id + ".mjs");
  const imp = (file: string) => pathToFileURL(join(dist.pathname, file)).href;
  writeFileSync(worker, `
import { ChatStore } from ${JSON.stringify(imp("chats.js"))};
import { PreferenceStore } from ${JSON.stringify(imp("preferences.js"))};
import { proposeAction } from ${JSON.stringify(imp("actions.js"))};
import { MemoryStore } from ${JSON.stringify(imp("memory.js"))};
import { MissionStore } from ${JSON.stringify(imp("storage.js"))};
import { OperativeRegistry } from ${JSON.stringify(imp("operatives.js"))};
import { AssignmentLeases } from ${JSON.stringify(imp("assignment-leases.js"))};
import { AgentLoopJournal } from ${JSON.stringify(imp("agent-loop-journal.js"))};
import { openDatabase } from ${JSON.stringify(imp("sqlite.js"))};
import { join } from "node:path";
const root = process.argv[2];
const id = process.argv[3];
const rounds = Number(process.argv[4]);
const missionsPath = join(root, ".sam", "missions.db");
const counts = { chats: 0, notes: 0, actions: 0, memories: 0, missions: 0, operatives: 0, leases: 0, loops: 0, hammer: 0 };
for (let i = 0; i < rounds; i++) {
  const tag = id + "-" + i;
  const chats = new ChatStore(root);
  try { chats.create("c " + tag); counts.chats++; } finally { chats.close(); }
  const prefs = new PreferenceStore(root);
  try { prefs.note("sam", "Remember contention " + tag, "rule", "lock-test"); counts.notes++; } finally { prefs.close(); }
  proposeAction(root, { actor: "sam", kind: "note", title: "Note " + tag, detail: "Written by process " + tag });
  counts.actions++;
  const mem = new MemoryStore(missionsPath);
  try { mem.add({ kind: "observation", content: "mem " + tag, source: "lock-test" }); counts.memories++; } finally { mem.close(); }
  const missions = new MissionStore(missionsPath);
  const extra = openDatabase(missionsPath);
  try {
    missions.create("Objective " + tag);
    extra.prepare("SELECT COUNT(*) AS n FROM missions").get();
    counts.missions++;
  } finally { extra.close(); missions.close(); }
  const reg = new OperativeRegistry(missionsPath);
  let opId = "";
  try {
    const op = reg.register({ name: "op" + id + "n" + i, adapter: "local", capabilities: ["code"] });
    if (!reg.setState(op.id, "available")) throw new Error("operative did not become available");
    opId = op.id;
    counts.operatives++;
  } finally { reg.close(); }
  const leases = new AssignmentLeases(missionsPath);
  try {
    const lease = leases.claim(opId, "task-" + tag);
    if (!lease) throw new Error("lease was not claimed for " + tag);
    counts.leases++;
  } finally { leases.close(); }
  const journal = new AgentLoopJournal(missionsPath);
  try { journal.create("goal " + tag); counts.loops++; } finally { journal.close(); }
  const db = openDatabase(missionsPath);
  try {
    const tx = db.transaction(() => {
      const row = db.prepare("SELECT COUNT(*) AS n FROM hammer").get();
      db.prepare("INSERT INTO hammer (id) VALUES (?)").run(tag);
      const until = Date.now() + 8;
      while (Date.now() < until) {}
      if (!row || typeof row.n !== "number") throw new Error("hammer count missing");
    });
    tx();
    counts.hammer++;
  } finally { db.close(); }
}
process.stdout.write(JSON.stringify(counts) + "\\n");
`);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [worker, root, id, String(ROUNDS)], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { out += d; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, out }));
  });
}

test("two processes hammer the same workspace stores without a database lock", async () => {
  const root = mkdtempSync(join(tmpdir(), "sam-sqlite-lock-"));
  try {
    seed(root);
    const [a, b] = await Promise.all([runWorker(root, "a"), runWorker(root, "b")]);
    const combined = a.out + "\n" + b.out;
    assert.equal(a.code, 0, combined);
    assert.equal(b.code, 0, combined);
    assert.equal(/database is locked/i.test(combined), false, combined);
    const counts = [a, b].map((r) => JSON.parse(r.out.trim()) as Record<string, number>);
    for (const key of ["chats", "notes", "actions", "memories", "missions", "operatives", "leases", "loops", "hammer"]) {
      assert.equal(counts[0][key] + counts[1][key], ROUNDS * 2, key);
    }
    const path = join(root, ".sam", "missions.db");
    const missions = new MissionStore(path);
    try { assert.equal(missions.list().length, ROUNDS * 2); }
    finally { missions.close(); }
    const db = openDatabase(path, { readonly: true });
    try { assert.equal((db.prepare("SELECT COUNT(*) AS n FROM hammer").get() as { n: number }).n, ROUNDS * 2); }
    finally { db.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
