import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import { MissionStore } from "./storage.js";
import { ChatStore } from "./chats.js";
import { dashboardHtml } from "./dashboard-ui.js";
import { OpenAICompatibleProvider } from "./openai-compatible.js";
import { discoverSkills } from "./skills.js";
import { connectorChat } from "./connector-chat.js";
import { connectors, addConnector, getConnector, removeConnector, testConnector, readConnectorTool } from "./connectors.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export type DashboardConfig={defaultAgent:string;showTeamEvents:boolean};
const defaultDashboardConfig:DashboardConfig={defaultAgent:"sam",showTeamEvents:true};
function configPath(root:string){return join(resolve(root),".sam","dashboard-config.json");}
function readDashboardConfig(root:string):DashboardConfig{
 const file=configPath(root);if(!existsSync(file))return {...defaultDashboardConfig};
 const data=JSON.parse(readFileSync(file,"utf8")) as Partial<DashboardConfig>;
 return {defaultAgent:typeof data.defaultAgent==="string"?data.defaultAgent:"sam",showTeamEvents:data.showTeamEvents!==false};
}
function saveDashboardConfig(root:string,data:Record<string,unknown>):DashboardConfig{
 if(Object.keys(data).some(k=>!["defaultAgent","showTeamEvents"].includes(k))||typeof data.defaultAgent!=="string"||typeof data.showTeamEvents!=="boolean"||!(/^[a-z][a-z0-9._-]{0,63}$/.test(data.defaultAgent)))throw Error("Invalid dashboard configuration");
 const config={defaultAgent:data.defaultAgent,showTeamEvents:data.showTeamEvents};
 const db=new ChatStore(root);try{if(config.defaultAgent!=="sam"&&!db.agents().some(a=>a.name===config.defaultAgent))throw Error("Unknown agent");}finally{db.close();}
 mkdirSync(join(resolve(root),".sam"),{recursive:true});writeFileSync(configPath(root),JSON.stringify(config,null,2),{mode:0o600});return config;
}
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
function chatStoreAgents(workspace:string){const db=new ChatStore(workspace);try{return db.agents();}finally{db.close();}}
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
    if(req.method==="POST"&&req.url===route+"/agents"){
      try{const body=await post();if(typeof body.name!=="string"||typeof body.instructions!=="string")throw Error("Invalid agent");const db=new ChatStore(workspace);try{json(201,db.createAgent(body.name,body.instructions));}finally{db.close();}}catch{json(400,{error:"Unable to create agent"});}return;
    }
    if(req.method==="POST"&&req.url===route+"/config"){
      try{json(200,saveDashboardConfig(workspace,await post()));}catch{json(400,{error:"Invalid configuration"});}return;
    }
    if(req.method==="POST"&&req.url===route+"/connectors"){
      try{const b=await post();if(typeof b.name!=="string"||typeof b.url!=="string"||typeof b.tokenEnv!=="string")throw Error("Invalid connector");
        json(201,addConnector(workspace,b.name,b.url,b.tokenEnv));
      }catch(e){json(400,{error:e instanceof Error?e.message:"Invalid connector"});}return;
    }
    const connectorRoute=req.url?.match(new RegExp("^/api/"+token+"/connectors/([0-9a-f-]{36})/(test|read|delete)$"));
    if(connectorRoute&&req.method==="POST"){
      try{await post();const id=connectorRoute[1],action=connectorRoute[2];
        if(action==="delete"){json(removeConnector(workspace,id)?200:404,{ok:true});return;}
        const c=getConnector(workspace,id);
        if(action==="test"){json(200,await testConnector(c));return;}
        const b=await Promise.resolve({}); // read parameters are intentionally fixed for this first slice
        void b;
        const tools=await testConnector(c);
        if(!tools.approved.includes("whoami")||!tools.approved.includes("pipeline_summary")||!tools.approved.includes("list_leads"))throw Error("Required read tools unavailable");
        const identity=await readConnectorTool(c,"whoami");
        const summary=await readConnectorTool(c,"pipeline_summary");
        const leads=await readConnectorTool(c,"list_leads",{limit:10});
        json(200,{identity,summary,leads});
      }catch(e){const m=e instanceof Error?e.message:"Connector request failed";json(400,{error:m.startsWith("MCP ")||m.startsWith("Connector ")||m.startsWith("Required ")||m.startsWith("Tool ") ?m:"Connector request failed"});}return;
    }
    const branchMatch=req.url?.match(new RegExp("^/api/"+token+"/chats/([0-9a-f-]{36})/branch$"));
    if(req.method==="POST"&&branchMatch){
      try{const body=await post();if(typeof body.title!=="string")throw Error("Invalid branch title");const db=new ChatStore(workspace);try{json(201,db.branch(branchMatch[1],body.title));}finally{db.close();}}catch{json(400,{error:"Unable to branch chat"});}return;
    }
    const editChat=req.url?.match(new RegExp("^/api/"+token+"/chats/([0-9a-f-]{36})/(rename|pin)$"));
    if(req.method==="POST"&&editChat){
      try{const body=await post();const db=new ChatStore(workspace);try{
        const ok=editChat[2]==="rename"?(typeof body.title==="string"&&db.rename(editChat[1],body.title)):(typeof body.pinned==="boolean"&&db.pin(editChat[1],body.pinned));
        if(!ok){json(404,{error:"Chat not found or invalid input"});}else{json(200,{ok:true});}
      }finally{db.close();}}catch{json(400,{error:"Unable to update chat"});}return;
    }
    const match=req.url?.match(new RegExp("^/api/"+token+"/chats/([0-9a-f-]{36})(/messages)?$"));
    if(match && req.method==="GET" && !match[2]){
      const db=new ChatStore(workspace);try{json(200,{messages:db.messages(match[1]),events:db.events(match[1])});}catch{json(404,{error:"Chat not found"});}finally{db.close();}return;
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
        const config=readDashboardConfig(workspace);const profiles=chatStoreAgents(workspace);const active=profiles.find(a=>a.name===config.defaultAgent);
        const messages=[{role:"system" as const,content:"You are SAM, a local-first mission assistant. This dashboard supports creating chats, branching the selected chat using Branch chat, pinning/unpinning and renaming chats using the three-dot menu, creating named agent profiles, and selecting a default agent under Config. These are real UI capabilities, not tools you can call. Explain how to use them accurately. You cannot directly operate dashboard controls or spawn agents from this chat. Approved read-only MCP connector tools may be available if configured. Do not invent folders, archive, search, or other unsupported UI features. "+(active?"Adopt the role of agent "+active.name+": "+active.instructions:"")},...history.slice(-24).map(m=>({role:m.role,content:m.content})),{role:"user" as const,content:body.content}];
        const useConnectors=connectors(workspace).some(c=>c.enabled&&!!process.env[c.tokenEnv]);
        const result=useConnectors?{message:{role:"assistant" as const,content:await connectorChat(workspace,provider,model,messages)}}:await provider.complete({model,messages});
        const saved=new ChatStore(workspace);try{saved.add(id,"assistant",result.message.content); }finally{saved.close();}
        json(200,{reply:result.message});
      }catch(error){const message=error instanceof Error?error.message:"Unknown model error";const known=["Model not configured","Chat history limit reached","Remote model requires an API key","Model request timed out","Model network request failed","Invalid model response content","Model returned no safe visible content","Model returned unterminated reasoning content","Invalid model JSON response","Model response too large","Empty model response"];const http=/^Model request failed \(HTTP (\d{3})\)$/.exec(message);const safe=known.includes(message)?message:http?message:"Message failed. Check model configuration and server logs.";console.error("[SAM dashboard chat]",safe);json(400,{error:safe});}finally{pending.delete(id);}return;
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
        res.end(JSON.stringify({ok:true,at:new Date().toISOString(),missions,skills:discoverSkills(workspace),schedules:listSchedules(workspace),chats,agents:chatStoreAgents(workspace),config:readDashboardConfig(workspace),connectors:connectors(workspace).map(c=>({...c,credentialPresent:!!process.env[c.tokenEnv]})),logs}));
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
