import test from "node:test";
import assert from "node:assert/strict";
import {LocalEchoAdapter, hashOutput, verifyExecutionEvidence, validateExecutionRequest, executionRequestId} from "./execution.js";

const request = {missionId:"m", taskId:"t", workerId:"w", leaseGeneration:1, objective:"offline test"};
test("offline adapter emits verifiable output bound to exact request", async () => {
  const result = await new LocalEchoAdapter().execute(request);
  assert.equal(result.output, request.objective);
  assert.equal(result.outputSha256, hashOutput(request.objective));
  assert.equal(result.requestId, executionRequestId(request));
  assert.equal(verifyExecutionEvidence(result, request), true);
});
test("rejects invalid lease generation and missing identity", () => {
  assert.throws(() => validateExecutionRequest({...request, leaseGeneration:0}), /generation/);
  assert.throws(() => validateExecutionRequest({...request, leaseGeneration:Number.MAX_SAFE_INTEGER+1}), /generation/);
  assert.throws(() => validateExecutionRequest({...request, workerId:" "}), /empty/);
  assert.throws(() => validateExecutionRequest(null as unknown as typeof request), /required/);
});
test("rejects evidence replayed across tasks, workers or lease generations", async () => {
  const result = await new LocalEchoAdapter().execute(request);
  assert.equal(verifyExecutionEvidence(result, {...request, taskId:"other"}), false);
  assert.equal(verifyExecutionEvidence(result, {...request, workerId:"other"}), false);
  assert.equal(verifyExecutionEvidence(result, {...request, leaseGeneration:2}), false);
  assert.equal(verifyExecutionEvidence(result, {...request, objective:"changed"}), false);
  assert.equal(verifyExecutionEvidence({...result, requestId:"not-a-hash"}, request), false);
});
test("detects tampering and invalid evidence", async () => {
  const result = await new LocalEchoAdapter().execute(request);
  assert.equal(verifyExecutionEvidence({...result, output:"changed"}, request), false);
  assert.equal(verifyExecutionEvidence({...result, outcome:"UNKNOWN" as "SUCCEEDED"}, request), false);
  assert.equal(verifyExecutionEvidence({...result, completedAt:"invalid"}, request), false);
  assert.equal(verifyExecutionEvidence({...result, outputSha256:"bad"}, request), false);
});
