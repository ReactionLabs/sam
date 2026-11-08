import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export type Connector = { id:string; name:string; url:string; tokenEnv:string; enabled:boolean; allowedTools:string[] };
const readOnlyTools = new Set(["whoami","list_leads","get_lead","pipeline_summary","analytics_summary"]);
const namePattern = /^[A-Za-z0-9 _.-]{1,64}$/;
const envPattern = /^SAM_MCP_TOKEN_[A-Z0-9_]{1,64}$/;
function path(root:string){return join(resolve(root),".sam","connectors.json");}
function allowedUrl(raw:string):string{
 const u=new URL(raw);
 if(u.protocol!=="https:"||u.username||u.password||u.hash||u.search||u.port)throw Error("MCP endpoint must be a plain HTTPS URL");
 const allowed=(process.env.SAM_MCP_ALLOWED_HOSTS??"mcp.secondshiftos.com").split(",").map(x=>x.trim().toLowerCase()).filter(Boolean);
 if(!allowed.includes(u.hostname.toLowerCase()))throw Error("MCP host not allowlisted. Set SAM_MCP_ALLOWED_HOSTS locally.");
 return u.toString();
}
export function connectors(root:string):Connector[]{
 if(!existsSync(path(root)))return [];
 const value:unknown=JSON.parse(readFileSync(path(root),"utf8"));
 if(!Array.isArray(value)||value.length>32)throw Error("Invalid connector registry");
 return value as Connector[];
}
function save(root:string,items:Connector[]){mkdirSync(join(resolve(root),".sam"),{recursive:true});writeFileSync(path(root),JSON.stringify(items,null,2),{mode:0o600});}
export function addConnector(root:string,name:string,url:string,tokenEnv:string):Connector{
 if(!namePattern.test(name)||!envPattern.test(tokenEnv))throw Error("Invalid connector name or environment variable");
 const endpoint=allowedUrl(url), items=connectors(root);
 if(items.length>=32||items.some(c=>c.name===name))throw Error("Connector limit or duplicate name");
 const item:Connector={id:randomUUID(),name,url:endpoint,tokenEnv,enabled:true,allowedTools:[...readOnlyTools]};
 save(root,[...items,item]);return item;
}
export function removeConnector(root:string,id:string):boolean{
 const items=connectors(root),rest=items.filter(x=>x.id!==id);
 if(rest.length===items.length)return false;save(root,rest);return true;
}
export function getConnector(root:string,id:string):Connector{
 const c=connectors(root).find(x=>x.id===id);
 if(!c||!c.enabled)throw Error("Connector not found or disabled");
 allowedUrl(c.url);return c;
}
function parseResponse(raw:string,contentType:string):unknown{
 if(contentType.includes("text/event-stream")){
  const data=raw.split(/\r?\n/).filter(line=>line.startsWith("data:")).map(line=>line.slice(5).trim()).find(x=>x.startsWith("{"));
  if(!data)throw Error("MCP server returned no JSON-RPC event");return JSON.parse(data);
 }
 return JSON.parse(raw);
}
export async function mcpCall(c:Connector,method:string,params:Record<string,unknown>={},tool?:string):Promise<unknown>{
 allowedUrl(c.url);
 if(!c.enabled)throw Error("Connector disabled");
 if(method==="tools/call"&&(!tool||!readOnlyTools.has(tool)||!c.allowedTools.includes(tool)))throw Error("MCP tool not authorized");
 if(!["initialize","tools/list","tools/call"].includes(method))throw Error("MCP method not authorized");
 const key=process.env[c.tokenEnv];
 if(!key)throw Error("Connector credential missing from environment");
 const ctrl=new AbortController(),timer=setTimeout(()=>ctrl.abort(),12000);
 try{
  const payload={jsonrpc:"2.0",id:randomUUID(),method,params:method==="tools/call"?{name:tool,arguments:params}:params};
  const response=await fetch(c.url,{method:"POST",redirect:"error",signal:ctrl.signal,headers:{"Authorization":"Bearer "+key,"Content-Type":"application/json","Accept":"application/json, text/event-stream","MCP-Protocol-Version":"2025-06-18"},body:JSON.stringify(payload)});
  if(!response.ok)throw Error(response.status===401||response.status===403?"MCP authorization failed":"MCP request failed (HTTP "+response.status+")");
  const raw=await response.text();
  if(raw.length>131072)throw Error("MCP response too large");
  const result=parseResponse(raw,response.headers.get("content-type")??"");
  if(!result||typeof result!=="object")throw Error("Invalid MCP response");
  const rpc=result as {error?:unknown;result?:unknown};
  if(rpc.error)throw Error("MCP server reported an error");
  return rpc.result;
 }catch(error){
  if(error instanceof Error&&error.name==="AbortError")throw Error("MCP request timed out");
  throw error;
 }finally{clearTimeout(timer);}
}
export async function testConnector(c:Connector){
 const init=await mcpCall(c,"initialize",{protocolVersion:"2025-06-18",capabilities:{},clientInfo:{name:"sam",version:"0.1.0"}});
 const listing=await mcpCall(c,"tools/list");
 const obj=listing as {tools?:Array<{name?:string}>};
 const tools=Array.isArray(obj?.tools)?obj.tools.map(x=>x.name).filter((x):x is string=>typeof x==="string"):[];
 return {initialized:!!init,tools,approved:tools.filter(x=>readOnlyTools.has(x)&&c.allowedTools.includes(x))};
}
export async function readConnectorTool(c:Connector,tool:string,args:Record<string,unknown>={}){
 if(!["whoami","pipeline_summary","list_leads"].includes(tool))throw Error("Tool not available in first connector slice");
 const result=await mcpCall(c,"tools/call",args,tool);
 return result;
}
