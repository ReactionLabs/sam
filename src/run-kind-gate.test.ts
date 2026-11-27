import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requestTestRun, testKinds, testKindBlocker } from "./approved-test-runner.js";

// The run-kind gate: the approved test-run kind is a
// registry name (testKinds in approved-test-runner.ts:
// build, test) that a person types at the CLI
// `run request --kind` door. The ONE seam every request
// rides, requestTestRun, refused a bad kind with the bare
// "Only build and test are allowed" - echoing no value
// and offering no fold correction, so a folded name
// ("Build", "bu-ild") dead-ended. testKindBlocker in
// approved-test-runner.ts is now the ONE source carrying
// the refusal text; requestTestRun throws it before
// safeRoot opens anything, so no request file or audit
// line is touched. The stored-request reader stays
// permissive by design.

test("run kind gate: every exact kind reads no blocker", () => {
  for (const kind of testKinds) assert.equal(testKindBlocker(kind), null, kind);
  assert.equal(testKinds.length, 2);
});

test("run kind gate: an unknown kind names the kinds, no correction", () => {
  assert.equal(
    testKindBlocker("powershell"),
    "Only build and test are allowed: \"powershell\". Run kinds: build, test",
  );
});

test("run kind gate: a folded name is refused with the correction", () => {
  assert.match(testKindBlocker("Build")!, /Did you mean "build"\?$/);
  assert.match(testKindBlocker("TEST")!, /Did you mean "test"\?$/);
  assert.match(testKindBlocker("bu-ild")!, /Did you mean "build"\?$/);
  assert.match(testKindBlocker("t est")!, /Did you mean "test"\?$/);
});

test("run kind gate: a non-string value refuses naming the registry, no correction", () => {
  assert.equal(testKindBlocker(42), "Only build and test are allowed: \"42\". Run kinds: build, test");
  assert.equal(testKindBlocker(""), "Only build and test are allowed: \"\". Run kinds: build, test");
});

test("run kind gate: the request seam throws the ONE source and records nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "run-kind-"));
  try {
    assert.throws(
      () => requestTestRun(dir, "Build"),
      /Only build and test are allowed: "Build"\. Run kinds: build, test\. Did you mean "build"\?$/,
    );
    assert.equal(existsSync(join(dir, ".sam")), false);
    const ok = requestTestRun(dir, "build");
    assert.equal(ok.kind, "build");
    assert.equal(readdirSync(join(dir, ".sam")).filter(f => f.startsWith("run-")).length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
