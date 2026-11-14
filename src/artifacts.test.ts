import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ARTIFACT_CONTENT_CSP, ARTIFACT_CONTENT_MAX_BYTES, ARTIFACT_FRAME_SANDBOX,
  artifactPath, artifactReadingHtml, artifactsForChat, createArtifact, getArtifact,
  getArtifactVersion, listArtifactVersions, listArtifacts, renderMarkdownArtifact, updateArtifact,
} from "./artifacts.js";
import { readActivity } from "./activity.js";
import { classifyDefect } from "./self-work.js";

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-artifacts-"));
}

test("artifacts: a pure read on a fresh install returns empty and creates nothing", () => {
  const root = scratch();
  try {
    assert.deepEqual(listArtifacts(root, "sam"), []);
    assert.equal(getArtifact(root, "00000000-0000-0000-0000-000000000000", "sam"), null);
    assert.deepEqual(listArtifactVersions(root, "00000000-0000-0000-0000-000000000000"), []);
    assert.equal(existsSync(join(root, ".sam", "artifacts.db")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("artifacts: create, read back, stable path, provenance carries the run's sources", () => {
  const root = scratch();
  try {
    const made = createArtifact(root, {
      profile: "dip", title: "Zorblax brief", kind: "markdown",
      content: "# Zorblax brief\n\nThe launch code is **47-ALPHA**.",
      chatId: "chat-123", sources: [{ n: 1, kind: "file", descriptor: "project-facts.md" }],
    });
    assert.equal(made.version, 1);
    assert.equal(artifactPath(made.id), "/artifact/" + made.id);
    const back = getArtifact(root, made.id, "dip");
    assert.equal(back?.content, made.content);
    assert.equal(back?.createdBy.chatId, "chat-123");
    assert.deepEqual(back?.createdBy.sources, [{ n: 1, kind: "file", descriptor: "project-facts.md" }]);
    const list = listArtifacts(root, "dip");
    assert.equal(list.length, 1);
    assert.equal(list[0].path, "/artifact/" + made.id);
    assert.ok(list[0].contentBytes > 0);
    assert.equal(artifactsForChat(root, "chat-123").length, 1);
    const ledger = readActivity(root, 10, { kind: "artifact" });
    assert.equal(ledger.length, 1);
    assert.match(ledger[0].summary, /Created artifact 'Zorblax brief' \(markdown, v1\)/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("artifacts: an update is a new version of the SAME artifact and history stays listable", () => {
  const root = scratch();
  try {
    const made = createArtifact(root, { profile: "sam", title: "Field kit", kind: "html", content: "<h1>Kit</h1>" });
    const updated = updateArtifact(root, made.id, { profile: "sam", content: "<h1>Kit</h1><h2>Risks</h2>", chatId: "chat-9" });
    assert.equal(updated.id, made.id);
    assert.equal(updated.version, 2);
    assert.equal(getArtifact(root, made.id, "sam")?.content, "<h1>Kit</h1><h2>Risks</h2>");
    assert.equal(getArtifactVersion(root, made.id, 1, "sam")?.content, "<h1>Kit</h1>");
    assert.equal(getArtifactVersion(root, made.id, 2, "sam")?.content, "<h1>Kit</h1><h2>Risks</h2>");
    assert.equal(getArtifactVersion(root, made.id, 3, "sam"), null);
    const versions = listArtifactVersions(root, made.id, "sam");
    assert.deepEqual(versions.map(v => v.version), [1, 2]);
    assert.equal(versions[1].createdBy.chatId, "chat-9");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("artifacts: profile fence - another profile cannot read, list, or update", () => {
  const root = scratch();
  try {
    const made = createArtifact(root, { profile: "dip", title: "Private brief", kind: "markdown", content: "# Private" });
    assert.equal(getArtifact(root, made.id, "sam"), null);
    assert.deepEqual(listArtifacts(root, "sam"), []);
    assert.deepEqual(listArtifactVersions(root, made.id, "sam"), []);
    assert.throws(() => updateArtifact(root, made.id, { profile: "sam", content: "# Stolen" }), /belongs to profile dip/);
    assert.equal(getArtifact(root, made.id, "dip")?.version, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("artifacts: validation names its refusals - kind, title, and the byte cap", () => {
  const root = scratch();
  try {
    assert.throws(() => createArtifact(root, { profile: "sam", title: "X", kind: "deck", content: "hi" }), /Invalid artifact kind/);
    assert.throws(() => createArtifact(root, { profile: "sam", title: "  ", kind: "html", content: "hi" }), /title must be/);
    assert.throws(() => createArtifact(root, { profile: "sam", title: "X", kind: "html", content: " " }), /must not be empty/);
    const over = "x".repeat(ARTIFACT_CONTENT_MAX_BYTES + 1);
    assert.throws(
      () => createArtifact(root, { profile: "sam", title: "Big", kind: "markdown", content: over }),
      new RegExp("over the per-artifact cap of " + String(ARTIFACT_CONTENT_MAX_BYTES) + " bytes \\(ARTIFACT_CONTENT_MAX_BYTES\\)"),
    );
    assert.deepEqual(listArtifacts(root, "sam"), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("artifacts: markdown rendering escapes markup before applying its small formatting set", () => {
  const html = renderMarkdownArtifact("# Title\n\nHello **world** and `code`.\n\n- one\n- two\n\n<script>alert(1)</script>");
  assert.match(html, /<h1>Title<\/h1>/);
  assert.match(html, /<strong>world<\/strong>/);
  assert.match(html, /<code>code<\/code>/);
  assert.match(html, /<li>one<\/li><li>two<\/li>/);
  assert.ok(!html.includes("<script>"), "raw markup from a document must never reach the shell");
  assert.match(html, /&lt;script&gt;/);
});

test("artifacts: the reading shell sandboxes html and the content CSP forbids the network", () => {
  const root = scratch();
  try {
    const made = createArtifact(root, { profile: "sam", title: "Page", kind: "html", content: "<h1>Hi</h1><script>1</script>" });
    const shell = artifactReadingHtml(getArtifact(root, made.id, "sam")!, listArtifactVersions(root, made.id, "sam"));
    assert.match(shell, new RegExp('sandbox="' + ARTIFACT_FRAME_SANDBOX + '"'));
    assert.ok(!shell.includes("<script>1</script>"), "artifact html never rides the shell's own document");
    assert.match(shell, new RegExp("/content\\?version=1"));
    assert.match(ARTIFACT_CONTENT_CSP, /connect-src 'none'/);
    assert.match(ARTIFACT_CONTENT_CSP, /default-src 'none'/);
    assert.match(ARTIFACT_CONTENT_CSP, /form-action 'none'/);
    assert.ok(!/allow-same-origin/.test(ARTIFACT_FRAME_SANDBOX));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("artifacts: a dead store ledgers ONE artifact-failed line and the read fails closed", () => {
  const root = scratch();
  try {
    mkdirSync(join(root, ".sam"), { recursive: true });
    // A directory where the database file belongs: every open dies.
    mkdirSync(join(root, ".sam", "artifacts.db"));
    assert.throws(() => listArtifacts(root, "sam"));
    const ledger = readActivity(root, 10, { kind: "artifact-failed" });
    assert.equal(ledger.length, 1);
    assert.match(ledger[0].summary, /^Artifact read failed:/);
    assert.deepEqual(classifyDefect(ledger[0]), { key: "artifact-failed:read", label: "artifact store failures (read step)" });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
