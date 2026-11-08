import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import { MissionStore } from "./storage.js";
import { ChatStore } from "./chats.js";
import { dashboardHtml } from "./dashboard-ui.js";
import { OpenAICompatibleProvider } from "./openai-compatible.js";
import { discoverSkills } from "./skills.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export type Schedule={id:string;name:string;minutes:number;enabled:boolean;lastRun:string|null};
const MAX_SCHEDULES=32;
function scheduleFile(root:string){return join(resolve(root),".sam","schedules.json");}
export function listSchedules(root:string):Schedule[]{
  const file=scheduleFile(root);
  if(!existsSync(file))return [];
  const data:unknown=JSON.parse(readFileSync(file,"utf8"));
  if(!Array.isArray(data)||data.length>MAX_SCHEDULES)throw new Error("Invalid schedule file");
  return data as Schedule[];
}
export function addSchedule(root:string,name:string,minutes:number):Schedule{
  if(!/^[a-zA-Z0-9 _-]{1,80}$/.test(name))throw new Error("Invalid schedule name");
  if(!Number.isSafeInteger(minutes)||minutes<1||minutes>10080)throw new Error("Interval must be 1 to 10080 minutes");
  const items=listSchedules(root);
  if(items.length>=MAX_SCHEDULES||items.some(x=>x.name===name))throw new Error("Schedule limit or duplicate name");
  const item:Schedule={id:randomBytes(12).toString("hex"),name,minutes,enabled:true,lastRun:null};
  mkdirSync(join(resolve(root),".sam"),{recursive:true});
  writeFileSync(scheduleFile(root),JSON.stringify([...items,item],null,2),{flag:"w",mode:0o600});
  return item;
}
const html=`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SAM Local Dashboard</title><style>
:root{color-scheme:dark;font:16px system-ui;background:#0c111b;color:#eaf0ff}body{max-width:960px;margin:50px auto;padding:0 20px}h1{font-size:38px}section{background:#161f2f;border:1px solid #2b3b53;border-radius:14px;padding:22px;margin:18px 0}strong{color:#76d9bc}pre{white-space:pre-wrap;overflow-wrap:anywhere}small{color:#a4b4cd}
</style></head><body><h1>🕵️ SAM <small>Local Control Panel</small></h1><section><h2>Heartbeat <strong id="health">Connecting...</strong></h2><small id="clock"></small></section><section><h2>Missions</h2><pre id="missions">Loading...</pre></section><section><h2>Installed skills</h2><pre id="skills">Loading...</pre></section><section><h2>Chats</h2><pre id="chats">Loading...</pre></section><section><h2>Recent activity</h2><pre id="logs">Loading...</pre></section><section><h2>Schedules</h2><pre id="schedules">Loading...</pre><small>Schedules are stored locally. Automatic mission execution is not enabled.</small></section><script>
async function refresh(){try{const r=await fetch('/api/status',{cache:'no-store'});if(!r.ok)throw Error('Unavailable');const d=await r.json();document.getElementById('health').textContent='Online';document.getElementById('clock').textContent='Last check: '+new Date().toLocaleTimeString();for(const k of ['missions','skills','schedules','chats','logs'])document.getElementById(k).textContent=JSON.stringify(d[k],null,2);}catch(e){document.getElementById('health').textContent='Offline';}}
refresh();setInterval(refresh,10000);
</script></body></html>`;
export async function serveDashboard(root:string,port=4317):Promise<void>{
  if(!Number.isInteger(port)||port<1024||port>65535)throw new Error("Invalid dashboard port");
  const workspace=resolve(root);
  const token=randomBytes(16).toString("hex");
  const pending=new Set<string>();
  const server:Server=createServer(async(req,res)=>{
    res.setHeader("Cache-Control","no-store");
    res.setHeader("X-Content-Type-Options","nosniff");
    res.setHeader("Content-Security-Policy","default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
    const host=req.headers.host;
    if(host!==`127.0.0.1:${port}` && host!==`localhost:${port}`){res.writeHead(403);res.end();return;}
    const origin=req.headers.origin;
    if(origin && origin!==`http://127.0.0.1:${port}` && origin!==`http://localhost:${port}`){res.writeHead(403);res.end();return;}
    const json=(status:number,data:unknown)=>{res.writeHead(status,{"Content-Type":"application/json"});res.end(JSON.stringify(data));};
    const post=async()=>{
      if(req.headers["x-sam-request"]!=="dashboard"||!String(req.headers["content-type"]??"").startsWith("application/json"))throw Error("Invalid dashboard request");
      let body="";for await(const chunk of req){body+=chunk.toString("utf8");if(body.length>16000)throw Error("Request too large");}
      const value:unknown=JSON.parse(body);if(!value||typeof value!=="object"||Array.isArray(value))throw Error("Invalid JSON body");return value as Record<string,unknown>;
    };
    const route=`/api/${token}`;
    if(req.method==="POST" && req.url===route+"/chats"){
      try{const body=await post();if(typeof body.title!=="string")throw Error("Invalid title");const db=new ChatStore(workspace);try{json(201,db.create(body.title));}finally{db.close();}}catch{json(400,{error:"Unable to create chat"});}return;
    }
    const match=req.url?.match(new RegExp("^/api/"+token+"/chats/([0-9a-f-]{36})(/messages)?$"));
    if(match && req.method==="GET" && !match[2]){
      const db=new ChatStore(workspace);try{json(200,{messages:db.messages(match[1])});}catch{json(404,{error:"Chat not found"});}finally{db.close();}return;
    }
    if(match && req.method==="POST" && match[2]){
      const id=match[1];if(pending.has(id)){json(409,{error:"This chat already has a response in progress"});return;}
      pending.add(id);
      try{
        const body=await post();if(typeof body.content!=="string"||!body.content.trim()||body.content.length>12000)throw Error("Invalid message");
        const providerName=process.env.SAM_MODEL_PROVIDER??"";
        const endpoint=process.env.SAM_MODEL_ENDPOINT??(providerName==="minimax"?"https://api.minimax.io/v1/chat/completions":undefined);
        const model=process.env.SAM_MODEL;
        if(!endpoint||!model)throw Error("Model not configured");
        const key=process.env.SAM_MODEL_API_KEY??(providerName==="minimax"?process.env.MINIMAX_API_KEY:undefined)??"";
        const provider=new OpenAICompatibleProvider(endpoint,key,60000);
        const db=new ChatStore(workspace);let history;
        try{history=db.messages(id);if(history.length>=100)throw Error("Chat history limit reached");db.add(id,"user",body.content);}finally{db.close();}
        const messages=[{role:"system" as const,content:"You are SAM, a local-first mission assistant. Be accurate about capabilities. You cannot execute tools or spawn agents from this dashboard chat."},...history.slice(-24).map(m=>({role:m.role,content:m.content})),{role:"user" as const,content:body.content}];
        const result=await provider.complete({model,messages});
        const saved=new ChatStore(workspace);try{saved.add(id,"assistant",result.message.content); }finally{saved.close();}
        json(200,{reply:result.message});
      }catch(error){json(400,{error:error instanceof Error && ["Model not configured","Chat history limit reached"].includes(error.message)?error.message:"Message failed. Check model configuration and server logs."});}finally{pending.delete(id);}return;
    }
    if(req.method!=="GET"){res.writeHead(405);res.end();return;}
    if(req.url===`/dashboard/${token}`){res.setHeader("Content-Type","text/html; charset=utf-8");res.end(dashboardHtml);return;}
    if(req.url===`/api/status/${token}`){
      try{
        const store=new MissionStore(join(workspace,".sam","missions.db"));
        let missions:unknown;
        try{missions=store.list().slice(0,100).map(m=>({code:m.code,status:m.status,objective:m.objective}));}finally{store.close();}
        res.setHeader("Content-Type","application/json");
        const chatStore=new ChatStore(workspace);let chats:unknown;try{chats=chatStore.list();}finally{chatStore.close();}
        const audit=join(workspace,".sam","execution-audit.jsonl");
        let logs:string[]=[];
        if(existsSync(audit)){
          const raw=readFileSync(audit,"utf8");
          logs=raw.slice(-16000).split("\n").filter(Boolean).slice(-20).map(line=>line.slice(0,800));
        }
        res.end(JSON.stringify({ok:true,at:new Date().toISOString(),missions,skills:discoverSkills(workspace),schedules:listSchedules(workspace),chats,logs}));
      }catch{res.writeHead(500);res.end(JSON.stringify({error:"Dashboard data unavailable"}));}
      return;
    }
    res.writeHead(404);res.end();
  });
  await new Promise<void>((done,fail)=>{server.once("error",fail);server.listen(port,"127.0.0.1",()=>{server.off("error",fail);done();});});
  console.log(`SAM dashboard: http://127.0.0.1:${port}/dashboard/${token}`);
  console.log("Read-only local dashboard. Press Ctrl+C to stop.");
  await new Promise<void>(done=>{const stop=()=>server.close(()=>done());process.once("SIGINT",stop);process.once("SIGTERM",stop);});
}
