import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import type { AddressInfo } from "node:net";
import { proposeAction, decideAction, listActions, actionFailureReason } from "./actions.js";
import { MemoryStore } from "./memory.js";
import { readActivity } from "./activity.js";

// Action execution failures carry their cause (gap found
// 2026-11-16, hourly run 15:04 EST): applyDecision's catch took
// error.message alone, so an approved execution dying on
// transport (the skill install rides fetch to skills.sh and
// the GitHub API) read as the bare "fetch failed" wrapper in
// the failed card's stored result and in the "failed" ledger
// line. The reason now composes through errorReason (the
// 04:04 bridge seam): causeless errors keep their plain
// message, a transport wrapper names its cause, and no bot
// token leaks.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-action-cause-"));
}

const dnsErr = () => new TypeError("fetch failed", {
  cause: Object.assign(new Error("getaddrinfo ENOTFOUND api.github.com"), { code: "ENOTFOUND" }),
});

test("an action failure reason names the transport cause behind the wrapper", () => {
  assert.equal(actionFailureReason(dnsErr()), "fetch failed: getaddrinfo ENOTFOUND api.github.com");
});

test("an errno code riding only on the cause is appended when the message omits it", () => {
  const err = new TypeError("fetch failed", {
    cause: Object.assign(new Error("read"), { code: "ECONNRESET" }),
  });
  assert.equal(actionFailureReason(err), "fetch failed: read (ECONNRESET)");
});

test("causeless action errors keep their plain message; a non-Error throw keeps the fallback", () => {
  assert.equal(actionFailureReason(new Error("Invalid profile")), "Invalid profile");
  assert.equal(actionFailureReason("plain string failure"), "Execution failed");
});

test("no bot token leaks through an action failure reason", () => {
  const url = "https://api.telegram.org/bot987654:AAE-secret_token/getMe";
  const err = new TypeError("fetch failed", { cause: new Error("request to " + url + " failed") });
  const reason = actionFailureReason(err);
  assert.equal(reason.includes("AAE-secret_token"), false);
  assert.equal(reason.includes("987654"), false);
  assert.match(reason, /bot<redacted>/);
});

async function closedPort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}

test("a skill install dying on transport carries its cause in the stored result and the ledger line - and never its detail beyond the ref", async () => {
  const root = scratch();
  const port = await closedPort();
  const prev = process.env.SKILLS_GITHUB_API_URL;
  process.env.SKILLS_GITHUB_API_URL = "http://127.0.0.1:" + port;
  try {
    const a = proposeAction(root, { actor: "sam", kind: "skill", title: "Install a skill", detail: "some-owner/some-repo@some-skill" });
    const done = await decideAction(root, a.id, true);
    assert.equal(done.status, "failed");
    assert.match(done.result ?? "", /^fetch failed: connect ECONNREFUSED 127\.0\.0\.1:/);
    const stored = listActions(root).find(x => x.id === a.id);
    assert.equal(stored?.result, done.result);
    const lines = readActivity(root, 50).filter(x => x.kind === "failed");
    assert.equal(lines.length, 1);
    assert.equal(lines[0].summary, "skill: Install a skill - " + done.result);
  } finally {
    if (prev === undefined) delete process.env.SKILLS_GITHUB_API_URL; else process.env.SKILLS_GITHUB_API_URL = prev;
    rmSync(root, { recursive: true, force: true });
  }
});

test("a skill install dying on an HTTP error ledgers exactly its plain message, once", async () => {
  const root = scratch();
  const server = createServer((_req, res) => { res.writeHead(404); res.end("nope"); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const prev = process.env.SKILLS_GITHUB_API_URL;
  process.env.SKILLS_GITHUB_API_URL = "http://127.0.0.1:" + port;
  try {
    const a = proposeAction(root, { actor: "sam", kind: "skill", title: "Install a skill", detail: "some-owner/some-repo@some-skill" });
    const done = await decideAction(root, a.id, true);
    assert.equal(done.status, "failed");
    assert.equal(done.result, "Fetch failed (HTTP 404) for http://127.0.0.1:" + port + "/repos/some-owner/some-repo/git/trees/HEAD");
    const lines = readActivity(root, 50).filter(x => x.kind === "failed");
    assert.equal(lines.length, 1);
    assert.equal(lines[0].summary, "skill: Install a skill - " + done.result);
  } finally {
    if (prev === undefined) delete process.env.SKILLS_GITHUB_API_URL; else process.env.SKILLS_GITHUB_API_URL = prev;
    server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a causeless execution failure through the gate keeps its plain message in both records", async () => {
  const root = scratch();
  try {
    // The gate now refuses a patch target that cannot execute
    // (2026-11-24 13:04), so the causeless-failure proof proposes
    // against a live record and archives it before approval: the
    // execution seam still fails, with the ONE source's text.
    const store = new MemoryStore(join(root, ".sam", "missions.db"));
    let targetId = "";
    try {
      const rec = store.add({ kind: "observation", content: "the old text", source: "test", scope: "core" });
      targetId = rec.id;
    } finally { store.close(); }
    const a = proposeAction(root, { actor: "sam", kind: "note", title: "Patch a note", detail: "replacement text", supersedes: targetId });
    const store2 = new MemoryStore(join(root, ".sam", "missions.db"));
    try { assert.equal(store2.archive(targetId), true); } finally { store2.close(); }
    const done = await decideAction(root, a.id, true);
    assert.equal(done.status, "failed");
    assert.equal(done.result, "Cannot patch: record " + targetId + " is already archived");
    const lines = readActivity(root, 50).filter(x => x.kind === "failed");
    assert.equal(lines.length, 1);
    assert.equal(lines[0].summary, "note: Patch a note - " + done.result);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
