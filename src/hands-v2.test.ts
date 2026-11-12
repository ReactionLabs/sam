import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
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
    assert.match(line.summary, /sandbox demo/);
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
