import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export type Connector = { id:string; name:string; url:string; tokenEnv:string; enabled:boolean; allowedTools:string[] };
// Every tool SAM may ever call, across all known MCP servers. All are read-only by
// construction on their servers; authorization still intersects this set with the
// connector's own allowedTools and the tools the server actually advertises.
export const readOnlyTools = new Set(["whoami","list_leads","get_lead","pipeline_summary","analytics_summary","coin_lookup","list_candidates","list_alerts","paper_setups","stack_health"]);
const namePattern = /^[A-Za-z0-9 _.-]{1,64}$/;
const envPattern = /^SAM_MCP_TOKEN_[A-Z0-9_]{1,64}$/;
function path(root:string){return join(resolve(root),".sam","connectors.json");}
function allowedUrl(raw:string):string{
 const u=new URL(raw);
 if(u.username||u.password||u.hash||u.search)throw Error("MCP endpoint must be a plain URL");
 const allowed=(process.env.SAM_MCP_ALLOWED_HOSTS??"mcp.secondshiftos.com").split(",").map(x=>x.trim().toLowerCase()).filter(Boolean);
 const host=u.hostname.toLowerCase();
 const loopback=host==="127.0.0.1"||host==="localhost"||host==="::1";
 // Narrow loopback exception: a same-machine MCP server (e.g. the Nines MCP on
 // Johnny's box) may use plain http on an explicit port, but only when the
 // operator allowlisted the loopback host by name. Remote stays HTTPS-only.
 if(loopback&&allowed.includes(host)){
  if(u.protocol!=="http:")throw Error("Loopback MCP endpoint must use plain http on this machine");
  if(!u.port)throw Error("Loopback MCP endpoint needs an explicit port");
  return u.toString();
 }
 if(u.protocol!=="https:"||u.port)throw Error("MCP endpoint must be a plain HTTPS URL");
 if(!allowed.includes(host))throw Error("MCP host not allowlisted. Set SAM_MCP_ALLOWED_HOSTS locally.");
 return u.toString();
}
const connectorFields=["id","name","url","tokenEnv","enabled","allowedTools"] as const;
const idPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function validateConnector(value:unknown):Connector{
 if(!value||typeof value!=="object"||Array.isArray(value)||Object.getPrototypeOf(value)!==Object.prototype)
  throw Error("Invalid connector registry entry");
 const item=value as Record<string,unknown>;
 if(Object.keys(item).length!==connectorFields.length||connectorFields.some(key=>!Object.hasOwn(item,key)))
  throw Error("Invalid connector registry entry");
 const {id,name,url,tokenEnv,enabled,allowedTools}=item;
 if(typeof id!=="string"||!idPattern.test(id)||typeof name!=="string"||!namePattern.test(name))
  throw Error("Invalid connector identity");
 if(typeof tokenEnv!=="string"||!envPattern.test(tokenEnv))
  throw Error("Invalid connector credential reference");
 if(typeof enabled!=="boolean")throw Error("Invalid connector enabled state");
 if(typeof url!=="string")throw Error("Invalid connector endpoint");
 try{allowedUrl(url);}catch{throw Error("Invalid connector endpoint");}
 if(!Array.isArray(allowedTools)||allowedTools.length>readOnlyTools.size||
    !allowedTools.every((tool):tool is string=>typeof tool==="string"&&readOnlyTools.has(tool))||
    new Set(allowedTools).size!==allowedTools.length)
  throw Error("Invalid connector tool allowlist");
 return {id,name,url,tokenEnv,enabled,allowedTools:[...allowedTools]};
}
export function connectors(root:string):Connector[]{
 if(!existsSync(path(root)))return [];
 const value:unknown=JSON.parse(readFileSync(path(root),"utf8"));
 if(!Array.isArray(value)||value.length>32)throw Error("Invalid connector registry");
 const items=value.map(validateConnector);
 const ids=new Set<string>(),names=new Set<string>();
 for(const item of items){
  if(ids.has(item.id)||names.has(item.name))throw Error("Duplicate connector identity");
  ids.add(item.id);names.add(item.name);
 }
 return items;
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
type RpcEnvelope={jsonrpc?:string;id?:string|number;result?:unknown;error?:unknown};
type Session={id?:string;version:string};
function parseResponse(raw:string,contentType:string):RpcEnvelope{
 let parsed:unknown;
 if(contentType.includes("text/event-stream")){
  const events=raw.split(/\r?\n\r?\n/);
  const data=events.flatMap(e=>e.split(/\r?\n/).filter(l=>l.startsWith("data:")).map(l=>l.slice(5).trim())).find(v=>v.startsWith("{"));
  if(!data)throw Error("MCP server returned no JSON-RPC event");
  parsed=JSON.parse(data);
 }else parsed=JSON.parse(raw);
 if(!parsed||typeof parsed!=="object"||Array.isArray(parsed))throw Error("Invalid MCP response");
 return parsed as RpcEnvelope;
}
async function exchange(c:Connector,session:Session,method:string,params:Record<string,unknown>,notification=false):Promise<unknown>{
 const key=process.env[c.tokenEnv];
 if(!key)throw Error("Connector credential missing from environment");
 const ctrl=new AbortController(),timer=setTimeout(()=>ctrl.abort(),12000);
 const id=randomUUID();
 try{
  const payload=notification?{jsonrpc:"2.0",method,params}:{jsonrpc:"2.0",id,method,params};
  const headers:Record<string,string>={"Authorization":"Bearer "+key,"Content-Type":"application/json","Accept":"application/json, text/event-stream","MCP-Protocol-Version":session.version};
  if(session.id)headers["Mcp-Session-Id"]=session.id;
  const response=await fetch(c.url,{method:"POST",redirect:"error",signal:ctrl.signal,headers,body:JSON.stringify(payload)});
  if(!response.ok)throw Error(response.status===401||response.status===403?"MCP authorization failed":"MCP request failed (HTTP "+response.status+")");
  const sessionId=response.headers.get("mcp-session-id");
  if(sessionId){
   if(sessionId.length>256||/[\r\n]/.test(sessionId))throw Error("Invalid MCP session ID");
   session.id=sessionId;
  }
  if(notification&&response.status===202)return undefined;
  const reader=response.body?.getReader();
  if(!reader)throw Error("Empty MCP response");
  const chunks:Uint8Array[]=[];let length=0;
  try{for(;;){const {done,value}=await reader.read();if(done)break;length+=value.byteLength;if(length>131072)throw Error("MCP response too large");chunks.push(value);}}finally{reader.releaseLock();}
  const raw=Buffer.concat(chunks).toString("utf8");
  if(notification&&!raw.trim())return undefined;
  const rpc=parseResponse(raw,response.headers.get("content-type")??"");
  if(rpc.jsonrpc!=="2.0"||(!notification&&rpc.id!==id))throw Error("MCP response ID mismatch");
  if(rpc.error)throw Error("MCP server reported an error");
  return rpc.result;
 }catch(error){
  if(error instanceof Error&&error.name==="AbortError")throw Error("MCP request timed out");
  throw error;
 }finally{clearTimeout(timer);}
}
async function openSession(c:Connector):Promise<Session>{
 const session:Session={version:"2025-06-18"};
 const init=await exchange(c,session,"initialize",{protocolVersion:session.version,capabilities:{},clientInfo:{name:"sam",version:"0.1.0"}});
 const result=init as {protocolVersion?:unknown}|undefined;
 if(!result||typeof result.protocolVersion!=="string")throw Error("Invalid MCP initialization");
 session.version=result.protocolVersion;
 await exchange(c,session,"notifications/initialized",{},true);
 return session;
}
export async function mcpCall(c:Connector,method:string,params:Record<string,unknown>={},tool?:string):Promise<unknown>{
 allowedUrl(c.url);
 if(!c.enabled)throw Error("Connector disabled");
 if(method==="tools/call"&&(!tool||!readOnlyTools.has(tool)||!c.allowedTools.includes(tool)))throw Error("MCP tool not authorized");
 if(!["initialize","tools/list","tools/call"].includes(method))throw Error("MCP method not authorized");
 const session=await openSession(c);
 if(method==="initialize")return {protocolVersion:session.version};
 return exchange(c,session,method,method==="tools/call"?{name:tool,arguments:params}:params);
}
export async function testConnector(c:Connector){
 allowedUrl(c.url);
 const session=await openSession(c);
 const listing=await exchange(c,session,"tools/list",{});
 const obj=listing as {tools?:Array<{name?:string}>};
 const tools=Array.isArray(obj?.tools)?obj.tools.map(x=>x.name).filter((x):x is string=>typeof x==="string"):[];
 return {initialized:true,protocolVersion:session.version,tools,approved:tools.filter(x=>readOnlyTools.has(x)&&c.allowedTools.includes(x))};
}
export async function readConnectorTool(c:Connector,tool:string,args:Record<string,unknown>={}){
 if(!readOnlyTools.has(tool)||!c.allowedTools.includes(tool))throw Error("Tool not authorized for this connector");
 return mcpCall(c,"tools/call",args,tool);
}
