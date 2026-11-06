import test from "node:test";
import assert from "node:assert/strict";
import {canTransition} from "./kernel.js";
import {MissionStore} from "./storage.js";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
test("mission state machine rejects invalid transitions",()=>{
  assert.equal(canTransition("DRAFT","RUNNING"),false);
  assert.equal(canTransition("DRAFT","PLANNING"),true);
  assert.equal(canTransition("COMPLETED","RUNNING"),false);
});
test("missions persist across store restart with event history",()=>{
  const dir=mkdtempSync(join(tmpdir(),"sam-test-"));
  try {
    const path=join(dir,"missions.db");
    const a=new MissionStore(path);
    const mission=a.create("Test mission");
    a.transition(mission.code,"PLANNING");
    a.close();
    const b=new MissionStore(path);
    assert.equal(b.get(mission.code)?.status,"PLANNING");
    assert.deepEqual(b.events(mission.id).map(e=>e.sequence),[1,2]);
    assert.throws(()=>b.transition(mission.code,"COMPLETED"),/Invalid transition/);
    b.close();
  } finally {rmSync(dir,{recursive:true,force:true});}
});
