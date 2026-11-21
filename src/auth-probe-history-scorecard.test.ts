import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordActivity } from "./activity.js";
import { authProbeHistoryScorecardText, authProbeLedgerSummary, parseAuthProbeSummary } from "./auth-status.js";
import { heartbeatFactSignatureString, heartbeatOutputHash, heartbeatOutputsEquivalent } from "./heartbeat.js";
import { scriptArgv, scriptCommandNames } from "./schedule.js";

// The auth probe history daily-measurement wiring (2026-11-21,
// the measured-proof series): every completed auth probe has
// ledgered as an auth-probe line since the probe landed - until
// now as inline concatenation at the seam, with no ONE writer
// and no fold, so how many probe runs ever completed, how their
// ok/total targets and model calls sum, and which failure
// buckets have ever appeared was invisible in aggregate (the
// probe store is a singleton holding only the LAST run's
// verdicts, overwritten on every probe; the auth status
// scorecard reads that current state, never the history). A
// not-ok target is a route or pin that would die in a turn, so
// the verdict is attention only when any not-ok target was ever
// recorded or a line is unparseable. The scorecard text is a
// script job's stdout and is P3-diffed on its facts, so it is
// ONE line carrying counts only: no stamp, no actor, no target
// name, no reason - the summaries carry target names, which
// the fold consumes and never prints. The scorecard path is a
// pure read - it creates nothing and probes nothing; every
// state here is built through the ledger's own public door
// (recordActivity) with the seam's own summary writer, never
// around either.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-auth-probe-history-"));
}

test("auth probe history scorecard: a bare install is clear, stable, clock-free, P3-silent, and creates nothing", () => {
  const dir = scratch();
  try {
    const text = authProbeHistoryScorecardText(dir);
    assert.equal(text, "Auth probe history: clear, 0 runs, 0 ok targets, 0 total targets, 0 model calls, latest 0/0 targets ok, auth 0, rate_limit 0, billing 0, timeout 0, network 0, empty 0, missing 0, error 0, 0 total");
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "no stamp in the text");
    assert.equal(text.includes("\n"), false, "the scorecard is one line");
    assert.equal(existsSync(join(dir, ".sam")), false, "a pure read creates no store");
    const again = authProbeHistoryScorecardText(dir);
    assert.equal(again, text, "two reads of the same state produce identical text");
    const prior = { hash: heartbeatOutputHash(text), sig: heartbeatFactSignatureString(text) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(again), heartbeatFactSignatureString(again)),
      true,
      "P3 judges a held auth probe scorecard the same news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("auth probe history scorecard: the history folds to counts, the latest run wins, and no target surfaces", () => {
  const dir = scratch();
  try {
    const clean = authProbeHistoryScorecardText(dir);
    recordActivity(dir, "owner", "auth-probe", authProbeLedgerSummary(9, 9, 2, []));
    recordActivity(dir, "owner", "auth-probe", authProbeLedgerSummary(10, 10, 3, []));
    recordActivity(dir, "sam", "turn", "Answered in chat 6b222963");
    const text = authProbeHistoryScorecardText(dir);
    assert.equal(text, "Auth probe history: clear, 2 runs, 19 ok targets, 19 total targets, 5 model calls, latest 10/10 targets ok, auth 0, rate_limit 0, billing 0, timeout 0, network 0, empty 0, missing 0, error 0, 2 total");
    assert.notEqual(text, clean, "the first recorded probe changes the scorecard");
    const prior = { hash: heartbeatOutputHash(clean), sig: heartbeatFactSignatureString(clean) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(text), heartbeatFactSignatureString(text)),
      false,
      "P3 judges the grown scorecard as new news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("auth probe history scorecard: not-ok targets are attention, counted per bucket, with no target name printed", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "owner", "auth-probe", authProbeLedgerSummary(8, 10, 2, [
      { target: "profile:sekrit-pin", bucket: "rate_limit" },
      { target: "route:chat", bucket: "auth" },
    ]));
    recordActivity(dir, "owner", "auth-probe", authProbeLedgerSummary(9, 10, 2, [
      { target: "provider:sekrit-provider", bucket: "rate_limit" },
    ]));
    const text = authProbeHistoryScorecardText(dir);
    assert.equal(text, "Auth probe history: attention, 2 runs, 17 ok targets, 20 total targets, 4 model calls, latest 9/10 targets ok, auth 1, rate_limit 2, billing 0, timeout 0, network 0, empty 0, missing 0, error 0, 2 total");
    assert.equal(text.includes("sekrit"), false, "no target name surfaces");
    assert.equal(text.includes("profile:"), false, "no target string surfaces");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("auth probe history scorecard: an unmatched shape counts toward the total and the unparseable count and is never printed", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "owner", "auth-probe", authProbeLedgerSummary(9, 9, 2, []));
    recordActivity(dir, "owner", "auth-probe", "Some wholly novel probe shape naming sekrit_evidence");
    const text = authProbeHistoryScorecardText(dir);
    assert.equal(text, "Auth probe history: attention, 1 runs, 9 ok targets, 9 total targets, 2 model calls, latest 9/9 targets ok, auth 0, rate_limit 0, billing 0, timeout 0, network 0, empty 0, missing 0, error 0, 2 total, 1 unparseable");
    assert.equal(text.includes("novel probe"), false, "an unmatched summary is never printed");
    assert.equal(text.includes("sekrit_evidence"), false, "no verbatim summary surfaces");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("auth probe parse: the writer is byte-identical to the ledgered shapes and parses, and only the fixed shapes parse", () => {
  assert.equal(authProbeLedgerSummary(9, 9, 2, []), "Auth probe: 9/9 targets ok (2 model call(s))");
  assert.equal(
    authProbeLedgerSummary(8, 10, 2, [{ target: "route:chat", bucket: "auth" }, { target: "profile:sam", bucket: "missing" }]),
    "Auth probe: 8/10 targets ok (2 model call(s)); not ok: route:chat=auth, profile:sam=missing",
  );
  assert.deepEqual(parseAuthProbeSummary(authProbeLedgerSummary(9, 9, 2, [])), { ok: 9, total: 9, calls: 2, bad: [] });
  assert.deepEqual(
    parseAuthProbeSummary(authProbeLedgerSummary(8, 10, 2, [{ target: "route:chat", bucket: "auth" }, { target: "profile:sam", bucket: "missing" }])),
    { ok: 8, total: 10, calls: 2, bad: [{ target: "route:chat", bucket: "auth" }, { target: "profile:sam", bucket: "missing" }] },
  );
  assert.equal(parseAuthProbeSummary(""), null);
  assert.equal(parseAuthProbeSummary("Auth probe: 11/10 targets ok (2 model call(s))"), null, "an ok count above its total does not parse");
  assert.equal(parseAuthProbeSummary("Auth probe: 0/0 targets ok (0 model call(s))"), null, "a zero total does not parse");
  assert.equal(parseAuthProbeSummary("Auth probe: 9/9 targets ok (10 model call(s))"), null, "more calls than targets does not parse - one call per distinct model at most");
  assert.equal(parseAuthProbeSummary("Auth probe: 9/10 targets ok (2 model call(s))"), null, "a shortfall with no not-ok list does not parse");
  assert.equal(parseAuthProbeSummary("Auth probe: 9/9 targets ok (2 model call(s)); not ok: route:chat=auth"), null, "a not-ok list on a full pass does not parse");
  assert.equal(parseAuthProbeSummary("Auth probe: 8/10 targets ok (2 model call(s)); not ok: route:chat=auth"), null, "a not-ok list shorter than the shortfall does not parse");
  assert.equal(parseAuthProbeSummary("Auth probe: 9/10 targets ok (2 model call(s)); not ok: route:chat=ok"), null, "the ok bucket never appears in the not-ok list");
  assert.equal(parseAuthProbeSummary("Auth probe: 9/10 targets ok (2 model call(s)); not ok: route:chat=bogus"), null, "an unknown bucket does not parse");
  assert.equal(parseAuthProbeSummary("Auth probe: 9/9 targets ok"), null, "a truncated line does not parse");
});

test("auth probe history scorecard: the script allowlist rides the CLI scorecard", () => {
  assert.ok(scriptCommandNames().includes("sam-auth-probe-history"), "sam-auth-probe-history is allowlisted");
  const argv = scriptArgv("/some/root", "sam-auth-probe-history");
  assert.ok(argv.some(a => a.endsWith("cli.js")), "the argv runs the CLI");
  assert.deepEqual(argv.slice(-2), ["models", "probe-history"], "the argv rides models probe-history");
});
