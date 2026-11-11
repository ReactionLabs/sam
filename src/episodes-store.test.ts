import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { episodeEvidence, listEpisodes, writeEpisode, type EpisodeChat } from "./episodes.js";

// State convergence (UNIFICATION item 4, fifth store): the P4 episode
// evidence migrated from whole-file episodes.json rewrites to
// one-row-per-profile:date SQLite. These tests pin the migration
// contract: a legacy file imports key by key with its evidence intact
// and is renamed (never deleted), a malformed file imports nothing and
// stays put (the old reader threw on one and killed the tick), a pure
// read creates nothing, merges for different profile:dates cannot
// revert each other, the 31-date prune still bounds the store, and a
// write over migrated legacy evidence grows the same day's episode.

function fresh(): string { return mkdtempSync(join(tmpdir(), "sam-ep-store-")); }

function chat(chatId: string, content: string, at: string): EpisodeChat {
  return { chatId, title: "Desk " + chatId, messages: [{ role: "user", content, created_at: at }] };
}

test("episodes store: a legacy episodes.json imports key by key, evidence intact, file renamed not deleted", () => {
  const root = fresh();
  try {
    mkdirSync(join(root, ".sam"), { recursive: true });
    const legacy = {
      "trading:2026-11-01": [chat("c1", "legacy morning", "2026-11-01T08:00:00.000Z")],
      "dip:2026-11-01": [chat("c9", "legacy personal", "2026-11-01T09:00:00.000Z")],
    };
    writeFileSync(join(root, ".sam", "episodes.json"), JSON.stringify(legacy, null, 2));
    const evidence = episodeEvidence(root, "trading", "2026-11-01");
    assert.deepEqual(evidence, legacy["trading:2026-11-01"]);
    assert.deepEqual(episodeEvidence(root, "dip", "2026-11-01"), legacy["dip:2026-11-01"]);
    assert.equal(existsSync(join(root, ".sam", "episodes.db")), true);
    assert.equal(existsSync(join(root, ".sam", "episodes.json")), false);
    assert.equal(existsSync(join(root, ".sam", "episodes.json.migrated")), true);
    const kept = JSON.parse(readFileSync(join(root, ".sam", "episodes.json.migrated"), "utf8")) as Record<string, unknown>;
    assert.deepEqual(Object.keys(kept).sort(), ["dip:2026-11-01", "trading:2026-11-01"]);
    // A write over migrated evidence grows the same day, in the DB only.
    writeEpisode(root, "trading", "2026-11-01", [chat("c2", "legacy evening", "2026-11-01T20:00:00.000Z")]);
    const grown = episodeEvidence(root, "trading", "2026-11-01");
    assert.deepEqual(grown.map(c => c.chatId), ["c1", "c2"]);
    assert.equal(listEpisodes(root, "trading").length, 1);
    assert.match(listEpisodes(root, "trading")[0].content, /legacy morning/);
    assert.match(listEpisodes(root, "trading")[0].content, /legacy evening/);
    assert.equal(existsSync(join(root, ".sam", "episodes.json")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("episodes store: a malformed legacy file imports nothing, stays in place, and no longer kills the write", () => {
  const root = fresh();
  try {
    mkdirSync(join(root, ".sam"), { recursive: true });
    writeFileSync(join(root, ".sam", "episodes.json"), "{ not json");
    assert.deepEqual(episodeEvidence(root, "trading", "2026-11-01"), []);
    assert.equal(existsSync(join(root, ".sam", "episodes.json")), true);
    assert.equal(existsSync(join(root, ".sam", "episodes.json.migrated")), false);
    // The old reader threw here; the migrated store writes fresh evidence.
    const rec = writeEpisode(root, "trading", "2026-11-01", [chat("c1", "fresh start", "2026-11-01T08:00:00.000Z")]);
    assert.ok(rec);
    assert.deepEqual(episodeEvidence(root, "trading", "2026-11-01").map(c => c.chatId), ["c1"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("episodes store: a pure read on an install with neither file creates nothing", () => {
  const root = fresh();
  try {
    assert.deepEqual(episodeEvidence(root, "trading", "2026-11-01"), []);
    assert.equal(existsSync(join(root, ".sam")), false);
    // An empty day also writes nothing and creates nothing.
    assert.equal(writeEpisode(root, "trading", "2026-11-01", [{ chatId: "c", title: "t", messages: [] }]), null);
    assert.equal(existsSync(join(root, ".sam", "episodes.db")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("episodes store: merges for different profile:dates survive interleaved writes, and the prune keeps the newest 31 dates", () => {
  const root = fresh();
  try {
    writeEpisode(root, "trading", "2026-10-01", [chat("t1", "trading one", "2026-10-01T08:00:00.000Z")]);
    writeEpisode(root, "dip", "2026-10-01", [chat("d1", "dip one", "2026-10-01T08:30:00.000Z")]);
    writeEpisode(root, "trading", "2026-10-01", [chat("t2", "trading two", "2026-10-01T09:00:00.000Z")]);
    writeEpisode(root, "dip", "2026-10-01", [chat("d2", "dip two", "2026-10-01T09:30:00.000Z")]);
    assert.deepEqual(episodeEvidence(root, "trading", "2026-10-01").map(c => c.chatId), ["t1", "t2"]);
    assert.deepEqual(episodeEvidence(root, "dip", "2026-10-01").map(c => c.chatId), ["d1", "d2"]);
    // 33 more trading dates (Oct 2-31, Nov 1-3): at 34 dates total the
    // oldest three fall off the 31-date bound, the newest stays.
    const extra = [...Array(30)].map((_, i) => "2026-10-" + String(i + 2).padStart(2, "0"))
      .concat(["2026-11-01", "2026-11-02", "2026-11-03"]);
    for (const date of extra) writeEpisode(root, "trading", date, [chat("x-" + date, "day " + date, date + "T08:00:00.000Z")]);
    assert.deepEqual(episodeEvidence(root, "trading", "2026-10-01"), []);
    assert.deepEqual(episodeEvidence(root, "trading", "2026-10-03"), []);
    assert.deepEqual(episodeEvidence(root, "trading", "2026-10-04").map(c => c.chatId), ["x-2026-10-04"]);
    assert.deepEqual(episodeEvidence(root, "trading", "2026-11-03").map(c => c.chatId), ["x-2026-11-03"]);
    // Another profile's dates are untouched by trading's prune.
    assert.deepEqual(episodeEvidence(root, "dip", "2026-10-01").map(c => c.chatId), ["d1", "d2"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
