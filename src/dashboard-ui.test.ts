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
