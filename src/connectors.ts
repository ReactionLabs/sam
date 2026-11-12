import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { openDatabase } from "./sqlite.js";

export type Connector = { id:string; name:string; url:string; tokenEnv:string; enabled:boolean; allowedTools:string[] };
// Every tool SAM may ever call, across all known MCP servers. All are read-only by
// construction on their servers; authorization still intersects this set with the
// connector's own allowedTools and the tools the server actually advertises.
export const readOnlyTools = new Set(["whoami","list_leads","get_lead","pipeline_summary","analytics_summary","coin_lookup","list_candidates","list_alerts","paper_setups","stack_health"]);
const namePattern = /^[A-Za-z0-9 _.-]{1,64}$/;
const envPattern = /^SAM_MCP_TOKEN_[A-Z0-9_]{1,64}$/;
function connectorsFile(root:string){return join(resolve(root),".sam","connectors.json");}
function connectorsDbFile(root:string){return join(resolve(root),".sam","connectors.db");}
// State convergence (UNIFICATION item 4, twelfth store): the connector
// registry is SQLite (.sam/connectors.db, the channels pattern), one
// row per connector holding the connector's full JSON, rowid order =
// the old file order. The old connectors.json was rewritten whole on
// every add and remove, and its writers (the dashboard connector
// routes and the CLI) ran beside readers in every turn process, so
// two writers holding the same snapshot silently lost the second
// one's change: a removed connector could resurrect, an added one
// could vanish, and a snapshot save could restore an enabled flag or
// a wider allowedTools set than the registry currently holds - the
// turn loops authorize from exactly those fields. Here each mutation
// is a single-row INSERT, UPDATE, or DELETE, and connections carry a
// busy_timeout so a writer waits out a peer's transaction instead of
// dying on "database is locked". First open imports a legacy
// connectors.json in file order and renames it
// connectors.json.migrated - imported, never deleted; a malformed
// file, a non-array payload, or an over-cap payload imports nothing
// and is left in place (the migrated shape reads it as an empty
// registry instead of throwing "Invalid connector registry", the
// channels precedent - strictly safer for an authorization store).
// A pure read on an install with neither file creates nothing. The
// P9 backup snapshots every .sam/*.db generically, so the migrated
// store is carried with no backup change.
function openConnectorsStore(root:string):Database.Database{
 const dir=join(resolve(root),".sam");
 mkdirSync(dir,{recursive:true,mode:0o700});
 if(lstatSync(dir).isSymbolicLink())throw new Error("Unsafe SAM state directory");
 const db=openDatabase(connectorsDbFile(root));
 db.exec("CREATE TABLE IF NOT EXISTS connectors (id TEXT PRIMARY KEY, data TEXT NOT NULL)");
 migrateLegacyConnectors(db,root);
 return db;
}
function migrateLegacyConnectors(db:Database.Database,root:string):void{
 const {n}=db.prepare("SELECT COUNT(*) AS n FROM connectors").get() as {n:number};
 if(n>0)return;
 const file=connectorsFile(root);
 if(!existsSync(file))return;
 let data:unknown;
 try{data=JSON.parse(readFileSync(file,"utf8"));}catch{return;}
 if(!Array.isArray(data)||data.length>32)return;
 const insert=db.prepare("INSERT OR IGNORE INTO connectors (id, data) VALUES (?, ?)");
 const importAll=db.transaction((rows:unknown[])=>{
  for(const raw of rows){
   if(!raw||typeof raw!=="object")continue;
   const connector=raw as Partial<Connector>;
   if(typeof connector.id!=="string"||!connector.id)continue;
   insert.run(connector.id,JSON.stringify(connector));
  }
 });
 importAll(data);
 renameSync(file,file+".migrated");
}
function rowToConnector(data:string):Connector|null{
 try{const value:unknown=JSON.parse(data);return value&&typeof value==="object"?value as Connector:null;}
 catch{return null;}
}
function storeExists(root:string):boolean{
 return existsSync(connectorsDbFile(root))||existsSync(connectorsFile(root));
}
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
export function connectors(root:string):Connector[]{
 if(!storeExists(root))return [];
 const db=openConnectorsStore(root);
 try{
  const rows=db.prepare("SELECT data FROM connectors ORDER BY rowid").all() as Array<{data:string}>;
  const items:Connector[]=[];
  for(const row of rows){const connector=rowToConnector(row.data);if(connector)items.push(connector);}
  return items;
 }finally{db.close();}
}
function findConnectorRow(root:string,id:string):Connector|null{
 if(!storeExists(root))return null;
 const db=openConnectorsStore(root);
 try{
  const row=db.prepare("SELECT data FROM connectors WHERE id = ?").get(id) as {data:string}|undefined;
  return row?rowToConnector(row.data):null;
 }finally{db.close();}
}
function insertConnectorRow(root:string,item:Connector):void{
 const db=openConnectorsStore(root);
 try{db.prepare("INSERT INTO connectors (id, data) VALUES (?, ?)").run(item.id,JSON.stringify(item));}
 finally{db.close();}
}
function updateConnectorRow(root:string,item:Connector):void{
 const db=openConnectorsStore(root);
 try{db.prepare("UPDATE connectors SET data = ? WHERE id = ?").run(JSON.stringify(item),item.id);}
 finally{db.close();}
}
// The store's update door (the updateChannel precedent): patch one
// connector by id through the store's own shape. Returns the updated
// connector, or null when no such connector exists - and a miss on
// an install with no store at all creates nothing.
export function updateConnector(root:string,id:string,patch:Partial<Connector>):Connector|null{
 if(!storeExists(root))return null;
 const current=findConnectorRow(root,id);
 if(!current)return null;
 const next:Connector={...current,...patch,id:current.id};
 updateConnectorRow(root,next);
 return next;
}
export function addConnector(root:string,name:string,url:string,tokenEnv:string):Connector{
 if(!namePattern.test(name)||!envPattern.test(tokenEnv))throw Error("Invalid connector name or environment variable");
 const endpoint=allowedUrl(url), items=connectors(root);
 if(items.length>=32||items.some(c=>c.name===name))throw Error("Connector limit or duplicate name");
 const item:Connector={id:randomUUID(),name,url:endpoint,tokenEnv,enabled:true,allowedTools:[...readOnlyTools]};
 insertConnectorRow(root,item);return item;
}
export function removeConnector(root:string,id:string):boolean{
 if(!storeExists(root))return false;
 const db=openConnectorsStore(root);
 try{
  const result=db.prepare("DELETE FROM connectors WHERE id = ?").run(id);
  return result.changes>0;
 }finally{db.close();}
}
export function getConnector(root:string,id:string):Connector{
 const c=findConnectorRow(root,id);
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
