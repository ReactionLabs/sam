import test from "node:test";
import assert from "node:assert/strict";
import { missionStatusFromPayload, missionStatusText, type MissionStatusInput } from "./mission-status.js";

function greenInput(): MissionStatusInput {
  return {
    at: "2026-11-19T22:00:00.000Z",
    auth: {
      key: "present",
      endpoint: "https://example.invalid/v1",
      routes: [{ route: "chat", model: "M", key: "present", lastProbe: { bucket: "ok" } }],
    },
    contextAudit: { overall: { passed: 9, total: 9 }, findings: [] },
    readiness: { vault: { held: 1 }, backups: { count: 3, newest: { created_at: "2026-11-19T08:00:00.000Z" } } },
    connectors: [
      { name: "Nines", enabled: true, credentialPresent: true, allowedTools: ["whoami"] },
      { name: "second-shift", enabled: true, credentialPresent: true, allowedTools: ["whoami", "list_hq_clients"] },
    ],
    channels: [{ kind: "telegram", enabled: true, credentialPresent: true, ownerIds: [42] }],
    pendingActions: [],
    verification: { state: "clean", pendingChanges: [] },
  };
}

const DOCTOR_OK = { checks: [{ id: "runtime", status: "ok" }, { id: "model", status: "ok" }] };

test("mission status: every check green reads All systems groovy, one light per system", () => {
  const s = missionStatusFromPayload(greenInput(), { doctor: DOCTOR_OK });
  assert.equal(s.allGreen, true);
  assert.equal(s.headline, "All systems groovy");
  assert.equal(s.counts.green, s.counts.total);
  // model, memory, vault, two connectors, backups, telegram, approvals, doctor, verify
  assert.equal(s.counts.total, 10);
  assert.ok(s.lights.some(l => l.name === "Connector: Second Shift" && l.level === "green"));
});

test("mission status: a configured model with no probe is amber, never green", () => {
  const input = greenInput();
  input.auth!.routes![0].lastProbe = null;
  const s = missionStatusFromPayload(input, { doctor: DOCTOR_OK });
  const model = s.lights.find(l => l.id === "model")!;
  assert.equal(model.level, "amber");
  assert.equal(s.allGreen, false);
  assert.notEqual(s.headline, "All systems groovy");
});

test("mission status: a failed probe is red and a missing key is red", () => {
  const input = greenInput();
  input.auth!.routes![0].lastProbe = { bucket: "auth" };
  assert.equal(missionStatusFromPayload(input, { doctor: DOCTOR_OK }).lights.find(l => l.id === "model")!.level, "red");
  const input2 = greenInput();
  input2.auth!.key = "absent";
  assert.equal(missionStatusFromPayload(input2, { doctor: DOCTOR_OK }).lights.find(l => l.id === "model")!.level, "red");
});

test("mission status: pending approvals show amber and are never hidden", () => {
  const input = greenInput();
  input.pendingActions = [{}, {}, {}];
  const s = missionStatusFromPayload(input, { doctor: DOCTOR_OK });
  const a = s.lights.find(l => l.id === "approvals")!;
  assert.equal(a.level, "amber");
  assert.match(a.sentence, /3 approval\(s\) are waiting/);
});

test("mission status: a failing doctor check is a red light naming the check", () => {
  const doctor = { checks: [{ id: "runtime", status: "ok" }, { id: "socket-permissions", status: "fail" }, { id: "daemon-token", status: "warn" }] };
  const s = missionStatusFromPayload(greenInput(), { doctor });
  const d = s.lights.find(l => l.id === "doctor")!;
  assert.equal(d.level, "red");
  assert.match(d.sentence, /socket permissions/);
  assert.equal(s.headline, "Some systems need attention");
});

test("mission status: no doctor report on the surface is amber, not green", () => {
  const s = missionStatusFromPayload(greenInput());
  assert.equal(s.lights.find(l => l.id === "doctor")!.level, "amber");
  assert.equal(s.allGreen, false);
});

test("mission status: the verify backlog and a failed verification are never green", () => {
  const input = greenInput();
  input.verification = { state: "unverified", pendingChanges: [{}, {}] };
  const v = missionStatusFromPayload(input, { doctor: DOCTOR_OK }).lights.find(l => l.id === "verify")!;
  assert.equal(v.level, "amber");
  assert.match(v.sentence, /2 change\(s\)/);
  input.verification = { state: "failed", pendingChanges: [] };
  assert.equal(missionStatusFromPayload(input, { doctor: DOCTOR_OK }).lights.find(l => l.id === "verify")!.level, "red");
});

test("mission status: telegram pairing mode and a tool-less connector are amber", () => {
  const input = greenInput();
  input.channels = [{ kind: "telegram", enabled: true, credentialPresent: true, ownerIds: [] }];
  input.connectors = [{ name: "second-shift", enabled: true, credentialPresent: true, allowedTools: [] }];
  const s = missionStatusFromPayload(input, { doctor: DOCTOR_OK });
  assert.equal(s.lights.find(l => l.id === "telegram")!.level, "amber");
  assert.equal(s.lights.find(l => l.id === "connector:second-shift")!.level, "amber");
});

test("mission status: stale backups amber, no backups red, empty vault amber", () => {
  const input = greenInput();
  input.readiness!.backups = { count: 2, newest: { created_at: "2026-11-10T08:00:00.000Z" } };
  assert.equal(missionStatusFromPayload(input, { doctor: DOCTOR_OK }).lights.find(l => l.id === "backups")!.level, "amber");
  input.readiness!.backups = { count: 0, newest: null };
  assert.equal(missionStatusFromPayload(input, { doctor: DOCTOR_OK }).lights.find(l => l.id === "backups")!.level, "red");
  input.readiness!.vault = { held: 0 };
  assert.equal(missionStatusFromPayload(input, { doctor: DOCTOR_OK }).lights.find(l => l.id === "vault")!.level, "amber");
});

test("mission status text: no clock reading, carries the credit line, byte-stable", () => {
  const a = missionStatusText(missionStatusFromPayload(greenInput(), { doctor: DOCTOR_OK }));
  const b = missionStatusText(missionStatusFromPayload(greenInput(), { doctor: DOCTOR_OK }));
  assert.equal(a, b);
  assert.match(a, /^Mission status: All systems groovy/);
  assert.match(a, /Claudia, an open character by anabology$/);
  assert.doesNotMatch(a, /2026|T\d{2}:/);
});
