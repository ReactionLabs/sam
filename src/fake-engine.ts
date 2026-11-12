import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { windowsCmdShim } from "./bin-path.js";

/**
 * A fake coding-engine binary the suite can exec.
 *
 * The work is a Node script on every platform (Windows cannot exec
 * a `#!/bin/sh` fixture). POSIX points SAM_ENGINE_BIN at that .mjs,
 * which carries this runtime's shebang. win32 points it at a
 * claude.cmd shim that invokes node on the same script.
 */
export function installFakeEngine(dir: string, opts: { workFile: string; projectDir: string; authStatusJson?: string }): string {
  const script = join(dir, "claude-fake.mjs");
  const source = fakeEngineSource(opts.workFile, opts.projectDir, opts.authStatusJson ?? "");
  writeFileSync(script, `#!${process.execPath}\n${source}`);
  if (process.platform === "win32") {
    const cmd = join(dir, "claude.cmd");
    writeFileSync(cmd, windowsCmdShim(process.execPath, script));
    return cmd;
  }
  chmodSync(script, 0o755);
  return script;
}

function fakeEngineSource(workFile: string, projectDir: string, authStatusJson: string): string {
  return [
    'import { spawnSync } from "node:child_process";',
    'import { existsSync } from "node:fs";',
    "const args = process.argv.slice(2);",
    'if (args[0] === "auth" && args[1] === "status") {',
    `  process.stdout.write(${JSON.stringify(authStatusJson)});`,
    "  process.exit(0);",
    "}",
    `const work = ${JSON.stringify(workFile)};`,
    `const proj = ${JSON.stringify(projectDir)};`,
    "if (existsSync(work)) {",
    '  const run = spawnSync(process.execPath, [work, proj], { stdio: ["ignore", "inherit", "inherit"] });',
    "  if (run.error || run.status !== 0) process.exit(run.status ?? 1);",
    "}",
    'console.log("engine: work complete");',
    "",
  ].join("\n");
}
