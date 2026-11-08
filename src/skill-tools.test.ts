import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeWorkspaceTool } from "./workspace-tools.js";
import { validateToolTurn } from "./memory-tool.js";

test("SAM discovers and reads installed skills without executing their content",()=>{
  const root=mkdtempSync(join(tmpdir(),"sam-skill-tools-"));
  try {
    const dir=join(root,"skills","reporting");
    mkdirSync(dir,{recursive:true});
    writeFileSync(join(dir,"SKILL.md"),"---\nname: reporting\ndescription: Prepare reports from evidence\n---\nUse sources and cite dates.\n");
    const list=JSON.parse(executeWorkspaceTool(root,"list_skills","{}"));
    assert.equal(list.untrusted,true);
    assert.equal(list.skills[0].name,"reporting");
    const read=JSON.parse(executeWorkspaceTool(root,"read_skill",'{"name":"reporting"}'));
    assert.equal(read.untrusted,true);
    assert.match(read.instructions,/cite dates/);
    assert.throws(()=>executeWorkspaceTool(root,"read_skill",'{"name":"../.env"}'),/Invalid skill name/);
    assert.throws(()=>executeWorkspaceTool(root,"list_skills",'{"extra":1}'),/arguments/);
    assert.throws(()=>executeWorkspaceTool(root,"read_skill",'{"name":"missing"}'),/Skill not found/);
  } finally { rmSync(root,{recursive:true,force:true}); }
});

test("model tool validation permits skills only with workspace authorization",()=>{
  const turn={content:null,tool_calls:[{id:"call1",type:"function",function:{name:"read_skill",arguments:'{"name":"reporting"}'}}]};
  assert.throws(()=>validateToolTurn(turn),/Unsupported/);
  assert.equal(validateToolTurn(turn,true).tool_calls?.length,1);
});
