import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ARTIFACT_KINDS, artifactKindBlocker, createArtifact, listArtifacts } from "./artifacts.js";

// The artifact-kind gate: the artifact kind is a registry
// name (ARTIFACT_KINDS in artifacts.ts: html, markdown) that
// a person types at the CLI `artifacts create --kind` door,
// the dashboard artifacts API accepts in its body, and the
// model names in the chat artifact tool. Every route rides
// ONE seam - validateKind inside createArtifact - but its
// refusal was an aside ("Invalid artifact kind: X (html or
// markdown)") naming the kinds only parenthetically and
// offering no fold correction. artifactKindBlocker in
// artifacts.ts is now the ONE source carrying the refusal
// text, and validateKind throws it, so every creation route
// refuses in the same words before anything is created.
// Stored-kind readers stay permissive by design (a kind
// removed after an artifact names it leaves the record
// readable).

function fresh(): string {
  return mkdtempSync(join(tmpdir(), "sam-artifact-kind-gate-"));
}

test("artifact kind gate: every exact kind reads no blocker", () => {
  for (const kind of ARTIFACT_KINDS) assert.equal(artifactKindBlocker(kind), null, kind);
  assert.equal(ARTIFACT_KINDS.length, 2);
});

test("artifact kind gate: an unknown kind names the kinds, no correction", () => {
  assert.equal(
    artifactKindBlocker("deck"),
    "Invalid artifact kind \"deck\". Kinds: html, markdown",
  );
});

test("artifact kind gate: a folded name is refused with the correction", () => {
  assert.match(artifactKindBlocker("HTML")!, /Did you mean "html"\?$/);
  assert.match(artifactKindBlocker("MarkDown")!, /Did you mean "markdown"\?$/);
  assert.match(artifactKindBlocker("mark-down")!, /Did you mean "markdown"\?$/);
  assert.match(artifactKindBlocker("mark down")!, /Did you mean "markdown"\?$/);
});

test("artifact kind gate: a non-string value refuses naming the registry, no correction", () => {
  assert.equal(artifactKindBlocker(42), "Invalid artifact kind \"42\". Kinds: html, markdown");
  assert.equal(artifactKindBlocker(""), "Invalid artifact kind \"\". Kinds: html, markdown");
});

test("artifact kind gate: createArtifact throws the ONE source and creates nothing; an exact kind still creates", () => {
  const root = fresh();
  try {
    assert.throws(
      () => createArtifact(root, { profile: "sam", title: "T", kind: "mark-down", content: "hi" }),
      (e: unknown) => e instanceof Error && e.message === artifactKindBlocker("mark-down"),
    );
    assert.throws(
      () => createArtifact(root, { profile: "sam", title: "T", kind: "deck", content: "hi" }),
      (e: unknown) => e instanceof Error && e.message === artifactKindBlocker("deck"),
    );
    assert.deepEqual(listArtifacts(root, "sam"), []);
    const ok = createArtifact(root, { profile: "sam", title: "T", kind: "markdown", content: "hi" });
    assert.equal(ok.kind, "markdown");
    assert.equal(listArtifacts(root, "sam").length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
