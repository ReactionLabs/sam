import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dashboardHtml } from "./dashboard-ui.js";
import { ChatStore } from "./chats.js";
import { executeOwnTool, ownToolsFor } from "./own-tools.js";
import { getArtifact } from "./artifacts.js";

test("dashboard page: the artifacts library and chat affordance are wired", () => {
  assert.match(dashboardHtml, /id="navArtifacts"/);
  assert.match(dashboardHtml, /id="artifactsView" class="manage" hidden/);
  assert.match(dashboardHtml, /function showArtifacts\(/);
  assert.match(dashboardHtml, /function renderArtifacts\(/);
  assert.match(dashboardHtml, /function artifactCard\(/);
  assert.match(dashboardHtml, /data-tab="artifacts"/);
  assert.match(dashboardHtml, /Open artifact/);
});

test("own tools: sam_artifact creates and revises in a live owner chat, visitors refused", () => {
  const root = mkdtempSync(join(tmpdir(), "sam-artifact-tool-"));
  try {
    const db = new ChatStore(root);
    const chat = db.create("Deliverables", null);
    const visitor = db.create("Door chat", null, { visitor: true });
    db.close();
    const made = executeOwnTool(root, "sam", "sam_artifact", {
      action: "create", title: "Field brief", kind: "markdown",
      content: "# Field brief\n\nThe launch code is 47-ALPHA.",
    }, chat.id, "msg-1") as { status: string; id: string; version: number; path: string };
    assert.equal(made.status, "created");
    assert.equal(made.version, 1);
    assert.equal(made.path, "/artifact/" + made.id);
    const revised = executeOwnTool(root, "sam", "sam_artifact", {
      action: "update", id: made.id,
      content: "# Field brief\n\nThe launch code is 47-ALPHA.\n\n## Risks\n\nRain.",
    }, chat.id, "msg-2") as { status: string; id: string; version: number };
    assert.equal(revised.status, "updated");
    assert.equal(revised.id, made.id);
    assert.equal(revised.version, 2);
    assert.match(getArtifact(root, made.id, "sam")!.content, /## Risks/);
    const refused = executeOwnTool(root, "sam", "sam_artifact", {
      action: "create", title: "Nope", kind: "html", content: "<p>x</p>",
    }, visitor.id, "msg-3") as { error: string };
    assert.match(refused.error, /Visitors cannot make artifacts/);
    const noChat = executeOwnTool(root, "sam", "sam_artifact", {
      action: "create", title: "Nope", kind: "html", content: "<p>x</p>",
    }) as { error: string };
    assert.match(noChat.error, /live owner chat/);
    const names = ownToolsFor(root).map(t => (t as { function: { name: string } }).function.name);
    assert.ok(names.includes("sam_artifact"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
