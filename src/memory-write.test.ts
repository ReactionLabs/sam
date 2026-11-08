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
