import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authoredSkills, curateSkills, curatorFindings, proposeAuthoredSkill, renderSkillMarkdown, runSkillCurator, validateSkillDraft, writeAuthoredSkill } from "./skill-author.js";
import { discoverSkills, readSkill } from "./skills.js";
import { decideAction, listActions } from "./actions.js";
import { executeOwnTool, ownToolsFor } from "./own-tools.js";
import { ChatStore } from "./chats.js";
import { consolidatePreferences } from "./heartbeat.js";
import { readActivity } from "./activity.js";

function freshRoot(): string { return mkdtempSync(join(tmpdir(), "sam-skill-author-")); }
const GOOD = {
  name: "stack-check",
  description: "Check the frozen stack counts and report what changed",
  instructions: "Steps: read the stack health first. Then compare the candidate count and the newest timestamp against the last recorded values. Report only what changed, with the numbers beside the claim.",
};
function placeSkill(root: string, folder: string, dir: string, name: string, description: string, body: string): void {
  const target = join(root, folder, dir);
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, "SKILL.md"), renderSkillMarkdown({ name, description, instructions: body }));
}
const BODY_A = "First gather the evidence from the source system. Then compare it against the previous record. Then write down only the differences, each with its number attached so the reader can check it.";
const BODY_B = "Open the ledger and total the entries for the day. Cross-check the total against the receipts folder. If the two disagree, list every entry that appears in one place but not the other.";
const BODY_C = "Walk the garden beds in order and note which rows were watered. Check the rain gauge by the fence. Write the date beside each bed that still looks dry so the next visit starts there.";
const BODY_D = "Tune the instrument to the reference pitch first. Play each string alone and listen for beats. Adjust in small turns, resting between passes, and stop when the beats disappear entirely.";

test("skill author: validation refuses bad shapes and secrets before anything is written", () => {
  const root = freshRoot();
  try {
    assert.throws(() => validateSkillDraft({ ...GOOD, name: "Bad Name" }), /Invalid skill name/);
    assert.throws(() => validateSkillDraft({ ...GOOD, description: "Too short" }), /Invalid skill description/);
    assert.throws(() => validateSkillDraft({ ...GOOD, instructions: "Too short." }), /Invalid skill instructions/);
    assert.throws(() => validateSkillDraft({ ...GOOD, instructions: "x".repeat(3201) }), /Invalid skill instructions/);
    const fakeKey = "sk" + "_live_" + "1234567890abcdef";
    assert.throws(() => validateSkillDraft({ ...GOOD, instructions: GOOD.instructions + " Use api_key = " + fakeKey + " to connect." }), /credential/);
    assert.throws(() => validateSkillDraft({ ...GOOD, instructions: GOOD.instructions + "\n-----BEGIN RSA PRIVATE KEY-----\nabc" }), /private key/);
    assert.equal(discoverSkills(root).length, 0);
    assert.equal(authoredSkills(root).length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("skill author: a draft rides the one gate and writes only on approval", async () => {
  const root = freshRoot();
  try {
    const r = proposeAuthoredSkill(root, { actor: "sam", ...GOOD });
    assert.equal(r.status, "pending_owner_approval");
    assert.equal(r.patch, false);
    // Nothing on disk yet; exactly one pending skill-author proposal.
    assert.equal(discoverSkills(root).length, 0);
    assert.equal(existsSync(join(root, ".agents", "skills", GOOD.name)), false);
    const pending = listActions(root).filter(a => a.status === "pending" && a.kind === "skill-author");
    assert.equal(pending.length, 1);
    assert.equal(readActivity(root, 10, { kind: "skill-gated" }).length, 1);
    const decided = await decideAction(root, r.proposal.id, true);
    assert.equal(decided.status, "done");
    assert.match(decided.result ?? "", /Authored skill stack-check \(v1\)/);
    // Discoverable and readable through the same doors every skill uses.
    const found = discoverSkills(root).find(s => s.name === GOOD.name);
    assert.ok(found);
    assert.equal(found.description, GOOD.description);
    assert.match(readSkill(root, GOOD.name).instructions, /read the stack health first/);
    const provenance = authoredSkills(root);
    assert.equal(provenance.length, 1);
    assert.equal(provenance[0].source, "sam-authored");
    assert.equal(provenance[0].version, 1);
    assert.equal(readActivity(root, 10, { kind: "skill-authored" }).length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("skill author: rejection writes nothing, and a patch of an authored skill bumps its version", async () => {
  const root = freshRoot();
  try {
    const first = proposeAuthoredSkill(root, { actor: "sam", ...GOOD });
    const rejected = await decideAction(root, first.proposal.id, false);
    assert.equal(rejected.status, "rejected");
    assert.equal(discoverSkills(root).length, 0);
    // Direct operator write (the CLI author path), then a gated patch.
    const record = writeAuthoredSkill(root, GOOD, { actor: "operator" });
    assert.equal(record.version, 1);
    const patch = proposeAuthoredSkill(root, { actor: "sam", ...GOOD, instructions: GOOD.instructions + " Also name the previous value beside the new one." });
    assert.equal(patch.patch, true);
    const decided = await decideAction(root, patch.proposal.id, true);
    assert.equal(decided.status, "done");
    assert.equal(authoredSkills(root)[0].version, 2);
    assert.match(readSkill(root, GOOD.name).instructions, /name the previous value/);
    assert.equal(readActivity(root, 10, { kind: "skill-patched" }).length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("skill author: SAM can never overwrite a skill it did not author", async () => {
  const root = freshRoot();
  try {
    placeSkill(root, ".agents/skills", "hand-placed", "hand-placed", "A hand placed skill for testing the fence", BODY_A);
    assert.throws(() => proposeAuthoredSkill(root, { actor: "sam", name: "hand-placed", description: GOOD.description, instructions: GOOD.instructions }), /not authored by SAM/);
    assert.throws(() => writeAuthoredSkill(root, { name: "hand-placed", description: GOOD.description, instructions: GOOD.instructions }, { actor: "operator" }), /not authored by SAM/);
    assert.equal(listActions(root).filter(a => a.kind === "skill-author").length, 0);
    // The hand-placed skill is untouched.
    assert.match(readSkill(root, "hand-placed").instructions, /gather the evidence/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("skill author: the chat tool gates the draft and refuses visitors", () => {
  const root = freshRoot();
  try {
    const db = new ChatStore(root);
    const ownerChat = db.create("owner chat");
    const visitorChat = db.create("visitor chat", null, { visitor: true });
    db.close();
    const drafted = executeOwnTool(root, "sam", "sam_author_skill", { ...GOOD }, ownerChat.id) as { status: string; patch: boolean; note: string };
    assert.equal(drafted.status, "pending_owner_approval");
    assert.equal(drafted.patch, false);
    assert.match(drafted.note, /NOT written yet/);
    assert.equal(discoverSkills(root).length, 0);
    const visitor = executeOwnTool(root, "sam", "sam_author_skill", { ...GOOD, name: "visitor-skill" }, visitorChat.id) as { error: string };
    assert.match(visitor.error, /Visitors cannot author skills/);
    const names = ownToolsFor(root).map(t => (t as { function: { name: string } }).function.name);
    assert.ok(names.includes("sam_author_skill"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("skill curator: flags duplicate content, near-duplicate descriptions, shadowing, orphans, and unmatchable descriptions", () => {
  const root = freshRoot();
  try {
    placeSkill(root, ".agents/skills", "web-one", "web-one", "Check the public web for current facts and sources", BODY_A);
    placeSkill(root, ".agents/skills", "web-two", "web-two", "Morning bakery run checklist for the corner shop", BODY_A);
    placeSkill(root, ".agents/skills", "deploy-one", "deploy-one", "Verify deployment status by reading the live dashboard and logs", BODY_B);
    placeSkill(root, ".agents/skills", "deploy-two", "deploy-two", "Verify deployment status by reading the live dashboard and logs today", BODY_A + " Extra step at the end.");
    placeSkill(root, ".agents/skills", "dup", "dup", "The first copy of the duplicated skill", BODY_C);
    placeSkill(root, "skills", "dup", "dup", "The shadowed second copy of this skill", BODY_C);
    placeSkill(root, ".agents/skills", "tiny", "tiny", "Tiny", BODY_D);
    mkdirSync(join(root, ".sam"), { recursive: true });
    writeFileSync(join(root, ".sam", "skill-installs.json"), JSON.stringify([{ name: "ghost-skill", source: "owner/repo", ref: "owner/repo", files: 1, installedAt: "2026-11-01T00:00:00Z", actor: "operator" }]));
    const findings = curateSkills(root);
    const kinds = new Set(findings.map(f => f.kind));
    assert.ok(kinds.has("duplicate-content"), JSON.stringify(findings));
    assert.ok(kinds.has("duplicate-description"));
    assert.ok(kinds.has("shadowed"));
    assert.ok(kinds.has("orphaned-provenance"));
    assert.ok(kinds.has("unmatchable-description"));
    for (const f of findings) assert.ok(f.suggestedPatch.length > 10, f.kind);
    const dupContent = findings.find(f => f.kind === "duplicate-content");
    assert.deepEqual(dupContent?.skills, ["web-one", "web-two"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("skill curator: a clean library flags nothing, and a changed finding set ledgers once", () => {
  const root = freshRoot();
  try {
    assert.deepEqual(curateSkills(root), []);
    const clean = runSkillCurator(root);
    assert.equal(clean.findings.length, 0);
    placeSkill(root, ".agents/skills", "web-one", "web-one", "Check the public web for current facts and sources", BODY_A);
    placeSkill(root, ".agents/skills", "web-two", "web-two", "Morning bakery run checklist for the corner shop", BODY_A);
    const first = runSkillCurator(root);
    assert.equal(first.changed, true);
    assert.equal(first.findings.length, 1);
    const second = runSkillCurator(root);
    assert.equal(second.changed, false);
    assert.equal(curatorFindings(root).length, 1);
    assert.equal(readActivity(root, 10, { kind: "skill-curator" }).length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("skill curator: heartbeat consolidation carries the curator pass", () => {
  const root = freshRoot();
  try {
    placeSkill(root, ".agents/skills", "web-one", "web-one", "Check the public web for current facts and sources", BODY_A);
    placeSkill(root, ".agents/skills", "web-two", "web-two", "Morning bakery run checklist for the corner shop", BODY_A);
    const result = consolidatePreferences(root);
    assert.deepEqual(result.curator, ["duplicate-content:web-one+web-two"]);
    assert.equal(curatorFindings(root).length, 1);
    const log = readFileSync(join(root, ".sam", "heartbeats.jsonl"), "utf8");
    assert.match(log, /"curator":\["duplicate-content:web-one\+web-two"\]/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
