import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readActivity } from "./activity.js";
import { openDatabase } from "./sqlite.js";
import {
  installSkill, installedSkills, isSkillInstallsStoreLedgered, parseSkillRef,
  removeInstalledSkill, skillInstallsStoreFailureSummary, updateInstalledSkill,
  type InstalledSkill,
} from "./skill-registry.js";
import { classifyDefect } from "./self-work.js";

// Skill installs store failure visibility (gap found
// 2026-11-15, hourly run 21:04): the skill installs store
// (.sam/skill-installs.db) is the registry provenance
// registry - installedSkills rides status.ts (dashboard
// status, CLI overview), the CLI skills verbs, and the
// skill curator; the row writes ride installSkill (the
// ONE gate's installs), updateInstalledSkill, and
// removeInstalledSkill - and every touch opened it raw:
// a dead skill-installs.db threw into whichever catch
// wrapped the call, none naming the store. Each touch
// now ledgers ONE skill-installs-store-failed line
// (phase read / write) and rethrows exactly, tagged;
// every caller's handling is unchanged and reads still
// fail closed (never folded as no installs, which would
// silently empty the provenance registry dressed as a
// fresh install).
const realFetch = globalThis.fetch;
const ALPHA_MD = "---\nname: alpha-skill\ndescription: Alpha test skill\n---\n\nAlpha instructions.\n";
const TREE = { truncated: false, tree: [
  { path: "skills/alpha/SKILL.md", type: "blob", size: 80 },
  { path: "skills/alpha/references/guide.md", type: "blob", size: 10 },
] };
const RAW: Record<string, string> = {
  "skills/alpha/SKILL.md": ALPHA_MD,
  "skills/alpha/references/guide.md": "guide text",
};
function jsonRes(body: unknown): Response { return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } }); }

before(() => {
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    if (url.includes("api.github.com/repos/acme/widgets/git/trees")) return jsonRes(TREE);
    const rawPrefix = "https://raw.githubusercontent.com/acme/widgets/HEAD/";
    if (url.startsWith(rawPrefix)) { const body = RAW[url.slice(rawPrefix.length)]; return body === undefined ? new Response("nope", { status: 404 }) : new Response(body, { status: 200 }); }
    return new Response("unexpected " + url, { status: 500 });
  }) as typeof fetch;
});
after(() => { globalThis.fetch = realFetch; });

function fresh(): { base: string; sam: string } {
  const base = mkdtempSync(join(tmpdir(), "sam-skill-installs-fail-"));
  const sam = join(base, "home");
  mkdirSync(sam, { recursive: true });
  return { base, sam };
}

function legacySkill(name: string, source: string): InstalledSkill {
  return { name, source, ref: source + "@" + name, files: 2, installedAt: "2026-11-10T13:13:29.115Z", actor: "dip" };
}

function seed(root: string, records: InstalledSkill[]): void {
  mkdirSync(join(root, ".sam"), { recursive: true });
  writeFileSync(join(root, ".sam", "skill-installs.json"), JSON.stringify(records, null, 2));
  assert.deepEqual(installedSkills(root).map(s => s.name), records.map(s => s.name));
}

function failedLines(root: string) {
  return readActivity(root, 100, { kind: "skill-installs-store-failed" });
}

function plantDeadStore(root: string): void {
  rmSync(join(root, ".sam", "skill-installs.db"), { force: true });
  mkdirSync(join(root, ".sam", "skill-installs.db"), { recursive: true });
}

test("skill-installs-store-failed: summary shapes collapse and cap the reason, and self-work classifies by phase", () => {
  assert.equal(skillInstallsStoreFailureSummary("read", "unable to open\n  database   file"), "Skill installs store read failed: unable to open database file");
  assert.equal(skillInstallsStoreFailureSummary("write", "disk gone"), "Skill installs store write failed: disk gone");
  assert.equal(skillInstallsStoreFailureSummary("write", "x".repeat(500)).length, 200);
  for (const phase of ["read", "write"] as const) {
    assert.deepEqual(
      classifyDefect({ at: "", actor: "sam", kind: "skill-installs-store-failed", summary: skillInstallsStoreFailureSummary(phase, "boom") }),
      { key: "skill-installs-store-failed:" + phase, label: "skill installs store failures (" + phase + " step)" },
    );
  }
});

test("skill-installs-store-failed: a healthy install, read, update, and remove round trip ledgers no failure line", async () => {
  const { base, sam } = fresh();
  try {
    const out = await installSkill(sam, "acme/widgets@alpha-skill", { actor: "sam" });
    assert.deepEqual(out.installed.map(s => s.name), ["alpha-skill"]);
    assert.deepEqual(installedSkills(sam).map(s => s.name), ["alpha-skill"]);
    const updated = updateInstalledSkill(sam, "alpha-skill", { files: 9 });
    assert.equal(updated?.files, 9);
    assert.equal(installedSkills(sam)[0].files, 9);
    assert.equal(removeInstalledSkill(sam, "alpha-skill"), true);
    assert.deepEqual(installedSkills(sam), []);
    assert.equal(failedLines(sam).length, 0);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("skill-installs-store-failed: an absent store reads as no installs, creates nothing, and ledgers nothing", () => {
  const { base, sam } = fresh();
  try {
    assert.deepEqual(installedSkills(sam), []);
    assert.equal(updateInstalledSkill(sam, "nope", { files: 9 }), null);
    assert.equal(removeInstalledSkill(sam, "nope"), false);
    assert.equal(failedLines(sam).length, 0, "nothing failed, so nothing ledgers");
    assert.equal(existsSync(join(sam, ".sam")), false, "a pure read creates nothing, not even the .sam directory");
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("skill-installs-store-failed: a torn row still parses forgiving and ledgers nothing", () => {
  const { base, sam } = fresh();
  try {
    seed(sam, [legacySkill("webclaw", "0xmassi/webclaw-skill")]);
    const db = openDatabase(join(sam, ".sam", "skill-installs.db"));
    try { db.prepare("INSERT INTO skill_installs (name, data) VALUES (?, ?)").run("torn-1", "{ not json"); } finally { db.close(); }
    assert.deepEqual(installedSkills(sam).map(s => s.name), ["webclaw"], "the torn row is skipped, the real record still reads");
    assert.equal(failedLines(sam).length, 0);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("skill-installs-store-failed: a dead store ledgers exactly one line per touch, tagged, rethrows, and carries no install content", async () => {
  const { base, sam } = fresh();
  try {
    seed(sam, [legacySkill("zorblax", "secret-owner/zorblax-skill")]);
    plantDeadStore(sam);

    assert.throws(() => installedSkills(sam), (e: unknown) => isSkillInstallsStoreLedgered(e));
    let lines = failedLines(sam);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].actor, "sam");
    assert.ok(lines[0].summary.startsWith("Skill installs store read failed: "), lines[0].summary);
    assert.deepEqual(classifyDefect(lines[0]), { key: "skill-installs-store-failed:read", label: "skill installs store failures (read step)" });

    assert.throws(() => updateInstalledSkill(sam, "zorblax", { files: 9 }), (e: unknown) => isSkillInstallsStoreLedgered(e));
    lines = failedLines(sam);
    assert.equal(lines.length, 2, "the update door's inner read touch ledgers exactly one line, never two for one touch");
    assert.ok(lines[1].summary.startsWith("Skill installs store read failed: "), lines[1].summary);

    assert.throws(() => removeInstalledSkill(sam, "zorblax"), (e: unknown) => isSkillInstallsStoreLedgered(e));
    lines = failedLines(sam);
    assert.equal(lines.length, 3, "the remove door's inner read touch ledgers exactly one line, never two for one touch");
    assert.ok(lines[2].summary.startsWith("Skill installs store read failed: "), lines[2].summary);

    await assert.rejects(() => installSkill(sam, "acme/widgets@alpha-skill", { actor: "sam" }), (e: unknown) => isSkillInstallsStoreLedgered(e));
    lines = failedLines(sam);
    assert.equal(lines.length, 4, "an install on a dead store dies at its insert touch with exactly one line");
    assert.ok(lines[3].summary.startsWith("Skill installs store write failed: "), lines[3].summary);

    assert.ok(!JSON.stringify(lines).includes("zorblax"), "no install record ever enters a failure line");
    assert.ok(!JSON.stringify(lines).includes("alpha-skill"), "no install record ever enters a failure line");
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("skill-installs-store-failed: validation errors are not store failures and ledger nothing", async () => {
  const { base, sam } = fresh();
  try {
    assert.throws(() => parseSkillRef("not a ref!!"), (e: unknown) => /Skill reference must look like/.test((e as Error).message) && !isSkillInstallsStoreLedgered(e));
    await assert.rejects(() => installSkill(sam, "not a ref!!", { actor: "sam" }), (e: unknown) => /Skill reference must look like/.test((e as Error).message) && !isSkillInstallsStoreLedgered(e));
    assert.equal(updateInstalledSkill(sam, "", { files: 9 }), null);
    assert.equal(failedLines(sam).length, 0);
    assert.equal(existsSync(join(sam, ".sam", "skill-installs.db")), false, "no validation refusal created the store");
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("skill-installs-store-failed: a failing insert ledgers exactly one write line with the verbatim reason", async () => {
  const { base, sam } = fresh();
  try {
    seed(sam, [legacySkill("webclaw", "0xmassi/webclaw-skill")]);
    const raw = openDatabase(join(sam, ".sam", "skill-installs.db"));
    try {
      raw.exec("CREATE TRIGGER planted_insert_fail BEFORE INSERT ON skill_installs BEGIN SELECT RAISE(ABORT, 'planted insert failure'); END;");
    } finally { raw.close(); }
    await assert.rejects(() => installSkill(sam, "acme/widgets@alpha-skill", { actor: "sam" }), (e: unknown) => isSkillInstallsStoreLedgered(e));
    const lines = failedLines(sam);
    assert.equal(lines.length, 1, "the insert touch ledgers exactly one line");
    assert.ok(lines[0].summary.startsWith("Skill installs store write failed: "), lines[0].summary);
    assert.ok(lines[0].summary.includes("planted insert failure"), lines[0].summary);
    assert.deepEqual(classifyDefect(lines[0]), { key: "skill-installs-store-failed:write", label: "skill installs store failures (write step)" });
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("skill-installs-store-failed: failing update and delete touches each ledger exactly one write line with the verbatim reason", () => {
  const { base, sam } = fresh();
  try {
    seed(sam, [legacySkill("zorblax", "secret-owner/zorblax-skill")]);
    const raw = openDatabase(join(sam, ".sam", "skill-installs.db"));
    try {
      raw.exec("CREATE TRIGGER planted_update_fail BEFORE UPDATE ON skill_installs BEGIN SELECT RAISE(ABORT, 'planted update failure'); END;");
    } finally { raw.close(); }
    assert.throws(() => updateInstalledSkill(sam, "zorblax", { files: 9 }), (e: unknown) => isSkillInstallsStoreLedgered(e));
    let lines = failedLines(sam);
    assert.equal(lines.length, 1, "the update touch ledgers exactly one line");
    assert.ok(lines[0].summary.startsWith("Skill installs store write failed: "), lines[0].summary);
    assert.ok(lines[0].summary.includes("planted update failure"), lines[0].summary);
    assert.ok(!lines[0].summary.includes("zorblax"), "no install record ever enters a failure line");

    const raw2 = openDatabase(join(sam, ".sam", "skill-installs.db"));
    try {
      raw2.exec("DROP TRIGGER planted_update_fail;");
      raw2.exec("CREATE TRIGGER planted_delete_fail BEFORE DELETE ON skill_installs BEGIN SELECT RAISE(ABORT, 'planted delete failure'); END;");
    } finally { raw2.close(); }
    assert.throws(() => removeInstalledSkill(sam, "zorblax"), (e: unknown) => isSkillInstallsStoreLedgered(e));
    lines = failedLines(sam);
    assert.equal(lines.length, 2, "the delete touch ledgers exactly one more line");
    assert.ok(lines[1].summary.startsWith("Skill installs store write failed: "), lines[1].summary);
    assert.ok(lines[1].summary.includes("planted delete failure"), lines[1].summary);
  } finally { rmSync(base, { recursive: true, force: true }); }
});
