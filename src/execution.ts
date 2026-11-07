import {createHash, randomUUID} from "node:crypto";

export type ExecutionOutcome = "SUCCEEDED" | "FAILED";
export interface ExecutionRequest {
  missionId: string;
  taskId: string;
  workerId: string;
  leaseGeneration: number;
  objective: string;
}
export interface ExecutionEvidence {
  requestId: string;
  outcome: ExecutionOutcome;
  output: string;
  outputSha256: string;
  completedAt: string;
}
export interface ExecutionAdapter {
  readonly id: string;
  execute(request: Readonly<ExecutionRequest>): Promise<ExecutionEvidence>;
}
export function validateExecutionRequest(request: ExecutionRequest): void {
  for (const value of [request.missionId, request.taskId, request.workerId, request.objective]) {
    if (typeof value !== "string" || !value.trim()) throw new Error("Execution request contains an empty field");
  }
  if (!Number.isSafeInteger(request.leaseGeneration) || request.leaseGeneration < 1)
    throw new Error("Execution requires a positive lease generation");
}
export function hashOutput(output: string): string {
  return createHash("sha256").update(output, "utf8").digest("hex");
}
export function verifyExecutionEvidence(evidence: ExecutionEvidence): boolean {
  if (!evidence || typeof evidence.requestId !== "string" || !evidence.requestId.trim()) return false;
  if (evidence.outcome !== "SUCCEEDED" && evidence.outcome !== "FAILED") return false;
  if (typeof evidence.output !== "string" || typeof evidence.outputSha256 !== "string") return false;
  if (typeof evidence.completedAt !== "string" || !Number.isFinite(Date.parse(evidence.completedAt))) return false;
  return hashOutput(evidence.output) === evidence.outputSha256;
}
/** Offline deterministic adapter for contract testing only. No model, tools, or network. */
export class LocalEchoAdapter implements ExecutionAdapter {
  readonly id = "local-echo-test";
  async execute(request: Readonly<ExecutionRequest>): Promise<ExecutionEvidence> {
    validateExecutionRequest(request);
    const output = request.objective;
    return {requestId: randomUUID(), outcome: "SUCCEEDED", output,
      outputSha256: hashOutput(output), completedAt: new Date().toISOString()};
  }
}
