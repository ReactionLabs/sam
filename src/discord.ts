import type { Channel } from "./channels.js";
import { chunkText } from "./telegram.js";

// Discord channel, v1: outbound posting through a channel webhook, which is the
// capability Dip named ("be able to post in Discord"). The webhook URL is the
// credential and lives in the channel's env variable, never in the registry.
// Two-way Discord chat (interactions endpoint) needs a public HTTPS door and
// lands separately; this module is posting only and says so.
export async function postDiscord(channel:Channel,text:string,fetchFn:typeof fetch=fetch):Promise<number>{
 if(channel.kind!=="discord")throw Error("Not a discord channel");
 if(!text.trim()||text.length>8000)throw Error("Invalid message text");
 const url=process.env[channel.tokenEnv];
 if(!url)throw Error("Channel credential missing from environment: "+channel.tokenEnv);
 const parsed=new URL(url);
 if(parsed.protocol!=="https:"||!(parsed.hostname==="discord.com"||parsed.hostname==="discordapp.com")||!parsed.pathname.startsWith("/api/webhooks/"))throw Error("Channel credential is not a Discord webhook URL");
 const parts=chunkText(text.trim(),2000);
 for(const part of parts){
  const response=await fetchFn(url,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({content:part})});
  if(!response.ok)throw Error("Discord request failed (HTTP "+response.status+")");
 }
 return parts.length;
}
