import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { addChannel } from "./channels.js";

// The Manage view (Dip, 2026-11-12) renders from /api/status. On this
// branch the payload is the dashboard's inline one, so the fields the
// view needs - channels, skillInstalled, usageToday - are pinned here
// against the served payload, not just the builder.
test("GET /api/status carries the Manage view fields", async () => {
  const root = mkdtempSync(join(tmpdir(), "sam-manage-"));
  const cli = fileURLToPath(new URL("./cli.js", import.meta.url));
  const port = 22000 + Math.floor(Math.random() * 20000);
  addChannel(root, "telegram", "Dip Telegram", "dip", "SAM_CHANNEL_TG_MAIN", [6300316150]);
  mkdirSync(join(root, ".sam"), { recursive: true });
  writeFileSync(join(root, ".sam", "skill-installs.json"), JSON.stringify([
    { name: "agent-reach", source: "github", ref: "owner/repo", files: 3, installedAt: "2026-11-10T00:00:00.000Z", actor: "sam" },
  ]));
  const child = spawn(process.execPath, [cli, "--workspace", root, "dashboard", "--port", String(port)], {
    env: { PATH: "/usr/bin:/bin", SAM_ENGINE_BIN: "/no", SAM_GOG_BIN: "/no" },
  });
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
    const body = await res.json() as {
      channels: Array<{ name: string; kind: string; credentialPresent: boolean }>;
      skillInstalled: Array<{ name: string }>;
      usageToday: { totalTokens: number; calls: number };
    };
    assert.equal(body.channels.length, 1);
    assert.equal(body.channels[0].name, "Dip Telegram");
    assert.equal(typeof body.channels[0].credentialPresent, "boolean");
    assert.equal(body.skillInstalled.length, 1);
    assert.equal(body.skillInstalled[0].name, "agent-reach");
    assert.equal(typeof body.usageToday.totalTokens, "number");
    assert.equal(typeof body.usageToday.calls, "number");
  } finally {
    child.kill("SIGTERM");
    await new Promise(resolve => child.once("exit", resolve));
    rmSync(root, { recursive: true, force: true });
  }
});
