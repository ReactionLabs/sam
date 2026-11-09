import { createServer, type Server } from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { Channel } from "./channels.js";
import type { SamClient } from "./telegram.js";

// Webhook trigger channel: an external system (a monitor, the Nines stack, a
// cron) POSTs a prompt and SAM works it inside a chat bound to the channel's
// profile, returning the reply synchronously. Loopback-only listener, shared
// secret in a header compared in constant time, bounded body and prompt. The
// secret lives in the channel's env variable, never in the registry file.
export async function handleWebhook(deps:{channel:Channel;sam:SamClient;secret:string;chatId?:string},req:{secret?:string;body:unknown}):Promise<{status:number;reply?:string;error?:string;chatId?:string}>{
 const given=Buffer.from(req.secret??"");
 const expected=Buffer.from(deps.secret);
 if(given.length!==expected.length||!timingSafeEqual(given,expected))return {status:401,error:"Unauthorized"};
 if(!req.body||typeof req.body!=="object"||Array.isArray(req.body))return {status:400,error:"Invalid JSON body"};
 const text=(req.body as {text?:unknown}).text;
 if(typeof text!=="string"||!text.trim()||text.length>4000)return {status:400,error:"Invalid text"};
 const chatId=deps.chatId??await deps.sam.ensureChat("Webhook · "+deps.channel.profile,deps.channel.profile);
 const reply=await deps.sam.postMessage(chatId,text.trim());
 return {status:200,reply,chatId};
}
export async function serveWebhookChannel(opts:{channel:Channel;sam:SamClient;secret:string;port:number}):Promise<void>{
 if(!Number.isInteger(opts.port)||opts.port<1024||opts.port>65535)throw new Error("Invalid webhook port");
 let chatId:string|undefined;
 const server:Server=createServer(async(req,res)=>{
  const json=(status:number,data:unknown)=>{res.writeHead(status,{"Content-Type":"application/json"});res.end(JSON.stringify(data));};
  if(req.method!=="POST"||req.url!=="/hook/"+encodeURIComponent(opts.channel.name)){res.writeHead(404);res.end();return;}
  let body="";for await(const chunk of req){body+=chunk.toString("utf8");if(body.length>16000){json(413,{error:"Request too large"});return;}}
  let parsed:unknown;try{parsed=JSON.parse(body);}catch{json(400,{error:"Invalid JSON body"});return;}
  try{
   const result=await handleWebhook({channel:opts.channel,sam:opts.sam,secret:opts.secret,chatId},{secret:req.headers["x-sam-hook-secret"] as string|undefined,body:parsed});
   if(result.chatId)chatId=result.chatId;
   json(result.status,result.status===200?{reply:result.reply}:{error:result.error});
  }catch{json(502,{error:"SAM request failed"});}
 });
 await new Promise<void>((done,fail)=>{server.once("error",fail);server.listen(opts.port,"127.0.0.1",()=>{server.off("error",fail);done();});});
 await new Promise<void>(done=>{const stop=()=>server.close(()=>done());process.once("SIGINT",stop);process.once("SIGTERM",stop);});
}
