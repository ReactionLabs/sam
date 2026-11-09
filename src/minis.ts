import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ChatStore } from "./chats.js";
import { addHeartbeatJob } from "./heartbeat.js";

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
export function removeMini(root:string,name:string):boolean{
  const items=minis(root),rest=items.filter(m=>m.name!==name);
  if(rest.length===items.length)return false;
  saveMinis(root,rest);return true;
}
