import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { colorizeHelp, colorizeJson, grooveEnabled, makeTheme, stripAnsi } from "./theme.js";

const tty = { isTTY: true };
const pipe = { isTTY: false };

test("theme: the groove decision is TTY-only and honors NO_COLOR and SAM_PLAIN", () => {
  assert.equal(grooveEnabled({}, tty), true);
  assert.equal(grooveEnabled({}, pipe), false);
  assert.equal(grooveEnabled({}, {}), false, "no TTY flag, no paint");
  assert.equal(grooveEnabled({ NO_COLOR: "1" }, tty), false);
  assert.equal(grooveEnabled({ NO_COLOR: "" }, tty), false, "NO_COLOR disables by presence, any value");
  assert.equal(grooveEnabled({ SAM_PLAIN: "1" }, tty), false);
  assert.equal(grooveEnabled({ SAM_PLAIN: "0" }, tty), true, "only SAM_PLAIN=1 forces plain");
});

test("theme: when off, every helper is the identity and shapes are unchanged", () => {
  const theme = makeTheme(false);
  assert.equal(theme.on, false);
  assert.equal(theme.ok("SAM initialized at /x"), "SAM initialized at /x");
  assert.equal(theme.lead("SAM dashboard: http://127.0.0.1:4317/dashboard/abc"), "SAM dashboard: http://127.0.0.1:4317/dashboard/abc");
  assert.equal(theme.dim("Read-only local dashboard."), "Read-only local dashboard.");
  assert.equal(theme.sectionHeader("Model", "ready"), "== Model (ready) ==");
  assert.equal(theme.divider(), "");
  const doc = JSON.stringify({ a: 1 }, null, 2);
  assert.equal(theme.json(doc), doc);
  assert.equal(theme.help("Usage: sam [options]"), "Usage: sam [options]");
});

test("theme: when on, helpers paint without changing a single word", () => {
  const theme = makeTheme(true);
  for (const line of [theme.ok("done"), theme.lead("starting"), theme.dim("quiet")]) {
    assert.ok(line.includes("\x1b["), "painted");
  }
  assert.equal(stripAnsi(theme.ok("done")), "✦ done");
  assert.equal(stripAnsi(theme.lead("starting")), "starting");
  assert.equal(stripAnsi(theme.dim("quiet")), "quiet");
  assert.equal(stripAnsi(theme.sectionHeader("Model", "ready")), "== Model == (ready)");
  assert.ok(theme.divider().includes("✶"));
});

test("theme: JSON paint wraps tokens only - stripped output is byte-identical", () => {
  const value = {
    name: "S.A.M.",
    count: 42,
    ratio: 1.25,
    big: 1e21,
    negative: -7,
    ready: true,
    missing: null,
    nested: { list: ["a:b", "quote \"inside\"", 0, false], empty: {} },
    tricky: "not a number 123 and not a bool true",
  };
  const pretty = JSON.stringify(value, null, 2);
  const painted = colorizeJson(pretty);
  assert.ok(painted.includes("\x1b[38;2;"), "paint present");
  assert.equal(stripAnsi(painted), pretty, "stripping the paint returns the exact document");
  assert.deepEqual(JSON.parse(painted.replace(/\x1b\[[0-9;]*m/g, "")), value);
  assert.equal(colorizeJson("{}"), "{}");
  assert.equal(colorizeJson("[]"), "[]");
});

test("theme: help paint wraps structure only - stripped output is byte-identical", () => {
  const help = [
    "Usage: sam [options] [command]",
    "",
    "S.A.M. | Secret Agent Man mission commander",
    "",
    "Options:",
    "  --workspace <path>  Workspace directory",
    "  -h, --help          display help for command",
    "",
    "Commands:",
    "  doctor              Diagnose stores",
    "  status              Show status",
    "",
  ].join("\n");
  const painted = colorizeHelp(help);
  assert.ok(painted.includes("\x1b[38;2;"), "paint present");
  assert.equal(stripAnsi(painted), help, "stripping the paint returns the exact help text");
});

test("theme: piped CLI output carries zero ANSI bytes, in every mode", () => {
  const workspace = mkdtempSync(join(tmpdir(), "sam-theme-"));
  const cli = fileURLToPath(new URL("./cli.js", import.meta.url));
  const run = (args: string[], env: NodeJS.ProcessEnv = {}) => {
    const result = spawnSync(process.execPath, [cli, "--workspace", workspace, ...args], {
      encoding: "utf8",
      env: { ...process.env, ...env },
    });
    return result;
  };
  try {
    run(["init"]);
    for (const args of [["overview"], ["status"], ["doctor"], ["--help"], ["chats", "list"], ["config", "sections"]]) {
      const piped = run(args);
      assert.ok(!piped.stdout.includes("\x1b"), `no ANSI in piped ${args.join(" ")}`);
      assert.ok(!piped.stderr.includes("\x1b"), `no ANSI on stderr for piped ${args.join(" ")}`);
    }
    // Deterministic commands: the plain-forcing env vars change nothing.
    for (const args of [["status"], ["--help"], ["chats", "list"], ["config", "sections"]]) {
      const piped = run(args);
      const forced = run(args, { SAM_PLAIN: "1", NO_COLOR: "1" });
      assert.equal(forced.stdout, piped.stdout, `SAM_PLAIN/NO_COLOR leave piped ${args.join(" ")} untouched`);
    }
    const parsed = JSON.parse(run(["overview"]).stdout);
    assert.equal(typeof parsed, "object", "piped overview is still plain JSON a script can parse");
    const jsonFlag = run(["overview", "--json"]);
    assert.ok(!jsonFlag.stdout.includes("\x1b"), "no ANSI in --json output");
    const parsedJson = JSON.parse(jsonFlag.stdout);
    delete parsed.at; delete parsedJson.at;
    assert.deepEqual(parsedJson, parsed, "--json and human modes carry the same payload shape");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("theme: the banner splash stays escape-free when stdout is not a TTY", () => {
  const cli = fileURLToPath(new URL("./cli.js", import.meta.url));
  const result = spawnSync(process.execPath, [cli, "tui", "--banner"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!result.stdout.includes("\x1b"), "piped splash is plain blocks, no escapes");
  assert.match(result.stdout, /Self-directed AI Workforce/);
});
