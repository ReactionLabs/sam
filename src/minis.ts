import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
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
function registryPath(root:string){return join(resolve(root),".sam","minis.json");}
export function minis(root:string):Mini[]{
  if(!existsSync(registryPath(root)))return [];
  const value:unknown=JSON.parse(readFileSync(registryPath(root),"utf8"));
  if(!Array.isArray(value)||value.length>50)throw new Error("Invalid minis registry");
  return value as Mini[];
}
function saveMinis(root:string,items:Mini[]){mkdirSync(join(resolve(root),".sam"),{recursive:true});writeFileSync(registryPath(root),JSON.stringify(items,null,2),{mode:0o600});}
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
  saveMinis(root,[...existing,mini]);
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
  const items=minis(root),rest=items.filter(m=>m.name!==name);
  if(rest.length===items.length)return false;
  saveMinis(root,rest);return true;
}
