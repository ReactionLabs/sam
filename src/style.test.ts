import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PLAIN_STYLE_INSTRUCTION } from "./style.js";

// Dip ruling 2026-11-09 09:52 EST: plain style is the base default for every
// profile and install; standing law stays the override layer.
test("plain style instruction carries every element of the ruling", () => {
  const s = PLAIN_STYLE_INSTRUCTION.toLowerCase();
  assert.match(s, /never use bold, italics, or asterisk emphasis/);
  assert.match(s, /plain sentences/);
  assert.match(s, /hyphen list only when listing real items/);
});

test("the instruction itself uses no markdown emphasis", () => {
  assert.ok(!PLAIN_STYLE_INSTRUCTION.includes("*"), "no asterisks in the style text itself");
  assert.ok(!PLAIN_STYLE_INSTRUCTION.includes("#"), "no heading markers");
});

test("agent-turn bakes the style into the base prompt before profile instructions and law", () => {
  const src = readFileSync(new URL("../src/agent-turn.ts", import.meta.url), "utf8");
  const styleAt = src.indexOf("PLAIN_STYLE_INSTRUCTION+");
  assert.ok(styleAt > 0, "base system prompt includes the plain-style default");
  const roleAt = src.indexOf("Adopt the role of agent", styleAt);
  const lawAt = src.indexOf("lawBlock}", styleAt);
  assert.ok(roleAt > styleAt && lawAt > roleAt, "style precedes profile instructions and law, so law can override it");
});
