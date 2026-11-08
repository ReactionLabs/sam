import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {runMemoryToolTurn,executeMemorySearch,validateToolTurn} from "./memory-tool.js";

test("approved model memory persists across store reopen and search",async()=>{
  const root=mkdtempSync(join(tmpdir(),"sam-memory-write-")),db=join(root,"memory.db");
  try {
    let calls=0,approvals=0;
    const request=async()=>{
      calls++;
      if(calls===1)return {content:null,tool_calls:[{id:"write1",type:"function" as const,function:{name:"memory_add",arguments:JSON.stringify({kind:"observation",content:"verified sapphire penguin",source:"owner-test"})}}]};
      return {content:"Recorded after approval."};
    };
    const result=await runMemoryToolTurn(request, [{role:"user",content:"remember sapphire penguin"}],db,undefined,undefined,undefined,async()=>{approvals++;return true;});
    assert.equal(result,"Recorded after approval.");
    assert.equal(approvals,1);
    assert.match(executeMemorySearch(db,JSON.stringify({query:"sapphire"})),/verified sapphire penguin/);
  }finally{rmSync(root,{recursive:true,force:true});}
});
test("denied memory write does not persist",async()=>{
  const root=mkdtempSync(join(tmpdir(),"sam-memory-deny-")),db=join(root,"memory.db");
  try{
    let calls=0;
    await runMemoryToolTurn(async()=>++calls===1?{content:null,tool_calls:[{id:"w",type:"function" as const,function:{name:"memory_add",arguments:JSON.stringify({kind:"observation",content:"denied fox",source:"test"})}}]}:{content:"Denied."},[{role:"user",content:"remember"}],db,undefined,undefined,undefined,async()=>false);
    assert.match(executeMemorySearch(db,JSON.stringify({query:"denied"})),/"records":\[\]/);
  }finally{rmSync(root,{recursive:true,force:true});}
});
test("memory write tool is rejected unless opt-in",()=>{
  const turn={content:null,tool_calls:[{id:"w",type:"function",function:{name:"memory_add",arguments:"{}"}}]};
  assert.throws(()=>validateToolTurn(turn,false,false),/Unsupported/);
  assert.equal(validateToolTurn(turn,false,true).tool_calls?.length,1);
});

test("owner denial emits denied audit without completed and returns explicit failure evidence",async()=>{
  const root=mkdtempSync(join(tmpdir(),"sam-memory-audit-")),db=join(root,"memory.db");
  try{
    let calls=0;
    const audit:Array<{tool:string;status:string;detail:string}>=[];
    const replies:string[]=[];
    const response=await runMemoryToolTurn(async(messages)=>{
      if(++calls===1)return {content:null,tool_calls:[{id:"deny1",type:"function" as const,function:{name:"memory_add",arguments:JSON.stringify({kind:"decision",content:"never persist this marker",source:"owner-test"})}}]};
      replies.push(JSON.stringify(messages));
      return {content:"I did not save the memory."};
    },[{role:"user",content:"Remember this"}],db,e=>audit.push(e),undefined,undefined,async()=>false);
    assert.match(response,/did not save/);
    assert.deepEqual(audit.map(e=>e.status),["requested","denied"]);
    assert.equal(JSON.parse((JSON.parse(replies[0]) as Array<{role:string;content:string}>).find(m=>m.role==="tool")!.content).saved,false);
    assert.match(executeMemorySearch(db,JSON.stringify({query:"marker"})),/"records":\\[\\]/);
  }finally{rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
});
