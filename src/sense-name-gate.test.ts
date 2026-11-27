import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { senseArgv, senseNameBlocker, senseNames, sensesActionBlocker, sensesActions, sensesStatus } from "./senses.js";
import { executeOwnToolAsync } from "./own-tools.js";
import { readActivity } from "./activity.js";

// The sense name gate: the sense is a registry name
// (senseNames in senses.ts: mail, agenda) that every sense
// read names into senseArgv, the ONE seam every name rides
// (runSense builds its fixed argv there; the CLI senses
// doors and the sam_senses chat tool both ride runSense).
// senseArgv refused an unknown name with "Unknown sense
// 'X'. Senses: mail, agenda." - the value echoed and the
// registry named, but no fold correction, so a folded name
// dead-ended. The sam_senses tool's action dispatch
// improvised its own refusal ("Unknown senses action: X
// (status, mail, agenda)"), also with no fold correction.
// senseNameBlocker and sensesActionBlocker in senses.ts
// are now the ONE sources carrying the refusal texts.
// Stored sense names are unchanged: read back as stored,
// never re-validated.

test("sense name gate: every exact sense name reads no blocker, and the status surface reads the registry", () => {
  for (const name of senseNames) assert.equal(senseNameBlocker(name), null, name);
  assert.equal(senseNames.length, 2);
  assert.deepEqual(sensesStatus({ PATH: "" }).senses, ["mail", "agenda"]);
  for (const action of sensesActions) assert.equal(sensesActionBlocker(action), null, action);
  assert.deepEqual([...sensesActions], ["status", "mail", "agenda"]);
});

test("sense name gate: an unknown sense echoes the value and names the senses, no correction", () => {
  assert.equal(
    senseNameBlocker("calendar"),
    "Unknown sense \"calendar\". Senses: mail, agenda",
  );
  assert.equal(
    sensesActionBlocker("read"),
    "Unknown senses action \"read\". Actions: status, mail, agenda",
  );
});

test("sense name gate: a folded name is refused with the correction", () => {
  assert.match(senseNameBlocker("Mail")!, /Did you mean "mail"\?$/);
  assert.match(senseNameBlocker("AGENDA")!, /Did you mean "agenda"\?$/);
  assert.match(senseNameBlocker("a_genda")!, /Did you mean "agenda"\?$/);
  assert.match(sensesActionBlocker("Status")!, /Did you mean "status"\?$/);
  assert.match(sensesActionBlocker("Mail")!, /Did you mean "mail"\?$/);
});

test("sense name gate: a non-string or empty value refuses naming the registry, no correction", () => {
  assert.match(senseNameBlocker(42)!, /^Unknown sense "42"\. Senses:/);
  assert.doesNotMatch(senseNameBlocker(42)!, /Did you mean/);
  assert.match(senseNameBlocker("")!, /^Unknown sense ""\. Senses:/);
  assert.doesNotMatch(senseNameBlocker("")!, /Did you mean/);
  assert.match(sensesActionBlocker(undefined)!, /^Unknown senses action "undefined"\. Actions:/);
  assert.doesNotMatch(sensesActionBlocker(undefined)!, /Did you mean/);
});

test("sense name gate: the senseArgv seam refuses a folded name before building any argv, and an exact name builds", () => {
  assert.throws(() => senseArgv("Mail" as never), /Did you mean "mail"\?$/);
  assert.throws(() => senseArgv("calendar" as never), /^Error: Unknown sense "calendar"\. Senses: mail, agenda$/);
  assert.deepEqual(senseArgv("mail", { query: "from:a@b.c", max: 5 }), ["gmail", "search", "from:a@b.c", "--max", "5", "--json"]);
});

test("sense name gate: the sam_senses dispatch refuses a folded action with the correction and spends no read", async () => {
  const root = mkdtempSync(join(tmpdir(), "sense-name-gate-"));
  try {
    const folded = await executeOwnToolAsync(root, "sam", "sam_senses", { action: "Mail" }) as { error?: string };
    assert.match(folded.error ?? "", /Did you mean "mail"\?$/);
    const unknown = await executeOwnToolAsync(root, "sam", "sam_senses", { action: "read" }) as { error?: string };
    assert.equal(unknown.error, "Unknown senses action \"read\". Actions: status, mail, agenda");
    assert.equal(readActivity(root, 50).filter(l => l.kind === "sense-read").length, 0);
    const status = await executeOwnToolAsync(root, "sam", "sam_senses", { action: "status" }) as { senses?: string[] };
    assert.deepEqual(status.senses, ["mail", "agenda"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
