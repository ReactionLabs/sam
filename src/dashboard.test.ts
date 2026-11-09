import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addSchedule, listSchedules, revokeLaw } from "./dashboard.js";
import { PreferenceStore } from "./preferences.js";
import { readActivity } from "./activity.js";

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

test("owner console (P8): revokeLaw revokes standing law once and writes the ledger line",()=>{
  const root=mkdtempSync(join(tmpdir(),"sam-dashboard-law-"));
  try {
    const store=new PreferenceStore(root);
    const rule=store.note("trading","Never trade on Fridays","rule","chat-1");
    const noted=store.note("trading","short answers","like","chat-1");
    store.close();
    const revoked=revokeLaw(root,rule.id);
    assert.equal(revoked?.status,"revoked");
    assert.equal(revoked?.statement,"Never trade on Fridays");
    const check=new PreferenceStore(root);
    try{
      assert.equal(check.lawsFor("trading").length,0);
      assert.equal(check.get(noted.id)?.status,"noted");
    }finally{check.close();}
    // Already revoked and unknown ids are a clean null, never a second write.
    assert.equal(revokeLaw(root,rule.id),null);
    assert.equal(revokeLaw(root,"00000000-0000-0000-0000-000000000000"),null);
    const ledger=readActivity(root,30,{kind:"law-revoked"});
    assert.equal(ledger.length,1);
    assert.equal(ledger[0].actor,"owner");
    assert.match(ledger[0].summary,/trading: Never trade on Fridays/);
  } finally {rmSync(root,{recursive:true,force:true});}
});
