import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addConnector, connectors, getConnector, mcpCall, removeConnector, testConnector, readConnectorTool } from "./connectors.js";

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

test("MCP handshake retains session, discovers read tools, and rejects writes",async()=>{
 const root=mkdtempSync(join(tmpdir(),"sam-mcp-mock-"));
 const originalFetch=globalThis.fetch;
 const oldKey=process.env.SAM_MCP_TOKEN_TEST;
 const oldHosts=process.env.SAM_MCP_ALLOWED_HOSTS;
 const seen:string[]=[];
 try{
  process.env.SAM_MCP_ALLOWED_HOSTS="mcp.secondshiftos.com";
  process.env.SAM_MCP_TOKEN_TEST="fake-local-test-token";
  const c=addConnector(root,"Mock","https://mcp.secondshiftos.com/mcp/v1","SAM_MCP_TOKEN_TEST");
  globalThis.fetch=async(_input,init)=>{
   const request=JSON.parse(String(init?.body)) as {id?:string;method:string;params?:{name?:string}};
   const headers=init?.headers as Record<string,string>;
   assert.equal(headers.Authorization,"Bearer fake-local-test-token");
   if(request.method!=="initialize")assert.equal(headers["Mcp-Session-Id"],"test-session");
   seen.push(request.method);
   if(request.method==="notifications/initialized")return new Response(null,{status:202});
   const result=request.method==="initialize"?{protocolVersion:"2025-06-18",capabilities:{},serverInfo:{name:"mock",version:"1"}}:
    request.method==="tools/list"?{tools:[{name:"whoami"},{name:"list_leads"},{name:"update_lead_stage"}]}:
    request.method==="tools/call"?{content:[{type:"text",text:"test tenant"}]}:{};
   return new Response(JSON.stringify({jsonrpc:"2.0",id:request.id,result}),{status:200,headers:{"Content-Type":"application/json","Mcp-Session-Id":"test-session"}});
  };
  const check=await testConnector(c);
  assert.deepEqual(check.approved,["whoami","list_leads"]);
  assert.deepEqual(check.tools,["whoami","list_leads","update_lead_stage"]);
  await readConnectorTool(c,"whoami");
  await assert.rejects(mcpCall(c,"tools/call",{},"update_lead_stage"),/not authorized/);
  assert.deepEqual(seen,["initialize","notifications/initialized","tools/list","initialize","notifications/initialized","tools/call"]);
 }finally{
  globalThis.fetch=originalFetch;
  if(oldKey===undefined)delete process.env.SAM_MCP_TOKEN_TEST;else process.env.SAM_MCP_TOKEN_TEST=oldKey;
  if(oldHosts===undefined)delete process.env.SAM_MCP_ALLOWED_HOSTS;else process.env.SAM_MCP_ALLOWED_HOSTS=oldHosts;
  rmSync(root,{recursive:true,force:true});
 }
});

test("loopback MCP needs an allowlisted host, and trading tools are authorized read-only",async()=>{
 const root=mkdtempSync(join(tmpdir(),"sam-mcp-loop-"));
 const before=process.env.SAM_MCP_ALLOWED_HOSTS;
 try{
  process.env.SAM_MCP_ALLOWED_HOSTS="mcp.secondshiftos.com,127.0.0.1";
  const c=addConnector(root,"Nines","http://127.0.0.1:4390/mcp/v1","SAM_MCP_TOKEN_NINES");
  assert.ok(c.allowedTools.includes("stack_health"));
  assert.ok(c.allowedTools.includes("coin_lookup"));
  await assert.rejects(mcpCall(c,"tools/call",{},"stack_health"),/credential missing/);
  await assert.rejects(mcpCall(c,"tools/call",{},"drop_table"),/not authorized/);
  process.env.SAM_MCP_ALLOWED_HOSTS="mcp.secondshiftos.com";
  assert.throws(()=>addConnector(root,"bad","http://127.0.0.1:4390/mcp/v1","SAM_MCP_TOKEN_NINES"),/HTTPS/);
 }finally{
  if(before===undefined)delete process.env.SAM_MCP_ALLOWED_HOSTS;else process.env.SAM_MCP_ALLOWED_HOSTS=before;
  rmSync(root,{recursive:true,force:true});
 }
});

test("MCP connector registry validates persisted credential references and exact read-only grants",()=>{
 const root=mkdtempSync(join(tmpdir(),"sam-mcp-registry-"));
 const before=process.env.SAM_MCP_ALLOWED_HOSTS;
 try{
  process.env.SAM_MCP_ALLOWED_HOSTS="mcp.secondshiftos.com";
  mkdirSync(join(root,".sam"),{recursive:true});
  const file=join(root,".sam","connectors.json");
  const valid={id:"123e4567-e89b-12d3-a456-426614174000",name:"Test",url:"https://mcp.secondshiftos.com/mcp/v1",tokenEnv:"SAM_MCP_TOKEN_TEST",enabled:true,allowedTools:["whoami"]};
  writeFileSync(file,JSON.stringify([{...valid,tokenEnv:"PATH"}]));
  assert.throws(()=>connectors(root),/Invalid connector credential reference/);
  writeFileSync(file,JSON.stringify([{...valid,allowedTools:["update_lead_stage"]}]));
  assert.throws(()=>connectors(root),/Invalid connector tool allowlist/);
  writeFileSync(file,JSON.stringify([{...valid,credential:"must-not-be-stored"}]));
  assert.throws(()=>connectors(root),/Invalid connector registry entry/);
  writeFileSync(file,JSON.stringify([valid,{...valid,name:"Test 2"}]));
  assert.throws(()=>connectors(root),/Duplicate connector identity/);
  writeFileSync(file,JSON.stringify([valid]));
  assert.deepEqual(connectors(root),[valid]);
 }finally{
  if(before===undefined)delete process.env.SAM_MCP_ALLOWED_HOSTS;else process.env.SAM_MCP_ALLOWED_HOSTS=before;
  rmSync(root,{recursive:true,force:true});
 }
});
