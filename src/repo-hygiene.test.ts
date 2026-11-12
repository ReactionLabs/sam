import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// The repo used to track `node_modules` as a symlink to another
// install's directory. `.gitignore` said `node_modules/`, and a
// trailing slash matches only a directory, so git kept the symlink.
// A fresh clone must install its own dependencies with npm.

const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..");

test("node_modules is not tracked, and gitignore covers a symlink as well as a directory", () => {
  const listed = execFileSync("git", ["-C", repoRoot, "ls-files", "-s", "--", "node_modules"], { encoding: "utf8" });
  assert.equal(listed, "", "node_modules must not be in the index");
  const ignore = readFileSync(join(repoRoot, ".gitignore"), "utf8");
  assert.match(ignore, /^node_modules$/m);
  assert.equal(/^node_modules\/$/m.test(ignore), false);
  const check = execFileSync("git", ["-C", repoRoot, "check-ignore", "-v", "--", "node_modules"], { encoding: "utf8" });
  assert.match(check, /\.gitignore:\d+:node_modules\tnode_modules/);
});
