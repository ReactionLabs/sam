import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatStore } from "./chats.js";
import { addHeartbeatJob, consolidatePreferences, heartbeatFactSignature, heartbeatFactSignatureString, heartbeatJobs, heartbeatLog, heartbeatOutputHash, heartbeatOutputsEquivalent, normalizeHeartbeatOutput, runHeartbeat, updateHeartbeatJob } from "./heartbeat.js";
import { PreferenceStore } from "./preferences.js";
import { readActivity } from "./activity.js";

test("heartbeat consolidation learns from chats once, then promotes earned law",async()=>{
 const root=mkdtempSync(join(tmpdir(),"sam-hb-"));
 try{
  const db=new ChatStore(root);
  const chat=db.create("Desk","trading");
  db.add(chat.id,"user","I like short answers");
  db.add(chat.id,"assistant","Noted.");
  db.add(chat.id,"user","I like short answers");
  db.close();
  const first=consolidatePreferences(root);
  assert.equal(first.scanned,2);
  assert.equal(first.noted,2);
  const second=consolidatePreferences(root);
  assert.equal(second.scanned,0);
  const db2=new ChatStore(root);
  db2.add(chat.id,"user","I like short answers");
  db2.close();
  const third=consolidatePreferences(root);
  assert.deepEqual(third.promoted,["trading: short answers"]);
  const prefs=new PreferenceStore(root);
  assert.equal(prefs.lawsFor("trading").length,1);
  prefs.close();
 }finally{rmSync(root,{recursive:true,force:true});}
});

test("heartbeat runs a due job once through the injected turn runner",async()=>{
 const root=mkdtempSync(join(tmpdir(),"sam-hb2-"));
 try{
  addHeartbeatJob(root,"stack watch",15,"trading","Check the stack");
  const turns:string[]=[];
  const deps={ensureChat:async()=>"hb-chat",runTurn:async(_id:string,content:string)=>{turns.push(content);return "All quiet.";}};
  const first=await runHeartbeat(root,deps);
  assert.deepEqual(first.ran,["stack watch"]);
  assert.deepEqual(turns,["Check the stack"]);
  const second=await runHeartbeat(root,deps);
  assert.deepEqual(second.ran,[]);
 }finally{rmSync(root,{recursive:true,force:true});}
});

test("heartbeat output normalization ignores rephrasing chrome but not fact changes",()=>{
 const a="- Candidates total: **282,966**\n- Newest candidate: **2026-11-04T22:45:59.894Z** - the stack is still frozen.\n- ALERT verdict count: **9**";
 const b="Candidates total: 282,966\nNewest candidate: 2026-11-04T22:45:59.894Z - THE STACK IS STILL FROZEN\nALERT verdict count: 9\nSnapshot as_of: 2026-11-09T03:46:20Z";
 assert.equal(heartbeatOutputHash(a),heartbeatOutputHash(b));
 assert.equal(normalizeHeartbeatOutput("**All** `quiet.`"),"all quiet");
 const changed="- Candidates total: **282,967**\n- Newest candidate: **2026-11-04T22:45:59.894Z** - the stack is still frozen.\n- ALERT verdict count: **9**";
 assert.notEqual(heartbeatOutputHash(a),heartbeatOutputHash(changed));
});

// The live stack-watch replies that defeated text normalization: same facts,
// wholly reworded clauses between runs (box heartbeats.jsonl, 2026-11-09).
const LIVE_A="- Candidates total: **282,966**\n- Newest candidate: **2026-11-04T22:45:59.894Z** - **the stack is still frozen** (identical to the last two checks).\n- Candidate verdicts: **ALERT = 9** (PASS 1,139 / PENDING 281,818)\n- Paper setups in state `entered`: **20** (tool returned 20 rows, all `entered`)";
const LIVE_B="- Candidates total: **282,966**\n- Newest candidate: **2026-11-04T22:45:59.894Z** - **the stack is still frozen** (unchanged since the Nov 4 crash).\n- Candidate verdicts: **ALERT = 9** (PASS 1,139 / PENDING 281,818)\n- Paper setups in state `entered`: **20**\n- Snapshot `as_of` 2026-11-09T06:25:36Z; last healed never";
const LIVE_C="- Candidates total: **282,966**\n- Newest candidate: **2026-11-04T22:45:59.894Z** - **the stack is still frozen.**\n- Alert verdict count: **9**\n- Paper setups in `entered` state: **20**";

test("heartbeat fact signature: live paraphrases of the same facts are equivalent",()=>{
 assert.notEqual(heartbeatOutputHash(LIVE_A),heartbeatOutputHash(LIVE_B));
 const priorA={hash:heartbeatOutputHash(LIVE_A),sig:heartbeatFactSignatureString(LIVE_A)};
 // B rewords a clause and adds a snapshot line; C omits the PASS/PENDING
 // counts entirely. Neither contradicts a single fact in A.
 assert.equal(heartbeatOutputsEquivalent(priorA,heartbeatOutputHash(LIVE_B),heartbeatFactSignatureString(LIVE_B)),true);
 assert.equal(heartbeatOutputsEquivalent(priorA,heartbeatOutputHash(LIVE_C),heartbeatFactSignatureString(LIVE_C)),true);
 assert.ok(heartbeatFactSignature(LIVE_A).length>=4);
 // Reordering the same facts changes nothing either.
 const reordered="- Paper setups in `entered` state: **20**\n- Alert verdict count: **9**\n- Candidates total: **282,966**\n- Newest candidate: **2026-11-04T22:45:59.894Z**";
 assert.equal(heartbeatFactSignatureString(LIVE_C),heartbeatFactSignatureString(reordered));
});

test("heartbeat fact signature: any single fact change breaks equivalence",()=>{
 const priorA={hash:heartbeatOutputHash(LIVE_A),sig:heartbeatFactSignatureString(LIVE_A)};
 for(const changed of [
  LIVE_C.replace("282,966","283,001"),
  LIVE_C.replace("**9**","**10**"),
  LIVE_C.replace("**20**","**21**"),
  LIVE_C.replace("2026-11-04T22:45:59.894Z","2026-11-09T01:02:03.000Z"),
  LIVE_A.replace("1,139","1,140"),
 ]){
  assert.notEqual(heartbeatFactSignatureString(LIVE_C),heartbeatFactSignatureString(changed),changed);
  assert.equal(heartbeatOutputsEquivalent(priorA,heartbeatOutputHash(changed),heartbeatFactSignatureString(changed)),false,changed);
 }
});

test("heartbeat fact signature: ISO timestamps canonicalize to second precision",()=>{
 // The live 12:56 UTC break: the stored signature carried milliseconds
 // (d:2026-11-04t22:45:59.894z) while a thinner reply rendered the same
 // instant truncated to the second. Same second = same fact.
 const withMs="- Candidates total: **282,966**\n- Newest candidate: **2026-11-04T22:45:59.894Z**\n- Alert verdict count: **9**\n- Paper setups in state `entered`: **20** (tool count, `state_filter: entered`)";
 const truncated=withMs.replace("2026-11-04T22:45:59.894Z","2026-11-04T22:45:59Z");
 const zeroMs=withMs.replace("2026-11-04T22:45:59.894Z","2026-11-04T22:45:59.000Z");
 assert.equal(heartbeatFactSignatureString(withMs),heartbeatFactSignatureString(truncated));
 assert.equal(heartbeatFactSignatureString(withMs),heartbeatFactSignatureString(zeroMs));
 assert.ok(heartbeatFactSignature(withMs).includes("d:2026-11-04t22:45:59z"));
 // A legacy stored signature that still carries milliseconds heals on
 // comparison: it must match a newly extracted truncated signature.
 const legacySig="d:2026-11-04t22:45:59.894z|n:1139|n:20|n:281818|n:282966|n:9|n:9";
 const priorLegacy={hash:"legacy-hash-that-will-not-match",sig:legacySig};
 assert.equal(heartbeatOutputsEquivalent(priorLegacy,heartbeatOutputHash(truncated),heartbeatFactSignatureString(truncated)),true);
 // A different second is still a different fact.
 const otherSecond=withMs.replace("2026-11-04T22:45:59.894Z","2026-11-04T22:46:00.894Z");
 assert.notEqual(heartbeatFactSignatureString(withMs),heartbeatFactSignatureString(otherSecond));
 assert.equal(heartbeatOutputsEquivalent({hash:heartbeatOutputHash(withMs),sig:heartbeatFactSignatureString(withMs)},heartbeatOutputHash(otherSecond),heartbeatFactSignatureString(otherSecond)),false);
});

test("heartbeat diffing: a timestamp rendering wobble (ms dropped) stays silent",async()=>{
 const root=mkdtempSync(join(tmpdir(),"sam-hb-ms-"));
 try{
  addHeartbeatJob(root,"stack watch",30,"trading","Check the stack","chan-1");
  const deliveries:string[]=[];
  let reply="- Candidates total: **282,966**\n- Newest candidate: **2026-11-04T22:45:59.894Z** - the stack is still frozen.\n- Alert verdict count: **9** (PASS 1,139 / PENDING 281,818)\n- Paper setups in state `entered`: **20**";
  const deps={ensureChat:async()=>"hb-chat",runTurn:async()=>reply,deliver:async(_id:string,text:string)=>{deliveries.push(text);}};
  const first=await runHeartbeat(root,deps);
  assert.deepEqual(first.changed,["stack watch"]);
  assert.equal(deliveries.length,1);
  reply=reply.replace("2026-11-04T22:45:59.894Z","2026-11-04T22:45:59Z");
  makeJobDue(root);
  const second=await runHeartbeat(root,deps);
  assert.deepEqual(second.changed,[]);
  assert.deepEqual(second.unchanged,["stack watch"]);
  assert.equal(deliveries.length,1);
 }finally{rmSync(root,{recursive:true,force:true});}
});

test("heartbeat equivalence: thin outputs fall back to the text comparison (fail-open)",()=>{
 const quiet={hash:heartbeatOutputHash("All quiet."),sig:heartbeatFactSignatureString("All quiet.")};
 assert.equal(heartbeatOutputsEquivalent(quiet,heartbeatOutputHash("All quiet!"),heartbeatFactSignatureString("All quiet!")),true);
 assert.equal(heartbeatOutputsEquivalent(quiet,heartbeatOutputHash("Something happened."),heartbeatFactSignatureString("Something happened.")),false);
 // One lone fact is not proof enough to silence a differently worded reply.
 const oneFact={hash:heartbeatOutputHash("Count is 5, all good"),sig:heartbeatFactSignatureString("Count is 5, all good")};
 assert.equal(heartbeatOutputsEquivalent(oneFact,heartbeatOutputHash("Still 5 and holding"),heartbeatFactSignatureString("Still 5 and holding")),false);
 // A legacy record with no stored signature can only match on text.
 const legacy={hash:heartbeatOutputHash(LIVE_A)};
 assert.equal(heartbeatOutputsEquivalent(legacy,heartbeatOutputHash(LIVE_B),heartbeatFactSignatureString(LIVE_B)),false);
 assert.equal(heartbeatOutputsEquivalent(undefined,heartbeatOutputHash(LIVE_A),heartbeatFactSignatureString(LIVE_A)),false);
});

test("heartbeat diffing: a paraphrased repeat stays silent, a fact change delivers",async()=>{
 const root=mkdtempSync(join(tmpdir(),"sam-hb4-"));
 try{
  addHeartbeatJob(root,"stack watch",30,"trading","Check the stack","chan-1");
  const deliveries:string[]=[];
  let reply=LIVE_A;
  const deps={ensureChat:async()=>"hb-chat",runTurn:async()=>reply,deliver:async(_id:string,text:string)=>{deliveries.push(text);}};
  const first=await runHeartbeat(root,deps);
  assert.deepEqual(first.changed,["stack watch"]);
  assert.equal(deliveries.length,1);
  reply=LIVE_B;
  makeJobDue(root);
  const second=await runHeartbeat(root,deps);
  assert.deepEqual(second.changed,[]);
  assert.deepEqual(second.unchanged,["stack watch"]);
  assert.equal(deliveries.length,1);
  assert.equal(readActivity(root,50).filter(a=>a.kind==="heartbeat").length,1);
  reply=LIVE_C.replace("**20**","**21**");
  makeJobDue(root);
  const third=await runHeartbeat(root,deps);
  assert.deepEqual(third.changed,["stack watch"]);
  assert.equal(deliveries.length,2);
  const state=JSON.parse(readFileSync(join(root,".sam","heartbeat-state.json"),"utf8")) as {outputs:Record<string,{hash:string;sig:string}>};
  assert.equal(Object.values(state.outputs)[0].sig,heartbeatFactSignatureString(reply));
 }finally{rmSync(root,{recursive:true,force:true});}
});

function makeJobDue(root:string){
 // Through the store's own update door (UNIFICATION item 4): the
 // jobs store is SQLite now, and tests write through its shape,
 // never around it - the actions-migration precedent.
 for(const job of heartbeatJobs(root))updateHeartbeatJob(root,job.id,{lastRun:"2000-01-01T00:00:00.000Z"});
}

test("heartbeat diffing: unchanged output stays silent, changed output delivers and lands in the activity ledger",async()=>{
 const root=mkdtempSync(join(tmpdir(),"sam-hb3-"));
 try{
  addHeartbeatJob(root,"stack watch",30,"trading","Check the stack","chan-1");
  const deliveries:string[]=[];
  let reply="- Candidates total: **282,966**\n- ALERT verdict count: **9**";
  const deps={ensureChat:async()=>"hb-chat",runTurn:async()=>reply,deliver:async(_id:string,text:string)=>{deliveries.push(text);}};
  const first=await runHeartbeat(root,deps);
  assert.deepEqual(first.changed,["stack watch"]);
  assert.deepEqual(first.unchanged,[]);
  assert.equal(deliveries.length,1);
  assert.equal(readActivity(root,50).filter(a=>a.kind==="heartbeat").length,1);
  // Same facts, fresh chrome and a fresh snapshot line: silence.
  reply="Candidates total: 282,966\nALERT verdict count: 9\nSnapshot as_of: 2026-11-09T04:16:20Z";
  makeJobDue(root);
  const second=await runHeartbeat(root,deps);
  assert.deepEqual(second.ran,["stack watch"]);
  assert.deepEqual(second.changed,[]);
  assert.deepEqual(second.unchanged,["stack watch"]);
  assert.equal(deliveries.length,1);
  assert.equal(readActivity(root,50).filter(a=>a.kind==="heartbeat").length,1);
  const silent=heartbeatLog(root,50).filter(e=>e.type==="job-unchanged");
  assert.equal(silent.length,1);
  assert.equal(silent[0].name,"stack watch");
  // A real fact change announces itself again.
  reply="- Candidates total: **283,001**\n- ALERT verdict count: **10**";
  makeJobDue(root);
  const third=await runHeartbeat(root,deps);
  assert.deepEqual(third.changed,["stack watch"]);
  assert.equal(deliveries.length,2);
  assert.equal(readActivity(root,50).filter(a=>a.kind==="heartbeat").length,2);
  const state=JSON.parse(readFileSync(join(root,".sam","heartbeat-state.json"),"utf8")) as {outputs:Record<string,{hash:string}>};
  assert.equal(Object.values(state.outputs)[0].hash,heartbeatOutputHash(reply));
 }finally{rmSync(root,{recursive:true,force:true});}
});
