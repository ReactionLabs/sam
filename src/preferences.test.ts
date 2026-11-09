import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PreferenceStore, extractPreferences, lawPromptBlock } from "./preferences.js";

test("preferences: explicit rules are law instantly, likes promote on the third reinforcement",()=>{
 const root=mkdtempSync(join(tmpdir(),"sam-prefs-"));
 try{
  const store=new PreferenceStore(root);
  const rule=store.note("trading","Never trade on Fridays","rule","chat-1");
  assert.equal(rule.status,"law");
  store.note("trading","short answers","like","chat-1");
  store.note("trading","short answers","like","chat-2");
  assert.equal(store.lawsFor("trading").length,1);
  const third=store.note("trading","short answers","like","chat-3");
  assert.equal(third.hits,3);
  const promoted=store.promote();
  assert.equal(promoted.length,1);
  assert.equal(store.lawsFor("trading").length,2);
  assert.equal(store.lawsFor("second-shift").length,0);
  assert.match(lawPromptBlock(store.lawsFor("trading")),/Never trade on Fridays/);
  assert.equal(store.revoke(rule.id),true);
  assert.equal(store.lawsFor("trading").length,1);
  store.close();
 }finally{rmSync(root,{recursive:true,force:true});}
});

test("preferences: get reads one record back by id and misses cleanly",()=>{
 const root=mkdtempSync(join(tmpdir(),"sam-prefs-get-"));
 try{
  const store=new PreferenceStore(root);
  const rule=store.note("trading","Always confirm before acting","rule","chat-1");
  assert.equal(store.get(rule.id)?.statement,"Always confirm before acting");
  assert.equal(store.get(rule.id)?.status,"law");
  assert.equal(store.get("00000000-0000-0000-0000-000000000000"),undefined);
  store.close();
 }finally{rmSync(root,{recursive:true,force:true});}
});

test("preference extraction hears first-person likes, dislikes, and rules only",()=>{
 assert.deepEqual(extractPreferences("I like short answers and I never trade on Fridays").map(x=>x.kind),["rule","like"]);
 assert.equal(extractPreferences("Remember: the box is sovereign")[0].kind,"rule");
 assert.equal(extractPreferences("The market likes volatility").length,0);
 assert.equal(extractPreferences("What is the stack health?").length,0);
});
