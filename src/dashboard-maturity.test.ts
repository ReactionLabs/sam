import test from "node:test";
import assert from "node:assert/strict";
import { dashboardHtml } from "./dashboard-ui.js";

// Maturity pass pins (2026-11-14). Each assertion names the defect it guards.

test("stale build and stale token heal through one loop-guarded bounce", () => {
  assert.ok(dashboardHtml.includes("const PAGE_BUILD='__SAM_BUILD_ID__'"), "page carries its build id placeholder");
  assert.ok(dashboardHtml.includes("d.buildId!==PAGE_BUILD"), "status poll compares build ids");
  assert.ok(dashboardHtml.includes("function rekeyOnce()"), "single rekey path");
  assert.ok(dashboardHtml.includes("r.status===401||r.status===403||(r.status===404&&!d)"), "safe() rekeys on auth loss and token-shaped 404s");
});

test("connection indicator is honest and tappable", () => {
  assert.ok(dashboardHtml.includes('id="connection" title="Connection status. Tap to retry."'), "connection carries a retry hint");
  assert.ok(dashboardHtml.includes("el('connection').onclick=()=>refresh();"), "tapping the indicator retries the status fetch");
  assert.ok(dashboardHtml.includes("el('connection').textContent='● Offline';"), "offline text matches the online shape");
});

test("first exchange earns a Sam-given name", () => {
  assert.ok(dashboardHtml.includes("function provisionalTitle("), "provisional title heuristic exists");
  assert.ok(dashboardHtml.includes("/autotitle'"), "page asks the server to name the chat after the first exchange");
  // Turn behavior (2026-11-14): the reply is asynchronous now (the message queues and the turn drains in the background), so naming is armed at send and fired by the queue watch when the first reply lands.
  assert.ok(dashboardHtml.includes("pendingAutotitle={chatId:selected,firstMessage:content};"), "naming is armed when the auto-created chat sends");
  assert.ok(dashboardHtml.includes("nameChatFromExchange(pa.chatId,pa.firstMessage);"), "naming runs after the first reply lands");
});

test("daily paths have no prompt dialogs left", () => {
  for (const gone of ["prompt('Chat name'", "prompt('Chat options", "prompt('Rename chat'", "prompt('Branch name'", "alert('Select a chat first')"]) {
    assert.ok(!dashboardHtml.includes(gone), "removed: " + gone);
  }
  assert.ok(dashboardHtml.includes("function toast("), "errors surface as toasts");
  assert.ok(dashboardHtml.includes("className='chatsheet'"), "chat options are an inline sheet");
  assert.ok(dashboardHtml.includes("function startRename("), "rename is inline in the chat row");
});

test("composer maturity: desktop Enter, auto-grow, honest busy state", () => {
  assert.ok(dashboardHtml.includes("window.innerWidth>820"), "Enter sends on desktop widths only");
  assert.ok(dashboardHtml.includes("function autogrow()"), "textarea auto-grows");
  assert.ok(dashboardHtml.includes("Math.min(t.scrollHeight,180)"), "auto-grow is capped");
  // Turn behavior (2026-11-14): the composer never locks while Sam works (messages queue instead), and the placeholder stays honest about the state without disabling the send.
  assert.ok(dashboardHtml.includes("Sam is working - yours will queue and be seen"), "working state is honest in the composer, and the composer stays open");
});

test("header and bubbles cannot collide", () => {
  assert.ok(dashboardHtml.includes("#title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"), "header title truncates inside its flex space");
  assert.ok(dashboardHtml.includes(".bubble{padding-right:38px}"), "copy chip never sits on message text");
  assert.ok(dashboardHtml.includes(".main{min-width:0}"), "the main grid column can shrink below a long title's min-content (no page blowout)");
});

test("opening a chat lands on the newest message, and readers are never yanked", () => {
  assert.ok(dashboardHtml.includes("function pinToBottom()"), "bounded pin helper exists");
  const open = dashboardHtml.slice(dashboardHtml.indexOf("async function openChat("), dashboardHtml.indexOf("async function createChat()"));
  // Turn behavior (2026-11-14): thread rendering was extracted into renderThreadData (shared with the queue watch); the ordering intent is unchanged.
  assert.ok(open.indexOf("setView('talk')") < open.indexOf("renderThreadData(data)"), "mobile view is revealed before rendering, not after");
  assert.ok(open.includes("threadPinned=true;pinToBottom();"), "openChat pins to the newest message at the end");
  assert.ok(dashboardHtml.includes("if(threadPinned)el('thread').scrollTop=el('thread').scrollHeight;"), "append scrolls respect a scrolled-up reader");
  assert.ok(dashboardHtml.includes("lastJumpAt=Date.now();const m="), "citation deep links suppress the pin");
});
