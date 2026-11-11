import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { ChatStore } from "./chats.js";
import { addHeartbeatJob } from "./heartbeat.js";
import { connectors } from "./connectors.js";

// Minis: a mini is a scoped SAM spawned for one person. Under the hood it is a
// profile plus a registry record, and everything SAM has learned to scope by
// profile snaps to it: the mini's turns only ever load its own chats, its own
// standing law, and the one connector pinned to its profile. A mini cannot see
// another mini's law, chats, or data source, because every read path in the
// engine is keyed by the profile name the mini owns.
// Spawning is one act: profile + welcome chat + optional starter heartbeat +
// registry entry. The registry is what the owner console lists; the profile is
// what the engine runs.
export interface Mini { id:string; name:string; person:string; created_at:string }
function minisPath(root:string){return join(resolve(root),".sam","minis.json");}
function minisDbFile(root:string){return join(resolve(root),".sam","minis.db");}
// State convergence (UNIFICATION item 4, fifteenth store): the minis
// registry is SQLite (.sam/minis.db, the links pattern), one row per
// mini holding the mini's full JSON, rowid order = the old file
// order. The old minis.json was rewritten whole on every spawn and
// every remove, and its writers (the ONE gate's spawn executor and
// the CLI) ran beside minis() readers in the dashboard status build,
// the door handler, and every spawn validation, so two writers
// holding the same snapshot silently lost the second one's change -
// a freshly spawned mini could vanish from the registry (an
// orphaned profile no console lists and no door serves) and a
// removed mini could resurrect under a concurrent spawn's save.
// Here each mutation is a single-row INSERT or DELETE, and
// connections carry a busy_timeout so a writer waits out a peer's
// transaction instead of dying on "database is locked". First open
// imports a legacy minis.json in file order and renames it
// minis.json.migrated - imported, never deleted; a malformed file,
// a non-array payload, or an over-cap payload imports nothing and
// is left in place (the migrated shape reads it as no minis instead
// of throwing "Invalid minis registry", the episodes precedent -
// strictly more forgiving for a registry the console and doors
// read on every request). A pure read on an install with neither
// file creates nothing. The P9 backup snapshots every .sam/*.db
// generically, so the migrated store is carried with no backup
// change.
function openMinisStore(root:string):Database.Database{
 const dir=join(resolve(root),".sam");
 mkdirSync(dir,{recursive:true,mode:0o700});
 if(lstatSync(dir).isSymbolicLink())throw new Error("Unsafe SAM state directory");
 const db=new Database(minisDbFile(root));
 db.pragma("journal_mode = WAL");
 db.pragma("busy_timeout = 5000");
 db.exec("CREATE TABLE IF NOT EXISTS minis (id TEXT PRIMARY KEY, data TEXT NOT NULL)");
 migrateLegacyMinis(db,root);
 return db;
}
function migrateLegacyMinis(db:Database.Database,root:string):void{
 const {n}=db.prepare("SELECT COUNT(*) AS n FROM minis").get() as {n:number};
 if(n>0)return;
 const file=minisPath(root);
 if(!existsSync(file))return;
 let data:unknown;
 try{data=JSON.parse(readFileSync(file,"utf8"));}catch{return;}
 if(!Array.isArray(data)||data.length>50)return;
 const insert=db.prepare("INSERT OR IGNORE INTO minis (id, data) VALUES (?, ?)");
 const importAll=db.transaction((rows:unknown[])=>{
  for(const raw of rows){
   if(!raw||typeof raw!=="object")continue;
   const mini=raw as Partial<Mini>;
   if(typeof mini.id!=="string"||!mini.id)continue;
   insert.run(mini.id,JSON.stringify(mini));
  }
 });
 importAll(data);
 renameSync(file,file+".migrated");
}
function rowToMini(data:string):Mini|null{
 try{const value:unknown=JSON.parse(data);return value&&typeof value==="object"?value as Mini:null;}
 catch{return null;}
}
function storeExists(root:string):boolean{
 return existsSync(minisDbFile(root))||existsSync(minisPath(root));
}
export function minis(root:string):Mini[]{
 if(!storeExists(root))return [];
 const db=openMinisStore(root);
 try{
  const rows=db.prepare("SELECT data FROM minis ORDER BY rowid").all() as Array<{data:string}>;
  const items:Mini[]=[];
  for(const row of rows){const mini=rowToMini(row.data);if(mini)items.push(mini);}
  return items;
 }finally{db.close();}
}
function findMiniRow(root:string,id:string):Mini|null{
 if(!storeExists(root))return null;
 const db=openMinisStore(root);
 try{
  const row=db.prepare("SELECT data FROM minis WHERE id = ?").get(id) as {data:string}|undefined;
  return row?rowToMini(row.data):null;
 }finally{db.close();}
}
function insertMiniRow(root:string,item:Mini):void{
 const db=openMinisStore(root);
 try{db.prepare("INSERT INTO minis (id, data) VALUES (?, ?)").run(item.id,JSON.stringify(item));}
 finally{db.close();}
}
function updateMiniRow(root:string,item:Mini):void{
 const db=openMinisStore(root);
 try{db.prepare("UPDATE minis SET data = ? WHERE id = ?").run(JSON.stringify(item),item.id);}
 finally{db.close();}
}
// The store's update door (the updateLinkGroup precedent): patch one
// mini by id through the store's own shape. Returns the updated
// mini, or null when no such mini exists - and a miss on an install
// with no store at all creates nothing.
export function updateMini(root:string,id:string,patch:Partial<Mini>):Mini|null{
 if(!storeExists(root))return null;
 const current=findMiniRow(root,id);
 if(!current)return null;
 const next:Mini={...current,...patch,id:current.id};
 updateMiniRow(root,next);
 return next;
}
export interface SpawnMiniInput { name:string; person:string; instructions:string; model?:string|null; connectorId?:string|null; starterHeartbeat?:boolean }
export function spawnMini(root:string,input:SpawnMiniInput):Mini{
  if(!/^[a-z][a-z0-9._-]{0,63}$/.test(input.name))throw new Error("Invalid mini name");
  if(!input.person.trim()||input.person.length>80)throw new Error("Invalid person");
  const existing=minis(root);
  if(existing.some(m=>m.name===input.name))throw new Error("Mini already exists");
  const db=new ChatStore(root);
  let welcomeChatId:string;
  try{
    db.createAgent(input.name,input.instructions,{model:input.model??null,connectorId:input.connectorId??null});
    welcomeChatId=db.create("Meet "+input.person.trim(),input.name).id;
  }finally{db.close();}
  if(input.starterHeartbeat){
    addHeartbeatJob(root,input.name+" daily digest",1440,input.name,
      "Write a short daily digest for "+input.person.trim()+": anything new in your chats with them, anything you are watching on their behalf, and one line on what you will keep an eye on next. Keep it under 10 lines. If nothing happened, say so in one line.",null);
  }
  const mini:Mini={id:randomUUID(),name:input.name,person:input.person.trim(),created_at:new Date().toISOString()};
  insertMiniRow(root,mini);
  void welcomeChatId;
  return mini;
}
export interface SpawnSpec { name:string; person:string; instructions:string; model:string|null; connectorId:string|null; starterHeartbeat:boolean }
/** Proposal-time validation for a kind "spawn" detail (the team build,
 *  Dip 2026-11-10): the owner is never shown a spawn card that cannot
 *  execute. The name must be a fresh profile name - not "sam", not an
 *  existing scoped agent, not an existing profile of any kind - the
 *  person and the standing instructions must be real, and a connector
 *  pin must name a connector this install actually holds. Execution
 *  re-validates, so a name taken between proposal and approval fails
 *  the card instead of colliding. */
export function validateSpawnDetail(root:string,detail:string):SpawnSpec{
  let raw:Record<string,unknown>;
  try{raw=JSON.parse(detail) as Record<string,unknown>;}catch{throw new Error("Invalid spawn detail: not JSON");}
  const name=typeof raw.name==="string"?raw.name:"";
  if(!/^[a-z][a-z0-9._-]{0,63}$/.test(name))throw new Error("Invalid spawn name: a lowercase profile name (letters, digits, . _ -), starting with a letter");
  if(name==="sam")throw new Error("Invalid spawn name: 'sam' is the core profile and already exists");
  const person=typeof raw.person==="string"?raw.person.trim():"";
  if(!person||person.length>80)throw new Error("Invalid spawn person: name who or what the new agent serves (1 to 80 chars)");
  const instructions=typeof raw.instructions==="string"?raw.instructions.trim():"";
  if(!instructions||instructions.length>4000)throw new Error("Invalid spawn instructions: the new agent's standing orders (1 to 4000 chars)");
  if(minis(root).some(m=>m.name===name))throw new Error("Cannot spawn '" + name + "': an agent with that name already exists");
  const db=new ChatStore(root);
  try{if(db.agents().some(a=>a.name===name))throw new Error("Cannot spawn '" + name + "': a profile with that name already exists");}finally{db.close();}
  const model=typeof raw.model==="string"&&raw.model.trim()?raw.model.trim():null;
  if(model&&model.length>120)throw new Error("Invalid spawn model pin (max 120 chars)");
  const connectorId=typeof raw.connectorId==="string"&&raw.connectorId.trim()?raw.connectorId.trim():null;
  if(connectorId&&!connectors(root).some(c=>c.id===connectorId))throw new Error("Cannot spawn: no connector with id " + connectorId + " exists on this install");
  return {name,person,instructions,model,connectorId,starterHeartbeat:raw.starterHeartbeat===true};
}
export function removeMini(root:string,name:string):boolean{
  if(!storeExists(root))return false;
  const target=minis(root).find(m=>m.name===name);
  if(!target)return false;
  const db=openMinisStore(root);
  try{
    const result=db.prepare("DELETE FROM minis WHERE id = ?").run(target.id);
    return result.changes>0;
  }finally{db.close();}
}
