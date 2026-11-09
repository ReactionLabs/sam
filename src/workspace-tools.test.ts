import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeWorkspaceTool } from "./workspace-tools.js";
import { validateToolTurn } from "./memory-tool.js";

test("read-only workspace tools inspect files and search within scope", () => {
  const root=mkdtempSync(join(tmpdir(),"sam-files-"));
  try {
    mkdirSync(join(root,"src"));
    writeFileSync(join(root,"src","memory.ts"),"export const memorySearch = true;\n");
    const listed=executeWorkspaceTool(root,"list_directory",'{"path":"src"}');
    assert.match(listed,/memory.ts/);
    const read=executeWorkspaceTool(root,"read_file",'{"path":"src/memory.ts"}');
    assert.match(read,/memorySearch/);
    const searched=executeWorkspaceTool(root,"search_files",'{"path":"src","query":"memorySearch"}');
    assert.match(searched,/memory.ts/);
  } finally { rmSync(root,{recursive:true,force:true}); }
});

test("workspace read tools reject traversal, secrets, symlinks and unsupported writes", () => {
  const root=mkdtempSync(join(tmpdir(),"sam-files-sec-"));
  try {
    writeFileSync(join(root,".env"),"SECRET=abc");
    writeFileSync(join(root,"safe.ts"),"safe");
    assert.throws(()=>executeWorkspaceTool(root,"read_file",'{"path":"../outside"}'),/outside|workspace/);
    assert.throws(()=>executeWorkspaceTool(root,"read_file",'{"path":".env"}'),/Protected/);
    assert.throws(()=>executeWorkspaceTool(root,"write_file",'{"path":"safe.ts"}'),/Unsupported/);
    try {
      symlinkSync(join(root,"safe.ts"),join(root,"alias.ts"));
      assert.throws(()=>executeWorkspaceTool(root,"read_file",'{"path":"alias.ts"}'),/Symlink/);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EPERM" &&
          (error as NodeJS.ErrnoException).code !== "EACCES")
        throw error;
      // Windows may deny symlink creation without Developer Mode or elevated rights.
      // The production symlink rejection remains enforced when links are available.
    }
    assert.throws(()=>validateToolTurn({content:null,tool_calls:[{id:"c1",type:"function",function:{name:"read_file",arguments:'{"path":"safe.ts"}'}}]}),/Unsupported/);
    assert.equal(validateToolTurn({content:null,tool_calls:[{id:"c1",type:"function",function:{name:"read_file",arguments:'{"path":"safe.ts"}'}}]},true).tool_calls?.length,1);
  } finally { rmSync(root,{recursive:true,force:true}); }
});
