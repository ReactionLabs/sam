import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ChatStore } from "./chats.js";

// Links: the only bridge between profiles. Profiles are isolated by default -
// each has its own private memory scope and cannot see another's. A link group
// adds ONE shared scope visible to exactly its members. Law is never shared:
// a link shares memory (facts), never one profile's rules over another.
export interface LinkGroup { id:string; name:string; members:string[]; created_at:string }
function linksPath(root:string){return join(resolve(root),".sam","links.json");}
export function links(root:string):LinkGroup[]{
  if(!existsSync(linksPath(root)))return [];
  const value:unknown=JSON.parse(readFileSync(linksPath(root),"utf8"));
  if(!Array.isArray(value)||value.length>100)throw new Error("Invalid links registry");
  return value as LinkGroup[];
}
function saveLinks(root:string,items:LinkGroup[]){mkdirSync(join(resolve(root),".sam"),{recursive:true});writeFileSync(linksPath(root),JSON.stringify(items,null,2),{mode:0o600});}
function validMember(root:string,name:string):boolean{
  if(name==="sam")return true;
  if(!/^[a-z][a-z0-9._-]{0,63}$/.test(name))return false;
  const db=new ChatStore(root);try{return db.agents().some(a=>a.name===name);}finally{db.close();}
}
export function createLink(root:string,name:string,members:string[]):LinkGroup{
  if(!name.trim()||name.length>80)throw new Error("Invalid link name");
  const unique=[...new Set(members)];
  if(unique.length<2)throw new Error("A link needs at least two members");
  for(const member of unique)if(!validMember(root,member))throw new Error("Unknown profile: "+member);
  const group:LinkGroup={id:randomUUID(),name:name.trim(),members:unique,created_at:new Date().toISOString()};
  saveLinks(root,[...links(root),group]);return group;
}
export function addLinkMember(root:string,id:string,member:string):LinkGroup{
  if(!validMember(root,member))throw new Error("Unknown profile: "+member);
  const items=links(root);const group=items.find(g=>g.id===id);
  if(!group)throw new Error("Link not found");
  if(!group.members.includes(member))group.members.push(member);
  saveLinks(root,items);return group;
}
export function removeLinkMember(root:string,id:string,member:string):LinkGroup{
  const items=links(root);const group=items.find(g=>g.id===id);
  if(!group)throw new Error("Link not found");
  group.members=group.members.filter(m=>m!==member);
  saveLinks(root,items);return group;
}
export function deleteLink(root:string,id:string):boolean{
  const items=links(root),rest=items.filter(g=>g.id!==id);
  if(rest.length===items.length)return false;saveLinks(root,rest);return true;
}
// The scopes one actor may read: its own level plus every link it belongs to.
// The core actor "sam" owns the core level. A named profile NEVER sees the
// core, and never sees another profile's private scope, linked or not.
export function visibleScopes(root:string,actor:string):string[]{
  const own=actor==="sam"?"core":"profile:"+actor;
  const shared=links(root).filter(g=>g.members.includes(actor)).map(g=>"link:"+g.id);
  return [own,...shared];
}
