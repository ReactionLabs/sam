import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {addConnector} from "./connectors.js";
import {connectorChat} from "./connector-chat.js";
import {OpenAICompatibleProvider} from "./openai-compatible.js";

test("connector chat executes approved read-only MCP tool and summarizes response",async()=>{
 const root=mkdtempSync(join(tmpdir(),"sam-chat-mcp-"));
 const oldFetch=globalThis.fetch,oldKey=process.env.SAM_MCP_TOKEN_TEST,oldHosts=process.env.SAM_MCP_ALLOWED_HOSTS;
 try{
  process.env.SAM_MCP_ALLOWED_HOSTS="mcp.secondshiftos.com";
  process.env.SAM_MCP_TOKEN_TEST="fake-key";
  addConnector(root,"Second Shift","https://mcp.secondshiftos.com/mcp/v1","SAM_MCP_TOKEN_TEST");
  let modelCalls=0;let toolCalls=0;
  globalThis.fetch=async(input,init)=>{
   const url=String(input),body=JSON.parse(String(init?.body));
   if(url.includes("model.example")){
    modelCalls++;
    const msg=modelCalls===1?{role:"assistant",content:null,tool_calls:[{id:"call-1",type:"function",function:{name:"mcp_whoami",arguments:"{}"}}]}:{role:"assistant",content:"Connected to Second Shift."};
    return new Response(JSON.stringify({choices:[{message:msg}]}),{headers:{"Content-Type":"application/json"}});
   }
   if(body.method==="notifications/initialized")return new Response(null,{status:202});
   if(body.method==="tools/call"){toolCalls++;assert.equal(body.params.name,"whoami");}
   const result=body.method==="initialize"?{protocolVersion:"2025-06-18"}:body.method==="tools/list"?{tools:[{name:"whoami"},{name:"update_lead_stage"}]}:{content:[{type:"text",text:"tenant-scoped identity"}]};
   return new Response(JSON.stringify({jsonrpc:"2.0",id:body.id,result}),{headers:{"Content-Type":"application/json"}});
  };
  const provider=new OpenAICompatibleProvider("https://model.example/v1/chat/completions","model-test-key");
  const result=await connectorChat(root,provider,"test-model",[{role:"user",content:"Who am I connected as?"}]);
  assert.equal(result,"Connected to Second Shift.");
  assert.equal(toolCalls,1);
  assert.equal(modelCalls,2);
 }finally{
  globalThis.fetch=oldFetch;
  if(oldKey===undefined)delete process.env.SAM_MCP_TOKEN_TEST;else process.env.SAM_MCP_TOKEN_TEST=oldKey;
  if(oldHosts===undefined)delete process.env.SAM_MCP_ALLOWED_HOSTS;else process.env.SAM_MCP_ALLOWED_HOSTS=oldHosts;
  rmSync(root,{recursive:true,force:true});
 }
});
