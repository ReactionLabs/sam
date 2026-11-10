import test from "node:test";
import assert from "node:assert/strict";
import { dashboardHtml } from "./dashboard-ui.js";

// Regression guard (2026-11-08): a newline escape written into the page
// template shipped a literal line break inside a JS string, the whole inline
// script failed to parse, and the dashboard rendered but was completely dead
// (stuck on Connecting, unclickable chats) while every server check passed.
// The served script must always parse.
test("dashboard page: the inline script parses as valid JavaScript",()=>{
  const match=/<script>([\s\S]*)<\/script>/.exec(dashboardHtml);
  assert.ok(match,"script block present");
  assert.doesNotThrow(()=>{new Function(match[1]);});
  assert.match(dashboardHtml,/id="configPanel"/);
  assert.match(dashboardHtml,/id="toBottom"/);
});

test("dashboard page: model routing + spend surface (P11)",()=>{
  assert.match(dashboardHtml,/id="usage"/);
  assert.match(dashboardHtml,/function renderUsage\(/);
  assert.match(dashboardHtml,/Model &amp; spend/);
});

test("dashboard page: drafts + contacts surface (P12)",()=>{
  assert.match(dashboardHtml,/id="drafts"/);
  assert.match(dashboardHtml,/id="contacts"/);
  assert.match(dashboardHtml,/function renderDrafts\(/);
  assert.match(dashboardHtml,/Drafts \(you send these\)/);
});

test("dashboard page: owner console surfaces (P8) - law revoke, approvals history, activity filter",()=>{
  // Law is a control surface now, not a flat <pre>: a container the script
  // fills with per-law Revoke buttons wired to the dashboard revoke route.
  assert.match(dashboardHtml,/id="laws" class="appr"/);
  assert.match(dashboardHtml,/function renderLaws\(/);
  assert.match(dashboardHtml,/function revokeLawUi\(/);
  assert.match(dashboardHtml,/preferences\/'\+id\+'\/revoke/);
  // Decided approvals get their own history view beside the pending queue.
  assert.match(dashboardHtml,/id="approvalHistory"/);
  assert.match(dashboardHtml,/function renderApprovalHistory\(/);
  // Agent activity can be narrowed to one profile, server-side.
  assert.match(dashboardHtml,/id="activityFilter"/);
  assert.match(dashboardHtml,/function renderActivityFilter\(/);
  assert.match(dashboardHtml,/\?actor=/);
});

test("dashboard page: copy/paste path hardened for touch (defect 2026-11-09 18:00)",()=>{
  // The fallback runs synchronously inside the tap (iOS keeps user
  // activation only for the synchronous path): a readonly textarea,
  // explicitly selected with setSelectionRange, copied via execCommand
  // whose result is CHECKED - never an unconditional Copied claim.
  assert.match(dashboardHtml,/function fallbackCopyText\(text\)/);
  assert.match(dashboardHtml,/ta\.readOnly=true/);
  assert.match(dashboardHtml,/ta\.setSelectionRange\(0,text\.length\)/);
  assert.match(dashboardHtml,/ok=document\.execCommand\('copy'\)/);
  const copyFn=/async function copyText[\s\S]*?\nfunction copyButton/.exec(dashboardHtml);
  assert.ok(copyFn,"copyText present");
  assert.ok(copyFn[0].indexOf("fallbackCopyText(text)")<copyFn[0].indexOf("navigator.clipboard.writeText"),"fallback is attempted before the async clipboard API");
  assert.match(dashboardHtml,/Long-press text to copy/);
  // The affordance is a labeled, plainly tappable pill, not a faint icon.
  assert.match(dashboardHtml,/\.bubble \.copy\{[^}]*min-height:36px/);
  assert.match(dashboardHtml,/document\.createTextNode\(' Copy'\)/);
  // Text selection is never eaten: bubbles and their text spans carry
  // explicit selection + touch-callout CSS.
  assert.match(dashboardHtml,/\.bubble \.msgtext[^}]*-webkit-touch-callout:default/);
  // send() must never overwrite a bubble with textContent again - that
  // destroyed the copy button on every live reply. It updates through
  // the bubble setter, and the setter keeps the copy closure current.
  assert.doesNotMatch(dashboardHtml,/lastElementChild\.textContent/);
  assert.match(dashboardHtml,/pending\.setText\(d\.reply\.content\)/);
  assert.match(dashboardHtml,/setText\(next\)\{holder\.text=next/);
  // Team (agent) messages carry the same affordance.
  assert.match(dashboardHtml,/copyButton\(\(\)=>event\.content\)/);
});

test("dashboard page: chat rail shows unread dots, last-message times, and an archived view",()=>{
  // Unread state is per-browser (localStorage), baselined on first
  // sight so old chats do not all flare at once; opening a chat
  // marks it seen; each row carries its last-message time.
  assert.match(dashboardHtml,/samSeenChats/);
  assert.match(dashboardHtml,/markSeen\(id\)/);
  assert.match(dashboardHtml,/udot/);
  assert.match(dashboardHtml,/relWhen\(c\.lastMessageAt\)/);
  // Cleanup lives in the chat options menu: archive for live
  // chats, unarchive for archived ones, behind the Archived
  // toggle - never a delete.
  assert.match(dashboardHtml,/chat\.archived\?'Unarchive':'Archive'/);
  assert.match(dashboardHtml,/archtoggle/);
  assert.match(dashboardHtml,/lastArchivedItems/);
});

test("dashboard page: sidebar sections actually navigate (owner defect 2026-11-09)",()=>{
  // The Skills/Missions/Schedules/Activity nav items scrolled to blocks in
  // the right rail, which on the phone layout only exists inside the
  // Activity view - from any other view the tap scrolled a hidden element
  // and read as dead. showSection must switch to the containing view on
  // narrow screens, then scroll and flash the target block.
  assert.match(dashboardHtml,/function showSection\(id\)\{const node=el\(id\);if\(!node\)return;/);
  assert.match(dashboardHtml,/matchMedia\('\(max-width:820px\)'\)/);
  assert.match(dashboardHtml,/setView\('activity'\)/);
  assert.match(dashboardHtml,/classList\.add\('flash'\)/);
  assert.match(dashboardHtml,/\.info\.flash\{box-shadow:0 0 0 2px #e8ae65\}/);
  // The Skills block renders readable rows, not a JSON dump.
  assert.match(dashboardHtml,/No skills installed yet/);
  assert.doesNotMatch(dashboardHtml,/\['missions','skills','schedules','logs'\]/);
});
