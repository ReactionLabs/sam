import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LANE_KINDS, laneKindBlocker, planJob, type LaneSpec } from "./orchestration.js";
import { listJobs } from "./orchestration.js";

// The lane-kind gate: the lane kind is a registry name
// (LANE_KINDS in orchestration.ts: research, build, verify,
// coordinate, general) that a person types in an
// orchestration spec at the CLI `orchestrate plan` /
// `orchestrate run` doors and the model names in the
// sam_orchestrate chat tool's lanes. Every route rides ONE
// seam - validateSpec - but its refusal was the bare "Lane
// X has an unknown kind: Y", naming no registry and offering
// no fold correction, so a folded name ("Research",
// "co-ordinate", "co_ordinate") dead-ended. laneKindBlocker
// in orchestration.ts is now the ONE source carrying the
// refusal text; validateSpec throws it before laneTools
// indexes by kind. Stored-kind readers stay permissive by
// design (a stored lane record's kind is read back as
// stored).

function lane(partial: Partial<LaneSpec> & { name: string }): LaneSpec {
  return {
    kind: "research",
    goal: "goal for " + partial.name,
    doneLooksLike: "done shape for " + partial.name,
    notDoneLooksLike: "not done shape for " + partial.name,
    landsAt: "the job report",
    ...partial,
  } as LaneSpec;
}

test("lane kind gate: every exact kind reads no blocker", () => {
  for (const kind of LANE_KINDS) assert.equal(laneKindBlocker(kind, "a"), null, kind);
  assert.equal(LANE_KINDS.length, 5);
});

test("lane kind gate: an unknown kind names the kinds, no correction", () => {
  assert.equal(
    laneKindBlocker("explore", "scout"),
    "Lane scout has an unknown kind \"explore\". Kinds: research, build, verify, coordinate, general",
  );
});

test("lane kind gate: a folded name is refused with the correction", () => {
  assert.match(laneKindBlocker("Research", "a")!, /Did you mean "research"\?$/);
  assert.match(laneKindBlocker("BUILD", "a")!, /Did you mean "build"\?$/);
  assert.match(laneKindBlocker("co-ordinate", "a")!, /Did you mean "coordinate"\?$/);
  assert.match(laneKindBlocker("co_ordinate", "a")!, /Did you mean "coordinate"\?$/);
});

test("lane kind gate: a non-string value refuses naming the registry, no correction", () => {
  assert.equal(laneKindBlocker(42, "a"), "Lane a has an unknown kind \"42\". Kinds: research, build, verify, coordinate, general");
  assert.equal(laneKindBlocker("", "a"), "Lane a has an unknown kind \"\". Kinds: research, build, verify, coordinate, general");
});

test("lane kind gate: the plan seam throws the ONE source and creates no job", () => {
  const root = mkdtempSync(join(tmpdir(), "lane-kind-"));
  assert.throws(
    () => planJob(root, { ask: "x", lanes: [lane({ name: "scout", kind: "co-ordinate" as LaneSpec["kind"] })] }),
    /Lane scout has an unknown kind "co-ordinate"\. Kinds: research, build, verify, coordinate, general\. Did you mean "coordinate"\?$/,
  );
  assert.equal(listJobs(root).length, 0);
});
