import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

// Channels are how the outside world talks to SAM: a messaging surface (Telegram
// first) bound to one profile. Like connectors, a channel stores only an env
// reference for its credential, never the secret itself. Owner allowlisting is
// fail-closed: an empty owner list means nobody can talk yet.
export type Channel = { id:string; kind:"telegram"|"webhook"; name:string; profile:string; tokenEnv:string; ownerIds:number[]; enabled:boolean };
const namePattern = /^[A-Za-z0-9 _.-]{1,64}$/;
const profilePattern = /^[a-z][a-z0-9._-]{0,63}$/;
const envPattern = /^SAM_CHANNEL_[A-Z0-9_]{1,64}$/;
function path(root:string){return join(resolve(root),".sam","channels.json");}
export function channels(root:string):Channel[]{
 if(!existsSync(path(root)))return [];
 const value:unknown=JSON.parse(readFileSync(path(root),"utf8"));
 if(!Array.isArray(value)||value.length>16)throw Error("Invalid channel registry");
 return value as Channel[];
}
function save(root:string,items:Channel[]){mkdirSync(join(resolve(root),".sam"),{recursive:true});writeFileSync(path(root),JSON.stringify(items,null,2),{mode:0o600});}
export function addChannel(root:string,kind:Channel["kind"],name:string,profile:string,tokenEnv:string,ownerIds:number[]=[]):Channel{
 if(kind!=="telegram"&&kind!=="webhook")throw Error("Invalid channel kind");
 if(!namePattern.test(name)||!profilePattern.test(profile)||!envPattern.test(tokenEnv))throw Error("Invalid channel name, profile, or environment variable");
 if(!Array.isArray(ownerIds)||ownerIds.length>64||ownerIds.some(x=>!Number.isSafeInteger(x)||x<=0))throw Error("Invalid owner list");
 const items=channels(root);
 if(items.length>=16||items.some(c=>c.name===name))throw Error("Channel limit or duplicate name");
 const item:Channel={id:randomUUID(),kind,name,profile,tokenEnv,ownerIds:[...new Set(ownerIds)],enabled:true};
 save(root,[...items,item]);return item;
}
export function removeChannel(root:string,id:string):boolean{
 const items=channels(root),rest=items.filter(x=>x.id!==id);
 if(rest.length===items.length)return false;save(root,rest);return true;
}
export function setChannelOwners(root:string,id:string,ownerIds:number[]):Channel{
 if(!Array.isArray(ownerIds)||ownerIds.length>64||ownerIds.some(x=>!Number.isSafeInteger(x)||x<=0))throw Error("Invalid owner list");
 const items=channels(root);const item=items.find(c=>c.id===id);
 if(!item)throw Error("Channel not found");
 item.ownerIds=[...new Set(ownerIds)];save(root,items);return item;
}
