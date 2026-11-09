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
