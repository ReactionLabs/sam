import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readActivity } from "./activity.js";
import { classifyProposal, saveApprovalPolicy } from "./approval-policy.js";
import { addConnector } from "./connectors.js";
import {
  buildPythonEnv, cloneIntoCodeRoot, codeCommandNames, codeCommandSpec, createSandbox, destroySandbox,
  gitCloneSpec, installSandboxPackage, listSandboxes, python3Available, registeredSecretEnvNames,
  runPython, sandboxPipArgv, venvModuleAvailable, venvPythonPath, writeSandboxFile, type CodeRunner,
} from "./code.js";
import { setCodeRoot } from "./code.js";
import { executeOwnToolAsync } from "./own-tools.js";
import { addProvider } from "./providers.js";
import { ChatStore } from "./chats.js";

// Hands v2: git-clone, a Python runner, and SAM-managed sandboxes.
// Network stays out of the suite. A missing python3, venv, or git
// skips that case with a reason instead of failing it.

function fixture() {
  const base = mkdtempSync(join(tmpdir(), "sam-hands-"));
  const sam = join(base, "home");
  const proj = join(base, "proj");
  mkdirSync(sam, { recursive: true });
  mkdirSync(proj, { recursive: true });
  writeFileSync(join(proj, "package.json"), JSON.stringify({ name: "proj", scripts: { build: "true", test: "true" } }));
  setCodeRoot(sam, proj);
  return { base, sam, proj };
}

function gitAvailable(): boolean {
  try { execFileSync("git", ["--version"], { stdio: "ignore" }); return true; } catch { return false; }
}

test("git-clone is an allowlisted name: structured url and destination, no shell, no push", async () => {
  const { base, sam, proj } = fixture();
  try {
    assert.ok(codeCommandNames().includes("git-clone"));
    assert.throws(() => codeCommandSpec(sam, "git-clone"), /needs a url and a destination/);
    assert.throws(() => codeCommandSpec(sam, "git-push"), /Allowlisted commands/);
    const spec = gitCloneSpec(sam, "https://example.com/repo.git", "vendor/lib");
    assert.equal(spec.file, "git");
    assert.deepEqual(spec.args.slice(0, 3), ["clone", "--no-recurse-submodules", "--"]);
    assert.equal(spec.args[3], "https://example.com/repo.git");
    assert.equal(spec.args[4], join(proj, "vendor", "lib"));
    assert.equal(spec.args.includes("push"), false);
    assert.equal(spec.cwd, proj);

    const seen: Array<{ file: string; args: string[] }> = [];
    const runner: CodeRunner = async (file, args) => { seen.push({ file, args: [...args] }); return { exitCode: 0, output: "cloned" }; };
    const result = await cloneIntoCodeRoot(sam, "sam", "https://example.com/repo.git", "vendor/lib", { runner });
    assert.equal(result.ok, true);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].file, "git");
    assert.equal(seen[0].args.includes("push"), false);
    const line = readActivity(sam, 20).filter(l => l.kind === "git-clone").at(-1);
    assert.ok(line);
    assert.match(line.summary, /https:\/\/example.com\/repo\.git/);
    assert.match(line.summary, /vendor\/lib/);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("git-clone refuses path escapes, option injection, and embedded passwords before git runs", async () => {
  const { base, sam, proj } = fixture();
  try {
    const outside = join(base, "outside");
    mkdirSync(outside, { recursive: true });
    let calls = 0;
    const runner: CodeRunner = async () => { calls += 1; return { exitCode: 0, output: "" }; };
    for (const dest of ["../outside", "/tmp/elsewhere", "vendor/../../outside", ".git/hooks", "src/.env"]) {
      await assert.rejects(() => cloneIntoCodeRoot(sam, "sam", "https://example.com/repo.git", dest, { runner }), /Invalid|Protected|outside|Symlink|already exists/, dest);
    }
    await assert.rejects(() => cloneIntoCodeRoot(sam, "sam", "--upload-pack=evil", "vendor/lib", { runner }), /Clone URL/);
    await assert.rejects(() => cloneIntoCodeRoot(sam, "sam", "ext::sh -c evil", "vendor/lib", { runner }), /Clone URL/);
    await assert.rejects(() => cloneIntoCodeRoot(sam, "sam", "https://user:secret-token@example.com/repo.git", "vendor/lib", { runner }), /password/);
    assert.equal(calls, 0);
    assert.equal(existsSync(join(outside, "lib")), false);
    const ledger = readActivity(sam, 30).map(l => l.summary).join("\n");
    assert.equal(ledger.includes("secret-token"), false);
    assert.match(ledger, /https:\/\/example.com\/repo\.git/);
    // A symlink inside the root is not a door out of it.
    let linked = true;
    try { symlinkSync(outside, join(proj, "link")); } catch { linked = false; }
    if (linked) {
      await assert.rejects(() => cloneIntoCodeRoot(sam, "sam", "https://example.com/repo.git", "link/child", { runner }), /Symlink/);
      assert.equal(existsSync(join(outside, "child")), false);
      assert.equal(calls, 0);
    }
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("git-clone from a local file:// bare repo (no network)", { skip: gitAvailable() ? false : "git is not available on this machine; skipped rather than failed" }, async () => {
  const { base, sam, proj } = fixture();
  try {
    const work = join(base, "src-work");
    const bare = join(base, "src.git");
    mkdirSync(work, { recursive: true });
    writeFileSync(join(work, "hello.txt"), "hello from fixture\n");
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: work });
    execFileSync("git", ["add", "hello.txt"], { cwd: work });
    execFileSync("git", ["-c", "user.email=fixture@example.com", "-c", "user.name=Fixture", "commit", "-q", "-m", "init"], { cwd: work });
    execFileSync("git", ["clone", "--bare", "-q", work, bare]);
    const url = pathToFileURL(bare).href;
    assert.match(url, /^file:/);
    const result = await cloneIntoCodeRoot(sam, "sam", url, "vendor/lib");
    assert.equal(result.ok, true, result.output);
    assert.equal(readFileSync(join(proj, "vendor", "lib", "hello.txt"), "utf8"), "hello from fixture\n");
    assert.equal(existsSync(join(base, "outside")), false);
    const line = readActivity(sam, 10).filter(l => l.kind === "git-clone").at(-1);
    assert.ok(line);
    assert.match(line.summary, /file:/);
    assert.match(line.summary, /vendor\/lib/);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("python env drops connector tokens and model keys unless a name is passed through", () => {
  const { base, sam } = fixture();
  try {
    addConnector(sam, "Second Shift", "https://mcp.secondshiftos.com/mcp/v1", "SAM_MCP_TOKEN_SECOND_SHIFT");
    addProvider(sam, { id: "widget", endpoint: "https://api.widget.example/v1/chat/completions", keyEnv: "WIDGET_SIGNING", model: "widget-1" });
    assert.ok(registeredSecretEnvNames(sam).includes("SAM_MCP_TOKEN_SECOND_SHIFT"));
    assert.ok(registeredSecretEnvNames(sam).includes("WIDGET_SIGNING"));
    const env: NodeJS.ProcessEnv = {
      PATH: "/usr/bin",
      SAFE_MARKER: "visible-marker",
      SAM_MCP_TOKEN_SECOND_SHIFT: "connector-token-sentinel",
      MINIMAX_API_KEY: "model-key-sentinel",
      WIDGET_SIGNING: "widget-signing-sentinel",
      PYTHONSTARTUP: "/tmp/not-the-script.py",
    };
    const scrubbed = buildPythonEnv(sam, env, []);
    assert.equal(scrubbed.env.PATH, "/usr/bin");
    assert.equal(scrubbed.env.SAFE_MARKER, "visible-marker");
    assert.equal(scrubbed.env.SAM_MCP_TOKEN_SECOND_SHIFT, undefined);
    assert.equal(scrubbed.env.MINIMAX_API_KEY, undefined);
    assert.equal(scrubbed.env.WIDGET_SIGNING, undefined);
    assert.equal(scrubbed.env.PYTHONSTARTUP, undefined);
    const kept = buildPythonEnv(sam, env, ["MINIMAX_API_KEY"]);
    assert.equal(kept.env.MINIMAX_API_KEY, "model-key-sentinel");
    assert.deepEqual(kept.passed, ["MINIMAX_API_KEY"]);
    assert.throws(() => buildPythonEnv(sam, env, ["MINIMAX_API_KEY=model-key-sentinel"]), /names, not values/);
    assert.throws(() => buildPythonEnv(sam, env, Array.from({ length: 17 }, (_, i) => "NAME_" + i)), /limited to 16/);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("git-clone ledger keeps the destination when the URL is long, and never stores a rejected secret", async () => {
  const { base, sam } = fixture();
  try {
    const runner: CodeRunner = async () => ({ exitCode: 0, output: "" });
    const dest = "vendor/" + "b".repeat(40);
    const url = "https://example.com/" + "a".repeat(280) + "/repo.git";
    await cloneIntoCodeRoot(sam, "sam", url, dest, { runner });
    const line = readActivity(sam, 5).filter(l => l.kind === "git-clone").at(-1);
    assert.ok(line);
    assert.ok(line.summary.length <= 300);
    assert.ok(line.summary.includes(dest), line.summary);
    assert.match(line.summary, /https:\/\/example\.com\//);
    await assert.rejects(() => cloneIntoCodeRoot(sam, "sam", "https://user:secret-token@example.com/" + "a".repeat(240) + "/repo.git", "../out", { runner }), /password|Invalid/);
    const ledger = readActivity(sam, 10).map(l => l.summary).join("\n");
    assert.equal(ledger.includes("secret-token"), false);
    assert.match(ledger, /\.\.\/out/);
    await assert.rejects(() => cloneIntoCodeRoot(sam, "sam", "https://example.com/repo.git", "C:/outside", { runner }), /Invalid/);
    const { proj } = { proj: join(base, "proj") };
    writeFileSync(join(proj, "taken.txt"), "stay\n");
    let calls = 0;
    await assert.rejects(() => cloneIntoCodeRoot(sam, "sam", "https://example.com/repo.git", "taken.txt", { runner: async () => { calls += 1; return { exitCode: 0, output: "" }; } }), /already exists/);
    assert.equal(calls, 0);
    assert.equal(readFileSync(join(proj, "taken.txt"), "utf8"), "stay\n");
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("python runner: argv is interpreter plus file, hash is ledgered, output is capped", async () => {
  const { base, sam, proj } = fixture();
  try {
    const script = "print('hi')\n";
    writeFileSync(join(proj, "probe.py"), script);
    const digest = createHash("sha256").update(script).digest("hex");
    const seen: Array<{ file: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
    const result = await runPython(sam, "sam", "probe.py", {
      env: { PATH: "/usr/bin", MINIMAX_API_KEY: "model-key-sentinel", SAFE_MARKER: "visible-marker" },
      runner: async (file, args, _cwd, _timeout, env) => {
        seen.push({ file, args: [...args], env });
        return { exitCode: 0, output: "y".repeat(20_000) };
      },
    });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].file, "python3");
    assert.deepEqual(seen[0].args, [join(proj, "probe.py")]);
    assert.equal(seen[0].env.MINIMAX_API_KEY, undefined);
    assert.equal(seen[0].env.SAFE_MARKER, "visible-marker");
    assert.equal(result.sha256, digest);
    assert.equal(result.output.length, 8_000);
    assert.equal(result.truncated, true);
    const line = readActivity(sam, 10).filter(l => l.kind === "python-run").at(-1);
    assert.ok(line);
    assert.match(line.summary, new RegExp("sha256:" + digest));
    assert.equal(line.summary.includes("model-key-sentinel"), false);
    await assert.rejects(() => runPython(sam, "sam", "../home/x.py", { runner: async () => ({ exitCode: 0, output: "" }) }), /Invalid|Protected/);
    const timed = await runPython(sam, "sam", "probe.py", { runner: async () => ({ exitCode: null, output: "partial", timedOut: true }) });
    assert.equal(timed.timedOut, true);
    assert.equal(timed.ok, false);
    let seenTimeout = 0;
    await runPython(sam, "sam", "probe.py", { timeoutMs: 5, runner: async (_f, _a, _c, timeout) => { seenTimeout = timeout; return { exitCode: 0, output: "" }; } });
    assert.equal(seenTimeout, 1_000);
    await runPython(sam, "sam", "probe.py", { timeoutMs: 999_999, runner: async (_f, _a, _c, timeout) => { seenTimeout = timeout; return { exitCode: 0, output: "" }; } });
    assert.equal(seenTimeout, 120_000);
    await assert.rejects(() => runPython(sam, "sam", "/etc/passwd", { runner: async () => ({ exitCode: 0, output: "" }) }), /Invalid relative/);
    writeFileSync(join(proj, "real.py"), "print(1)\n");
    let linked = true;
    try { symlinkSync(join(proj, "real.py"), join(proj, "link.py")); } catch { linked = false; }
    if (linked) {
      let calls = 0;
      await assert.rejects(() => runPython(sam, "sam", "link.py", { runner: async () => { calls += 1; return { exitCode: 0, output: "" }; } }), /Symlink/);
      assert.equal(calls, 0);
    }
  } finally { rmSync(base, { recursive: true, force: true }); }
});

const py = python3Available();
test("python runner: a real interpreter does not see scrubbed secrets", { skip: py.ok ? false : py.reason + "; skipped rather than failed" }, async () => {
  const { base, sam, proj } = fixture();
  try {
    const script = "import json, os\nkeys = ['SAM_MCP_TOKEN_DEMO', 'MINIMAX_API_KEY', 'SAFE_MARKER', 'PYTHONSTARTUP']\nprint(json.dumps({k: os.environ.get(k) for k in keys}))\n";
    writeFileSync(join(proj, "probe.py"), script);
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      SAM_MCP_TOKEN_DEMO: "connector-token-sentinel",
      MINIMAX_API_KEY: "model-key-sentinel",
      SAFE_MARKER: "visible-marker",
      PYTHONSTARTUP: join(proj, "should-not-run.py"),
    };
    writeFileSync(join(proj, "should-not-run.py"), "raise SystemExit('startup ran')\n");
    const result = await runPython(sam, "sam", "probe.py", { env });
    assert.equal(result.ok, true, result.output);
    const parsed = JSON.parse(result.output) as Record<string, string | null>;
    assert.equal(parsed.SAM_MCP_TOKEN_DEMO, null);
    assert.equal(parsed.MINIMAX_API_KEY, null);
    assert.equal(parsed.PYTHONSTARTUP, null);
    assert.equal(parsed.SAFE_MARKER, "visible-marker");
    const kept = await runPython(sam, "sam", "probe.py", { env, passThrough: ["MINIMAX_API_KEY"] });
    const parsedKept = JSON.parse(kept.output) as Record<string, string | null>;
    assert.equal(parsedKept.MINIMAX_API_KEY, "model-key-sentinel");
    assert.equal(parsedKept.SAM_MCP_TOKEN_DEMO, null);
    const ledger = readActivity(sam, 10).filter(l => l.kind === "python-run").map(l => l.summary).join("\n");
    assert.match(ledger, /MINIMAX_API_KEY/);
    assert.equal(ledger.includes("model-key-sentinel"), false);
    assert.equal(ledger.includes("connector-token-sentinel"), false);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

function fakeVenvRunner(): CodeRunner {
  return async (_file, args) => {
    assert.equal(args[0], "-m");
    assert.equal(args[1], "venv");
    const sandboxDir = dirname(args[2]);
    const pyPath = venvPythonPath(sandboxDir);
    mkdirSync(dirname(pyPath), { recursive: true });
    writeFileSync(pyPath, "");
    return { exitCode: 0, output: "" };
  };
}

test("sandboxes: create, list, pip argv, and delete only a sandbox SAM created", async () => {
  const { base, sam } = fixture();
  try {
    await assert.rejects(() => createSandbox(sam, "sam", "Demo", { runner: fakeVenvRunner() }), /Invalid sandbox name/);
    await assert.rejects(() => createSandbox(sam, "sam", "../home", { runner: fakeVenvRunner() }), /Invalid sandbox name/);
    await assert.rejects(() => createSandbox(sam, "sam", "demo", { python: null }), /python3 is not available/);
    const created = await createSandbox(sam, "sam", "demo", { runner: fakeVenvRunner() });
    assert.equal(created.name, "demo");
    assert.equal(existsSync(created.python), true);
    assert.deepEqual(listSandboxes(sam).map(s => s.name), ["demo"]);
    const wrote = writeSandboxFile(sam, "sam", "demo", "app.py", "print(1)\n");
    assert.equal(wrote.path, "app.py");
    assert.throws(() => writeSandboxFile(sam, "sam", "demo", "../escape.py", "x"), /Invalid|Protected/);
    const pipCalls: string[][] = [];
    const pip = await installSandboxPackage(sam, "sam", "demo", "requests", "2.32.3", {
      runner: async (_file, args) => { pipCalls.push([...args]); return { exitCode: 0, output: "installed" }; },
    });
    assert.equal(pip.ok, true);
    assert.deepEqual(pipCalls[0], ["-m", "pip", "install", "--disable-pip-version-check", "--no-input", "requests==2.32.3"]);
    assert.deepEqual(sandboxPipArgv(sam, "demo", "requests", "2.32.3").args, pipCalls[0]);
    assert.throws(() => sandboxPipArgv(sam, "demo", "--index-url", "1.0.0"), /plain name/);
    assert.throws(() => sandboxPipArgv(sam, "demo", "requests", ">=2"), /exact version/);
    const pipLine = readActivity(sam, 20).filter(l => l.kind === "sandbox-pip").at(-1);
    assert.ok(pipLine);
    assert.match(pipLine.summary, /^Installed requests==2\.32\.3 into sandbox demo: ok$/);
    assert.match(pipLine.summary, /requests==2\.32\.3/);
    assert.match(pipLine.summary, /demo/);

    const unmarked = join(sam, ".sam", "sandboxes", "notmine");
    mkdirSync(unmarked, { recursive: true });
    writeFileSync(join(unmarked, "keep.txt"), "stay\n");
    assert.throws(() => destroySandbox(sam, "sam", "notmine"), /not a sandbox SAM created/);
    assert.equal(readFileSync(join(unmarked, "keep.txt"), "utf8"), "stay\n");
    const outside = join(base, "outside");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "keep.txt"), "stay\n");
    let linked = true;
    try { symlinkSync(outside, join(sam, ".sam", "sandboxes", "linked")); } catch { linked = false; }
    if (linked) {
      assert.throws(() => destroySandbox(sam, "sam", "linked"), /not a sandbox SAM created/);
      assert.equal(readFileSync(join(outside, "keep.txt"), "utf8"), "stay\n");
    }
    assert.deepEqual(destroySandbox(sam, "sam", "demo"), { name: "demo", removed: true });
    assert.equal(existsSync(created.path), false);
    assert.equal(existsSync(unmarked), true);
    assert.deepEqual(listSandboxes(sam), []);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("python in a sandbox uses that venv's interpreter and the script's hash", async () => {
  const { base, sam } = fixture();
  try {
    await createSandbox(sam, "sam", "demo", { runner: fakeVenvRunner() });
    const content = "print('from sandbox')\n";
    writeSandboxFile(sam, "sam", "demo", "app.py", content);
    const digest = createHash("sha256").update(content).digest("hex");
    const seen: Array<{ file: string; args: string[] }> = [];
    const result = await runPython(sam, "sam", "app.py", {
      sandbox: "demo",
      runner: async (file, args) => { seen.push({ file, args: [...args] }); return { exitCode: 0, output: "from sandbox\n" }; },
    });
    assert.equal(result.sandbox, "demo");
    assert.equal(result.sha256, digest);
    assert.equal(seen[0].file, result.interpreter);
    assert.match(seen[0].file, /venv[\\/](?:bin|Scripts)[\\/]python(?:\.exe)?$/);
    assert.equal(seen[0].args.length, 1);
    assert.match(seen[0].args[0], /app\.py$/);
    assert.equal(seen[0].file.includes("python"), true);
    const line = readActivity(sam, 20).filter(l => l.kind === "python-run" && l.summary.includes(digest)).at(-1);
    assert.ok(line);
    assert.match(line.summary, /sandbox:demo/);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

const venv = venvModuleAvailable();
test("sandbox create uses a real venv when python3 provides one", { skip: venv.ok ? false : venv.reason + "; skipped rather than failed" }, async () => {
  const { base, sam } = fixture();
  try {
    const created = await createSandbox(sam, "sam", "realbox");
    assert.equal(existsSync(created.python), true);
    assert.deepEqual(listSandboxes(sam).map(s => s.name), ["realbox"]);
    destroySandbox(sam, "sam", "realbox");
    assert.equal(existsSync(created.path), false);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("sandboxes: a failed venv leaves nothing to delete, a symlink is not replaced, and a tampered marker is not ours", async () => {
  const { base, sam } = fixture();
  try {
    await assert.rejects(() => createSandbox(sam, "sam", "nope", { runner: async () => ({ exitCode: 1, output: "no venv" }) }), /not created/);
    assert.equal(existsSync(join(sam, ".sam", "sandboxes", "nope")), false);
    assert.throws(() => destroySandbox(sam, "sam", "nope"), /No SAM sandbox/);

    const outside = join(base, "outside");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "keep.txt"), "stay\n");
    mkdirSync(join(sam, ".sam", "sandboxes"), { recursive: true });
    let linked = true;
    try { symlinkSync(outside, join(sam, ".sam", "sandboxes", "linked")); } catch { linked = false; }
    if (linked) {
      await assert.rejects(() => createSandbox(sam, "sam", "linked", { runner: fakeVenvRunner() }), /symlink/);
      assert.equal(readFileSync(join(outside, "keep.txt"), "utf8"), "stay\n");
    }

    const first = await createSandbox(sam, "sam", "demo", { runner: fakeVenvRunner() });
    const second = await createSandbox(sam, "sam", "other", { runner: fakeVenvRunner() });
    writeSandboxFile(sam, "sam", "other", "keep.txt", "stay\n");
    let ran = 0;
    await assert.rejects(() => runPython(sam, "sam", "../sandbox.json", {
      sandbox: "demo",
      runner: async () => { ran += 1; return { exitCode: 0, output: "" }; },
    }), /Invalid|Protected/);
    assert.equal(ran, 0);
    const markerPath = join(first.path, "sandbox.json");
    const marker = JSON.parse(readFileSync(markerPath, "utf8")) as { name: string };
    marker.name = "other";
    writeFileSync(markerPath, JSON.stringify(marker));
    assert.throws(() => destroySandbox(sam, "sam", "demo"), /not a sandbox SAM created/);
    assert.equal(existsSync(first.path), true);
    assert.deepEqual(listSandboxes(sam).map(s => s.name), ["other"]);
    destroySandbox(sam, "sam", "other");
    assert.equal(existsSync(second.path), false);
    assert.equal(existsSync(first.path), true);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("pip failure is ledgered with the package and the version", async () => {
  const { base, sam } = fixture();
  try {
    await createSandbox(sam, "sam", "demo", { runner: fakeVenvRunner() });
    const pip = await installSandboxPackage(sam, "sam", "demo", "requests", "2.32.3", {
      runner: async () => ({ exitCode: 2, output: "no index" }),
    });
    assert.equal(pip.ok, false);
    assert.equal(pip.exitCode, 2);
    const line = readActivity(sam, 10).filter(l => l.kind === "sandbox-pip").at(-1);
    assert.ok(line);
    assert.match(line.summary, /requests==2\.32\.3/);
    assert.match(line.summary, /exit 2/);
    assert.match(line.summary, /demo/);
    // The verb follows the outcome: a failed install is never
    // ledgered with the success verb.
    assert.match(line.summary, /^Install failed for /);
    assert.equal(/^Installed /.test(line.summary), false);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("git-clone failure is ledgered as a failure, never with the success verb", async () => {
  const { base, sam } = fixture();
  try {
    const failing: CodeRunner = async () => ({ exitCode: 128, output: "fatal: could not read from remote" });
    const failed = await cloneIntoCodeRoot(sam, "sam", "https://github.com/ReactionLabs/agent-bridge", "agent-bridge", { runner: failing });
    assert.equal(failed.ok, false);
    assert.equal(failed.exitCode, 128);
    const line = readActivity(sam, 10).filter(l => l.kind === "git-clone").at(-1);
    assert.ok(line);
    assert.match(line.summary, /^Clone failed for https:\/\/github\.com\/ReactionLabs\/agent-bridge into agent-bridge: exit 128$/);
    assert.equal(line.summary.includes("Cloned "), false);
    // A success still ledgers the success verb, unchanged.
    const okRunner: CodeRunner = async () => ({ exitCode: 0, output: "cloned" });
    const ok = await cloneIntoCodeRoot(sam, "sam", "https://example.com/repo.git", "vendor/lib", { runner: okRunner });
    assert.equal(ok.ok, true);
    const okLine = readActivity(sam, 10).filter(l => l.kind === "git-clone").at(-1);
    assert.ok(okLine);
    assert.match(okLine.summary, /^Cloned https:\/\/example\.com\/repo\.git into vendor\/lib: ok$/);
    // A timed-out clone is a failure too.
    const slow: CodeRunner = async () => ({ exitCode: null, output: "partial", timedOut: true });
    const timed = await cloneIntoCodeRoot(sam, "sam", "https://example.com/slow.git", "vendor/slow", { runner: slow });
    assert.equal(timed.ok, false);
    const timedLine = readActivity(sam, 10).filter(l => l.kind === "git-clone").at(-1);
    assert.ok(timedLine);
    assert.match(timedLine.summary, /^Clone failed for /);
    assert.match(timedLine.summary, /timed out/);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("python runner: a real interpreter enforces the timeout and the output cap", { skip: py.ok ? false : py.reason + "; skipped rather than failed", timeout: 20_000 }, async () => {
  const { base, sam, proj } = fixture();
  try {
    writeFileSync(join(proj, "flood.py"), "print('Z' * 20000)\n");
    const flooded = await runPython(sam, "sam", "flood.py", { env: { PATH: process.env.PATH } });
    assert.equal(flooded.ok, true, flooded.output.slice(0, 80));
    assert.equal(flooded.output.length, 8_000);
    assert.equal(flooded.truncated, true);
    assert.equal(flooded.output.includes("Z".repeat(100)), true);
    const floodLine = readActivity(sam, 5).filter(l => l.kind === "python-run").at(-1);
    assert.ok(floodLine);
    assert.match(floodLine.summary, new RegExp("sha256:" + flooded.sha256));
    assert.equal(floodLine.summary.includes("Z".repeat(40)), false);

    writeFileSync(join(proj, "sleep.py"), "import time\ntime.sleep(30)\nprint('done')\n");
    const started = Date.now();
    const slept = await runPython(sam, "sam", "sleep.py", { timeoutMs: 1000, env: { PATH: process.env.PATH } });
    const elapsed = Date.now() - started;
    assert.equal(slept.timedOut, true);
    assert.equal(slept.ok, false);
    assert.ok(elapsed < 15_000, "sleep was not stopped (" + elapsed + "ms)");
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("code CLI: clone refusal and sandbox list go through the same hands, with no model and no network", () => {
  const { base, sam } = fixture();
  try {
    const cli = fileURLToPath(new URL("./cli.js", import.meta.url));
    const env = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" };
    const run = (...args: string[]) => spawnSync(process.execPath, [cli, "--workspace", sam, "--json", ...args], { encoding: "utf8", env });
    const commands = run("code", "commands");
    assert.equal(commands.status, 0, commands.stderr);
    assert.match(commands.stdout, /git-clone/);
    const spec = run("code", "spec", "git-clone");
    assert.notEqual(spec.status, 0);
    assert.match(spec.stderr, /needs a url and a destination/);
    const escaped = run("code", "clone", "https://example.com/repo.git", "../out");
    assert.notEqual(escaped.status, 0);
    assert.match(escaped.stderr, /Invalid relative code path/);
    const line = readActivity(sam, 5).filter(l => l.kind === "git-clone").at(-1);
    assert.ok(line);
    assert.match(line.summary, /https:\/\/example\.com\/repo\.git/);
    assert.match(line.summary, /\.\.\/out/);
    const listed = run("code", "sandbox-list");
    assert.equal(listed.status, 0, listed.stderr);
    assert.deepEqual(JSON.parse(listed.stdout), { sandboxes: [] });
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("the approval gate is unchanged: git-push stays consequential and cannot be smart-approved", () => {
  const { base, sam } = fixture();
  try {
    assert.equal(classifyProposal("git-push", null).risk, "consequential");
    assert.equal(classifyProposal("git-clone", null).risk, "consequential");
    assert.throws(() => saveApprovalPolicy(sam, { mode: "smart", autoKinds: ["git-push"] }), /cannot auto-approve consequential/);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("sam_code exposes clone, python, and sandboxes, and still refuses visitors", async () => {
  const { base, sam } = fixture();
  try {
    const status = await executeOwnToolAsync(sam, "sam", "sam_code", { action: "status" }) as { commands: string[] };
    assert.ok(status.commands.includes("git-clone"));
    const escaped = await executeOwnToolAsync(sam, "sam", "sam_code", { action: "run", command: "git-clone", url: "https://example.com/repo.git", destination: "../out" }) as { error: string };
    assert.match(escaped.error, /Invalid|Protected|outside/);
    const store = new ChatStore(sam);
    try {
      const chat = store.create("Web chat", "sam", { visitor: true });
      const refused = await executeOwnToolAsync(sam, "sam", "sam_code", { action: "sandbox-list" }, undefined, chat.id) as { error: string };
      assert.match(refused.error, /Visitors cannot use coder hands/);
    } finally { store.close(); }
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("hands v2 copy keeps the sandbox description to dependency and filesystem isolation", () => {
  const repo = dirname(dirname(fileURLToPath(import.meta.url)));
  const banned = /security boundary/i;
  for (const rel of ["src/code.ts", "src/identity.ts", "src/own-tools.ts", "src/cli.ts"]) {
    const text = readFileSync(join(repo, rel), "utf8");
    assert.equal(banned.test(text), false, rel);
  }
});
