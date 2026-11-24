import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listActions, proposeAction } from "./actions.js";
import { readActivity } from "./activity.js";
import { parseSkillRef } from "./skill-registry.js";

// The proposal-time execution gate for kind skill: it was
// the ONLY kind with no proposal-time validation - its
// detail is a registry skill reference parsed only at
// execution, where installSkill rides fetchSkillCandidates
// into parseSkillRef, which refuses deterministically and
// locally on a malformed ref and on a dotted (non-GitHub)
// owner. parseSkillRef is the ONE source; the gate throws
// it before any card exists. Network truth past the ref
// shape (repo exists, SKILL.md exists) is NOT gated.

function fresh(): string { return mkdtempSync(join(tmpdir(), "sam-skill-gate-")); }

test("skill gate: a malformed ref refuses at proposal in parseSkillRef's words and creates nothing", () => {
  const root = fresh();
  try {
    let expected = "";
    try { parseSkillRef("not a ref at all"); } catch (e) { expected = e instanceof Error ? e.message : String(e); }
    assert.match(expected, /Skill reference must look like/);
    let err = "";
    try { proposeAction(root, { actor: "sam", kind: "skill", title: "Install it", detail: "not a ref at all" }); } catch (e) { err = e instanceof Error ? e.message : String(e); }
    assert.equal(err, expected);
    assert.equal(listActions(root).length, 0);
    assert.equal(readActivity(root).filter(l => l.kind === "proposal").length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("skill gate: a dotted owner (hosted outside GitHub) refuses at proposal in parseSkillRef's words", () => {
  const root = fresh();
  try {
    let expected = "";
    try { parseSkillRef("skills.volces.com/some-repo@some-skill"); } catch (e) { expected = e instanceof Error ? e.message : String(e); }
    assert.match(expected, /not a GitHub owner/);
    let err = "";
    try { proposeAction(root, { actor: "sam", kind: "skill", title: "Install it", detail: "skills.volces.com/some-repo@some-skill" }); } catch (e) { err = e instanceof Error ? e.message : String(e); }
    assert.equal(err, expected);
    assert.equal(listActions(root).length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("skill gate: bare names, empty segments, and extra path segments refuse at proposal", () => {
  const root = fresh();
  try {
    for (const detail of ["just-a-name", "acme/", "/widgets", "acme/widgets/extra/deep", "acme/widgets@"]) {
      assert.throws(() => proposeAction(root, { actor: "sam", kind: "skill", title: "Install it", detail }), /Skill reference/, detail);
    }
    assert.equal(listActions(root).length, 0);
    assert.equal(readActivity(root).filter(l => l.kind === "proposal").length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("skill gate: valid refs propose pending - owner/repo, owner/repo@skill, and owner/repo/skill", () => {
  const root = fresh();
  try {
    for (const detail of ["acme/widgets", "acme/widgets@beta-skill", "acme/widgets/beta-skill"]) {
      const p = proposeAction(root, { actor: "sam", kind: "skill", title: "Install it", detail });
      assert.equal(p.status, "pending");
      assert.equal(p.detail, detail);
    }
    assert.equal(listActions(root).length, 3);
    assert.equal(readActivity(root).filter(l => l.kind === "proposal").length, 3);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("skill gate: other kinds are untouched by the skill check", () => {
  const root = fresh();
  try {
    const p = proposeAction(root, { actor: "sam", kind: "note", title: "Remember", detail: "not a ref at all" });
    assert.equal(p.status, "pending");
    assert.equal(listActions(root).length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
