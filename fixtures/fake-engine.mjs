#!/usr/bin/env node
// Fake coding-engine CLI for the operative harness.
//
// SAM spawns a coding engine with one fixed argv (engine.ts
// engineArgv) and, separately, probes `auth status` (engine-connect.ts).
// This stub speaks those two shapes and nothing else. It has no
// network, no credential, and no login: `auth status` is always
// signed out, and `auth login` is refused.
//
// A coding prompt may contain blocks
//
//   WRITE <relative-path>
//   <body lines>
//   END
//
// each written under the current working directory (the code root
// SAM pinned). Paths stay inside that directory: absolute paths,
// dot segments, and dotfiles are refused. With no WRITE block the
// process changes nothing and says so on stdout. Output is plain
// text, the `--output-format text` contract.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

const args = process.argv.slice(2);

function fail(message) {
  process.stderr.write("fake-engine: " + message + "\n");
  process.exit(2);
}

if (args.length === 2 && args[0] === "auth" && args[1] === "status") {
  process.stdout.write(JSON.stringify({ loggedIn: false }) + "\n");
  process.exit(0);
}
if (args[0] === "auth") fail("auth login is refused; this stub holds no credentials and cannot sign in");

if (args.length !== 6 || args[0] !== "-p" || args[2] !== "--output-format" || args[3] !== "text" || args[4] !== "--permission-mode" || args[5] !== "acceptEdits") {
  fail("expected: -p <prompt> --output-format text --permission-mode acceptEdits");
}

const lines = String(args[1] ?? "").split("\n");
const writes = [];
for (let i = 0; i < lines.length; i++) {
  const match = /^WRITE (\S+)$/.exec(lines[i]);
  if (!match) continue;
  const rel = match[1];
  const body = [];
  for (i += 1; i < lines.length && lines[i] !== "END"; i++) body.push(lines[i]);
  writes.push({ rel, body: body.join("\n") + (body.length ? "\n" : "") });
}

const cwd = resolve(process.cwd());
const written = [];
for (const write of writes) {
  const parts = write.rel.split("/");
  if (!write.rel || isAbsolute(write.rel) || write.rel.includes("\\") || parts.some((part) => part === "" || part === "." || part === ".." || part.startsWith("."))) {
    fail("refusing path " + write.rel);
  }
  const dest = resolve(cwd, write.rel);
  const back = relative(cwd, dest);
  if (!back || back.startsWith("..") || isAbsolute(back)) fail("refusing path " + write.rel);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, write.body);
  written.push(write.rel);
}

if (written.length) process.stdout.write("engine: wrote " + written.join(", ") + "\n");
else process.stdout.write("engine: no changes\n");
