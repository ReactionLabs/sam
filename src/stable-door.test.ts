import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => resolvePort(port));
    });
  });
}

function httpGet(url: string): Promise<{ status: number; location: string | undefined }> {
  return new Promise((resolveRes, reject) => {
    const req = http.get(url, (res) => {
      res.resume();
      resolveRes({ status: res.statusCode ?? 0, location: res.headers.location });
    });
    req.setTimeout(5000, () => req.destroy(new Error("timeout " + url)));
    req.on("error", reject);
  });
}

test("stable door: GET /sam redirects to the current dashboard token", async () => {
  const root = mkdtempSync(join(tmpdir(), "sam-stable-door-"));
  const port = await freePort();
  const child: ChildProcess = spawn(process.execPath, [join(repoRoot, "dist", "cli.js"), "--workspace", root, "dashboard", "--port", String(port)], {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout?.on("data", (chunk) => { log += chunk.toString(); });
  child.stderr?.on("data", (chunk) => { log += chunk.toString(); });
  const kill = () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  };
  try {
    const url = await new Promise<string>((resolveUrl, reject) => {
      const timer = setTimeout(() => reject(new Error("dashboard did not print its URL\n" + log)), 8000);
      const watch = () => {
        const match = log.match(/SAM dashboard: (http:\/\/127\.0\.0\.1:\d+\/dashboard\/[0-9a-f]{32})/);
        if (match) { clearTimeout(timer); resolveUrl(match[1]); }
      };
      child.stdout?.on("data", watch);
      child.on("exit", (code) => { clearTimeout(timer); reject(new Error("dashboard exited " + code + "\n" + log)); });
      watch();
    });
    const token = url.split("/").pop();
    const redirected = await httpGet(`http://127.0.0.1:${port}/sam`);
    assert.equal(redirected.status, 302);
    assert.equal(redirected.location, `/dashboard/${token}`);
    const slash = await httpGet(`http://127.0.0.1:${port}/sam/`);
    assert.equal(slash.status, 302);
    assert.equal(slash.location, `/dashboard/${token}`);
    const status = await fetch(`http://127.0.0.1:${port}/api/status/${token}`);
    assert.equal(status.status, 200);
    const body = await status.json() as { ok?: boolean };
    assert.equal(body.ok, true);
  } finally {
    kill();
    await new Promise((r) => setTimeout(r, 300));
    if (child.exitCode === null) child.kill("SIGKILL");
    rmSync(root, { recursive: true, force: true });
  }
});
