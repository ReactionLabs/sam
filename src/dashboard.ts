import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import { MissionStore } from "./storage.js";
import { ChatStore } from "./chats.js";
import { recentSkillUse, lastSkillByChat } from "./skill-use.js";
import { dashboardHtml } from "./dashboard-ui.js";
import { OpenAICompatibleProvider } from "./openai-compatible.js";
import { discoverSkills, skillAllowlists } from "./skills.js";
import { listBindings } from "./bindings.js";
import { loadApprovalPolicy } from "./approval-policy.js";
import { codeSummary } from "./code.js";
import { codingSummary } from "./coding.js";
import { engineStatus } from "./engine.js";
import { engineConnectStatus } from "./engine-connect.js";
import { sensesStatus } from "./senses.js";
import { briefStatus } from "./brief.js";
import { unificationReport } from "./unification.js";
import { readSetupRecord } from "./config-wizard.js";
import { authStatus } from "./auth-status.js";
import { observabilityReport } from "./observability.js";
import { runChatTurn } from "./agent-turn.js";
import { PreferenceStore } from "./preferences.js";
import { heartbeatJobs, heartbeatLog } from "./heartbeat.js";
import { minis } from "./minis.js";
import { doorForKey, doorEnabled, doorHomeLink, doorModeForKey, listDoors, miniDoorPage, peekSessionChat, sessionChat, rotateSessionChat, RateLimiter } from "./mini-door.js";
import { listDrafts } from "./drafts.js";
import { listContacts } from "./contacts.js";
import { DoorAbuseGuard, screenDoorMessage } from "./door-guard.js";
import { connectors, addConnector, getConnector, removeConnector, testConnector, readConnectorTool } from "./connectors.js";
import { listActions, decideAction } from "./actions.js";
import { readActivity, recordActivity } from "./activity.js";
import type { Preference } from "./preferences.js";
import { listBackgroundTasks } from "./background.js";
import { modelRoutingTable } from "./model-routing.js";
import { usageSummary, usageToday } from "./usage.js";
import { listCompactions } from "./compaction.js";
import { pairingStatus } from "./pairing.js";
import { authoredSkills, curatorFindings } from "./skill-author.js";
import { deliverySummary } from "./delivery-outbox.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export type DashboardConfig={defaultAgent:string;showTeamEvents:boolean};
const defaultDashboardConfig:DashboardConfig={defaultAgent:"sam",showTeamEvents:true};
function configPath(root:string){return join(resolve(root),".sam","dashboard-config.json");}
export function readDashboardConfig(root:string):DashboardConfig{
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
// Owner console (P8): revoking standing law from the dashboard. The CLI has
// had `preferences revoke` since CLI parity; this is the same store operation
// behind the dashboard's own authenticated POST, plus the ledger line that
// makes the revocation itself auditable. Returns the revoked record, or null
// when the id is unknown or the record was already revoked.
export function revokeLaw(root:string,id:string):Preference|null{
  const store=new PreferenceStore(root);
  try{
    const pref=store.get(id);
    if(!pref||pref.status==="revoked")return null;
    if(!store.revoke(id))return null;
    recordActivity(root,"owner","law-revoked",pref.profile+": "+pref.statement);
    return store.get(id)??null;
  }finally{store.close();}
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
  const doorLimiter=new RateLimiter(30,3600000,2000);
  const doorGuard=new DoorAbuseGuard();
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
      try{const body=await post();if(typeof body.title!=="string")throw Error("Invalid title");let agentName:string|null=null;
        if(body.agent!==undefined&&body.agent!=="sam"){if(typeof body.agent!=="string")throw Error("Invalid agent");if(!chatStoreAgents(workspace).some(a=>a.name===body.agent))throw Error("Unknown agent");agentName=body.agent;}
        const db=new ChatStore(workspace);try{json(201,db.create(body.title,agentName));}finally{db.close();}}catch{json(400,{error:"Unable to create chat"});}return;
    }
    if(req.method==="POST"&&req.url===route+"/agents"){
      try{const body=await post();if(typeof body.name!=="string"||typeof body.instructions!=="string")throw Error("Invalid agent");
        const model=body.model===undefined?null:body.model;const connectorId=body.connectorId===undefined?null:body.connectorId;
        if(model!==null&&typeof model!=="string")throw Error("Invalid agent");
        if(connectorId!==null&&(typeof connectorId!=="string"||!connectors(workspace).some(c=>c.id===connectorId)))throw Error("Unknown connector");
        const db=new ChatStore(workspace);try{json(201,db.createAgent(body.name,body.instructions,{model,connectorId}));}finally{db.close();}}catch{json(400,{error:"Unable to create agent"});}return;
    }
    if(req.method==="POST"&&req.url===route+"/config"){
      try{json(200,saveDashboardConfig(workspace,await post()));}catch{json(400,{error:"Invalid configuration"});}return;
    }
    const actionRoute=req.url?.match(new RegExp("^"+route+"/actions/([0-9a-f-]{36})/decide$"));
    if(actionRoute&&req.method==="POST"){
      try{const body=await post();json(200,await decideAction(workspace,actionRoute[1],body.decision==="approve"));}catch{json(400,{error:"Invalid action decision"});}return;
    }
    const lawRoute=req.url?.match(new RegExp("^"+route+"/preferences/([0-9a-f-]{36})/revoke$"));
    if(lawRoute&&req.method==="POST"){
      try{await post();const revoked=revokeLaw(workspace,lawRoute[1]);if(!revoked){json(404,{error:"Law not found or already revoked"});}else{json(200,revoked);}}catch{json(400,{error:"Invalid law revocation"});}return;
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
    const editChat=req.url?.match(new RegExp("^/api/"+token+"/chats/([0-9a-f-]{36})/(rename|pin|profile|archive)$"));
    if(req.method==="POST"&&editChat){
      try{const body=await post();const db=new ChatStore(workspace);try{
        let profileOk=true;
        if(editChat[2]==="profile"){const a=body.agent;if(a!==null&&a!=="sam"&&!(typeof a==="string"&&chatStoreAgents(workspace).some(x=>x.name===a)))profileOk=false;}
        const ok=editChat[2]==="rename"?(typeof body.title==="string"&&db.rename(editChat[1],body.title)):editChat[2]==="pin"?(typeof body.pinned==="boolean"&&db.pin(editChat[1],body.pinned)):editChat[2]==="archive"?(typeof body.archived==="boolean"&&db.archive(editChat[1],body.archived)):(profileOk&&db.setAgent(editChat[1],body.agent==="sam"?null:(body.agent as string|null)));
        if(!ok){json(404,{error:"Chat not found or invalid input"});}else{json(200,{ok:true});}
      }finally{db.close();}}catch{json(400,{error:"Unable to update chat"});}return;
    }
    const match=req.url?.match(new RegExp("^/api/"+token+"/chats/([0-9a-f-]{36})(/messages)?$"));
    if(match && req.method==="GET" && !match[2]){
      const db=new ChatStore(workspace);try{json(200,{messages:db.messages(match[1]),events:db.events(match[1]),actions:listActions(workspace).filter(a=>a.chatId===match[1])});}catch{json(404,{error:"Chat not found"});}finally{db.close();}return;
    }
    if(match && req.method==="POST" && match[2]){
      const id=match[1];if(pending.has(id)){json(409,{error:"This chat already has a response in progress"});return;}
      pending.add(id);
      try{
        const body=await post();if(typeof body.content!=="string"||!body.content.trim()||body.content.length>12000)throw Error("Invalid message");
        const turnStart=new Date().toISOString();
        const reply=await runChatTurn(workspace,id,body.content);
        const result={message:{role:"assistant" as const,content:reply}};
        let userReaction:string|null=null;try{const db2=new ChatStore(workspace);try{const msgs=db2.messages(id);for(let i=msgs.length-1;i>=0;i--){if(msgs[i].role==="user"){userReaction=msgs[i].reaction;break;}}}finally{db2.close();}}catch{/* the badge is garnish */}
        json(200,{reply:result.message,userReaction,actions:listActions(workspace).filter(a=>a.chatId===id&&a.createdAt>=turnStart)});
      }catch(error){const message=error instanceof Error?error.message:"Unknown model error";const known=["Model not configured","Chat history limit reached","Remote model requires an API key","Model request timed out","Model network request failed","Invalid model response content","Model returned no safe visible content","Model returned unterminated reasoning content","Invalid model JSON response","Model response too large","Empty model response","Unsafe model output","Profile connector unavailable"];const http=/^Model request failed \(HTTP (\d{3})\)$/.exec(message);const safe=known.includes(message)?message:http?message:"Message failed. Check model configuration and server logs.";console.error("[SAM dashboard chat]",safe,"| cause:",message);json(400,{error:safe});}finally{pending.delete(id);}return;
    }
    const doorMatch=/^\/mini\/([0-9a-f]{32,64})(\/(message|history))?(\?.*)?$/.exec(req.url??"");
    if(doorMatch){
      // P10 abuse guard: while probing has locked the doors, every door path
      // pauses - a flood of guessed keys must not keep costing lookups, and
      // the legitimate person's retry a few minutes later simply works.
      if(doorGuard.probeLocked()){json(429,{error:"Doors are paused briefly after too many invalid keys. Try again in a few minutes."});return;}
      const miniName=doorForKey(workspace,doorMatch[1]);
      if(!miniName){const probe=doorGuard.noteProbe();if(probe.justLocked)recordActivity(workspace,"sam","door-lockout","Invalid door keys locked the doors for 5 minutes");res.writeHead(404);res.end();return;}
      const miniRecord=minis(workspace).find(m=>m.name===miniName);
      if(req.method==="GET"&&!doorMatch[2]){res.setHeader("Content-Type","text/html; charset=utf-8");res.end(miniDoorPage(miniRecord?.person??miniName,miniName,doorHomeLink(workspace,doorMatch[1])));return;}
      if(req.method==="GET"&&doorMatch[2]==="/history"){
        const session=new URL(req.url??"","http://localhost").searchParams.get("session")??"";
        const chatId=peekSessionChat(workspace,miniName,session);
        if(!chatId){json(200,{messages:[]});return;}
        const store=new ChatStore(workspace);let msgs;try{msgs=store.messages(chatId).slice(-50).map(m=>({role:m.role,content:m.content}));}finally{store.close();}
        json(200,{messages:msgs});return;
      }
      if(req.method==="POST"&&doorMatch[2]==="/message"){
        try{
          let raw="";for await(const chunk of req){raw+=chunk.toString("utf8");if(raw.length>8000)throw Error("Request too large");}
          const body:unknown=JSON.parse(raw);
          if(!body||typeof body!=="object"||Array.isArray(body))throw Error("Invalid JSON body");
          const session=(body as Record<string,unknown>).session, content=(body as Record<string,unknown>).content;
          if(typeof session!=="string"||typeof content!=="string"||!content.trim()||content.length>2000)throw Error("Invalid door message");
          // P10 screen: injection-shaped text is refused at the door, before
          // it can reach preference capture, law proposals, or SAM's tools,
          // and the refusal itself lands in the owner's ledger.
          const screen=screenDoorMessage(content);
          if(screen.blocked){doorGuard.noteBlocked();recordActivity(workspace,miniName,"door-blocked","Refused a "+screen.category+" message at the door");json(400,{error:"That message can't be sent through this door."});return;}
          if(!doorLimiter.allow(miniName+":"+session)) {json(429,{error:"Slow down a little. Try again in a moment."});return;}
          if(!doorGuard.allowMini(miniName)) {json(429,{error:"This SAM has had a lot of messages in the last hour. Try again later."});return;}
          const visitorDoor=doorModeForKey(workspace,doorMatch[1])==="visitor";
          const makeChat=()=>{const store=new ChatStore(workspace);try{return store.create("Web chat",miniName==="sam"?null:miniName,{visitor:visitorDoor}).id;}finally{store.close();}};
          const chatId=sessionChat(workspace,miniName,session,makeChat);
          try{const reply=await runChatTurn(workspace,chatId,content.trim());json(200,{reply:{role:"assistant",content:reply}});}
          catch(error){
            if(error instanceof Error&&error.message==="Chat history limit reached"){
              const fresh=rotateSessionChat(workspace,miniName,session,makeChat);
              const reply=await runChatTurn(workspace,fresh,content.trim());json(200,{reply:{role:"assistant",content:reply}});
            }else throw error;
          }
        }catch(error){const message=error instanceof Error?error.message:"Door error";const safe=["Model not configured","Profile connector unavailable","Invalid door message","Invalid session"].includes(message)?message:"Message failed.";console.error("[SAM door chat]",safe,"| cause:",message);json(400,{error:safe});}
        return;
      }
      res.writeHead(405);res.end();return;
    }
    if(req.method!=="GET"){res.writeHead(405);res.end();return;}
    // Stable door: the dashboard token rotates on every start. Clients that
    // bookmark /sam (the Rust CLI, a reloaded page) get the current token URL.
    if(req.url==="/sam"||req.url==="/sam/"){res.writeHead(302,{Location:"/dashboard/"+token});res.end();return;}
    if(req.url===`/dashboard/${token}`){res.setHeader("Content-Type","text/html; charset=utf-8");res.end(dashboardHtml);return;}
    const statusParts=(req.url??"").split("?");
    const bearer=typeof req.headers["authorization"]==="string"&&req.headers["authorization"].startsWith("Bearer ")?req.headers["authorization"].slice(7):"";
    const queryToken=new URLSearchParams(statusParts[1]??"").get("token")??"";
    if(statusParts[0]==="/api/status"&&bearer!==token&&queryToken!==token){res.writeHead(401);res.end();return;}
    if(statusParts[0]===`/api/status/${token}`||statusParts[0]==="/api/status"){
      const statusParams=new URLSearchParams(statusParts[1]??"");
      const activityFilter={actor:statusParams.get("actor")||undefined,kind:statusParams.get("kind")||undefined};
      try{
        const store=new MissionStore(join(workspace,".sam","missions.db"));
        let missions:unknown;
        try{missions=store.list().slice(0,100).map(m=>({code:m.code,status:m.status,objective:m.objective}));}finally{store.close();}
        res.setHeader("Content-Type","application/json");
        const chatStore=new ChatStore(workspace);let chats:unknown;let archivedChats:unknown;try{const act=new Map(chatStore.lastActivity().map(a=>[a.chat_id,a] as const));const skillByChat=lastSkillByChat(workspace);const enrich=(c:{id:string})=>({...c,lastMessageAt:act.get(c.id)?.last_message_at??null,messageCount:act.get(c.id)?.messages??0,lastSkill:skillByChat.get(c.id)??null});chats=chatStore.list().map(enrich);archivedChats=chatStore.list({includeArchived:true}).filter(c=>c.archived).map(enrich);}finally{chatStore.close();}
        const audit=join(workspace,".sam","execution-audit.jsonl");
        let logs:string[]=[];
        if(existsSync(audit)){
          const raw=readFileSync(audit,"utf8");
          logs=raw.slice(-16000).split("\n").filter(Boolean).slice(-20).map(line=>line.slice(0,800));
        }
        const prefStore=new PreferenceStore(workspace);let preferences:unknown;try{preferences=prefStore.list();}finally{prefStore.close();}
const observability=observabilityReport(workspace);
        res.end(JSON.stringify({ok:true,at:new Date().toISOString(),missions,skills:discoverSkills(workspace),schedules:listSchedules(workspace),chats,archivedChats,skillUse:recentSkillUse(workspace,10),agents:chatStoreAgents(workspace),config:readDashboardConfig(workspace),connectors:connectors(workspace).map(c=>({...c,credentialPresent:!!process.env[c.tokenEnv]})),preferences,heartbeatJobs:heartbeatJobs(workspace),heartbeatLog:heartbeatLog(workspace,8),minis:minis(workspace).map(m=>{const pStore2=new PreferenceStore(workspace);let lawCount=0;try{lawCount=pStore2.lawsFor(m.name).length;}finally{pStore2.close();}return {...m,door:doorEnabled(workspace,m.name),laws:lawCount,chats:(chats as Array<{agent_name?:string|null}>).filter(c=>c.agent_name===m.name).length,heartbeats:heartbeatJobs(workspace).filter(j=>j.profile===m.name).length};}),actions:listActions(workspace),background:listBackgroundTasks(workspace).slice(-20),doors:listDoors(workspace),doorGuard:doorGuard.stats(),models:modelRoutingTable(),usage:usageSummary(workspace),usageToday:usageToday(workspace),drafts:listDrafts(workspace).slice(-20),contacts:listContacts(workspace),compactions:listCompactions(workspace),pairing:pairingStatus(workspace),skillAuthored:authoredSkills(workspace),skillCurator:curatorFindings(workspace),deliveryOutbox:deliverySummary(workspace),bindings:listBindings(workspace),skillAllowlists:skillAllowlists(workspace),approvals:loadApprovalPolicy(workspace),code:codeSummary(workspace),coding:codingSummary(workspace),engine:(()=>{const s=engineStatus(workspace);const c=engineConnectStatus(workspace);return {...s,connection:{route:c.route,connected:c.connected,stale:c.stale,record:c.connection}};})(),senses:sensesStatus(),brief:briefStatus(workspace),setup:readSetupRecord(workspace),auth:authStatus(workspace),unification:unificationReport(workspace),activity:readActivity(workspace,30,activityFilter),logs,observability,providerHealth:observability.providerHealth,spend:observability.spend,failures:observability.failures}));

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
