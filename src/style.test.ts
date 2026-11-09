import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PLAIN_STYLE_INSTRUCTION } from "./style.js";
import { composeSystemPrompt } from "./standing-files.js";

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
  assert.ok(src.includes("style:PLAIN_STYLE_INSTRUCTION"), "agent-turn passes the plain-style default into the tier assembly");
  assert.ok(src.includes("composeSystemPrompt"), "agent-turn assembles its system prompt through the tier composer");
  // The composer is the ordering contract now (Phase A tiers): style in
  // the head, the role line in the context tier, law in the volatile
  // tail - so law can still override style.
  const prompt = composeSystemPrompt({
    base: "BASE", style: PLAIN_STYLE_INSTRUCTION, stable: "",
    role: "Adopt the role of agent x: do things", context: "",
    volatile: "", law: "Standing law for this profile: be terse",
  });
  const styleAt = prompt.indexOf("asterisk emphasis");
  const roleAt = prompt.indexOf("Adopt the role of agent");
  const lawAt = prompt.indexOf("Standing law for this profile");
  assert.ok(styleAt > 0 && roleAt > styleAt && lawAt > roleAt, "style precedes profile instructions and law");
});
