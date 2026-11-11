import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installedSkills, installSkill, removeInstalledSkill, updateInstalledSkill, type InstalledSkill } from "./skill-registry.js";
import { discoverSkills } from "./skills.js";

// State convergence (UNIFICATION item 4, twentieth store): the skill
// provenance registry migrated from whole-file skill-installs.json
// rewrites to one-row-per-skill SQLite. These tests pin the migration
// contract: legacy files import in order with every field intact, are
// renamed (never deleted), a malformed file imports nothing and stays
// put, a pure read creates nothing, single-row mutations cannot lose
// each other, and a remove over a migrated legacy record persists (the
// resurrection shape).

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

function fresh(): string { return mkdtempSync(join(tmpdir(), "sam-skill-installs-store-")); }

function legacySkill(name: string, source: string): InstalledSkill {
  return { name, source, ref: source + "@" + name, files: 2, installedAt: "2026-11-10T13:13:29.115Z", actor: "dip" };
}

test("skill installs store: a legacy skill-installs.json imports in order, fields intact, file renamed not deleted", async () => {
  const root = fresh();
  try {
    mkdirSync(join(root, ".sam"), { recursive: true });
    const first = legacySkill("webclaw", "0xmassi/webclaw-skill");
    const second = legacySkill("git-commit", "github/awesome-copilot");
    writeFileSync(join(root, ".sam", "skill-installs.json"), JSON.stringify([first, second], null, 2));
    const items = installedSkills(root);
    assert.deepEqual(items.map(s => s.name), [first.name, second.name]);
    assert.deepEqual(items[0], first);
    assert.deepEqual(items[1], second);
    assert.equal(existsSync(join(root, ".sam", "skill-installs.db")), true);
    assert.equal(existsSync(join(root, ".sam", "skill-installs.json")), false);
    assert.equal(existsSync(join(root, ".sam", "skill-installs.json.migrated")), true);
    const kept = JSON.parse(readFileSync(join(root, ".sam", "skill-installs.json.migrated"), "utf8")) as unknown[];
    assert.equal(kept.length, 2);
    const out = await installSkill(root, "acme/widgets@alpha-skill", { actor: "sam" });
    assert.deepEqual(out.installed.map(s => s.name), ["alpha-skill"]);
    assert.deepEqual(installedSkills(root).map(s => s.name), [first.name, second.name, "alpha-skill"]);
    assert.equal(existsSync(join(root, ".sam", "skill-installs.json")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("skill installs store: a malformed legacy file imports nothing and is left in place", async () => {
  const root = fresh();
  try {
    mkdirSync(join(root, ".sam"), { recursive: true });
    writeFileSync(join(root, ".sam", "skill-installs.json"), "{ not json");
    assert.deepEqual(installedSkills(root), []);
    assert.equal(existsSync(join(root, ".sam", "skill-installs.json")), true);
    assert.equal(existsSync(join(root, ".sam", "skill-installs.json.migrated")), false);
    writeFileSync(join(root, ".sam", "skill-installs.json"), JSON.stringify({ name: "x" }));
    assert.deepEqual(installedSkills(root), []);
    assert.equal(existsSync(join(root, ".sam", "skill-installs.json.migrated")), false);
    const out = await installSkill(root, "acme/widgets@alpha-skill", { actor: "sam" });
    assert.deepEqual(out.installed.map(s => s.name), ["alpha-skill"]);
    assert.deepEqual(installedSkills(root).map(s => s.name), ["alpha-skill"]);
    assert.equal(existsSync(join(root, ".sam", "skill-installs.json")), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("skill installs store: a pure read on an empty install creates nothing", () => {
  const root = fresh();
  try {
    assert.deepEqual(installedSkills(root), []);
    assert.equal(updateInstalledSkill(root, "nope", { files: 9 }), null);
    assert.equal(removeInstalledSkill(root, "nope"), false);
    assert.equal(existsSync(join(root, ".sam", "skill-installs.db")), false);
    assert.equal(existsSync(join(root, ".sam", "skill-installs.json")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("skill installs store: interleaved install, update, and remove all survive (no whole-file lost update)", async () => {
  const root = fresh();
  try {
    const a = await installSkill(root, "acme/widgets@alpha-skill", { actor: "sam" });
    assert.equal(a.installed.length, 1);
    mkdirSync(join(root, ".sam"), { recursive: true });
    // A second record rides in through a legacy-shaped direct row via
    // the update door's sibling: seed by installing state through the
    // store itself is install-only, so exercise update + remove over
    // the installed record and a ghost.
    const patched = updateInstalledSkill(root, "alpha-skill", { files: 7, name: "renamed" });
    assert.equal(patched?.files, 7);
    assert.equal(patched?.name, "alpha-skill");
    assert.equal(updateInstalledSkill(root, "ghost", { files: 1 }), null);
    assert.equal(installedSkills(root)[0].files, 7);
    assert.equal(removeInstalledSkill(root, "alpha-skill"), true);
    assert.equal(removeInstalledSkill(root, "alpha-skill"), false);
    assert.deepEqual(installedSkills(root), []);
    assert.ok(!discoverSkills(root).some(s => s.name === "alpha-skill"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("skill installs store: a remove over a migrated legacy record persists in the DB (no resurrection)", async () => {
  const root = fresh();
  try {
    mkdirSync(join(root, ".sam"), { recursive: true });
    const legacy = legacySkill("docker-patterns", "affaan-m/ecc");
    writeFileSync(join(root, ".sam", "skill-installs.json"), JSON.stringify([legacy], null, 2));
    assert.deepEqual(installedSkills(root).map(s => s.name), [legacy.name]);
    assert.equal(removeInstalledSkill(root, legacy.name), true);
    assert.deepEqual(installedSkills(root), []);
    const out = await installSkill(root, "acme/widgets@alpha-skill", { actor: "operator" });
    assert.deepEqual(out.installed.map(s => s.name), ["alpha-skill"]);
    assert.deepEqual(installedSkills(root).map(s => s.name), ["alpha-skill"]);
    assert.equal(existsSync(join(root, ".sam", "skill-installs.json")), false);
    assert.equal(existsSync(join(root, ".sam", "skill-installs.db")), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
