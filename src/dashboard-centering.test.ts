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
// chat (provisional title from the message, then SAM names it properly from
// the exchange) and proceeds. The create call must carry the dashboard
// request header the server requires; without it the server refuses and the
// send silently died (the live bug behind Dip's 2026-11-14 "button isn't
// fixed" catch).
test("first send from the empty state creates the chat instead of demanding one", () => {
  assert.ok(!dashboardHtml.includes("Create a chat first"), "no create-first dead end");
  assert.ok(dashboardHtml.includes("body:JSON.stringify({title:provisionalTitle(content)})"), "send auto-creates with a provisional title");
  assert.ok(dashboardHtml.includes("/chats',{method:'POST',headers:{'Content-Type':'application/json','X-SAM-Request':'dashboard'},body:JSON.stringify({title:provisionalTitle(content)})"), "auto-create carries the required dashboard header");
});
