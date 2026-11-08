import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentLoopJournal } from "./agent-loop-journal.js";

test("agent loop journal persists progress and events across restart", () => {
  const dir = mkdtempSync(join(tmpdir(),"sam-loop-"));
  try {
    const db = join(dir,"state.db");
    let journal = new AgentLoopJournal(db);
    const loop = journal.create("Inspect memory implementation");
    journal.event(loop.id,"tool_requested","read_file src/memory.ts");
    journal.progress(loop.id,1,1);
    journal.close();
    journal = new AgentLoopJournal(db);
    assert.equal(journal.get(loop.id)?.calls,1);
    assert.equal(journal.events(loop.id).length,2);
    journal.finish(loop.id,"completed","Verified source path");
    assert.equal(journal.get(loop.id)?.state,"completed");
    assert.throws(()=>journal.event(loop.id,"tool_requested","another"),/not running/);
    journal.close();
  } finally { rmSync(dir,{recursive:true,force:true}); }
});

test("interrupted loops are fenced and cannot silently replay tools", () => {
  const dir = mkdtempSync(join(tmpdir(),"sam-loop-crash-"));
  try {
    const journal = new AgentLoopJournal(join(dir,"state.db"));
    const pending = journal.create("Fix bug");
    const done = journal.create("Other goal");
    journal.finish(done.id,"completed","Done");
    assert.equal(journal.interruptOrphans(),1);
    assert.equal(journal.get(pending.id)?.state,"interrupted");
    assert.equal(journal.get(done.id)?.state,"completed");
    assert.throws(()=>journal.progress(pending.id,2,3),/rejected/);
    assert.throws(()=>journal.finish(pending.id,"completed","unverified"),/rejected/);
    journal.close();
  } finally { rmSync(dir,{recursive:true,force:true}); }
});
