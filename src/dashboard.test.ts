import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addSchedule, listSchedules } from "./dashboard.js";

test("schedule definitions persist locally and reject unsafe intervals",()=>{
  const root=mkdtempSync(join(tmpdir(),"sam-dashboard-"));
  try {
    assert.deepEqual(listSchedules(root),[]);
    const item=addSchedule(root,"check repository",60);
    assert.equal(item.minutes,60);
    assert.equal(item.enabled,true);
    assert.equal(listSchedules(root)[0].id,item.id);
    assert.throws(()=>addSchedule(root,"check repository",60),/duplicate/);
    assert.throws(()=>addSchedule(root,"unsafe;command",60),/Invalid schedule name/);
    assert.throws(()=>addSchedule(root,"fast",0),/Interval/);
    assert.throws(()=>addSchedule(root,"huge",10081),/Interval/);
  } finally {rmSync(root,{recursive:true,force:true});}
});
