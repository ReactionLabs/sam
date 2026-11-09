import test from "node:test";
import assert from "node:assert/strict";
import { postDiscord } from "./discord.js";
import type { Channel } from "./channels.js";

test("discord poster chunks and posts only to a real Discord webhook URL",async()=>{
 const channel:Channel={id:"d1",kind:"discord",name:"announcements",profile:"sam",tokenEnv:"SAM_CHANNEL_DISCORD",ownerIds:[],enabled:true};
 const old=process.env.SAM_CHANNEL_DISCORD;
 try{
  process.env.SAM_CHANNEL_DISCORD="https://example.com/api/webhooks/123/abc";
  await assert.rejects(postDiscord(channel,"hi"),/not a Discord webhook/);
  process.env.SAM_CHANNEL_DISCORD="https://discord.com/api/webhooks/123/abc";
  const seen:string[]=[];
  const fake=async(_input:unknown,init?:{body?:string})=>{seen.push(JSON.parse(String(init?.body)).content as string);return new Response(null,{status:204});};
  const n=await postDiscord(channel,"x".repeat(4500),fake as typeof fetch);
  assert.equal(n,3);
  assert.deepEqual(seen.map(x=>x.length),[2000,2000,500]);
 }finally{
  if(old===undefined)delete process.env.SAM_CHANNEL_DISCORD;else process.env.SAM_CHANNEL_DISCORD=old;
 }
});
