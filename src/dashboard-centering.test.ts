import test from "node:test";
import assert from "node:assert/strict";
import { dashboardHtml } from "./dashboard-ui.js";

// Dip catch 2026-11-14: the empty state rode visibly high on his phone. The
// thread carries a large bottom scroll padding (158px desktop / 132px mobile)
// so bubbles clear the composer, and .empty{margin:auto} centers inside that
// padded box, which lifts the block above the visible center by half the
// padding difference. While the empty state is the only child there is
// nothing to scroll, so its padding goes symmetric and it centers truly.
test("empty state centers in the visible thread area on desktop and mobile", () => {
  assert.ok(dashboardHtml.includes(".thread:has(> .empty){padding-bottom:32px}"), "desktop centering rule present");
  assert.ok(dashboardHtml.includes(".thread:has(> .empty){padding-bottom:16px}"), "mobile centering rule present");
});

// Same screen, same moment: Send with no chat selected used to dead-end on an
// alert demanding a chat be created first. The first send now creates the
// chat (title from the message) and proceeds.
test("first send from the empty state creates the chat instead of demanding one", () => {
  assert.ok(!dashboardHtml.includes("Create a chat first"), "no create-first dead end");
  assert.ok(dashboardHtml.includes("content.slice(0,48)||'New conversation'"), "send auto-creates with a message-derived title");
});
