#!/usr/bin/env node
import { Command } from "commander";
import Database from "better-sqlite3";
import { TaskScheduler } from "./tasks.js";
import { OfflineMissionRunner } from "./offline-runner.js";
import { LocalEchoAdapter } from "./execution.js";
import { converse, FakeModelProvider } from "./model-conversation.js";
import { OpenAICompatibleProvider } from "./openai-compatible.js";
import { withIdentity } from "./identity.js";
import { inspectDirectory } from "./local-inspection.js";
import { inspectGitWorkspace } from "./git-inspection.js";
import { proposeEdit, applyEdit, rejectEdit } from "./file-edits.js";
import { reviewEdit } from "./edit-review.js";
import { reviewEditWithAi } from "./ai-edit-review.js";
import { requestTestRun, executeApprovedTestRun } from "./approved-test-runner.js";
import { serveDashboard, addSchedule, listSchedules } from "./dashboard.js";
import { PreferenceStore } from "./preferences.js";
import { heartbeatJobs, addHeartbeatJob, removeHeartbeatJob, runHeartbeat, deliverToChannel } from "./heartbeat.js";
import { listBackgroundTasks, queueBackgroundTask, drainBackgroundTasks } from "./background.js";
import { runChatTurn } from "./agent-turn.js";
import { channels, addChannel, removeChannel, setChannelOwners } from "./channels.js";
import { TelegramApi, DashboardSamClient, runTelegramBridge, dashboardTokenFromLog } from "./telegram.js";
import { serveWebhookChannel } from "./webhook.js";
import { postDiscord } from "./discord.js";
import { minis, spawnMini, removeMini } from "./minis.js";
import { links, createLink, addLinkMember, removeLinkMember, deleteLink } from "./links.js";
import { linkExchange } from "./collab.js";
import { issueDoorKey, disableDoor } from "./mini-door.js";
import { ChatStore } from "./chats.js";
import { runResearchTeam } from "./team-runtime.js";
import { proposeModelEdit } from "./model-edit.js";
import { discoverSkills, findSkill, searchSkills, readSkill } from "./skills.js";
import { searchSkillRegistry, installSkill, installedSkills, removeInstalledSkill } from "./skill-registry.js";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { requestDaemon, serveDaemon } from "./daemon.js";
import { MemoryStore, type MemoryKind } from "./memory.js";
import { recallMemory } from "./memory-recall.js";
import { runMemoryToolTurn } from "./memory-tool.js";
import { AgentLoopJournal } from "./agent-loop-journal.js";
import { ApprovalStore, type RiskClass } from "./approvals.js";
import { OperativeRegistry, type OperativeState } from "./operatives.js";
import { AssignmentLeases } from "./assignment-leases.js";
import { parseSamConfig, configReadiness } from "./config.js";
import { authorizeMcpTool } from "./mcp-policy.js";
import { join,resolve } from "node:path";
import { mkdirSync, readFileSync } from "node:fs";
import { MissionStore } from "./storage.js";
import { listActions, proposeAction, decideAction } from "./actions.js";
import { activityView, actionsView, chatView, turnActions, statusSnapshot } from "./cli-views.js";
import { listEpisodes } from "./episodes.js";
import { detectCorrection, proposeCorrection } from "./corrections.js";
import { missionStatuses, type MissionStatus } from "./kernel.js";

const program=new Command();
program.name("sam").description("S.A.M. | Secret Agent Man mission commander").version("0.1.0");
program.option("--workspace <path>","Workspace directory",process.cwd()).option("--json","JSON output");
function dbPath():string {
  return join(resolve(program.opts().workspace),".sam","missions.db");
}
function store():MissionStore {
  return new MissionStore(dbPath());
}
function withDb<T>(fn:(db:Database.Database,missions:MissionStore)=>T):T {
  const missions=store();
  const db=new Database(dbPath());
  db.pragma("foreign_keys = ON");
  try { return fn(db,missions); }
  finally { db.close(); missions.close(); }
}
function missionOrThrow(missions:MissionStore,code:string) {
  const m=missions.get(code); if(!m) throw new Error("Mission not found: "+code); return m;
}
function withTasks<T>(fn:(tasks:TaskScheduler,missions:MissionStore)=>T):T {
  return withDb((db,missions)=>fn(new TaskScheduler(db),missions));
}
function output(data:unknown):void { console.log(program.opts().json?JSON.stringify(data,null,2):typeof data==="string"?data:JSON.stringify(data,null,2)); }
program.command("init").description("Initialize local mission workspace").action(()=>{
  const dir=join(resolve(program.opts().workspace),".sam");mkdirSync(dir,{recursive:true});
  const db=store();db.close();output("SAM initialized at "+dir);
});
program.command("inspect-local").description("List one explicitly selected directory; no model access, file contents, or commands")
  .requiredOption("--root <path>","Authorized root folder")
  .option("--dir <relative>","Relative subdirectory",".")
  .action((options:{root:string;dir:string})=>output(inspectDirectory(options.root,options.dir)));
const gitCommands=program.command("git").description("Bounded read-only Git inspection in the authorized workspace");
gitCommands.command("status").description("Show branch and working-tree changes").action(()=>output(inspectGitWorkspace(program.opts().workspace,"status")));
gitCommands.command("diff").description("Show unstaged workspace changes (bounded)").action(()=>output(inspectGitWorkspace(program.opts().workspace,"diff")));
const edits=program.command("edit").description("Explicit human-reviewed file replacement; no model write access");
edits.command("propose").requiredOption("--path <relative>","Existing workspace file")
  .requiredOption("--from <file>","Local UTF-8 replacement content file")
  .action((options:{path:string;from:string})=>output(proposeEdit(program.opts().workspace,options.path,readFileSync(options.from,"utf8"))));
edits.command("suggest").requiredOption("--path <relative>","Existing workspace source file")
  .requiredOption("--instruction <text>","Requested edit (max 2000 characters)")
  .option("--model <id>","Model ID")
  .option("--timeout <seconds>","Model request timeout, 5 to 120 seconds","90")
  .requiredOption("--live","Explicitly permit a model API request (may incur charges)")
  .action(async(options:{path:string;instruction:string;model?:string;live:boolean;timeout:string})=>{
    const selected=process.env.SAM_MODEL_PROVIDER??"";
    const endpoint=process.env.SAM_MODEL_ENDPOINT??(selected==="minimax"?"https://api.minimax.io/v1/chat/completions":undefined);
    const model=options.model??process.env.SAM_MODEL;
    if(!endpoint || !model) throw new Error("Configure SAM_MODEL_ENDPOINT/SAM_MODEL or SAM_MODEL_PROVIDER=minimax/SAM_MODEL");
    const key=process.env.SAM_MODEL_API_KEY??(selected==="minimax"?process.env.MINIMAX_API_KEY:undefined)??"";
    const seconds=Number(options.timeout);
    if(!Number.isInteger(seconds) || seconds<5 || seconds>120) throw new Error("Timeout must be 5 to 120 seconds");
    const provider=new OpenAICompatibleProvider(endpoint,key,seconds*1000);
    output(await proposeModelEdit(program.opts().workspace,options.path,options.instruction,model,provider));
  });
edits.command("review").argument("<id>").description("Review bounded diff and deterministic findings; never writes target")
  .action((id:string)=>output(reviewEdit(program.opts().workspace,id)));
edits.command("review-ai").argument("<id>").description("Independent advisory AI review; never applies edits")
  .requiredOption("--live","Explicitly allow one model API request (may incur charges)")
  .option("--model <id>","Reviewer model ID")
  .option("--timeout <seconds>","Model request timeout, 5 to 120 seconds","90")
  .action(async(id:string,options:{live:boolean;model?:string;timeout:string})=>{
    const selected=process.env.SAM_MODEL_PROVIDER??"";
    const endpoint=process.env.SAM_MODEL_ENDPOINT??(selected==="minimax"?"https://api.minimax.io/v1/chat/completions":undefined);
    const model=options.model??process.env.SAM_REVIEW_MODEL??process.env.SAM_MODEL;
    if(!endpoint || !model) throw new Error("Configure SAM_MODEL_ENDPOINT/SAM_MODEL or SAM_MODEL_PROVIDER=minimax/SAM_MODEL");
    const key=process.env.SAM_MODEL_API_KEY??(selected==="minimax"?process.env.MINIMAX_API_KEY:undefined)??"";
    const seconds=Number(options.timeout);
    if(!Number.isInteger(seconds) || seconds<5 || seconds>120) throw new Error("Timeout must be 5 to 120 seconds");
    const provider=new OpenAICompatibleProvider(endpoint,key,seconds*1000);
    output(await reviewEditWithAi(program.opts().workspace,id,model,provider));
  });
edits.command("reject").argument("<id>").description("Discard proposal without modifying target")
  .action((id:string)=>output(rejectEdit(program.opts().workspace,id)));
edits.command("apply").requiredOption("--id <uuid>","Proposal ID")
  .requiredOption("--confirm <sha256>","Exact digest printed by edit propose")
  .action((options:{id:string;confirm:string})=>output(applyEdit(program.opts().workspace,options.id,options.confirm)));
const testRuns=program.command("run").description("Explicitly approved local build/test only; executes trusted project code without OS sandbox");
testRuns.command("request").requiredOption("--kind <build-or-test>","build or test")
  .action((options:{kind:string})=>output(requestTestRun(program.opts().workspace,options.kind)));
testRuns.command("execute").requiredOption("--id <uuid>","Run request ID")
  .requiredOption("--confirm <sha256>","Exact digest from run request")
  .option("--timeout <ms>","Timeout from 1000 to 120000 milliseconds","30000")
  .action(async(options:{id:string;confirm:string;timeout:string})=>
    output(await executeApprovedTestRun(program.opts().workspace,options.id,options.confirm,Number(options.timeout))));
program.command("dashboard").description("Start read-only dashboard on localhost").option("--port <number>","Loopback port","4317").action(async(o:{port:string})=>serveDashboard(program.opts().workspace,Number(o.port)));
const channelCmd=program.command("channels").description("Messaging channels that talk to SAM (Telegram first)");
channelCmd.command("add").argument("<name>").argument("<profile>").argument("<tokenEnv>").action((name:string,profile:string,tokenEnv:string)=>output(addChannel(program.opts().workspace,"telegram",name,profile,tokenEnv)));
channelCmd.command("add-discord").argument("<name>").argument("<profile>").argument("<tokenEnv>").action((name:string,profile:string,tokenEnv:string)=>output(addChannel(program.opts().workspace,"discord",name,profile,tokenEnv)));
channelCmd.command("add-webhook").argument("<name>").argument("<profile>").argument("<tokenEnv>").action((name:string,profile:string,tokenEnv:string)=>output(addChannel(program.opts().workspace,"webhook",name,profile,tokenEnv)));
channelCmd.command("list").action(()=>output(channels(program.opts().workspace)));
channelCmd.command("owners").argument("<id>").argument("<ids>").action((id:string,ids:string)=>output(setChannelOwners(program.opts().workspace,id,ids.split(",").map(x=>Number(x.trim())))));
channelCmd.command("remove").argument("<id>").action((id:string)=>output({removed:removeChannel(program.opts().workspace,id)}));
program.command("telegram-bridge").description("Run the Telegram channel bridge (long-polling, owner allowlisted)")
 .option("--channel <name>","Channel name (default: first enabled telegram channel)")
 .option("--dashboard-url <url>","SAM dashboard base URL",process.env.SAM_DASHBOARD_URL??"http://127.0.0.1:4317")
 .option("--dashboard-log <path>","Dashboard log file to discover the current dashboard token from",process.env.SAM_DASHBOARD_LOG??"")
 .option("--dashboard-token <token>","Dashboard token (overrides log discovery)",process.env.SAM_DASHBOARD_TOKEN??"")
 .action(async(o:{channel?:string;dashboardUrl:string;dashboardLog:string;dashboardToken:string})=>{
  const root=program.opts().workspace as string;
  const channel=channels(root).find(c=>c.enabled&&c.kind==="telegram"&&(!o.channel||c.name===o.channel));
  if(!channel)throw new Error("No enabled telegram channel configured");
  const botToken=process.env[channel.tokenEnv];
  if(!botToken)throw new Error("Channel credential missing from environment: "+channel.tokenEnv);
  const logPath=o.dashboardLog||join(resolve(root),"dashboard.log");
  const token=o.dashboardToken?()=>o.dashboardToken:()=>dashboardTokenFromLog(logPath);
  const sam=new DashboardSamClient(o.dashboardUrl.replace(/\/$/,""),token);
  let stopping=false;process.once("SIGINT",()=>{stopping=true;});process.once("SIGTERM",()=>{stopping=true;});
  console.log("SAM telegram bridge: channel "+channel.name+" -> profile "+channel.profile+", owners "+(channel.ownerIds.length?channel.ownerIds.join(","):"(none yet, pairing mode)"));
  await runTelegramBridge({root,channel,sam,api:new TelegramApi(botToken),stop:()=>stopping});
 });
program.command("discord-post").description("Post a message to a Discord channel via its webhook (channel kind: discord)")
 .requiredOption("--channel <name>","Discord channel name")
 .requiredOption("--text <text>","Message text")
 .action(async(o:{channel:string;text:string})=>{
  const root=program.opts().workspace as string;
  const channel=channels(root).find(c=>c.enabled&&c.kind==="discord"&&c.name===o.channel);
  if(!channel)throw new Error("No enabled discord channel with that name");
  output({posted:await postDiscord(channel,o.text)});
 });
const prefCmd=program.command("preferences").description("Preference memory and standing law, per profile");
prefCmd.command("list").option("--profile <name>","Only this profile").action((o:{profile?:string})=>{const store=new PreferenceStore(program.opts().workspace);try{output(store.list(o.profile));}finally{store.close();}});
prefCmd.command("add").argument("<profile>").argument("<statement>").action((profile:string,statement:string)=>{const store=new PreferenceStore(program.opts().workspace);try{output(store.note(profile,statement,"rule","operator"));}finally{store.close();}});
prefCmd.command("revoke").argument("<id>").action((id:string)=>{const store=new PreferenceStore(program.opts().workspace);try{output({revoked:store.revoke(id)});}finally{store.close();}});
const epCmd=program.command("episodes").description("Episodic memory: dated per-profile summaries of what happened in its chats, written by heartbeat consolidation (sam heartbeat)");
epCmd.command("list").option("--profile <name>","Only this profile").action((o:{profile?:string})=>output(listEpisodes(program.opts().workspace,o.profile)));
const hbCmd=program.command("heartbeats").description("Standing heartbeat jobs: SAM working on a timer");
hbCmd.command("add").argument("<name>").argument("<minutes>").argument("<profile>").argument("<prompt>").option("--channel <id>","Deliver replies to this channel id").action((name:string,minutes:string,profile:string,prompt:string,o:{channel?:string})=>output(addHeartbeatJob(program.opts().workspace,name,Number(minutes),profile,prompt,o.channel??null)));
hbCmd.command("list").action(()=>output(heartbeatJobs(program.opts().workspace)));
hbCmd.command("remove").argument("<id>").action((id:string)=>output({removed:removeHeartbeatJob(program.opts().workspace,id)}));
program.command("heartbeat").description("Run one heartbeat tick now: consolidate preference memory, promote law, run due jobs")
 .action(async()=>{
  const root=program.opts().workspace as string;
  const ensureChat=async(title:string,profile:string)=>{
   const db=new ChatStore(root);
   try{
    const found=db.list().find(c=>c.title===title&&(c.agent_name??null)===(profile==="sam"?null:profile));
    if(found)return found.id;
    return db.create(title,profile==="sam"?null:profile).id;
   }finally{db.close();}
  };
  const deliver=async(channelId:string,text:string)=>{
   const channel=channels(root).find(c=>c.id===channelId);
   await deliverToChannel(root,channelId,text,
    async(chatId:number,body:string)=>{
     if(!channel||channel.kind!=="telegram")return;
     const token=process.env[channel.tokenEnv];if(!token)throw new Error("Telegram credential missing");
     await new TelegramApi(token).sendMessage(chatId,body);
    },
    async(ch,body)=>postDiscord(ch,body));
  };
  output(await runHeartbeat(root,{runTurn:(chatId,content)=>runChatTurn(root,chatId,content,{route:"heartbeat"}),runBackgroundTurn:(chatId,content)=>runChatTurn(root,chatId,content,{route:"background"}),ensureChat,deliver}));
 });
const bgCmd=program.command("background").description("Background work (legs): tasks a chat handed off to run async and post back into the chat");
bgCmd.command("list").option("--chat <id>","Only this chat").action((o:{chat?:string})=>output(listBackgroundTasks(program.opts().workspace).filter(t=>!o.chat||t.chatId===o.chat)));
bgCmd.command("handoff").requiredOption("--chat <id>","Chat the task reports back into").requiredOption("--prompt <text>","The self-contained task").option("--actor <name>","Acting profile","sam").option("--title <text>","Short label").action((o:{chat:string;prompt:string;actor:string;title?:string})=>output(queueBackgroundTask(program.opts().workspace,{actor:o.actor,chatId:o.chat,prompt:o.prompt,title:o.title})));
bgCmd.command("drain").description("Run queued background tasks now, on the deep background budget tier").action(async()=>{const root=program.opts().workspace as string;output(await drainBackgroundTasks(root,{runTurn:(chatId,content)=>runChatTurn(root,chatId,content,{route:"background"})}));});
const miniCmd=program.command("minis").description("Minis: a scoped SAM spawned for one person, their data only");
miniCmd.command("spawn").argument("<name>").requiredOption("--person <who>","The person this mini serves").requiredOption("--instructions <text>","What this mini is for").option("--model <id>","Pin a model").option("--connector <id>","Pin one MCP connector by id").option("--heartbeat","Give it a starter daily-digest heartbeat").action((name:string,o:{person:string;instructions:string;model?:string;connector?:string;heartbeat?:boolean})=>output(spawnMini(program.opts().workspace,{name,person:o.person,instructions:o.instructions,model:o.model??null,connectorId:o.connector??null,starterHeartbeat:!!o.heartbeat})));
miniCmd.command("list").action(()=>output(minis(program.opts().workspace)));
miniCmd.command("door").argument("<name>").description("Issue (or rotate) the web door key for a mini (or sam, the core); the key is shown once").option("--home-link","Show a Main SAM link in the door header (operator doors only)").action((name:string,o:{homeLink?:boolean})=>{const key=issueDoorKey(program.opts().workspace,name,{homeLink:!!o.homeLink});output({mini:name,path:"/mini/"+key});});
miniCmd.command("door-off").argument("<name>").action((name:string)=>output({disabled:disableDoor(program.opts().workspace,name)}));
miniCmd.command("remove").argument("<name>").action((name:string)=>output({removed:removeMini(program.opts().workspace,name)}));
const linkCmd=program.command("links").description("Link groups: the only bridge between profiles. Linked profiles share one memory level");
linkCmd.command("create").argument("<name>").argument("<members...>","Profile names, at least two (sam is the core)").action((name:string,members:string[])=>output(createLink(program.opts().workspace,name,members)));
linkCmd.command("list").action(()=>output(links(program.opts().workspace)));
linkCmd.command("add").argument("<id>").argument("<member>").action((id:string,member:string)=>output(addLinkMember(program.opts().workspace,id,member)));
linkCmd.command("remove").argument("<id>").argument("<member>").action((id:string,member:string)=>output(removeLinkMember(program.opts().workspace,id,member)));
linkCmd.command("talk").argument("<id>").argument("<from>").argument("<to>").argument("<message>").description("Run one linked exchange: from speaks, to answers as itself").action(async(id:string,from:string,to:string,message:string)=>{const root=program.opts().workspace as string;output({reply:await linkExchange(root,id,from,to,message,{runTurn:(chatId,content)=>runChatTurn(root,chatId,content)})});});
linkCmd.command("delete").argument("<id>").action((id:string)=>output({deleted:deleteLink(program.opts().workspace,id)}));
const actCmd=program.command("actions").description("Proposed actions: SAM proposes, the owner approves, then it executes");
actCmd.command("list").option("--pending","Only pending").option("--chat <id>","Only this chat").option("--actor <name>","Only this profile").action((o:{pending?:boolean;chat?:string;actor?:string})=>output(actionsView(program.opts().workspace,{pending:!!o.pending,chat:o.chat,actor:o.actor})));
actCmd.command("propose").argument("<profile>").argument("<kind>").argument("<title>").argument("<detail>").option("--chat <id>","Stamp the chat this proposal belongs to").action((profile:string,kind:string,title:string,detail:string,o:{chat?:string})=>output(proposeAction(program.opts().workspace,{actor:profile,kind,title,detail,chatId:o.chat??null})));
actCmd.command("approve").argument("<id>").action(async(id:string)=>output(await decideAction(program.opts().workspace,id,true)));
actCmd.command("reject").argument("<id>").action(async(id:string)=>output(await decideAction(program.opts().workspace,id,false)));
const corrCmd=program.command("corrections").description("Corrections (P6): owner corrections in a message, proposed as standing law through the approval gate - never instant law");
corrCmd.command("detect").argument("<text>").description("Detection only: show the rule statement a message would propose; proposes nothing").action((text:string)=>output({correction:detectCorrection(text)}));
corrCmd.command("check").argument("<profile>").argument("<text>").option("--chat <id>","Stamp the chat the correction came from").description("Detect a correction in a message and route it into the approval gate as a pending law proposal (deduped)").action((profile:string,text:string,o:{chat?:string})=>{const correction=detectCorrection(text);if(!correction){output({correction:null,proposal:null});return;}const routed=proposeCorrection(program.opts().workspace,{actor:profile,chatId:o.chat??null,text});output({correction,proposal:routed?.proposal??null,created:routed?.created??false});});
program.command("activity").description("The activity ledger: everything SAM did, newest last").option("--limit <n>","How many lines").option("--actor <name>","Only this actor").option("--kind <kind>","Only this kind").action((o:{limit?:string;actor?:string;kind?:string})=>output(activityView(program.opts().workspace,{limit:o.limit?Number(o.limit):20,actor:o.actor,kind:o.kind})));
program.command("overview").description("One snapshot: pending approvals, recent activity, heartbeats, people, connectors").action(()=>output(statusSnapshot(program.opts().workspace)));
program.command("webhook-serve").description("Run a webhook trigger channel (loopback, shared-secret auth)")
 .requiredOption("--channel <name>","Webhook channel name")
 .option("--port <number>","Loopback port","4391")
 .option("--dashboard-url <url>","SAM dashboard base URL",process.env.SAM_DASHBOARD_URL??"http://127.0.0.1:4317")
 .option("--dashboard-log <path>","Dashboard log file to discover the current dashboard token from",process.env.SAM_DASHBOARD_LOG??"")
 .option("--dashboard-token <token>","Dashboard token (overrides log discovery)",process.env.SAM_DASHBOARD_TOKEN??"")
 .action(async(o:{channel:string;port:string;dashboardUrl:string;dashboardLog:string;dashboardToken:string})=>{
  const root=program.opts().workspace as string;
  const channel=channels(root).find(c=>c.enabled&&c.kind==="webhook"&&c.name===o.channel);
  if(!channel)throw new Error("No enabled webhook channel with that name");
  const secret=process.env[channel.tokenEnv];
  if(!secret||secret.length<24)throw new Error("Channel secret missing or too short in environment: "+channel.tokenEnv);
  const logPath=o.dashboardLog||join(resolve(root),"dashboard.log");
  const token=o.dashboardToken?()=>o.dashboardToken:()=>dashboardTokenFromLog(logPath);
  const sam=new DashboardSamClient(o.dashboardUrl.replace(/\/$/,""),token);
  console.log("SAM webhook channel "+channel.name+" -> profile "+channel.profile+" on 127.0.0.1:"+o.port);
  await serveWebhookChannel({channel,sam,secret,port:Number(o.port)});
 });
const chats=program.command("chats").description("Persistent separate chat histories (no model invocation)");
chats.command("new").argument("<title>").option("--profile <name>","Bind the chat to a profile").action((title:string,o:{profile?:string})=>{const db=new ChatStore(program.opts().workspace);try{output(db.create(title,o.profile&&o.profile!=="sam"?o.profile:null));}finally{db.close();}});
chats.command("list").action(()=>{const db=new ChatStore(program.opts().workspace);try{output(db.list());}finally{db.close();}});
chats.command("show").argument("<id>").action((id:string)=>{const db=new ChatStore(program.opts().workspace);try{output(db.messages(id));}finally{db.close();}});
chats.command("read").argument("<id>").description("Messages plus this chat's action cards").action((id:string)=>output(chatView(program.opts().workspace,id)));
chats.command("send").argument("<id>").argument("<message>").description("Run one real chat turn; any actions SAM proposes are printed with their ids for approval").action(async(id:string,message:string)=>{const ws=program.opts().workspace as string;const since=new Date().toISOString();const reply=await runChatTurn(ws,id,message);output({reply,proposed:turnActions(ws,id,since)});});
chats.command("event").argument("<chat-id>").requiredOption("--agent <name>","Registered agent identifier").requiredOption("--kind <kind>","message, tool, result, assignment").requiredOption("--text <text>","Event body").action((id:string,o:{agent:string;kind:string;text:string})=>{const db=new ChatStore(program.opts().workspace);try{output(db.addEvent(id,o.agent,o.kind as "message"|"tool"|"result"|"assignment",o.text));}finally{db.close();}});
const teams=program.command("team").description("Explicit, bounded two-agent research and QA collaboration (model calls may incur charges)");
teams.command("run").requiredOption("--chat <uuid>","Existing chat id").requiredOption("--objective <text>","Mission objective").requiredOption("--live","Explicitly authorize three model calls").option("--inspect-workspace","Read a bounded allowlist of local source files").option("--web","Search online with configured Brave Search API key").option("--agent-tools","Allow researcher to choose bounded read-only workspace tools").action(async(o:{chat:string;objective:string;live:boolean;inspectWorkspace?:boolean;web?:boolean;agentTools?:boolean})=>{
 const selected=process.env.SAM_MODEL_PROVIDER??"";
 const endpoint=process.env.SAM_MODEL_ENDPOINT??(selected==="minimax"?"https://api.minimax.io/v1/chat/completions":undefined);
 const model=process.env.SAM_MODEL;
 if(!endpoint||!model)throw new Error("Configure model endpoint and SAM_MODEL");
 const key=process.env.SAM_MODEL_API_KEY??(selected==="minimax"?process.env.MINIMAX_API_KEY:undefined)??"";
 if(o.web&&!process.env.SAM_WEB_SEARCH_API_KEY)throw new Error("Set SAM_WEB_SEARCH_API_KEY before using --web");
 const provider=new OpenAICompatibleProvider(endpoint,key,60000);
 output(await runResearchTeam(program.opts().workspace,o.chat,o.objective,[{name:"research",role:"Research specialist"},{name:"qa",role:"Critical QA reviewer"}],provider,model,{workspaceEvidence:!!o.inspectWorkspace,webSearchKey:o.web?process.env.SAM_WEB_SEARCH_API_KEY:undefined,agentTools:!!o.agentTools}));
});
const schedules=program.command("schedule").description("Store local interval schedules; automatic execution not yet enabled");
schedules.command("list").action(()=>output(listSchedules(program.opts().workspace)));
schedules.command("add").argument("<name>").requiredOption("--every <minutes>","Interval in minutes").action((name:string,o:{every:string})=>output(addSchedule(program.opts().workspace,name,Number(o.every))));
const skills=program.command("skills").description("Read-only discovery of project-local SKILL.md files; never executes skill content");
skills.command("list").description("List validated local skill metadata").action(()=>output(discoverSkills(program.opts().workspace)));
skills.command("find").argument("<query>").description("Search installed skill metadata").action((query:string)=>output(searchSkills(program.opts().workspace,query)));
skills.command("show").argument("<name>").description("Show skill metadata (not executable instructions)").action((name:string)=>output(findSkill(program.opts().workspace,name)));
skills.command("read").argument("<name>").description("Read installed skill instructions as untrusted reference, without execution").action((name:string)=>output(readSkill(program.opts().workspace,name)));
skills.command("search").argument("<query>").option("--limit <n>","Max results").description("Search the skills.sh directory (live, no key needed)").action(async(query:string,o:{limit?:string})=>output(await searchSkillRegistry(query,o.limit?Number(o.limit):10)));
skills.command("install").argument("<ref>").description("Install skill(s) from skills.sh: owner/repo or owner/repo@skill-name; fetched from GitHub, validated, never executed").action(async(ref:string)=>output(await installSkill(program.opts().workspace,ref,{actor:"operator"})));
skills.command("installed").description("Skills installed from the registry, with provenance").action(()=>output(installedSkills(program.opts().workspace)));
skills.command("remove").argument("<name>").description("Remove a registry-installed skill (hand-placed skills are never touched)").action((name:string)=>output({removed:removeInstalledSkill(program.opts().workspace,name)}));
const mission=program.command("mission").description("Manage missions");
mission.command("create").argument("<objective>").action((objective:string)=>{
  const db=store();try{output(db.create(objective));}finally{db.close();}
});
mission.command("list").action(()=>{const db=store();try{output(db.list());}finally{db.close();}});
mission.command("inspect").argument("<code>").action((code:string)=>{
  const db=store();try{
    const m=db.get(code);if(!m)throw new Error("Mission not found: "+code);
    output({mission:m,events:db.events(m.id)});
  }finally{db.close();}
});
mission.command("transition").argument("<code>").argument("<status>").description("Development-only manual state transition").action((code:string,status:string)=>{
  if(!missionStatuses.includes(status as MissionStatus))throw new Error("Invalid status: "+status);
  const db=store();try{output(db.transition(code,status as MissionStatus));}finally{db.close();}
});
const task=program.command("task").description("Plan and inspect mission tasks (execution requires a worker runtime)");
task.command("add").argument("<mission>").argument("<objective>")
  .option("--after <task-ids>","Comma-separated dependency task UUIDs")
  .action((code:string,objective:string,options:{after?:string})=>{
    output(withTasks((tasks,missions)=>{
      const mission=missions.get(code);
      if(!mission)throw new Error("Mission not found: "+code);
      const deps=options.after?.split(",").map(x=>x.trim()).filter(Boolean)??[];
      return tasks.add(mission.id,objective,deps);
    }));
  });
task.command("list").argument("<mission>").action((code:string)=>{
  output(withTasks((tasks,missions)=>{
    const mission=missions.get(code);
    if(!mission)throw new Error("Mission not found: "+code);
    return tasks.list(mission.id);
  }));
});
task.command("run-offline").argument("<mission>").description("Execute one task with deterministic offline echo only; no model or network").action(async(code:string)=>{
  const missions=store(), db=new Database(dbPath());
  db.pragma("foreign_keys = ON");
  try {
    const m=missionOrThrow(missions,code);
    const result=await new OfflineMissionRunner(db).runOne(m.id,"local-echo-worker",new LocalEchoAdapter());
    output(result??{status:"NO_ELIGIBLE_TASK"});
  } finally {db.close();missions.close();}
});
task.command("result").argument("<task-id>").description("Inspect persisted verified offline evidence").action((id:string)=>{
  output(withDb((db)=>new OfflineMissionRunner(db).result(id)??{status:"NO_RESULT"}));
});
program.command("chat").description("Offline smoke test by default; --live explicitly enables one model API request")
  .argument("<message>").option("--model <id>","Model identifier")
  .option("--live","Explicitly allow one network model request (may incur provider charges)")
  .action(async (message:string, options:{model?:string,live?:boolean})=>{
    if (options.live) {
      const selected=process.env.SAM_MODEL_PROVIDER??"";
      const endpoint=process.env.SAM_MODEL_ENDPOINT??
        (selected==="minimax"?"https://api.minimax.io/v1/chat/completions":undefined);
      if (!endpoint) throw new Error("Set SAM_MODEL_PROVIDER=minimax or SAM_MODEL_ENDPOINT to an OpenAI-compatible /chat/completions URL");
      const model=options.model??process.env.SAM_MODEL;
      if (!model) throw new Error("Specify --model or SAM_MODEL");
      const key=process.env.SAM_MODEL_API_KEY??(selected==="minimax"?process.env.MINIMAX_API_KEY:undefined)??"";
      const provider=new OpenAICompatibleProvider(endpoint,key);
      output(await converse(provider,{model,messages:withIdentity(program.opts().workspace,[{role:"user",content:message}])}));
    } else {
      output(await converse(new FakeModelProvider(),{model:options.model??"offline-test",messages:[{role:"user",content:message}]}));
    }
  });
const loops=program.command("loop").description("Inspect durable read-only agent loop journal");
loops.command("list").option("--limit <n>","Number of recent loops","20").action((options:{limit:string})=>{
  const journal=new AgentLoopJournal(dbPath());
  try { output(journal.list(Number(options.limit))); }
  finally { journal.close(); }
});
loops.command("inspect").argument("<id>").action((id:string)=>{
  const journal=new AgentLoopJournal(dbPath());
  try { output({loop:journal.get(id)??null,events:journal.events(id)}); }
  finally { journal.close(); }
});
loops.command("recover").description("Fence orphaned running loops after a crash; never replay tool calls").action(()=>{
  const journal=new AgentLoopJournal(dbPath());
  try { output({interrupted:journal.interruptOrphans()}); }
  finally { journal.close(); }
});
program.command("talk").description("Interactive terminal conversation with configured model; explicit network opt-in required")
  .requiredOption("--live","Allow model API requests (may incur provider charges)")
  .option("--model <id>","Model ID")
  .option("--with-memory","Explicitly include recent workspace memory records in model context")
  .option("--memory-tools","Allow model to call read-only SQLite memory_search (may incur an additional API request)")
  .option("--workspace-tools","Allow read-only workspace tools and installed skill reading (includes memory search)")
  .action(async(options:{live:boolean,model?:string,withMemory?:boolean,memoryTools?:boolean,workspaceTools?:boolean})=>{
    const selected=process.env.SAM_MODEL_PROVIDER??"";
    const endpoint=process.env.SAM_MODEL_ENDPOINT??
      (selected==="minimax"?"https://api.minimax.io/v1/chat/completions":undefined);
    const model=options.model??process.env.SAM_MODEL;
    if (!endpoint || !model) throw new Error("Configure SAM_MODEL_PROVIDER=minimax and SAM_MODEL, or SAM_MODEL_ENDPOINT and SAM_MODEL");
    const key=process.env.SAM_MODEL_API_KEY??(selected==="minimax"?process.env.MINIMAX_API_KEY:undefined)??"";
    const provider=new OpenAICompatibleProvider(endpoint,key);
    const messages:Array<{role:"user"|"assistant";content:string}>=[];
    const rl=createInterface({input:stdin,output:stdout,terminal:stdin.isTTY});
    console.log("SAM terminal chat. Type /exit to quit. Each reply may incur provider charges.");
    try {
      while (true) {
        let line:string;
        try { line=await rl.question("You > "); } catch { break; }
        if (line.trim()==="/exit" || line.trim()==="/quit") break;
        if (line.trim()==="/dashboard") {
          console.log("SAM > Starting localhost dashboard. Open the URL printed below.");
          void serveDashboard(program.opts().workspace).catch(e=>console.error("SAM dashboard:",e instanceof Error?e.message:"Unavailable"));
          continue;
        }
        if (!line.trim()) continue;
        if (line.trim().startsWith("/memory ")) {
          const query=line.trim().slice("/memory ".length).trim();
          if (!query || query.length>200) { console.log("SAM > Usage: /memory <search terms> (max 200 characters)"); continue; }
          try {
            const mem=new MemoryStore(dbPath());
            try {
              const records=mem.search(query).slice(0,10).map(r=>({id:r.id,kind:r.kind,source:r.source,created_at:r.created_at,content:r.content.slice(0,500)}));
              console.log("SAM memory > "+JSON.stringify(records,null,2));
            } finally { mem.close(); }
          } catch(error) { console.error("SAM memory search failed:",error instanceof Error?error.message:"Unknown error"); }
          continue;
        }
        const proposed=[...messages,{role:"user" as const,content:line}];
        const journal = options.memoryTools || options.workspaceTools ? new AgentLoopJournal(dbPath()) : undefined;
        const loop = journal?.create(line);
        try {
          const context=withIdentity(program.opts().workspace,proposed);
          const recalled=options.withMemory?recallMemory(dbPath()):undefined;
          if(recalled)context.splice(1,0,recalled);
          const answer=options.memoryTools || options.workspaceTools
            ?await runMemoryToolTurn((turn,enabled)=>provider.completeToolTurn(model,turn,enabled,Boolean(options.workspaceTools)),context,dbPath(),
              event=>{console.log("[SAM tool] "+event.tool+" "+event.status+" "+event.detail);journal?.event(loop!.id,"tool_"+event.status,event.tool+" "+event.detail);},
              options.workspaceTools ? program.opts().workspace : undefined,
              (round,calls)=>journal?.progress(loop!.id,round,calls))
            :(await converse(provider,{model,messages:context})).message.content;
          if (journal && loop) journal.finish(loop.id,"completed",answer.slice(0,8000));
          console.log("SAM > "+answer);
          messages.splice(0,messages.length,...proposed,{role:"assistant",content:answer});
          // Keep bounded in-memory context; no transcript is written to disk.
          if (messages.length>40) messages.splice(0,messages.length-40);
        } catch(error) {
          if (journal && loop) journal.finish(loop.id,"failed",error instanceof Error?error.message:"Unknown error");
          console.error("SAM request failed:",error instanceof Error?error.message:"Unknown error");
        } finally { journal?.close(); }
      }
    } finally { rl.close(); }
  });
const daemon=program.command("daemon").description("Local-only SAM control daemon");
daemon.command("serve").description("Run the daemon in the foreground").action(async()=>{
  output("SAM daemon listening in workspace "+resolve(program.opts().workspace));
  await serveDaemon(resolve(program.opts().workspace));
});
daemon.command("status").action(async()=>{
  try{output(await requestDaemon(resolve(program.opts().workspace),"ping"));}
  catch(error){output({ok:false,reason:error instanceof Error?error.message:String(error)});process.exitCode=1;}
});
daemon.command("stop").action(async()=>{
  output(await requestDaemon(resolve(program.opts().workspace),"stop"));
});

const memory=program.command("memory").description("Durable mission memory (evidence, never authority over policy)");
memory.command("add").argument("<kind>").argument("<content>").requiredOption("--source <source>","Provenance for this record").option("--mission <code>","Mission code to attach this record to").action((kind:string,content:string,options:{source:string,mission?:string})=>{
  const mem=new MemoryStore(dbPath()); const missions=store();
  try{ const missionId=options.mission?missionOrThrow(missions,options.mission).id:undefined; output(mem.add({missionId,kind:kind as MemoryKind,content,source:options.source})); }
  finally{mem.close();missions.close();}
});
memory.command("list").option("--mission <code>","Only records for this mission").action((options:{mission?:string})=>{
  const mem=new MemoryStore(dbPath()); const missions=store();
  try{ output(mem.list(options.mission?missionOrThrow(missions,options.mission).id:undefined)); }
  finally{mem.close();missions.close();}
});
memory.command("search").argument("<query>").action((query:string)=>{
  const mem=new MemoryStore(dbPath()); try{output(mem.search(query));}finally{mem.close();}
});
memory.command("archive").argument("<id>").action((id:string)=>{
  const mem=new MemoryStore(dbPath()); try{output({archived:mem.archive(id)});}finally{mem.close();}
});

const operative=program.command("operative").description("Operative capability registry (declarations, never credentials)");
operative.command("register").argument("<name>").argument("<adapter>").argument("<capabilities>").option("--max <n>","Max concurrent assignments").action((name:string,adapter:string,capabilities:string,options:{max?:string})=>{
  const reg=new OperativeRegistry(dbPath());
  try{ output(reg.register({name,adapter,capabilities:capabilities.split(",").map(x=>x.trim()).filter(Boolean),maxConcurrency:options.max?Number(options.max):undefined})); }
  finally{reg.close();}
});
operative.command("list").action(()=>{
  const reg=new OperativeRegistry(dbPath()); try{output(reg.list());}finally{reg.close();}
});
operative.command("state").argument("<id>").argument("<state>").action((id:string,state:string)=>{
  const reg=new OperativeRegistry(dbPath()); try{output({updated:reg.setState(id,state as OperativeState)});}finally{reg.close();}
});
operative.command("heartbeat").argument("<id>").action((id:string)=>{
  const reg=new OperativeRegistry(dbPath()); try{output({renewed:reg.heartbeat(id)});}finally{reg.close();}
});
operative.command("candidates").argument("<capabilities>").action((capabilities:string)=>{
  const reg=new OperativeRegistry(dbPath());
  try{ output(reg.candidates(capabilities.split(",").map(x=>x.trim()).filter(Boolean))); }
  finally{reg.close();}
});

const assignment=program.command("assignment").description("Durable operative assignment leases (a lease is not execution permission)");
assignment.command("claim").argument("<operative-id>").argument("<task-id>").option("--ttl <ms>","Lease TTL in milliseconds").action((operativeId:string,taskId:string,options:{ttl?:string})=>{
  const reg=new OperativeRegistry(dbPath()); reg.close();
  const leases=new AssignmentLeases(dbPath());
  try{ const lease=leases.claim(operativeId,taskId,Date.now(),options.ttl?Number(options.ttl):undefined); if(!lease) throw new Error("No lease granted: operative unavailable, at capacity, or task already claimed"); output(lease); }
  finally{leases.close();}
});
assignment.command("active").argument("<operative-id>").action((operativeId:string)=>{
  const leases=new AssignmentLeases(dbPath()); try{output(leases.active(operativeId));}finally{leases.close();}
});
assignment.command("finish").argument("<lease-id>").argument("<operative-id>").argument("<generation>").action((leaseId:string,operativeId:string,generation:string)=>{
  const leases=new AssignmentLeases(dbPath()); try{output({finished:leases.finish(leaseId,operativeId,Number(generation))});}finally{leases.close();}
});
assignment.command("renew").argument("<lease-id>").argument("<operative-id>").argument("<generation>").option("--ttl <ms>","Lease TTL in milliseconds").action((leaseId:string,operativeId:string,generation:string,options:{ttl?:string})=>{
  const leases=new AssignmentLeases(dbPath()); try{output({renewed:leases.renew(leaseId,operativeId,Number(generation),Date.now(),options.ttl?Number(options.ttl):undefined)});}finally{leases.close();}
});

const approval=program.command("approval").description("Action-bound approval ledger (request and inspect only; deciding requires an owner-authenticated boundary that is not built yet, so there is no decide command)");
approval.command("request").argument("<mission>").argument("<risk>").argument("<action-json>").option("--ttl <ms>","Approval lifetime in milliseconds").action((code:string,risk:string,actionJson:string,options:{ttl?:string})=>{
  output(withDb((db,missions)=>{
    const mission=missionOrThrow(missions,code);
    let action:unknown; try{action=JSON.parse(actionJson);}catch{throw new Error("Action must be valid JSON");}
    return new ApprovalStore(db).request(mission.id,risk as RiskClass,action,Date.now(),options.ttl?Number(options.ttl):undefined);
  }));
});
approval.command("list").argument("<mission>").action((code:string)=>{
  output(withDb((db,missions)=>new ApprovalStore(db).list(missionOrThrow(missions,code).id)));
});
approval.command("inspect").argument("<id>").action((id:string)=>{
  output(withDb((db)=>{ const a=new ApprovalStore(db).get(id); if(!a) throw new Error("Approval not found: "+id); return a; }));
});


const config=program.command("config").description("Environment configuration and readiness (never prints secret values)");
config.command("show").description("Show the parsed configuration with secrets reduced to present/absent").action(()=>{
  const cfg=parseSamConfig(process.env); const ready=configReadiness(cfg);
  output({
    modelProvider:cfg.modelProvider, model:cfg.model, minimaxBaseUrl:cfg.minimaxBaseUrl,
    minimaxApiKey:cfg.minimaxApiKey?"present":"absent",
    secondShiftMcpUrl:cfg.secondShiftMcpUrl, secondShiftMcpToken:cfg.secondShiftMcpToken?"present":"absent",
    logLevel:cfg.logLevel, modelReady:ready.modelReady, mcpReady:ready.mcpReady
  });
});

const mcp=program.command("mcp").description("MCP authorization policy (dry-run only; no server connection is made)");
mcp.command("authorize").argument("<tool>").description("Evaluate the deny-by-default policy for one tool name, locally")
  .option("--advertised <tools>","Comma-separated tool names the server advertised")
  .option("--allow <tools>","Comma-separated owner-approved read-only tool names")
  .option("--trust-server","Mark the server trusted for this evaluation")
  .action((tool:string,options:{advertised?:string,allow?:string,trustServer?:boolean})=>{
    const split=(s?:string)=>s?.split(",").map(x=>x.trim()).filter(Boolean)??[];
    const advertised=split(options.advertised).map(name=>({name}));
    const decision=authorizeMcpTool(tool,advertised,new Set(split(options.allow)),!!options.trustServer);
    output(decision);
    if(!decision.allowed)process.exitCode=1;
  });

program.command("doctor").description("Check local runtime prerequisites").action(()=>{
  const ready=configReadiness(parseSamConfig(process.env));
  output({node:process.version,platform:process.platform,workspace:resolve(program.opts().workspace),modelReady:ready.modelReady,mcpReady:ready.mcpReady,status:"CLI, local IPC daemon, memory, approvals, operative registry and assignment leases available on one workspace database; configuration and MCP policy wired; agent execution not implemented"});
});
program.command("status").action(()=>{
  const db=store(); const mem=new MemoryStore(dbPath()); const reg=new OperativeRegistry(dbPath());
  try{output({missions:db.list().length,memories:mem.list().length,operatives:reg.list().length,daemon:"use sam daemon status"});}
  finally{db.close();mem.close();reg.close();}
});
program.parseAsync().catch((err:unknown)=>{console.error("SAM error:",err instanceof Error?err.message:String(err));process.exitCode=1;});
