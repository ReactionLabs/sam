import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { openDatabase } from "./sqlite.js";
import { recordActivity } from "./activity.js";
import { getVaultCredentialValue, listVaultCredentials, VAULT_NAME_RE } from "./vault.js";

// A connector's credential comes from exactly one of two places:
// the process environment (tokenEnv, the original shape) or the
// SAM VAULT (vaultKey, SELF-PAIRING, Dip ruling 2026-11-12 13:18
// EST) - referenced by NAME only and resolved by the executor at
// call time. A vault-resolved value never enters the process
// environment, a log, or the model's view; every resolution is
// ledgered as a vault-use line carrying the credential name, the
// connector, and the outcome - never the value.
export type Connector = { id:string; name:string; url:string; tokenEnv:string; vaultKey?:string|null; enabled:boolean; allowedTools:string[] };
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
// The pairing flow's persisted loopback allowlist: when SAM pairs
// himself to a same-machine MCP (the Desktop Bridge shape), the
// loopback host is recorded here - in the connector store itself -
// because the env allowlist (SAM_MCP_ALLOWED_HOSTS) is an operator
// boot-time act no SAM flow can persist. Only loopback hosts may
// ever be recorded, and recording one never widens remote access:
// allowedUrl still demands plain http on an explicit port for a
// loopback endpoint, and HTTPS + the env allowlist for anything else.
const LOOPBACK_HOSTS = new Set(["127.0.0.1","localhost","::1"]);
export function isLoopbackHost(host:string):boolean{return LOOPBACK_HOSTS.has(host.toLowerCase());}
export function pairAllowlistedHosts(root:string):string[]{
 if(!existsSync(connectorsDbFile(root)))return [];
 const db=openConnectorsStore(root);
 try{
  db.exec("CREATE TABLE IF NOT EXISTS pair_allowlist (host TEXT PRIMARY KEY)");
  return (db.prepare("SELECT host FROM pair_allowlist ORDER BY rowid").all() as Array<{host:string}>).map(r=>r.host);
 }finally{db.close();}
}
export function allowlistPairHost(root:string,host:string):string{
 const h=host.trim().toLowerCase();
 if(!isLoopbackHost(h))throw Error("Only a loopback host can be allowlisted by pairing");
 const db=openConnectorsStore(root);
 try{
  db.exec("CREATE TABLE IF NOT EXISTS pair_allowlist (host TEXT PRIMARY KEY)");
  db.prepare("INSERT OR IGNORE INTO pair_allowlist (host) VALUES (?)").run(h);
 }finally{db.close();}
 return h;
}
function allowedUrl(raw:string,root?:string):string{
 const u=new URL(raw);
 if(u.username||u.password||u.hash||u.search)throw Error("MCP endpoint must be a plain URL");
 const allowed=(process.env.SAM_MCP_ALLOWED_HOSTS??"mcp.secondshiftos.com").split(",").map(x=>x.trim().toLowerCase()).filter(Boolean);
 if(root)for(const h of pairAllowlistedHosts(root))if(!allowed.includes(h))allowed.push(h);
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
 const endpoint=allowedUrl(url,root), items=connectors(root);
 if(items.length>=32||items.some(c=>c.name===name))throw Error("Connector limit or duplicate name");
 const item:Connector={id:randomUUID(),name,url:endpoint,tokenEnv,enabled:true,allowedTools:[...readOnlyTools]};
 insertConnectorRow(root,item);return item;
}
// The vault-bound registration (SELF-PAIRING): the connector names
// a vault credential instead of an env var. The credential must
// EXIST in the vault by name at registration time - pairing to a
// name the owner never deposited is refused here, so a paired
// connector can never point at an invented secret. tokenEnv is
// stored empty: this connector's credential lives in the vault only.
export function addConnectorVault(root:string,name:string,url:string,vaultKey:string):Connector{
 if(!namePattern.test(name))throw Error("Invalid connector name");
 if(!VAULT_NAME_RE.test(vaultKey))throw Error("Invalid vault credential name");
 if(!listVaultCredentials(root).some(c=>c.name===vaultKey))throw Error("No vault credential named \""+vaultKey+"\" - the owner deposits credentials into the vault; SAM never creates one");
 const endpoint=allowedUrl(url,root), items=connectors(root);
 if(items.length>=32||items.some(c=>c.name===name))throw Error("Connector limit or duplicate name");
 const item:Connector={id:randomUUID(),name,url:endpoint,tokenEnv:"",vaultKey,enabled:true,allowedTools:[...readOnlyTools]};
 insertConnectorRow(root,item);return item;
}
// EXECUTOR-ONLY credential resolution: env-backed connectors read
// their named env var (unchanged); vault-backed connectors resolve
// the value from the vault at call time. The value goes into the
// Authorization header of the MCP exchange and nowhere else.
export function resolveConnectorCredential(root:string|undefined,c:Connector):string|null{
 // A vault-backed connector resolves ONLY against a real workspace
 // root; without one it fails closed rather than ever reading a
 // vault relative to some other directory.
 if(c.vaultKey)return root?getVaultCredentialValue(root,c.vaultKey):null;
 return c.tokenEnv?process.env[c.tokenEnv]??null:null;
}
export function connectorCredentialPresent(root:string,c:Connector):boolean{
 return resolveConnectorCredential(root,c)!==null;
}
function ledgerConnectorVaultUse(root:string,c:Connector,purpose:string,outcome:string):void{
 if(!c.vaultKey)return;
 try{recordActivity(root,"sam","vault-use","Vault credential "+c.vaultKey+" used for connector \""+c.name+"\" ("+purpose+") - "+outcome);}catch{/* the ledger never breaks a connector call */}
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
 allowedUrl(c.url,root);return c;
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
async function exchange(root:string|undefined,c:Connector,session:Session,method:string,params:Record<string,unknown>,notification=false):Promise<unknown>{
 const key=resolveConnectorCredential(root,c);
 if(!key)throw Error(c.vaultKey?"Connector credential missing from vault":"Connector credential missing from environment");
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
async function openSession(root:string|undefined,c:Connector):Promise<Session>{
 const session:Session={version:"2025-06-18"};
 const init=await exchange(root,c,session,"initialize",{protocolVersion:session.version,capabilities:{},clientInfo:{name:"sam",version:"0.1.0"}});
 const result=init as {protocolVersion?:unknown}|undefined;
 if(!result||typeof result.protocolVersion!=="string")throw Error("Invalid MCP initialization");
 session.version=result.protocolVersion;
 await exchange(root,c,session,"notifications/initialized",{},true);
 return session;
}
// The root argument is what lets a vault-backed connector resolve
// its credential: callers that hold the workspace root pass it, and
// a vault-backed connector called without one fails closed with
// "credential missing from vault" instead of ever falling back to
// the environment. Env-backed connectors behave exactly as before
// with or without it. Every vault-backed public call ledgers ONE
// vault-use line (name + connector + outcome) per operation.
export async function mcpCall(c:Connector,method:string,params:Record<string,unknown>={},tool?:string,root?:string):Promise<unknown>{
 allowedUrl(c.url,root);
 if(!c.enabled)throw Error("Connector disabled");
 if(method==="tools/call"&&(!tool||!readOnlyTools.has(tool)||!c.allowedTools.includes(tool)))throw Error("MCP tool not authorized");
 if(!["initialize","tools/list","tools/call"].includes(method))throw Error("MCP method not authorized");
 try{
  const session=await openSession(root,c);
  const out=method==="initialize"?{protocolVersion:session.version}:await exchange(root,c,session,method,method==="tools/call"?{name:tool,arguments:params}:params);
  if(root)ledgerConnectorVaultUse(root,c,method==="tools/call"?"tool call "+String(tool):method,"ok");
  return out;
 }catch(e){
  if(root)ledgerConnectorVaultUse(root,c,method==="tools/call"?"tool call "+String(tool):method,"failed: "+(e instanceof Error?e.message:"unknown error"));
  throw e;
 }
}
export async function testConnector(c:Connector,root?:string){
 allowedUrl(c.url,root);
 try{
  const session=await openSession(root,c);
  const listing=await exchange(root,c,session,"tools/list",{});
  const obj=listing as {tools?:Array<{name?:string}>};
  const tools=Array.isArray(obj?.tools)?obj.tools.map(x=>x.name).filter((x):x is string=>typeof x==="string"):[];
  if(root)ledgerConnectorVaultUse(root,c,"connector test","ok");
  return {initialized:true,protocolVersion:session.version,tools,approved:tools.filter(x=>readOnlyTools.has(x)&&c.allowedTools.includes(x))};
 }catch(e){
  if(root)ledgerConnectorVaultUse(root,c,"connector test","failed: "+(e instanceof Error?e.message:"unknown error"));
  throw e;
 }
}
export async function readConnectorTool(c:Connector,tool:string,args:Record<string,unknown>={},root?:string){
 if(!readOnlyTools.has(tool)||!c.allowedTools.includes(tool))throw Error("Tool not authorized for this connector");
 return mcpCall(c,"tools/call",args,tool,root);
}
