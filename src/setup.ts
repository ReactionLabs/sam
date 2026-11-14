import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { stdin, stdout } from "node:process";
import { verifyAndSaveSetup, type Completer } from "./config-wizard.js";

// Cold-install path (Program B, scoreboard dimension 5): a stranger
// clones the repo and reaches a first answered chat in minutes, with
// zero tribal knowledge. Before this module the only configuration
// mechanism was process env: the README said to copy .env.example to
// .env, but nothing in the CLI ever loaded a file, so the documented
// path was a dead end and the working path (hand-exporting three
// vars in every shell) was written down nowhere.
//
// The one mechanism now: <workspace>/sam.env (the reference install's
// convention; the box's service reads the same file through its
// systemd EnvironmentFile). `sam setup` writes it, every CLI command
// loads it at startup, and a value already in the real environment
// always wins over the file (service installs inject theirs and are
// unaffected). Verify-before-save, the codebase's standing rule,
// applies to the key itself: the candidate key must answer one real
// completion before anything is written, so a failed setup leaves a
// fresh workspace untouched and never clobbers a working sam.env.

export const WORKSPACE_ENV_FILE = "sam.env";
export const DEFAULT_SETUP_PROVIDER = "minimax";
export const DEFAULT_SETUP_MODEL = "MiniMax-M2.5";

export function workspaceEnvPath(root: string): string {
  return join(resolve(root), WORKSPACE_ENV_FILE);
}

// Minimal KEY=VALUE parser for the workspace env file: blank lines
// and # comments are skipped, an optional `export ` prefix is
// accepted, one layer of matching surrounding quotes is stripped,
// and anything that does not look like a NAME=value line is ignored.
// Values are never logged by callers of this module.
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const body = line.startsWith("export ") ? line.slice("export ".length).trim() : line;
    const eq = body.indexOf("=");
    if (eq <= 0) continue;
    const name = body.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
    let value = body.slice(eq + 1).trim();
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    out[name] = value;
  }
  return out;
}

export function readWorkspaceEnv(root: string): Record<string, string> | null {
  const file = workspaceEnvPath(root);
  if (!existsSync(file)) return null;
  try { return parseEnvFile(readFileSync(file, "utf8")); } catch { return null; }
}

// Load <workspace>/sam.env into the process env for names that are
// not already set (the real environment wins). Returns the names it
// loaded. Called once per CLI invocation from the preAction hook, so
// every command (chats, dashboard, bridges) sees the stored config
// without the owner exporting anything.
export function loadWorkspaceEnv(root: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const values = readWorkspaceEnv(root);
  if (!values) return [];
  const loaded: string[] = [];
  for (const [name, value] of Object.entries(values)) {
    if (env[name] === undefined) { env[name] = value; loaded.push(name); }
  }
  return loaded;
}

// Write the workspace env file with owner-only permissions (0600),
// tightening a pre-existing file's mode as well. The header says what
// the file is and where it came from; it never contains anything but
// the values the owner just gave setup.
export function writeWorkspaceEnv(root: string, values: Record<string, string>): string {
  const dir = resolve(root);
  mkdirSync(dir, { recursive: true });
  const file = workspaceEnvPath(dir);
  const lines = [
    "# SAM workspace environment. Written by `sam setup` after the model",
    "# key was verified with one real completion. Loaded automatically by",
    "# every sam command (a value in your real environment wins over this",
    "# file). Never commit this file; never share it.",
    ...Object.entries(values).map(([k, v]) => k + "=" + v),
    "",
  ];
  writeFileSync(file, lines.join("\n"), { mode: 0o600 });
  chmodSync(file, 0o600);
  return file;
}

// --- the guided setup flow ----------------------------------------------

export interface SetupIo {
  print(line: string): void;
  ask(question: string): Promise<string>;
  askSecret(question: string): Promise<string>;
}

export interface SetupOptions {
  env?: NodeJS.ProcessEnv;
  // Take the key from this environment variable instead of prompting
  // (the value is never an argument and never printed, the same
  // discipline as `sam vault set --env`).
  keyEnv?: string;
  provider?: string;
  model?: string;
  // Reconfigure even when a sam.env already exists.
  force?: boolean;
  // Test seam: replaces the real model call verify makes.
  completer?: Completer;
}

export type SetupStatus = "configured" | "already-configured" | "verify-failed" | "aborted" | "unsupported-provider";
export interface SetupResult { status: SetupStatus; workspace: string; envFile: string; model: string | null; reason?: string }

export async function runSetup(root: string, io: SetupIo, opts: SetupOptions = {}): Promise<SetupResult> {
  const workspace = resolve(root);
  const env = opts.env ?? process.env;
  const envFile = workspaceEnvPath(workspace);
  const cli = "node dist/cli.js --workspace " + workspace;

  const existing = readWorkspaceEnv(workspace);
  if (existing && !opts.force && !opts.keyEnv) {
    const provider = existing.SAM_MODEL_PROVIDER ?? "(unset)";
    const model = existing.SAM_MODEL ?? "(unset)";
    const keyState = existing.MINIMAX_API_KEY || existing.SAM_MODEL_API_KEY ? "present" : "absent";
    io.print("This workspace already has a sam.env: provider " + provider + ", model " + model + ", key " + keyState + ".");
    const again = (await io.ask("Reconfigure it? [y/N]: ")).trim().toLowerCase();
    if (again !== "y" && again !== "yes") {
      io.print("Nothing changed. Start the dashboard with `" + cli + " dashboard` or chat with `" + cli + " chats new \"First chat\"`.");
      return { status: "already-configured", workspace, envFile, model: existing.SAM_MODEL ?? null };
    }
  }

  io.print("Setting up S.A.M. in " + workspace);
  const provider = ((opts.provider ?? (await io.ask("Model provider [minimax]: ")).trim()) || DEFAULT_SETUP_PROVIDER).toLowerCase();
  if (provider !== "minimax") {
    io.print("Guided setup currently wires the minimax provider only. For an OpenAI-compatible endpoint, write " + envFile + " by hand with SAM_MODEL_ENDPOINT, SAM_MODEL and SAM_MODEL_API_KEY, then run `sam config verify --live`. Nothing was saved.");
    return { status: "unsupported-provider", workspace, envFile, model: null };
  }
  const model = (opts.model ?? (await io.ask("Model [" + DEFAULT_SETUP_MODEL + "]: ")).trim()) || DEFAULT_SETUP_MODEL;

  let key = "";
  if (opts.keyEnv) {
    key = (env[opts.keyEnv] ?? "").trim();
    if (!key) {
      io.print("Environment variable " + opts.keyEnv + " is not set or is empty; no key to configure. Nothing was saved.");
      return { status: "aborted", workspace, envFile, model };
    }
  } else {
    key = (await io.askSecret("MiniMax API key (input hidden): ")).trim();
    if (!key) {
      io.print("No key entered. Nothing was saved; run setup again when you have the key.");
      return { status: "aborted", workspace, envFile, model };
    }
  }

  // Verify BEFORE anything is written: one real completion through
  // the existing provider, exactly the `config setup --live` check.
  // On success this also records the verified setup baseline and
  // creates the workspace state directory; on failure it saves
  // nothing, so the candidate key never reaches disk.
  const candidate: NodeJS.ProcessEnv = { ...env, SAM_MODEL_PROVIDER: provider, SAM_MODEL: model, MINIMAX_API_KEY: key };
  io.print("Verifying the key with one real model call...");
  const { verify } = await verifyAndSaveSetup(workspace, candidate, opts.completer);
  if (!verify.ok) {
    io.print("The key did not verify: " + verify.reason);
    io.print("Nothing was saved. Check the key and run setup again.");
    return { status: "verify-failed", workspace, envFile, model, reason: verify.reason };
  }

  writeWorkspaceEnv(workspace, { SAM_MODEL_PROVIDER: provider, SAM_MODEL: model, MINIMAX_API_KEY: key });
  io.print("");
  io.print("Verified: " + model + " answered. Your key is stored in " + envFile + " (permissions 0600, loaded automatically by every sam command).");
  io.print("");
  io.print("Next steps:");
  io.print("  First chat in the terminal:");
  io.print("    " + cli + " chats new \"First chat\"   (prints the chat id)");
  io.print("    " + cli + " chats send <chat-id> \"Say hello and tell me what you can do\"");
  io.print("  Or the dashboard (prints a local URL with its access token):");
  io.print("    " + cli + " dashboard");
  io.print("  Talk to SAM in a live terminal chat at any time:  " + cli + " tui");
  return { status: "configured", workspace, envFile, model };
}

// --- terminal IO ----------------------------------------------------------
//
// One stdin reader serves both the visible prompts and the hidden
// key prompt. Mixing node:readline for the questions with a raw-mode
// reader for the secret raced: input typed ahead was buffered (and
// echoed) by readline, then the secret read died on the closed
// interface. Here every character flows through a single queue in
// raw mode from the first prompt, echo is a per-read choice, and
// input that arrives early is held for the read that asks for it.

interface PendingRead {
  echo: boolean;
  value: string;
  resolve: (value: string) => void;
  reject: (err: Error) => void;
}

export function terminalSetupIo(): SetupIo & { close(): void } {
  const isTty = !!stdin.isTTY;
  const queue: string[] = [];
  let pending: PendingRead | null = null;
  let started = false;
  let ended = false;
  let closed = false;

  const finish = (read: PendingRead, value: string) => {
    if (pending === read) pending = null;
    read.resolve(value);
  };
  const pump = () => {
    while (pending && queue.length) {
      const ch = queue.shift()!;
      const read = pending;
      if (ch === "\n" || ch === "\r") { stdout.write("\n"); finish(read, read.value); continue; }
      if (ch === "\u0003") { closed = true; read.reject(new Error("Setup aborted.")); if (pending === read) pending = null; continue; }
      if (ch === "\u0004" && !read.value) { finish(read, read.value); continue; }
      if (ch === "\u007f" || ch === "\b") {
        if (read.value) { read.value = read.value.slice(0, -1); if (read.echo) stdout.write("\b \b"); }
        continue;
      }
      read.value += ch;
      if (read.echo) stdout.write(ch);
    }
    if (pending && ended && !queue.length) finish(pending, pending.value);
  };
  const onData = (chunk: string) => { for (const ch of chunk) queue.push(ch); pump(); };
  const onEnd = () => { ended = true; pump(); };
  const start = () => {
    if (started) return;
    started = true;
    if (isTty) stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    stdin.on("data", onData);
    stdin.on("end", onEnd);
  };
  const readLine = (echo: boolean): Promise<string> => {
    if (closed) return Promise.reject(new Error("Setup aborted."));
    if (!isTty && !echo) {
      return Promise.reject(new Error("No terminal available for the hidden key prompt. Pass --key-env <NAME> to take the key from an environment variable instead."));
    }
    start();
    return new Promise<string>((resolve, reject) => {
      pending = { echo, value: "", resolve, reject };
      pump();
    });
  };

  return {
    print: (line: string) => console.log(line),
    ask: (question: string) => { stdout.write(question); return readLine(true); },
    askSecret: (question: string) => { stdout.write(question); return readLine(false); },
    close: () => {
      if (isTty && started) stdin.setRawMode(false);
      stdin.removeListener("data", onData);
      stdin.removeListener("end", onEnd);
      stdin.pause();
    },
  };
}
