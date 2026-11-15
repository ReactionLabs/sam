import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readActivity } from "./activity.js";
import { setCodeRoot } from "./code.js";
import { ownToolsChat } from "./own-tools.js";
import { closeReadsAsToolLedger, createTurnControl, deadlineCloseNote, ownerAskForClose, turnDeadlineFallbackAnswer } from "./turn-control.js";
import type { OpenAICompatibleProvider } from "./openai-compatible.js";

// Owner-facing close-outs (Dip live catch, 2026-11-15 ~09:33
// EST, chat afb0f1ef "Integrating REA with the Assistant"):
// a deadline-closed turn saved the machinery checkpoint
// verbatim - "Work that ran before the stop: sam_code,
// sam_code, sam_reach, ..." - with a verification bookkeeping
// block stapled to it. The close-out is an owner summary now:
// what Sam was asked to do, what state the work is in, and
// the next step. The per-tool ledger and the verification
// bookkeeping live in the activity record, never the bubble.
// These tests pin both halves: the saved message carries no
// tool-name ledger and no "Verification note" text, and the
// ledger still carries the bookkeeping.

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

test("closeout: the deterministic deadline close is a plain owner summary built from the ask", () => {
  const text = turnDeadlineFallbackAnswer("https://github.com/morluto/rea how can i heavily integrate this with you?");
  assert.match(text, /stopped that turn at its time limit/);
  assert.ok(text.includes("how can i heavily integrate this with you?"), text);
  assert.ok(!/sam_[a-z_]+/.test(text), text);
  assert.ok(!/Verification note/.test(text), text);
  assert.ok(!/Work that ran before the stop/.test(text), text);
  assert.match(text, /Send the next message/);
  // No ask available: still coherent, still plain.
  const bare = turnDeadlineFallbackAnswer("");
  assert.match(bare, /stopped that turn at its time limit/);
  assert.ok(!bare.includes("You asked"), bare);
});

test("closeout: the ask extraction strips provenance, takes the latest owner words, and caps the length", () => {
  const messages = [
    { role: "system", content: "system prompt" },
    { role: "user", content: "[metadata source=dashboard]\nfirst ask" },
    { role: "assistant", content: "an answer" },
    { role: "user", content: "  second   ask\nwith whitespace  " },
    { role: "system", content: "Time check..." },
  ];
  assert.equal(ownerAskForClose(messages), "second ask with whitespace");
  assert.equal(ownerAskForClose([{ role: "user", content: "[metadata source=telegram]\nhello there" }]), "hello there");
  const long = ownerAskForClose([{ role: "user", content: "word ".repeat(80).trim() }]);
  assert.ok(long.length <= 181 && long.endsWith("…"), long);
  assert.equal(ownerAskForClose([{ role: "system", content: "only system" }]), "");
});

test("closeout: a run of tool names reads as a ledger; a passing mention does not", () => {
  const executed = ["sam_code", "sam_code", "sam_reach", "sam_workspace_list"];
  assert.equal(closeReadsAsToolLedger("Work that ran: sam_code, sam_reach, sam_workspace_list, sam_code.", executed), true);
  assert.equal(closeReadsAsToolLedger("I used sam_code to write the file, then checked it twice with sam_code.", executed), false);
  assert.equal(closeReadsAsToolLedger("I listed your workspace and read the file you named.", executed), false);
  assert.equal(closeReadsAsToolLedger("sam_code sam_code sam_code", executed), false);
});

test("closeout: the deadline synthesis note demands the owner's terms and forbids tool names", () => {
  const note = deadlineCloseNote();
  assert.match(note, /owner's own terms/);
  assert.match(note, /Never name a tool/);
  assert.match(note, /next step/);
});

function codeFixture() {
  const parent = mkdtempSync(join(tmpdir(), "sam-closeout-"));
  const root = join(parent, "home");
  mkdirSync(root, { recursive: true });
  const codeDir = join(parent, "code-root");
  mkdirSync(codeDir, { recursive: true });
  writeFileSync(join(codeDir, "package.json"), JSON.stringify({ name: "fixture", scripts: { build: "node -e \"process.exit(0)\"", test: "node -e \"process.exit(0)\"" } }));
  setCodeRoot(root, codeDir);
  return { parent, root };
}

// A model that writes code, then keeps listing the workspace
// slowly enough for the turn's deadline to trip; the tool-free
// close-out call either dies (mode "throw") or composes a
// tool-ledger text (mode "ledger"). Either way the saved
// message must be the plain deterministic close.
function deadlineStub(mode: "throw" | "ledger") {
  let step = 0;
  return {
    async completeConnectorTurn(_model: string, _messages: Array<Record<string, unknown>>, tools: unknown[]) {
      step++;
      if (tools.length === 0) {
        if (mode === "throw") throw new Error("provider died mid-close");
        return { content: "Work that ran before the stop: sam_code, sam_code, sam_reach, sam_workspace_list, sam_code. Nothing was deleted, and the turn is on my activity record.", calls: [] };
      }
      if (step === 1) return { content: null, calls: [{ id: "c1", name: "sam_code", args: { action: "write", path: "a.txt", content: "hello" } }] };
      await sleep(150);
      return { content: null, calls: [{ id: "c" + step, name: "sam_workspace_list", args: {} }] };
    },
  } as unknown as OpenAICompatibleProvider;
}

for (const mode of ["throw", "ledger"] as const) {
  test("closeout: a deadline-closed turn saves no tool ledger and no verification block (synthesis " + mode + ")", async () => {
    const { parent, root } = codeFixture();
    try {
      const chatId = "chat-closeout-" + mode;
      const control = createTurnControl(root, chatId, { deadlineMs: 250 });
      const fake = deadlineStub(mode);
      const reply = await ownToolsChat(root, "sam", fake, "test-model",
        [{ role: "user", content: "Please write a.txt for me and keep polishing it" }],
        undefined, chatId, { rounds: 40, maxCalls: 80 }, undefined, undefined, undefined, null, undefined, control);
      // The saved close is the plain owner summary.
      assert.match(reply, /stopped that turn at its time limit/);
      assert.ok(reply.includes("write a.txt for me"), reply);
      assert.match(reply, /Send the next message/);
      // No tool-name ledger, no verification block - even
      // though this turn changed code and closed unverified,
      // the exact stack from Dip's screenshot.
      assert.ok(!/sam_[a-z_]+/.test(reply), reply);
      assert.ok(!/Verification note/.test(reply), reply);
      assert.ok(!/Work that ran before the stop/.test(reply), reply);
      assert.ok(!reply.includes("(unverified:"), reply);
      // The one plain owner sentence about the unverified
      // change is allowed and present.
      assert.match(reply, /One heads-up: I changed code this turn and it has not been verified yet/);
      // The bookkeeping is NOT lost: the activity ledger
      // carries the per-tool deadline record and the
      // verification state with the pending file named.
      const deadlineLines = readActivity(root, 100, { kind: "turn-deadline" });
      assert.ok(deadlineLines.length >= 1, "the deadline trip is ledgered");
      assert.ok(deadlineLines.some(l => l.summary.includes("sam_code")), deadlineLines.map(l => l.summary).join(" | "));
      const loopLines = readActivity(root, 100, { kind: "loop-check" });
      assert.equal(loopLines.length, 1);
      assert.match(loopLines[0].summary, /a\.txt/);
    } finally { rmSync(parent, { recursive: true, force: true }); }
  });
}
