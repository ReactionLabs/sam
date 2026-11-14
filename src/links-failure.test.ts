import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readActivity } from "./activity.js";
import { ChatStore } from "./chats.js";
import {
  createLink, isLinkLedgered, linkFailureSummary, links, visibleScopes,
} from "./links.js";
import { classifyDefect } from "./self-work.js";

// Link store failure visibility (gap found 2026-11-14,
// hourly run 11:04): links() is the one read door for the
// link registry - the only bridge between profiles - and
// visibleScopes rides it to decide, on every memory read,
// which scopes an actor may see. Every touch was unguarded:
// direct readers threw raw on a dead store, and the
// resolver threw raw into three different fates, none
// naming the store. Each touch now ledgers ONE link-failed
// line (phase read for direct readers, phase resolve with
// the requesting actor as context for visibleScopes) and
// rethrows exactly, tagged; every caller's handling is
// unchanged.
function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-links-fail-"));
}

function failedLines(root: string) {
  return readActivity(root, 100, { kind: "link-failed" });
}

function plantDeadStore(root: string): void {
  mkdirSync(join(root, ".sam", "links.db"), { recursive: true });
}

test("link-failed: summary shapes collapse and cap the reason, and self-work classifies by phase", () => {
  assert.equal(linkFailureSummary("read", "sam", "unable to open\n  database   file"), "Link read failed: unable to open database file");
  assert.equal(linkFailureSummary("resolve", "dip", "disk gone"), "Link resolve failed for dip: disk gone");
  assert.equal(linkFailureSummary("read", "sam", "x".repeat(500)).length, 200);
  assert.equal(linkFailureSummary("resolve", "dip", "x".repeat(500)).length, 200);
  for (const phase of ["read", "resolve"] as const) {
    assert.deepEqual(
      classifyDefect({ at: "", actor: "sam", kind: "link-failed", summary: linkFailureSummary(phase, "dip", "boom") }),
      { key: "link-failed:" + phase, label: "link store failures (" + phase + " step)" },
    );
  }
});

test("link-failed: a dead store ledgers exactly one line per touch, tagged, and rethrows", () => {
  const root = scratch();
  try {
    plantDeadStore(root);
    assert.throws(() => links(root), (e: unknown) => isLinkLedgered(e));
    let lines = failedLines(root);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].actor, "sam");
    assert.ok(lines[0].summary.startsWith("Link read failed: "), lines[0].summary);
    assert.deepEqual(classifyDefect(lines[0]), { key: "link-failed:read", label: "link store failures (read step)" });

    // The resolver touch ledgers exactly one resolve line
    // carrying the requesting actor, never a second line
    // from the read door underneath it.
    assert.throws(() => visibleScopes(root, "dip"), (e: unknown) => isLinkLedgered(e));
    lines = failedLines(root);
    assert.equal(lines.length, 2, "the resolver touch ledgers exactly one more line, never two for one touch");
    assert.equal(lines[1].actor, "dip");
    assert.ok(lines[1].summary.startsWith("Link resolve failed for dip: "), lines[1].summary);
    assert.deepEqual(classifyDefect(lines[1]), { key: "link-failed:resolve", label: "link store failures (resolve step)" });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("link-failed: an absent store reads no links, resolves own-scope only, and creates nothing", () => {
  const root = scratch();
  try {
    assert.deepEqual(links(root), []);
    assert.deepEqual(visibleScopes(root, "dip"), ["profile:dip"]);
    assert.deepEqual(visibleScopes(root, "sam"), ["core"]);
    assert.equal(failedLines(root).length, 0, "nothing failed, so nothing ledgers");
    assert.equal(existsSync(join(root, ".sam", "links.db")), false, "a pure read creates no store");
    assert.equal(existsSync(join(root, ".sam")), false, "a pure read creates nothing at all");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("link-failed: a healthy registry reads and resolves scopes with zero failure lines", () => {
  const root = scratch();
  try {
    const db = new ChatStore(root);
    try { db.createAgent("dip", "Help dip.", {}); } finally { db.close(); }
    const group = createLink(root, "dip + sam", ["dip", "sam"]);
    assert.equal(links(root).length, 1);
    assert.deepEqual(visibleScopes(root, "dip"), ["profile:dip", "link:" + group.id]);
    assert.deepEqual(visibleScopes(root, "sam"), ["core", "link:" + group.id]);
    assert.equal(failedLines(root).length, 0);
    assert.ok(!JSON.stringify(failedLines(root)).includes("dip + sam"), "no link record ever enters a failure line");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
