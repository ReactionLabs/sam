import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addConnector, connectors, getConnector, mcpCall, removeConnector } from "./connectors.js";

test("MCP connector registry stores only env reference, denies unapproved host and write tool",async()=>{
 const root=mkdtempSync(join(tmpdir(),"sam-mcp-"));
 const before=process.env.SAM_MCP_ALLOWED_HOSTS;
 try{
  process.env.SAM_MCP_ALLOWED_HOSTS="mcp.secondshiftos.com";
  assert.throws(()=>addConnector(root,"bad","http://localhost:9999/mcp","SAM_MCP_TOKEN_TEST"),/HTTPS/);
  assert.throws(()=>addConnector(root,"bad","https://example.org/mcp","SAM_MCP_TOKEN_TEST"),/allowlisted/);
  const c=addConnector(root,"Second Shift","https://mcp.secondshiftos.com/mcp/v1","SAM_MCP_TOKEN_TEST");
  assert.equal(connectors(root).length,1);
  assert.equal(getConnector(root,c.id).name,"Second Shift");
  assert.equal(JSON.stringify(connectors(root)).includes("actual-secret"),false);
  await assert.rejects(mcpCall(c,"tools/call",{},"update_lead_stage"),/not authorized/);
  await assert.rejects(mcpCall(c,"tools/call",{},"mark_read"),/not authorized/);
  await assert.rejects(mcpCall(c,"tools/list"),/credential missing/);
  assert.equal(removeConnector(root,c.id),true);
  assert.equal(connectors(root).length,0);
 }finally{
  if(before===undefined)delete process.env.SAM_MCP_ALLOWED_HOSTS;else process.env.SAM_MCP_ALLOWED_HOSTS=before;
  rmSync(root,{recursive:true,force:true});
 }
});
