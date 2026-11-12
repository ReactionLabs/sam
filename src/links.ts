import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { openDatabase } from "./sqlite.js";
import { ChatStore } from "./chats.js";

// Links: the only bridge between profiles. Profiles are isolated by default -
// each has its own private memory scope and cannot see another's. A link group
// adds ONE shared scope visible to exactly its members. Law is never shared:
// a link shares memory (facts), never one profile's rules over another.
export interface LinkGroup { id:string; name:string; members:string[]; created_at:string }
function linksPath(root:string){return join(resolve(root),".sam","links.json");}
function linksDbFile(root:string){return join(resolve(root),".sam","links.db");}
// State convergence (UNIFICATION item 4, fourteenth store): the link
// registry is SQLite (.sam/links.db, the connectors pattern), one
// row per link group holding the group's full JSON, rowid order =
// the old file order. The old links.json was rewritten whole on
// every create, member add, member remove, and delete, and its
// writers (the dashboard/chat gate executor and spawn path, and
// the CLI) ran beside visibleScopes readers in every turn process,
// so two writers holding the same snapshot silently lost the
// second one's change - security-shaped here: a removed member
// could resurrect and regain the shared link scope, a deleted
// link could resurrect the same way, and a freshly created link
// could vanish. Here each mutation is a single-row INSERT,
// UPDATE, or DELETE, and connections carry a busy_timeout so a
// writer waits out a peer's transaction instead of dying on
// "database is locked". First open imports a legacy links.json
// in file order and renames it links.json.migrated - imported,
// never deleted; a malformed file, a non-array payload, or an
// over-cap payload imports nothing and is left in place (the
// migrated shape reads it as no links instead of throwing
// "Invalid links registry", the channels precedent - a torn
// file then yields own-scope-only, never wider access). A pure
// read on an install with neither file creates nothing. The P9
// backup snapshots every .sam/*.db generically, so the migrated
// store is carried with no backup change.
function openLinksStore(root:string):Database.Database{
 const dir=join(resolve(root),".sam");
 mkdirSync(dir,{recursive:true,mode:0o700});
 if(lstatSync(dir).isSymbolicLink())throw new Error("Unsafe SAM state directory");
 const db=openDatabase(linksDbFile(root));
 db.exec("CREATE TABLE IF NOT EXISTS link_groups (id TEXT PRIMARY KEY, data TEXT NOT NULL)");
 migrateLegacyLinks(db,root);
 return db;
}
function migrateLegacyLinks(db:Database.Database,root:string):void{
 const {n}=db.prepare("SELECT COUNT(*) AS n FROM link_groups").get() as {n:number};
 if(n>0)return;
 const file=linksPath(root);
 if(!existsSync(file))return;
 let data:unknown;
 try{data=JSON.parse(readFileSync(file,"utf8"));}catch{return;}
 if(!Array.isArray(data)||data.length>100)return;
 const insert=db.prepare("INSERT OR IGNORE INTO link_groups (id, data) VALUES (?, ?)");
 const importAll=db.transaction((rows:unknown[])=>{
  for(const raw of rows){
   if(!raw||typeof raw!=="object")continue;
   const group=raw as Partial<LinkGroup>;
   if(typeof group.id!=="string"||!group.id)continue;
   insert.run(group.id,JSON.stringify(group));
  }
 });
 importAll(data);
 renameSync(file,file+".migrated");
}
function rowToLink(data:string):LinkGroup|null{
 try{const value:unknown=JSON.parse(data);return value&&typeof value==="object"?value as LinkGroup:null;}
 catch{return null;}
}
function storeExists(root:string):boolean{
 return existsSync(linksDbFile(root))||existsSync(linksPath(root));
}
export function links(root:string):LinkGroup[]{
 if(!storeExists(root))return [];
 const db=openLinksStore(root);
 try{
  const rows=db.prepare("SELECT data FROM link_groups ORDER BY rowid").all() as Array<{data:string}>;
  const items:LinkGroup[]=[];
  for(const row of rows){const group=rowToLink(row.data);if(group)items.push(group);}
  return items;
 }finally{db.close();}
}
function findLinkRow(root:string,id:string):LinkGroup|null{
 if(!storeExists(root))return null;
 const db=openLinksStore(root);
 try{
  const row=db.prepare("SELECT data FROM link_groups WHERE id = ?").get(id) as {data:string}|undefined;
  return row?rowToLink(row.data):null;
 }finally{db.close();}
}
function insertLinkRow(root:string,item:LinkGroup):void{
 const db=openLinksStore(root);
 try{db.prepare("INSERT INTO link_groups (id, data) VALUES (?, ?)").run(item.id,JSON.stringify(item));}
 finally{db.close();}
}
function updateLinkRow(root:string,item:LinkGroup):void{
 const db=openLinksStore(root);
 try{db.prepare("UPDATE link_groups SET data = ? WHERE id = ?").run(JSON.stringify(item),item.id);}
 finally{db.close();}
}
// The store's update door (the updateConnector precedent): patch one
// link group by id through the store's own shape. Returns the updated
// group, or null when no such group exists - and a miss on an
// install with no store at all creates nothing.
export function updateLinkGroup(root:string,id:string,patch:Partial<LinkGroup>):LinkGroup|null{
 if(!storeExists(root))return null;
 const current=findLinkRow(root,id);
 if(!current)return null;
 const next:LinkGroup={...current,...patch,id:current.id};
 updateLinkRow(root,next);
 return next;
}
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
 insertLinkRow(root,group);return group;
}
export function addLinkMember(root:string,id:string,member:string):LinkGroup{
 if(!validMember(root,member))throw new Error("Unknown profile: "+member);
 const group=findLinkRow(root,id);
 if(!group)throw new Error("Link not found");
 if(!group.members.includes(member)){group.members.push(member);updateLinkRow(root,group);}
 return group;
}
export function removeLinkMember(root:string,id:string,member:string):LinkGroup{
 const group=findLinkRow(root,id);
 if(!group)throw new Error("Link not found");
 group.members=group.members.filter(m=>m!==member);
 updateLinkRow(root,group);return group;
}
export function deleteLink(root:string,id:string):boolean{
 if(!storeExists(root))return false;
 const db=openLinksStore(root);
 try{
  const result=db.prepare("DELETE FROM link_groups WHERE id = ?").run(id);
  return result.changes>0;
 }finally{db.close();}
}
// The scopes one actor may read: its own level plus every link it belongs to.
// The core actor "sam" owns the core level. A named profile NEVER sees the
// core, and never sees another profile's private scope, linked or not.
export function visibleScopes(root:string,actor:string):string[]{
 const own=actor==="sam"?"core":"profile:"+actor;
 const shared=links(root).filter(g=>g.members.includes(actor)).map(g=>"link:"+g.id);
 return [own,...shared];
}
