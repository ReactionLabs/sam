import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readActivity } from "./activity.js";
import { codeWrites, setCodeRoot } from "./code.js";
import { ownToolsChat } from "./own-tools.js";
import { OWNER_CHAT_BUDGET, OWNER_CHAT_CEILING } from "./budgets.js";
import { CODE_SEARCH_LIMIT, REACH_CALL_LIMIT, TurnEconomyGuard, isCodeSearchCall, scratchScriptPath } from "./loop-guards.js";
import type { OpenAICompatibleProvider } from "./openai-compatible.js";

// Turn economy (Dip ruling 2026-11-15, after chat afb0f1ef):
// a conversational question escalated itself into ~23 reach
// calls, then three turns of sam_code spelunking that wrote
// throwaway grep scripts into the code root. The box's write
// ledger is the inventory: 63 of 63 recorded code-root writes
// are created sam-*.py scratch scripts - the pattern these
// tests pin as refused/cut, while a genuine in-chat fix (read,
// edit, verify) runs end to end untouched.

test("turn-economy: the scratch signature is name shape only - sam-* scripts anywhere, search-y scripts at the top level", () => {
  assert.equal(scratchScriptPath("sam-grep-phrase.py"), true);
  assert.equal(scratchScriptPath("sam-find-orch2.py"), true);
  assert.equal(scratchScriptPath("tools/sam_scan.py"), true);
  assert.equal(scratchScriptPath("find-routes.py"), true);
  assert.equal(scratchScriptPath("grep_it.sh"), true);
  assert.equal(scratchScriptPath("src/search.py"), false);
  assert.equal(scratchScriptPath("src/sam-helper.ts"), false);
  assert.equal(scratchScriptPath("sam-notes.md"), false);
  assert.equal(scratchScriptPath("scripts/install.sh"), false);
  assert.equal(scratchScriptPath("src/index.py"), false);
  assert.equal(scratchScriptPath(""), false);
});

test("turn-economy: code-search calls are the digging verbs; verify runs and sandbox work are not digging", () => {
  assert.equal(isCodeSearchCall("sam_code", { action: "list", path: "." }), true);
  assert.equal(isCodeSearchCall("sam_code", { action: "read", path: "src/a.ts" }), true);
  assert.equal(isCodeSearchCall("sam_code", { action: "python", path: "sam-x.py" }), true);
  assert.equal(isCodeSearchCall("sam_code", { action: "python", path: "x.py", sandbox: "scratch" }), false);
  assert.equal(isCodeSearchCall("sam_code", { action: "run", command: "git-diff" }), true);
  assert.equal(isCodeSearchCall("sam_code", { action: "run", command: "build" }), false);
  assert.equal(isCodeSearchCall("sam_code", { action: "run", command: "test" }), false);
  assert.equal(isCodeSearchCall("sam_code", { action: "write", path: "a.py" }), false);
  assert.equal(isCodeSearchCall("sam_code", { action: "status" }), false);
  assert.equal(isCodeSearchCall("sam_reach", { action: "read" }), false);
});

test("turn-economy guard: refusal is creation-shaped, wires trip once, the grant is behavioral", () => {
  const missing = () => false;
  const present = () => true;
  const guard = new TurnEconomyGuard();
  const refused = guard.decide("sam_code", { action: "write", path: "sam-scan.py", content: "x" }, missing);
  assert.ok(refused && /Scratch script write refused/.test(refused.stub));
  assert.equal(refused?.ledger?.kind, "scratch-write-refused");
  // The same name over an existing file is project work.
  assert.equal(guard.decide("sam_code", { action: "write", path: "sam-scan.py", content: "x" }, present), null);
  // A real new source file is not scratch.
  assert.equal(guard.decide("sam_code", { action: "write", path: "src/feature.ts", content: "x" }, missing), null);
  // The spelunk wire: the limit runs, the next is stubbed with
  // exactly one ledger line across repeated trips.
  for (let i = 0; i < CODE_SEARCH_LIMIT; i++) assert.equal(guard.decide("sam_code", { action: "read", path: "src/f" + i + ".ts" }, missing), null);
  const trip = guard.decide("sam_code", { action: "read", path: "src/more.ts" }, missing);
  assert.ok(trip && /Code digging stopped/.test(trip.stub));
  assert.equal(trip?.ledger?.kind, "spelunk-tripwire");
  assert.ok(trip?.steer && /Turn economy/.test(trip.steer));
  const tripAgain = guard.decide("sam_code", { action: "list", path: "src" }, missing);
  assert.ok(tripAgain && tripAgain.ledger === undefined);
  // The grant: a landed edit earns the digging back.
  guard.noteSuccess("sam_code", { action: "edit", path: "src/f0.ts" });
  assert.equal(guard.decide("sam_code", { action: "read", path: "src/after.ts" }, missing), null);
  // And so does a coding job queued through the sanctioned door.
  const handed = new TurnEconomyGuard();
  for (let i = 0; i < CODE_SEARCH_LIMIT; i++) handed.decide("sam_code", { action: "read", path: "src/f" + i + ".ts" }, missing);
  handed.noteSuccess("sam_coding_task", { spec: "fix it" });
  assert.equal(handed.decide("sam_code", { action: "read", path: "src/after.ts" }, missing), null);
  // The research wire: same shape, its own counter and ledger kind.
  const research = new TurnEconomyGuard();
  for (let i = 0; i < REACH_CALL_LIMIT; i++) assert.equal(research.decide("sam_reach", { channel: "web", action: "search", query: "q" + i }, missing), null);
  const rTrip = research.decide("sam_reach", { channel: "web", action: "search", query: "one more" }, missing);
  assert.ok(rTrip && /Research calls stopped/.test(rTrip.stub));
  assert.equal(rTrip?.ledger?.kind, "research-tripwire");
});

function fixture() {
  const parent = mkdtempSync(join(tmpdir(), "sam-economy-"));
  const root = join(parent, "home");
  mkdirSync(root, { recursive: true });
  const codeDir = join(parent, "code-root");
  mkdirSync(join(codeDir, "src"), { recursive: true });
  writeFileSync(join(codeDir, "package.json"), JSON.stringify({ name: "fixture", scripts: { build: "node -e \"process.exit(0)\"", test: "node -e \"process.exit(0)\"" } }));
  writeFileSync(join(codeDir, "src", "a.ts"), "export const greeting = \"hello\";\n");
  writeFileSync(join(codeDir, "src", "b.ts"), "export const other = 1;\n");
  for (let i = 1; i <= 8; i++) writeFileSync(join(codeDir, "src", "f" + i + ".ts"), "// MARKER-F" + i + "\nexport const f" + i + " = " + i + ";\n");
  setCodeRoot(root, codeDir);
  return { parent, root, codeDir };
}

type Step = { calls?: Array<{ id: string; name: string; args: Record<string, unknown> }>; content?: string };
function scriptedProvider(steps: Step[], seenTools: string[]) {
  let step = 0;
  let scanned = 0;
  return {
    async completeConnectorTurn(_model: string, messages: Array<Record<string, unknown>>, _tools: unknown[]) {
      // The provider re-sends the full history every round: scan
      // only the tool results that are new since the last call.
      for (const m of messages.slice(scanned)) if (m.role === "tool" && typeof m.content === "string") seenTools.push(m.content);
      scanned = messages.length;
      const current = steps[step++] ?? { content: "I have answered from what I gathered." };
      if (current.calls) return { content: null, calls: current.calls };
      return { content: current.content ?? "I have answered from what I gathered.", calls: [] };
    },
  } as unknown as OpenAICompatibleProvider;
}
const call = (id: string, name: string, args: Record<string, unknown>) => ({ id, name, args });

test("turn-economy in chat: the afb0f1ef replay is cut - scratch writes refused, digging stubbed at the limit, a conversational answer still lands", async () => {
  const { parent, root, codeDir } = fixture();
  try {
    const steps: Step[] = [
      { calls: [call("w1", "sam_code", { action: "write", path: "sam-find-orch.py", content: "import os\nprint('grep the codebase')\n" }), call("w2", "sam_code", { action: "write", path: "sam-grep-phrase.py", content: "print('and again')\n" })] },
      ...Array.from({ length: 8 }, (_, i) => ({ calls: [call("r" + (i + 1), "sam_code", { action: "read", path: "src/f" + (i + 1) + ".ts" })] })),
      { content: "REA is a real-estate assistant repo. The clean way to integrate it with me is through a connector, not by either of us reading the other's code." },
    ];
    const seen: string[] = [];
    const reply = await ownToolsChat(root, "sam", scriptedProvider(steps, seen), "test-model",
      [{ role: "user", content: "https://github.com/morluto/rea how can i heavily integrate this with you?" }],
      undefined, "chat-economy-replay", { ...OWNER_CHAT_BUDGET }, undefined, undefined, undefined, { ...OWNER_CHAT_CEILING });
    // The conversational answer lands.
    assert.match(reply, /clean way to integrate/);
    // No scratch file exists, and no code write was recorded at all.
    assert.deepEqual(readdirSync(codeDir).filter(f => f.endsWith(".py")), []);
    assert.equal(codeWrites(root, 50).length, 0);
    // The model SAW both refusals and the wire's stub (twice:
    // reads 7 and 8), and exactly CODE_SEARCH_LIMIT real reads.
    assert.equal(seen.filter(s => s.includes("Scratch script write refused")).length, 2);
    assert.equal(seen.filter(s => s.includes("Code digging stopped")).length, 2);
    assert.equal(seen.filter(s => s.includes("MARKER-F")).length, CODE_SEARCH_LIMIT);
    // The ledger carries the refusals and exactly one trip line.
    assert.equal(readActivity(root, 200, { kind: "scratch-write-refused" }).length, 2);
    assert.equal(readActivity(root, 200, { kind: "spelunk-tripwire" }).length, 1);
  } finally { rmSync(parent, { recursive: true, force: true }); }
});

test("turn-economy in chat: a genuine coding ask runs end to end - reads past the limit after the edit lands, verify closes clean", async () => {
  const { parent, root, codeDir } = fixture();
  try {
    const steps: Step[] = [
      { calls: [call("r1", "sam_code", { action: "read", path: "src/a.ts" }), call("r2", "sam_code", { action: "read", path: "src/b.ts" })] },
      { calls: [call("e1", "sam_code", { action: "edit", path: "src/a.ts", oldText: "\"hello\"", newText: "\"hello, fixed\"" })] },
      ...Array.from({ length: 5 }, (_, i) => ({ calls: [call("v" + (i + 1), "sam_code", { action: "read", path: "src/f" + (i + 1) + ".ts" })] })),
      { calls: [call("b1", "sam_code", { action: "run", command: "build" }), call("t1", "sam_code", { action: "run", command: "test" })] },
      { content: "Fixed: the greeting in src/a.ts now reads hello, fixed, and build and test both pass." },
    ];
    const seen: string[] = [];
    const reply = await ownToolsChat(root, "sam", scriptedProvider(steps, seen), "test-model",
      [{ role: "user", content: "Fix the greeting in src/a.ts to say hello, fixed, and verify it" }],
      undefined, "chat-economy-fix", { ...OWNER_CHAT_BUDGET }, undefined, undefined, undefined, { ...OWNER_CHAT_CEILING });
    assert.match(reply, /Fixed: the greeting/);
    assert.ok(!/One heads-up/.test(reply), reply);
    assert.ok(readFileSync(join(codeDir, "src", "a.ts"), "utf8").includes("hello, fixed"));
    // Seven reads executed in total - past the wire - because
    // the landed edit granted the digging. No trip, no refusal.
    assert.equal(seen.filter(s => s.includes("MARKER-F")).length, 5);
    assert.equal(seen.filter(s => s.includes("Code digging stopped")).length, 0);
    assert.equal(readActivity(root, 200, { kind: "spelunk-tripwire" }).length, 0);
    assert.equal(readActivity(root, 200, { kind: "scratch-write-refused" }).length, 0);
  } finally { rmSync(parent, { recursive: true, force: true }); }
});

test("turn-economy in chat: the research wire cuts a reach marathon and the turn still answers", async () => {
  const { parent, root } = fixture();
  const previousBin = process.env.SAM_AGENT_REACH_BIN;
  process.env.SAM_AGENT_REACH_BIN = join(parent, "no-such-agent-reach");
  try {
    const steps: Step[] = [
      ...Array.from({ length: REACH_CALL_LIMIT + 2 }, (_, i) => ({ calls: [call("q" + (i + 1), "sam_reach", { channel: "web", action: "search", query: "rea integration angle " + (i + 1) })] })),
      { content: "Here is what the research supports, and where it runs out." },
    ];
    const seen: string[] = [];
    const reply = await ownToolsChat(root, "sam", scriptedProvider(steps, seen), "test-model",
      [{ role: "user", content: "Research every way REA could integrate with you" }],
      undefined, "chat-economy-reach", { ...OWNER_CHAT_BUDGET }, undefined, undefined, undefined, { ...OWNER_CHAT_CEILING });
    assert.match(reply, /what the research supports/);
    assert.equal(seen.filter(s => s.includes("Research calls stopped")).length, 2);
    assert.equal(readActivity(root, 200, { kind: "research-tripwire" }).length, 1);
  } finally {
    if (previousBin === undefined) delete process.env.SAM_AGENT_REACH_BIN; else process.env.SAM_AGENT_REACH_BIN = previousBin;
    rmSync(parent, { recursive: true, force: true });
  }
});

test("turn-economy scope: a turn with no ceiling (a machine route) keeps its contract - the same write executes", async () => {
  const { parent, root, codeDir } = fixture();
  try {
    const steps: Step[] = [
      { calls: [call("w1", "sam_code", { action: "write", path: "sam-scan.py", content: "print('machine turn')\n" })] },
      { content: "Done." },
    ];
    const seen: string[] = [];
    const reply = await ownToolsChat(root, "sam", scriptedProvider(steps, seen), "test-model",
      [{ role: "user", content: "Run the scan" }],
      undefined, "chat-economy-machine", { rounds: 6, maxCalls: 12 });
    assert.match(reply, /Done/);
    assert.equal(existsSync(join(codeDir, "sam-scan.py")), true);
    assert.equal(readActivity(root, 200, { kind: "scratch-write-refused" }).length, 0);
  } finally { rmSync(parent, { recursive: true, force: true }); }
});
