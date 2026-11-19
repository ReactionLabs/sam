import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { proposeAction, decideAction } from "./actions.js";
import { buildStatusPayload } from "./status.js";
import { addChannel } from "./channels.js";
import { mkdirSync, writeFileSync } from "node:fs";

function scratch(): string { return mkdtempSync(join(tmpdir(), "sam-status-")); }

function withoutAt(payload: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...payload };
  delete copy.at;
  // missionStatus is the one surface-supplied field: the dashboard
  // process passes its cached real doctor report (the doctor light
  // is the actual diagnosis there), the CLI overview passes none
  // and its doctor light reads amber - not run here. Like `at`,
  // it legitimately differs between the two doors; every other
  // field must match exactly.
  delete copy.missionStatus;
  return copy;
}

test("pendingActions is the pending slice of the same actions list", async () => {
  const root = scratch();
  try {
    const kept = proposeAction(root, { actor: "sam", kind: "note", title: "Still waiting", detail: "one" });
    const done = proposeAction(root, { actor: "sam", kind: "note", title: "Already decided", detail: "two" });
    await decideAction(root, done.id, false);
    const payload = buildStatusPayload(root);
    assert.equal(payload.actions.length, 2);
    assert.equal(payload.pendingActions.length, 1);
    assert.equal(payload.pendingActions[0].id, kept.id);
    assert.deepEqual(payload.pendingActions, payload.actions.filter(a => a.status === "pending"));
    assert.ok(Array.isArray(payload.skills));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("status payload carries the Claudia missionStatus derived from its own fields", () => {
  const root = scratch();
  try {
    const payload = buildStatusPayload(root);
    assert.ok(payload.missionStatus, "missionStatus present");
    assert.equal(payload.missionStatus.headline, payload.missionStatus.allGreen ? "All systems groovy" : payload.missionStatus.headline);
    assert.ok(payload.missionStatus.lights.length >= 8, "one light per system, connectors folded when none exist");
    // A bare install has no model configured and no doctor report
    // on this surface: neither light may read green (the model is
    // red, unconfigured; doctor is amber, not run here).
    assert.equal(payload.missionStatus.lights.find(l => l.id === "model")?.level, "red");
    assert.equal(payload.missionStatus.lights.find(l => l.id === "doctor")?.level, "amber");
    assert.equal(payload.missionStatus.allGreen, false);
    const withDoctor = buildStatusPayload(root, { doctor: { checks: [{ id: "socket-permissions", status: "fail" }] } });
    assert.equal(withDoctor.missionStatus.lights.find(l => l.id === "doctor")?.level, "red");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("status payload carries channels and installed skills for the Manage view", () => {
  const root = scratch();
  try {
    const empty = buildStatusPayload(root);
    assert.deepEqual(empty.channels, []);
    assert.deepEqual(empty.skillInstalled, []);
    assert.equal(typeof empty.usageToday.totalTokens, "number");
    assert.equal(typeof empty.usageToday.calls, "number");
    addChannel(root, "telegram", "Dip Telegram", "dip", "SAM_CHANNEL_TG_MAIN", [6300316150]);
    mkdirSync(join(root, ".sam"), { recursive: true });
    writeFileSync(join(root, ".sam", "skill-installs.json"), JSON.stringify([
      { name: "agent-reach", source: "github", ref: "owner/repo", files: 3, installedAt: "2026-11-10T00:00:00.000Z", actor: "sam" },
    ]));
    const payload = buildStatusPayload(root);
    assert.equal(payload.channels.length, 1);
    assert.equal(payload.channels[0].name, "Dip Telegram");
    assert.equal(payload.channels[0].kind, "telegram");
    assert.equal(payload.channels[0].profile, "dip");
    assert.equal(typeof payload.channels[0].credentialPresent, "boolean");
    assert.equal(payload.skillInstalled.length, 1);
    assert.equal(payload.skillInstalled[0].name, "agent-reach");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("GET /api/status and sam overview return the same payload for the same workspace", async () => {
  const root = scratch();
  const cli = fileURLToPath(new URL("./cli.js", import.meta.url));
  const port = 21000 + Math.floor(Math.random() * 20000);
  const env = { PATH: "/usr/bin:/bin", SAM_ENGINE_BIN: "/no", SAM_GOG_BIN: "/no" };
  const kept = proposeAction(root, { actor: "sam", kind: "note", title: "Still waiting", detail: "one" });
  const done = proposeAction(root, { actor: "sam", kind: "note", title: "Already decided", detail: "two" });
  await decideAction(root, done.id, false);
  const child = spawn(process.execPath, [cli, "--workspace", root, "dashboard", "--port", String(port)], { env });
  let log = "";
  try {
    const token = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("dashboard did not start\n" + log)), 8000);
      child.stdout?.on("data", (chunk: Buffer) => {
        log += chunk.toString("utf8");
        const match = new RegExp("http://127\\.0\\.0\\.1:" + port + "/dashboard/([0-9a-f]+)").exec(log);
        if (match) { clearTimeout(timer); resolve(match[1]); }
      });
      child.stderr?.on("data", (chunk: Buffer) => { log += chunk.toString("utf8"); });
      child.on("exit", () => { clearTimeout(timer); reject(new Error("dashboard exited\n" + log)); });
    });
    const res = await fetch("http://127.0.0.1:" + port + "/api/status", { headers: { Authorization: "Bearer " + token } });
    assert.equal(res.status, 200);
    const httpBody = await res.json() as Record<string, unknown> & { actions: Array<{ id: string; status: string }>; pendingActions: Array<{ id: string; status: string }> };
    const cliRun = spawnSync(process.execPath, [cli, "--workspace", root, "--json", "overview"], { encoding: "utf8", env });
    assert.equal(cliRun.status, 0, cliRun.stderr);
    const cliBody = JSON.parse(cliRun.stdout) as typeof httpBody;
    assert.deepEqual(Object.keys(httpBody).sort(), Object.keys(cliBody).sort());
    assert.deepEqual(withoutAt(httpBody), withoutAt(cliBody));
    assert.equal(httpBody.actions.length, 2);
    assert.deepEqual(httpBody.pendingActions, httpBody.actions.filter(a => a.status === "pending"));
    assert.equal(httpBody.pendingActions.length, 1);
    assert.equal(httpBody.pendingActions[0].id, kept.id);
    assert.equal(cliBody.pendingActions[0].id, kept.id);
    const filtered = await fetch("http://127.0.0.1:" + port + "/api/status?actor=sam", { headers: { Authorization: "Bearer " + token } });
    const filteredBody = await filtered.json() as Record<string, unknown>;
    assert.deepEqual(Object.keys(filteredBody).sort(), Object.keys(httpBody).sort());
  } finally {
    child.kill("SIGTERM");
    await new Promise(resolve => child.once("exit", resolve));
    rmSync(root, { recursive: true, force: true });
  }
});
