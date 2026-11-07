import test from "node:test";
import assert from "node:assert/strict";
import {LocalEchoAdapter, hashOutput, verifyExecutionEvidence, validateExecutionRequest} from "./execution.js";

const request = {missionId:"m", taskId:"t", workerId:"w", leaseGeneration:1, objective:"offline test"};
test("offline adapter emits verifiable output without side effects", async () => {
  const result = await new LocalEchoAdapter().execute(request);
  assert.equal(result.output, request.objective);
  assert.equal(result.outputSha256, hashOutput(request.objective));
  assert.equal(verifyExecutionEvidence(result), true);
});
test("rejects invalid lease generation and missing identity", () => {
  assert.throws(() => validateExecutionRequest({...request, leaseGeneration:0}), /generation/);
  assert.throws(() => validateExecutionRequest({...request, workerId:" "}), /empty/);
});
test("detects tampering and invalid evidence", async () => {
  const result = await new LocalEchoAdapter().execute(request);
  assert.equal(verifyExecutionEvidence({...result, output:"changed"}), false);
  assert.equal(verifyExecutionEvidence({...result, outcome:"UNKNOWN" as "SUCCEEDED"}), false);
  assert.equal(verifyExecutionEvidence({...result, completedAt:"invalid"}), false);
});
