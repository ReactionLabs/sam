#!/usr/bin/env node
import { Command } from "commander";
import Database from "better-sqlite3";
import { openDatabase } from "./sqlite.js";
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
import { verificationGate, verificationStatus } from "./verification.js";
import { defaultCodingReviewer, goldfishStatus, runGoldfishReview, sessionGate } from "./goldfish.js";
import { sessionCaps, sessionUsageToday } from "./session-caps.js";
import { serveDashboard, addSchedule, listSchedules } from "./dashboard.js";
import { PreferenceStore } from "./preferences.js";
import { heartbeatJobs, addHeartbeatJob, addScheduledJob, jobNextRun, removeHeartbeatJob, runHeartbeat, deliverToChannel } from "./heartbeat.js";
import { describeSchedule, scriptCommandNames, SCRIPT_JOB_COMMANDS } from "./schedule.js";
import { deliverySummary, readDeliveries } from "./delivery-outbox.js";
import { listBackgroundTasks, queueBackgroundTask, drainBackgroundTasks } from "./background.js";
import { listCodingTasks, queueCodingTask, drainCodingTasks } from "./coding.js";
import { drainEngineTasks, engineStatus, listEngineTasks, queueEngineTask } from "./engine.js";
import { connectEngine, disconnectEngine, engineConnectStatus, probeEngineAuth } from "./engine-connect.js";
import { runSense, sensesStatus } from "./senses.js";
import { briefStatus, buildBrief, installBrief } from "./brief.js";
import { buildStackWatchReport, stackWatchStatus } from "./stack-watch.js";
import { unificationReport } from "./unification.js";
import { runChatTurn } from "./agent-turn.js";
import { runTui } from "./tui.js";
import { renderImageFile } from "./term-image.js";
import { listReachChannels, reachDoctor, runReach } from "./reach.js";
import { channels, addChannel, removeChannel, setChannelOwners } from "./channels.js";
import { findChannel, issuePairingCode, pairingStatus, redeemPairingCode } from "./pairing.js";
import { TelegramApi, DashboardSamClient, runTelegramBridge, dashboardTokenFromLog } from "./telegram.js";
import { serveWebhookChannel } from "./webhook.js";
import { acceptEvent, bindEvent, eventBindings, serveEvents, signEvent, unbindEvent } from "./events.js";
import { postDiscord } from "./discord.js";
import { minis, spawnMini, removeMini } from "./minis.js";
import { links, createLink, addLinkMember, removeLinkMember, deleteLink } from "./links.js";
import { linkExchange } from "./collab.js";
import { issueDoorKey, disableDoor } from "./mini-door.js";
import { ChatStore } from "./chats.js";
import { addTeamMember, listTeamMembers, listTeamRuns, removeTeamMember, runResearchTeam, runStandingTeam, teamStatus } from "./team-runtime.js";
import { STANDING_FILES, listStandingFiles, readStandingFile, writeStandingFile, clearStandingFile } from "./standing-files.js";
import { proposeModelEdit } from "./model-edit.js";
import { discoverSkills, findSkill, searchSkills, readSkill, setSkillAllowlist, skillAllowlist, skillsForProfile } from "./skills.js";
import { listBindings, removeBinding, resolveBindingProfile, setBinding } from "./bindings.js";
import { clearCodeRoot, cloneIntoCodeRoot, codeCommandNames, codeCommandSpec, codeRoot, codeSummary, codeWrites, createSandbox, destroySandbox, editCodeFile, installSandboxPackage, listCodeFiles, listSandboxes, readCodeFile, runCodeCommand, runPython, setCodeRoot, writeCodeFile, writeSandboxFile } from "./code.js";
import { listTaskBranches } from "./git-work.js";
import { knownProfileNames } from "./actions.js";
import { searchSkillRegistry, installSkill, installedSkills, removeInstalledSkill } from "./skill-registry.js";
import { recentSkillUse } from "./skill-use.js";
import { authoredSkills, curatorFindings, proposeAuthoredSkill, runSkillCurator, writeAuthoredSkill } from "./skill-author.js";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { requestDaemon, serveDaemon } from "./daemon.js";
import { MemoryStore, type MemoryKind } from "./memory.js";
import { recallMemory } from "./memory-recall.js";
import { runMemoryToolTurn } from "./memory-tool.js";
import { AgentLoopJournal } from "./agent-loop-journal.js";
import { ApprovalStore, type RiskClass } from "./approvals.js";
import { OperativeRegistry, type OperativeState } from "./operatives.js";
import { cancelSubagent, getSubagent, listSubagents, spawnSubagent } from "./subagents.js";
import { cancelDelegation, getDelegation, listDelegations, operativeLiveness, proposeDelegation } from "./coding-operatives.js";
import { AssignmentLeases } from "./assignment-leases.js";
import { parseSamConfig, configReadiness } from "./config.js";
import { CONFIG_SECTIONS, configSections, detectSetup, readSetupRecord, runConfigWizard, verifyAndSaveSetup, verifyModel } from "./config-wizard.js";
import { authStatus, probeAuth } from "./auth-status.js";
import { addProvider, listProviders, removeProvider } from "./providers.js";
import { addFallbackRoute, clearFallbackRoutes, fallbackRoutes } from "./failover.js";
import { parseRelayRoute, relayPrompt, relayTargetsForProfile } from "./relay.js";
import { startCodexLogin, codexAuthState } from "./codex-auth.js";
import { samBanner } from "./banner.js";
import { authorizeMcpTool } from "./mcp-policy.js";
import { join,resolve } from "node:path";
import { mkdirSync, readFileSync } from "node:fs";
import { MissionStore } from "./storage.js";
import { listActions, proposeAction, decideAction, settleAutoApprovals, ACTION_KINDS } from "./actions.js";
import { loadApprovalPolicy, saveApprovalPolicy, scanNeverList, neverListSummary, classifyProposal, APPROVAL_MODES } from "./approval-policy.js";
import { listContacts, getContact, upsertContact, removeContact } from "./contacts.js";
import { listDrafts, getDraft, createDraft, removeDraft } from "./drafts.js";
import { activityView, actionsView, chatView, turnActions, statusSnapshot } from "./cli-views.js";
import { observabilityReport } from "./observability.js";
import { listEpisodes } from "./episodes.js";
import { closeLoop, listLoops, openLoop } from "./loops.js";
import { revisitDueLoops } from "./loop-revisit.js";
import { archiveManagedChat, branchManagedChat, listManagedChats, pinManagedChat, renameManagedChat, searchManagedChats, unarchiveManagedChat } from "./chat-manage.js";
import { readDeliveryLedger } from "./worthiness.js";
import { forceCompactChat, getCompaction, listCompactions } from "./compaction.js";
import { classifyNote, patchNote, saveNote } from "./notes.js";
import { createBackup, listBackups, restoreBackup, runRestoreDrill, verifyBackup } from "./backup.js";
import { detectCorrection, proposeCorrection } from "./corrections.js";
import { listDoors } from "./mini-door.js";
import { runRedTeamPack, screenDoorMessage } from "./door-guard.js";
import { missionStatuses, type MissionStatus } from "./kernel.js";
import { modelRoutingTable } from "./model-routing.js";
import { connectors } from "./connectors.js";
import { recordActivity } from "./activity.js";
import { usageSummary, readUsage } from "./usage.js";

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
  const db=openDatabase(dbPath());
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
// C5 self-review wiring for the production coding drains (heartbeat
// tick + coding drain): the real goldfish reviewer from the model
// env, or a refusing stub when no model is configured - a coding
// task then closes blocked naming the missing reviewer, never
// done-unreviewed.
function codingReviewer(root:string){ const reviewer=defaultCodingReviewer(root); if(reviewer) return (task:{spec:string})=>reviewer(task.spec); return async()=>{ throw new Error("Self-review is not configured on this install (no model endpoint/key for the goldfish reviewer)"); }; }
// The one channel-delivery closure: heartbeat job deliveries and
// second-answer channel updates ride the same door (Telegram via
// the channel's token env, Discord via its webhook poster).
function makeChannelDeliver(root:string){ return async(channelId:string,text:string)=>{
 const channel=channels(root).find(c=>c.id===channelId);
 await deliverToChannel(root,channelId,text,
  async(chatId:number,body:string)=>{
   if(!channel||channel.kind!=="telegram")return;
   const token=process.env[channel.tokenEnv];if(!token)throw new Error("Telegram credential missing");
   await new TelegramApi(token).sendMessage(chatId,body);
  },
  async(ch,body)=>postDiscord(ch,body));
}; }
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
const verifyCmd=program.command("verify").description("Verify-on-stop: applied changes stay unverified until a fresh approved build AND test pass after the last change; the gate is the only 'done' check");
verifyCmd.command("status").description("Show the verification ledger state and whether a session holding these changes may close").action(()=>{const root=program.opts().workspace;output({status:verificationStatus(root),gate:verificationGate(root),goldfish:goldfishStatus(root),session:sessionGate(root)});});
const capsCmd=program.command("caps").description("Session caps: per-chat per-day turn and token ceilings, checked at every turn entry; 0 disables a cap (SAM_SESSION_MAX_TURNS / SAM_SESSION_MAX_TOKENS)");
capsCmd.command("status").description("Show the cap configuration and today's per-chat usage against it").action(()=>{const root=program.opts().workspace;output({caps:sessionCaps(),sessions:sessionUsageToday(root)});});
const goldfishCmd=program.command("goldfish").description("Goldfish verifier: fresh-context review (diff + spec + live source + Pattern Catalog, no conversation history) with the last word on 'done'");
goldfishCmd.command("status").description("Show the latest goldfish verdict, its coverage, and the combined session gate").action(()=>{const root=program.opts().workspace;output({status:goldfishStatus(root),session:sessionGate(root)});});
goldfishCmd.command("review").description("Run one fresh-context goldfish review over the changes no review has covered yet")
  .requiredOption("--live","Explicitly allow one model API request (may incur charges)")
  .requiredOption("--spec <text>","The task spec the change was made against")
  .option("--model <id>","Reviewer model ID")
  .option("--timeout <seconds>","Model request timeout, 5 to 120 seconds","90")
  .action(async(options:{live:boolean;spec:string;model?:string;timeout:string})=>{
    const selected=process.env.SAM_MODEL_PROVIDER??"";
    const endpoint=process.env.SAM_MODEL_ENDPOINT??(selected==="minimax"?"https://api.minimax.io/v1/chat/completions":undefined);
    const model=options.model??process.env.SAM_GOLDFISH_MODEL??process.env.SAM_MODEL;
    if(!endpoint || !model) throw new Error("Configure SAM_MODEL_ENDPOINT/SAM_MODEL or SAM_MODEL_PROVIDER=minimax/SAM_MODEL");
    const key=process.env.SAM_MODEL_API_KEY??(selected==="minimax"?process.env.MINIMAX_API_KEY:undefined);
    if(!key) throw new Error("Missing model API key");
    const seconds=Number(options.timeout);
    if(!Number.isInteger(seconds) || seconds<5 || seconds>120) throw new Error("Timeout must be 5 to 120 seconds");
    const provider=new OpenAICompatibleProvider(endpoint,key,seconds*1000);
    output(await runGoldfishReview(program.opts().workspace,options.spec,model,provider));
  });
program.command("dashboard").description("Start read-only dashboard on localhost").option("--port <number>","Loopback port","4317").action(async(o:{port:string})=>serveDashboard(program.opts().workspace,Number(o.port)));
program.command("tui").description("SAM in the terminal: the S.A.M. splash, a live chat on the shared turn, images rendered in the transcript").option("--profile <name>","Profile to talk to (default sam)").option("--banner","Print the startup splash and exit").action(async(o:{profile?:string;banner?:boolean})=>{await runTui(program.opts().workspace,{profile:o.profile,bannerOnly:!!o.banner});});
program.command("image").argument("<file>").description("Render an image in this terminal (Kitty/iTerm2 graphics where the terminal supports them, ANSI half-blocks elsewhere)").action((file:string)=>{process.stdout.write(renderImageFile(file,{cols:Math.max(20,(process.stdout.columns??80)-2),rows:24}));});
const reach=program.command("reach").description("agent-reach from the operator seat: the same read-only search/read SAM uses through sam_reach");
reach.command("channels").description("Channels and the read actions each declares").action(async()=>output(await listReachChannels()));
reach.command("doctor").description("agent-reach channel status (text)").action(async()=>{process.stdout.write(await reachDoctor());});
reach.command("call").argument("<channel>").argument("<action>").argument("[query]").option("--limit <n>","Max results for a search").description("Run one declared read action, e.g. reach call web search 'breaking news' or reach call youtube subtitle <url>").action(async(channel:string,action:string,query:string|undefined,o:{limit?:string})=>output(await runReach({channel,action,query,limit:o.limit?Number(o.limit):undefined})));
const channelCmd=program.command("channels").description("Messaging channels that talk to SAM (Telegram first)");
channelCmd.command("add").argument("<name>").argument("<profile>").argument("<tokenEnv>").action((name:string,profile:string,tokenEnv:string)=>output(addChannel(program.opts().workspace,"telegram",name,profile,tokenEnv)));
channelCmd.command("add-discord").argument("<name>").argument("<profile>").argument("<tokenEnv>").action((name:string,profile:string,tokenEnv:string)=>output(addChannel(program.opts().workspace,"discord",name,profile,tokenEnv)));
channelCmd.command("add-webhook").argument("<name>").argument("<profile>").argument("<tokenEnv>").action((name:string,profile:string,tokenEnv:string)=>output(addChannel(program.opts().workspace,"webhook",name,profile,tokenEnv)));
channelCmd.command("list").action(()=>output(channels(program.opts().workspace)));
channelCmd.command("owners").argument("<id>").argument("<ids>").action((id:string,ids:string)=>output(setChannelOwners(program.opts().workspace,id,ids.split(",").map(x=>Number(x.trim())))));
channelCmd.command("pair").argument("<idOrName>").description("Issue a pairing code for a telegram channel (Phase A item 3): 8 characters, shown once, hash stored, expires in 1 hour, single use; issuing retires the previous live code").action((idOrName:string)=>output(issuePairingCode(program.opts().workspace,idOrName)));
channelCmd.command("pairs").description("Pairing state per telegram channel: live code + expiry, owner count, recent failed attempts, lockout").action(()=>output(pairingStatus(program.opts().workspace)));
channelCmd.command("redeem").argument("<idOrName>").argument("<code>").argument("<userId>").description("Redeem a pairing code for a telegram user id (the same door the bot uses; for operator testing and recovery)").action((idOrName:string,code:string,userId:string)=>{const root=program.opts().workspace as string;output(redeemPairingCode(root,findChannel(root,idOrName).id,code,Number(userId)));});
channelCmd.command("remove").argument("<id>").action((id:string)=>output({removed:removeChannel(program.opts().workspace,id)}));
channelCmd.command("bind").argument("<idOrName>").requiredOption("--profile <name>","Profile this binding routes to").option("--peer <id>","Sender id on the channel (omit for a channel-wide binding)").description("Set a deterministic binding (Phase C item 3): (channel, peer) routes to a profile; most specific wins - a peer binding beats a channel-wide binding beats the channel's own profile").action((idOrName:string,o:{profile:string;peer?:string})=>{const root=program.opts().workspace as string;const known=knownProfileNames(root);if(!known.includes(o.profile))throw new Error("Unknown profile: "+o.profile+". Known profiles: "+known.join(", "));output(setBinding(root,{channelId:findChannel(root,idOrName).id,peer:o.peer??null,profile:o.profile}));});
channelCmd.command("bindings").description("All deterministic bindings, with the channel each belongs to").action(()=>{const root=program.opts().workspace as string;const byId=new Map(channels(root).map(c=>[c.id,c.name]));output(listBindings(root).map(b=>({...b,channel:byId.get(b.channelId)??b.channelId})));});
channelCmd.command("unbind").argument("<id>").description("Remove one binding by its id (channels bindings lists them)").action((id:string)=>output({removed:removeBinding(program.opts().workspace,id)}));
channelCmd.command("resolve").argument("<idOrName>").option("--peer <id>","Sender id to resolve for").description("Show which profile a message on this channel would land on, and which rule decided it").action((idOrName:string,o:{peer?:string})=>{const root=program.opts().workspace as string;const channel=findChannel(root,idOrName);output({channel:channel.name,...resolveBindingProfile(root,channel,o.peer??null)});});
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
  const sam=new DashboardSamClient(o.dashboardUrl.replace(/\/$/,""),token,fetch,"telegram");
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
const compCmd=program.command("compaction").description("Context compression (Plan Phase A item 2): long chats fold their older turns into a stored summary - a memory flush is written first, exchanges are never split, raw turns are never deleted");
compCmd.command("list").description("Every chat that has compacted, newest first, with how many messages its summary covers").action(()=>output(listCompactions(program.opts().workspace)));
compCmd.command("show").argument("<chat>").description("One chat's compaction record (covered count + summary), or compacted:false").action((chat:string)=>{const found=getCompaction(program.opts().workspace,chat);output(found??{chat_id:chat,compacted:false});});
compCmd.command("run").argument("<chat>").description("Fold a chat's older turns now (keeps the newest exchanges verbatim; writes the memory flush first; visitor chats compact without a flush)").action((chat:string)=>{const result=forceCompactChat(program.opts().workspace,chat);output({chat:result.chatId,covered:result.covered,compactedNow:result.compactedNow,foldedCount:result.foldedCount,kept:result.kept.length,summary:result.summary});});
const noteCmd=program.command("notes").description("Two-tier note saves (Plan Phase B): helpful notes save immediately at the profile's scope; hard changes (superseding a record, identity facts, rule-like phrasing) route to the owner approval gate instead - when in doubt, gated");
noteCmd.command("save").argument("<content>").option("--profile <name>","Acting profile (default sam = core scope)","sam").option("--kind <kind>","Memory kind: observation, decision, failure, or procedure","observation").option("--supersedes <id>","Record id this note corrects (forces the hard tier)").action((content:string,o:{profile:string;kind:string;supersedes?:string})=>{const r=saveNote(program.opts().workspace,{actor:o.profile,content,kind:o.kind,supersedes:o.supersedes??null});output(r.status==="saved"?{status:r.status,tier:r.tier,id:r.record.id,scope:r.record.scope,source:r.record.source}:{status:r.status,tier:r.tier,reason:r.reason,proposalId:r.proposal.id});});
noteCmd.command("classify").argument("<content>").option("--supersedes <id>","Record id the note would correct").action((content:string,o:{supersedes?:string})=>output(classifyNote(content,{supersedes:o.supersedes??null})));
noteCmd.command("patch").description("Supersede one stored record by id with replacement text (Phase B item 2): always routed to the owner approval gate; on approval the new note saves and the old record is archived").argument("<id>").argument("<content>").option("--profile <name>","Acting profile (default sam = core scope)","sam").action((id:string,content:string,o:{profile:string})=>{const r=patchNote(program.opts().workspace,{actor:o.profile,id,content});output({status:r.status,tier:r.tier,reason:r.reason,proposalId:r.proposal.id,supersedes:r.supersedes});});
const epCmd=program.command("episodes").description("Episodic memory: dated per-profile summaries of what happened in its chats, written by heartbeat consolidation (sam heartbeat)");
epCmd.command("list").option("--profile <name>","Only this profile").action((o:{profile?:string})=>output(listEpisodes(program.opts().workspace,o.profile)));
const loopCmd=program.command("loops").description("Open loops: questions whose answers may change, carried into the next session under 'Where things stand'");
loopCmd.command("list").option("--profile <name>","Only this profile").option("--all","Include closed loops").action((o:{profile?:string;all?:boolean})=>output(listLoops(program.opts().workspace,{profile:o.profile,status:o.all?undefined:"open"})));
loopCmd.command("open").argument("<profile>").argument("<question>").argument("<watchFor>").option("--answer <text>","The answer given").option("--hours <n>","Hours until the next look").action((profile:string,question:string,watchFor:string,o:{answer?:string;hours?:string})=>output(openLoop(program.opts().workspace,{profile,question,answer:o.answer??"",watchFor,dueInHours:o.hours?Number(o.hours):undefined})));
loopCmd.command("close").argument("<id>").action((id:string)=>output({closed:closeLoop(program.opts().workspace,id)}));
loopCmd.command("revisit").description("Revisit due open loops now (SECOND ANSWERS): each due loop is re-checked on the heartbeat tier in its own check chat; unchanged stays silent and reschedules, a changed answer posts an update into the original chat (and its channel, through the outbox + worthiness gate), a settled question posts its final answer and closes").action(async()=>{const root=program.opts().workspace as string;output(await revisitDueLoops(root,{runTurn:(chatId,content)=>runChatTurn(root,chatId,content,{route:"heartbeat"}),deliver:makeChannelDeliver(root)}));});
const delCmd=program.command("deliveries").description("Notification worthiness ledger: every proactive delivery SAM sent or held, with the reason (S5)");
delCmd.command("list").option("--profile <name>","Only this profile").action((o:{profile?:string})=>output(readDeliveryLedger(program.opts().workspace,100).filter(e=>!o.profile||e.profile===o.profile)));
const hbCmd=program.command("heartbeats").description("Standing heartbeat jobs: SAM working on a timer");
hbCmd.command("add").argument("<name>").argument("<minutes>").argument("<profile>").argument("<prompt>").option("--channel <id>","Deliver replies to this channel id").action((name:string,minutes:string,profile:string,prompt:string,o:{channel?:string})=>output(addHeartbeatJob(program.opts().workspace,name,Number(minutes),profile,prompt,o.channel??null)));
hbCmd.command("schedule").description("Add a job on the real schedule surface (Phase C item 1): an interval ('every 30 minutes'), a wall-clock phrase ('daily at 9am', 'weekdays at 8:30am', 'every monday at 9am', 'monthly on the 1st at 9am'), a one-shot ('once at 8am tomorrow', 'once at 2026-11-11 08:00' - fires once in the job's timezone, then retires), or a 5-field cron expression, in a per-job timezone; --script names one allowlisted no-agent command instead of a model prompt").argument("<name>").argument("<profile>").argument("<schedule...>").option("--prompt <text>","The standing prompt for an agent job").option("--script <name>","No-agent script mode: one of "+scriptCommandNames().join(", ")).option("--timezone <tz>","IANA timezone for wall-clock schedules (default: the owner's timezone - SAM_OWNER_TIMEZONE, else America/New_York)").option("--channel <id>","Deliver replies to this channel id").action((name:string,profile:string,schedule:string[],o:{prompt?:string;script?:string;timezone?:string;channel?:string})=>output(addScheduledJob(program.opts().workspace,{name,profile,schedule:schedule.join(" "),timezone:o.timezone,prompt:o.prompt,script:o.script??null,channelId:o.channel??null})));
hbCmd.command("scripts").description("The no-agent script allowlist: SAM's own read-only CLI reports a script job may run").action(()=>output(scriptCommandNames().map(n=>({name:n,description:SCRIPT_JOB_COMMANDS[n].description}))));
hbCmd.command("next").description("When each job next fires, on its own schedule and timezone").action(()=>output(heartbeatJobs(program.opts().workspace).map(j=>({name:j.name,schedule:describeSchedule(j),mode:j.mode??"agent",nextRun:jobNextRun(j)?.toISOString()??null,lastRun:j.lastRun}))));
hbCmd.command("deliveries").description("The durable delivery outbox: every queued channel delivery with its state (pending, delivered, suppressed, failed, recovered)").option("--all","Include delivered and suppressed records").action((o:{all?:boolean})=>{const all=readDeliveries(program.opts().workspace);output(o.all?all:all.filter(d=>d.status==="pending"||d.status==="failed"));});
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
  const deliver=makeChannelDeliver(root);
  output(await runHeartbeat(root,{runTurn:(chatId,content)=>runChatTurn(root,chatId,content,{route:"heartbeat"}),runBackgroundTurn:(chatId,content)=>runChatTurn(root,chatId,content,{route:"background"}),ensureChat,deliver,reviewCoding:codingReviewer(root),reviewEngine:codingReviewer(root)}));
 });
const bgCmd=program.command("background").description("Background work (legs): tasks a chat handed off to run async and post back into the chat");
bgCmd.command("list").option("--chat <id>","Only this chat").action((o:{chat?:string})=>output(listBackgroundTasks(program.opts().workspace).filter(t=>!o.chat||t.chatId===o.chat)));
bgCmd.command("handoff").requiredOption("--chat <id>","Chat the task reports back into").requiredOption("--prompt <text>","The self-contained task").option("--actor <name>","Acting profile","sam").option("--title <text>","Short label").action((o:{chat:string;prompt:string;actor:string;title?:string})=>output(queueBackgroundTask(program.opts().workspace,{actor:o.actor,chatId:o.chat,prompt:o.prompt,title:o.title})));
bgCmd.command("drain").description("Run queued background tasks now, on the deep background budget tier").action(async()=>{const root=program.opts().workspace as string;output(await drainBackgroundTasks(root,{runTurn:(chatId,content)=>runChatTurn(root,chatId,content,{route:"background"})}));});
const codingCmd=program.command("coding").description("The coding loop (Phase D item 3, coder C3): queued coding tasks that plan, edit, verify, and iterate in the background, posting a summary + diff into their chat; done only when the verification ledger confirms the changes");
codingCmd.command("list").option("--chat <id>","Only this chat").description("List coding tasks, newest last").action((o:{chat?:string})=>output(listCodingTasks(program.opts().workspace).filter(t=>!o.chat||t.chatId===o.chat)));
codingCmd.command("queue").requiredOption("--chat <id>","Chat the task reports back into").requiredOption("--spec <text>","The self-contained coding spec").option("--actor <name>","Acting profile","sam").option("--max-iterations <n>","Iteration cap (1-5, default 3)").description("Queue a coding task: refuses until the operator designates a code root (code set-root)").action((o:{chat:string;spec:string;actor:string;maxIterations?:string})=>output(queueCodingTask(program.opts().workspace,{actor:o.actor,chatId:o.chat,spec:o.spec,maxIterations:o.maxIterations?parseInt(o.maxIterations,10):undefined})));
codingCmd.command("drain").description("Run queued coding tasks now, on the deep background budget tier; verified work is goldfish-reviewed (C5) before it can close done").action(async()=>{const root=program.opts().workspace as string;output(await drainCodingTasks(root,{runTurn:(chatId,content)=>runChatTurn(root,chatId,content,{route:"background"}),review:codingReviewer(root)}));});
codingCmd.command("push").argument("<task-id>").description("Propose pushing a finished coding task's sam/<task> branch to origin (C4 git discipline): creates a git-push proposal on the ONE gate - nothing pushes until the owner approves it").action((taskId:string)=>{const root=program.opts().workspace as string;const task=listCodingTasks(root).find(t=>t.id===taskId);if(!task)throw new Error("Unknown coding task: "+taskId);if(task.git?.mode!=="branch"||!task.git.branch)throw new Error("Coding task "+taskId+" has no task branch to push (git mode: "+(task.git?.mode??"none recorded")+")");if(task.git.pending.length)throw new Error("Coding task "+taskId+" still has uncommitted writes ("+task.git.pending.join(", ")+") - a push proposal names a finished branch only");const a=proposeAction(root,{actor:task.actor,kind:"git-push",title:"Push "+task.git.branch+" ("+task.title.slice(0,80)+")",detail:JSON.stringify({branch:task.git.branch}),chatId:task.chatId});output({status:"pending_owner_approval",id:a.id,kind:a.kind,branch:task.git.branch,commits:task.git.commits.map(c=>c.sha),note:"Nothing pushes until the owner approves this proposal."});});
const engineCmd=program.command("engine").description("The managed coding engine (Phase D item 6, coder C6): Claude Code runs as a managed extension of SAM inside the C4 branch sandbox - SAM proposes (owner-approved), the engine runs, SAM records + verifies + reviews + commits its work; the push stays an owner-approved git-push proposal");
engineCmd.command("status").description("Whether the engine binary is installed (SAM_ENGINE_BIN, else claude on PATH), its CLI-reuse connection state, plus the run queue state").action(()=>{const root=program.opts().workspace as string;output({...engineStatus(root),connection:engineConnectStatus(root)});});
engineCmd.command("auth").description("The Claude Code connection as SAM reads it WITHOUT probing: installed, the recorded route marker, and whether it is current; --probe runs the one fixed `claude auth status` check (a local CLI call, no model spend) and reports signed-in / signed-out / not-installed / unknown without saving anything").option("--probe","Run `claude auth status` now and report the verdict without recording a connection").action(async(o:{probe?:boolean})=>{const root=program.opts().workspace as string;const connection=engineConnectStatus(root);output(o.probe?{connection,probe:await probeEngineAuth()}:{connection,probe:null,note:"No probe was run. `sam engine connect` probes and, only on a signed-in verdict, records the connection."});});
engineCmd.command("connect").description("Connect Claude Code as the coding-engine route via CLI reuse (CLI dressing item 3): runs the fixed `claude auth status` probe and, ONLY on a signed-in verdict, records a non-secret route marker (.sam/engine-connection.json) - SAM never reads, stores, or forwards the CLI's tokens; installing Claude Code and signing it in are the operator's acts. Exits non-zero when no connection was recorded").action(async()=>{const root=program.opts().workspace as string;const result=await connectEngine(root);output(result);if(!result.connected)process.exitCode=1;});
engineCmd.command("disconnect").description("Remove ONLY SAM's engine route marker: the install stops claiming the Claude Code connection. The CLI's own login on this machine is untouched - SAM never held it").action(()=>output(disconnectEngine(program.opts().workspace)));
engineCmd.command("list").option("--chat <id>","Only this chat").description("List engine runs, newest last").action((o:{chat?:string})=>output(listEngineTasks(program.opts().workspace).filter(t=>!o.chat||t.chatId===o.chat)));
engineCmd.command("queue").requiredOption("--chat <id>","Chat the run reports back into").requiredOption("--spec <text>","The self-contained coding task for the engine").option("--actor <name>","Acting profile","sam").description("Queue an engine run directly (operator door): refuses until a git code root is designated and the engine is installed").action((o:{chat:string;spec:string;actor:string})=>output(queueEngineTask(program.opts().workspace,{actor:o.actor,chatId:o.chat,spec:o.spec})));
engineCmd.command("propose").requiredOption("--chat <id>","Chat the run reports back into").requiredOption("--spec <text>","The self-contained coding task for the engine").option("--actor <name>","Acting profile","sam").description("Propose an engine run on the ONE gate (kind engine, consequential): nothing runs until the owner approves; approval queues the run").action((o:{chat:string;spec:string;actor:string})=>{const root=program.opts().workspace as string;const a=proposeAction(root,{actor:o.actor,kind:"engine",title:"Engine run: "+o.spec.slice(0,80),detail:JSON.stringify({task:o.spec}),chatId:o.chat});output({status:"pending_owner_approval",id:a.id,kind:a.kind,note:"Nothing runs until the owner approves this proposal."});});
engineCmd.command("drain").description("Run one queued engine run now; verified work is goldfish-reviewed (C5) before it can close done").action(async()=>{const root=program.opts().workspace as string;output(await drainEngineTasks(root,{review:codingReviewer(root)}));});
engineCmd.command("push").argument("<task-id>").description("Propose pushing a finished engine run's sam/<task> branch to origin (C4): creates a git-push proposal on the ONE gate - nothing pushes until the owner approves it").action((taskId:string)=>{const root=program.opts().workspace as string;const task=listEngineTasks(root).find(t=>t.id===taskId);if(!task)throw new Error("Unknown engine task: "+taskId);if(task.git?.mode!=="branch"||!task.git.branch)throw new Error("Engine task "+taskId+" has no task branch to push (git mode: "+(task.git?.mode??"none recorded")+")");if(task.git.pending.length)throw new Error("Engine task "+taskId+" still has uncommitted changes ("+task.git.pending.join(", ")+") - a push proposal names a finished branch only");const a=proposeAction(root,{actor:task.actor,kind:"git-push",title:"Push "+task.git.branch+" ("+task.title.slice(0,80)+")",detail:JSON.stringify({branch:task.git.branch}),chatId:task.chatId});output({status:"pending_owner_approval",id:a.id,kind:a.kind,branch:task.git.branch,commits:task.git.commits.map(c=>c.sha),note:"Nothing pushes until the owner approves this proposal."});});
const senseCmd=program.command("senses").description("Senses (Phase E item 2): the core profile's read-only Gmail and Calendar door, riding the gog reader (SAM_GOG_BIN, else gog on PATH) with a fixed argv - installing and authorizing the reader is the operator's act");
senseCmd.command("status").description("Whether the senses reader is installed, and which senses exist (core profile only)").action(()=>output(sensesStatus()));
senseCmd.command("mail").option("--query <text>","Gmail search string (default: the last 7 days of the inbox)").option("--max <n>","Max results, 1-25").description("Search the owner's Gmail, read-only (core profile's sense)").action(async(o:{query?:string;max?:string})=>output(await runSense(program.opts().workspace,"sam","mail",{query:o.query,max:o.max?Number(o.max):undefined})));
senseCmd.command("agenda").option("--days <n>","Window in days from now, 1-7").description("The owner's calendar events from now through the window, read-only (core profile's sense)").action(async(o:{days?:string})=>output(await runSense(program.opts().workspace,"sam","agenda",{days:o.days?Number(o.days):undefined})));
const briefCmd=program.command("brief").description("The morning brief (Phase E item 3): a deterministic daily digest over the senses (today's agenda, the last day's mail), what needs the owner (approvals, stuck deliveries, failed jobs), the heartbeat watches' latest verdicts, and the open work queues - assembled in code, no model call; delivery rides a Phase C script job (sam-brief) through the worthiness gate and the durable outbox");
briefCmd.command("today").description("Assemble and print today's brief as plain text (this is the sam-brief script job's stdout)").action(async()=>output((await buildBrief(program.opts().workspace)).text));
briefCmd.command("status").description("Whether the daily brief job is installed, and its schedule").action(()=>output(briefStatus(program.opts().workspace)));
briefCmd.command("install").option("--channel <id-or-name>","Deliver the brief to this channel (default: no channel - the brief lands in the core chat only)").option("--schedule <phrase>","Schedule phrase (default: daily at 8am)").option("--timezone <iana>","Per-job timezone (default: America/New_York)").description("Install the daily brief as a wall-clock script heartbeat job; refuses if it is already installed").action((o:{channel?:string;schedule?:string;timezone?:string})=>output(installBrief(program.opts().workspace,{channelId:o.channel??null,schedule:o.schedule,timezone:o.timezone})));
program.command("unification").description("UNIFICATION audit (items 2+3, one gate / one job): a deterministic read-only inventory of the one live approval gate (the actions store) against the legacy mission approvals ledger and the unexecuted schedule store, with the exact proposed retire cut and its verdict - the audit creates nothing and deletes nothing; the cut lands only on the owner's ruling").action(()=>output(unificationReport(program.opts().workspace)));
const watchCmd=program.command("watches").description("Deterministic watches: reports assembled in code from a connector's own aggregates - counted in code, never by a model from a paged list");
watchCmd.command("stack").description("The Nines stack watch as plain text (this is the sam-stack-watch script job's stdout): candidates total, newest candidate, alert verdicts, and the entered paper-setups count through the Nines connector; a full page reports a floor, never a fake exact count").action(async()=>output((await buildStackWatchReport(program.opts().workspace)).text));
watchCmd.command("status").description("Whether the stack watch has a connector to read through (registry only - no MCP call is made)").action(()=>output(stackWatchStatus(program.opts().workspace)));
const bkCmd=program.command("backup").description("Reliability (P9): nightly state backups of the whole .sam state, with manifest verify and a restore drill that proves the copy boots");
bkCmd.command("create").description("Snapshot the whole .sam state (SQLite DBs via VACUUM INTO, manifest with sha256 per file) into a tarball").option("--dest <dir>","Backup directory (default: <workspace>/backups)").option("--keep <n>","Keep the newest N archives","7").action((o:{dest?:string;keep:string})=>{const root=program.opts().workspace as string;output(createBackup(root,o.dest??join(resolve(root),"backups"),Number(o.keep)));});
bkCmd.command("list").description("List backup archives, oldest first").option("--dest <dir>","Backup directory (default: <workspace>/backups)").action((o:{dest?:string})=>{const root=program.opts().workspace as string;output(listBackups(o.dest??join(resolve(root),"backups")));});
bkCmd.command("verify").argument("<archive>").description("Check an archive against its manifest: sha256 per file plus integrity_check per database").action((archive:string)=>output(verifyBackup(archive)));
bkCmd.command("drill").argument("[archive]").description("Restore drill: verify, then boot the copy - open the real stores on the extracted state and count what they hold (no archive = newest in --dest)").option("--dest <dir>","Backup directory (default: <workspace>/backups)").action((archive:string|undefined,o:{dest?:string})=>{const root=program.opts().workspace as string;const target=archive??listBackups(o.dest??join(resolve(root),"backups")).at(-1)?.path;if(!target)throw new Error("No backup archive found");output(runRestoreDrill(target));});
bkCmd.command("restore").argument("<archive>").description("Restore state from a verified archive into this workspace; refuses to overwrite live state without --force (old state is kept aside, never deleted)").option("--force","Restore over existing state, keeping the old .sam aside").action((archive:string,o:{force?:boolean})=>output(restoreBackup(program.opts().workspace,archive,!!o.force)));
const miniCmd=program.command("minis").description("Minis: a scoped SAM spawned for one person, their data only");
miniCmd.command("spawn").argument("<name>").requiredOption("--person <who>","The person this mini serves").requiredOption("--instructions <text>","What this mini is for").option("--model <id>","Pin a model").option("--connector <id>","Pin one MCP connector by id").option("--heartbeat","Give it a starter daily-digest heartbeat").action((name:string,o:{person:string;instructions:string;model?:string;connector?:string;heartbeat?:boolean})=>output(spawnMini(program.opts().workspace,{name,person:o.person,instructions:o.instructions,model:o.model??null,connectorId:o.connector??null,starterHeartbeat:!!o.heartbeat})));
miniCmd.command("list").action(()=>output(minis(program.opts().workspace)));
miniCmd.command("door").argument("<name>").description("Issue (or rotate) the web door key for a mini (or sam, the core); the key is shown once").option("--home-link","Show a Main SAM link in the door header (operator doors only)").option("--visitor","Visitor door (P12): people chatting are customers, not the owner - their text is never captured as preference, law, or fact").action((name:string,o:{homeLink?:boolean;visitor?:boolean})=>{const key=issueDoorKey(program.opts().workspace,name,{homeLink:!!o.homeLink,visitor:!!o.visitor});output({mini:name,mode:o.visitor?"visitor":"owner",path:"/mini/"+key});});
miniCmd.command("door-off").argument("<name>").action((name:string)=>output({disabled:disableDoor(program.opts().workspace,name)}));
miniCmd.command("doors").description("Door audit (P10): every door with its expiry, key version, and session count - a door is a bearer credential, so its age must be visible").action(()=>output(listDoors(program.opts().workspace)));
miniCmd.command("screen").argument("<text>").description("Screening only (P10): show whether a message would be refused at a web door, and why; sends nothing").action((text:string)=>output(screenDoorMessage(text)));
miniCmd.command("redteam").description("Run the prompt-injection red-team pack against the door screen (P10): every attack must be refused under its category, every benign near-miss must pass").action(()=>output(runRedTeamPack()));
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
actCmd.command("propose").argument("<profile>").argument("<kind>").argument("<title>").argument("<detail>").option("--chat <id>","Stamp the chat this proposal belongs to").action(async(profile:string,kind:string,title:string,detail:string,o:{chat?:string})=>{const root=program.opts().workspace as string;const a=proposeAction(root,{actor:profile,kind,title,detail,chatId:o.chat??null});const settled=await settleAutoApprovals(root,a.id);output(settled[0]??a);});
actCmd.command("approve").argument("<id>").action(async(id:string)=>output(await decideAction(program.opts().workspace,id,true)));
actCmd.command("reject").argument("<id>").action(async(id:string)=>output(await decideAction(program.opts().workspace,id,false)));
actCmd.command("mode").description("Approvals engine (Phase D item 1): the install's approval mode, its smart-mode auto list, and the hardline never-list that binds in every mode").action(()=>{const root=program.opts().workspace as string;output({policy:loadApprovalPolicy(root),neverList:neverListSummary(),classes:Object.fromEntries(ACTION_KINDS.map(k=>[k,classifyProposal(k,null).risk]))});});
actCmd.command("set-mode").argument("<mode>","manual, smart, or off").option("--auto <kinds>","Smart mode only: comma-separated proposal kinds that may auto-execute (internal kinds only; replaces the list)").option("--clear-auto","Empty the smart-mode auto list").description("Set the approval mode - an OWNER act, ledgered. manual: everything waits for the owner (the default). smart: listed internal kinds auto-execute. off: everything auto-executes except the never-list").action((mode:string,o:{auto?:string;clearAuto?:boolean})=>{const root=program.opts().workspace as string;if(!APPROVAL_MODES.includes(mode as never))throw new Error("Invalid approval mode \""+mode+"\". Modes: "+APPROVAL_MODES.join(", "));let autoKinds:string[]|undefined;if(o.clearAuto)autoKinds=[];else if(o.auto!==undefined){autoKinds=o.auto.split(",").map(s=>s.trim()).filter(Boolean);const bad=autoKinds.filter(k=>!ACTION_KINDS.includes(k));if(bad.length)throw new Error("Unknown action kind(s): "+bad.join(", ")+". Kinds: "+ACTION_KINDS.join(", "));}const policy=saveApprovalPolicy(root,{mode:mode as never,autoKinds});recordActivity(root,"owner","approval-mode","Approval mode set to "+policy.mode+(policy.autoKinds.length?(" (auto: "+policy.autoKinds.join(", ")+")"):""));output(policy);});
actCmd.command("settle").description("Execute every pending proposal the current approval mode auto-approves (a no-op in manual mode)").action(async()=>output(await settleAutoApprovals(program.opts().workspace as string)));
actCmd.command("check").argument("<text>").description("Screening only: show whether a text hits the hardline never-list, and how a proposal kind classifies; proposes nothing").action((text:string)=>output({neverList:scanNeverList(text)}));
const contactCmd=program.command("contacts").description("Contacts (P12): per-contact permission notes - what SAM may do with each person it writes to; a no-drafts note is a hard refusal in the drafting path");
contactCmd.command("list").action(()=>output(listContacts(program.opts().workspace)));
contactCmd.command("show").argument("<name>").action((name:string)=>output(getContact(program.opts().workspace,name)));
contactCmd.command("set").argument("<name>").description("Create or update a contact's permission note").option("--note <text>","The permission note (owner words: what is fine, what needs care)").option("--nodraft","Mark this contact no-drafts: drafting to them refuses outright").option("--allow-draft","Clear a no-drafts mark").action((name:string,o:{note?:string;nodraft?:boolean;allowDraft?:boolean})=>{if(o.nodraft&&o.allowDraft)throw new Error("Choose one of --nodraft / --allow-draft");output(upsertContact(program.opts().workspace,{name,note:o.note,noDraft:o.allowDraft?false:o.nodraft?true:undefined}));});
contactCmd.command("remove").argument("<name>").action((name:string)=>output({removed:removeContact(program.opts().workspace,name)}));
const draftCmd=program.command("drafts").description("Outbound drafts (P12): SAM drafts, the OWNER sends. Drafts live in SAM's own store; there is no send command, by design");
draftCmd.command("create").requiredOption("--to <name>","Who the draft is for").option("--channel <kind>","email, text, message, letter, or other","message").option("--subject <text>","Subject line, if the channel has one").requiredOption("--body <text>","The draft text").option("--actor <name>","Drafting profile","sam").action((o:{to:string;channel:string;subject?:string;body:string;actor:string})=>output(createDraft(program.opts().workspace,{actor:o.actor,to:o.to,channel:o.channel,subject:o.subject??null,body:o.body,via:"cli"})));
draftCmd.command("list").action(()=>output(listDrafts(program.opts().workspace)));
draftCmd.command("show").argument("<id>").action((id:string)=>output(getDraft(program.opts().workspace,id)));
draftCmd.command("remove").argument("<id>").description("Discard a draft (the only way a draft ends, besides the owner copying it out and sending it themselves)").action((id:string)=>output({removed:removeDraft(program.opts().workspace,id)}));
const corrCmd=program.command("corrections").description("Corrections (P6): owner corrections in a message, proposed as standing law through the approval gate - never instant law");
corrCmd.command("detect").argument("<text>").description("Detection only: show the rule statement a message would propose; proposes nothing").action((text:string)=>output({correction:detectCorrection(text)}));
corrCmd.command("check").argument("<profile>").argument("<text>").option("--chat <id>","Stamp the chat the correction came from").description("Detect a correction in a message and route it into the approval gate as a pending law proposal (deduped)").action((profile:string,text:string,o:{chat?:string})=>{const correction=detectCorrection(text);if(!correction){output({correction:null,proposal:null});return;}const routed=proposeCorrection(program.opts().workspace,{actor:profile,chatId:o.chat??null,text});output({correction,proposal:routed?.proposal??null,created:routed?.created??false});});
const modelsCmd=program.command("models").description("Model routing (P11) + auth status (CLI dressing item 2): which model each route tier runs, and whether the routes and profile pins actually work - bare `sam models` prints the routing table");
modelsCmd.action(()=>output(modelRoutingTable()));
modelsCmd.command("status").description("Auth status over every detected route: per route tier and per profile (pin wins) - resolved model, source, the key env NAME as present/absent (values never print), endpoint, the setup baseline, the engine CLI-reuse route, and the last probe verdicts").option("--probe","Probe every distinct resolved model with ONE real completion each, bucket the results (ok/auth/rate_limit/billing/timeout/network/empty/missing), and persist them for later status reads").option("--live","Explicitly allow the probe's model API requests (may incur charges); required with --probe").option("--check","Exit non-zero when the chat route is unhealthy (no model/key, or its latest probe is not ok) - for scripts").action(async(o:{probe?:boolean;live?:boolean;check?:boolean})=>{const root=resolve(program.opts().workspace);if(o.probe&&!o.live)throw new Error("--probe makes real model API requests; pass --live to allow them (the explicit network opt-in)");let probe=null;if(o.probe)probe=await probeAuth(root);const status=authStatus(root);output({auth:status,probe});if(o.check&&!status.healthy)process.exitCode=1;});
modelsCmd.command("list").description("The routing table plus every profile's resolved model and key state, as one read").action(()=>{const root=resolve(program.opts().workspace);const status=authStatus(root);output({routes:modelRoutingTable(),profiles:status.profiles,providers:status.providers});});
const providersCmd=program.command("providers").description("Model providers configured at once: the environment provider plus entries in .sam/providers.db (endpoint and key ENV NAME only - never a key value). A profile pins one with `sam agents set-provider`");
providersCmd.command("list").description("Every configured provider: id, endpoint, key env name as present/absent, and the models it serves. Values are never printed").action(()=>output(listProviders(program.opts().workspace)));
providersCmd.command("add").argument("<id>").requiredOption("--endpoint <url>","OpenAI-compatible /chat/completions URL").requiredOption("--key-env <NAME>","Environment variable NAME that holds this provider's key").requiredOption("--model <id>","Default model").option("--cheap <id>","Cheap-tier model (heartbeat)").option("--deep <id>","Deep-tier model (background)").description("Register an additional provider. The id is not a secret; the key stays in the environment").action((id:string,o:{endpoint:string;keyEnv:string;model:string;cheap?:string;deep?:string})=>{const root=program.opts().workspace as string;const added=addProvider(root,{id,endpoint:o.endpoint,keyEnv:o.keyEnv,model:o.model,cheapModel:o.cheap??null,deepModel:o.deep??null});recordActivity(root,"owner","provider-add","Provider "+added.id+" registered (key env "+added.keyEnv+", "+added.key+")");output(added);});
providersCmd.command("remove").argument("<id>").description("Remove a file-configured provider. The environment provider is not stored here and cannot be removed").action((id:string)=>{const root=program.opts().workspace as string;const removed=removeProvider(root,id);if(removed)recordActivity(root,"owner","provider-remove","Provider "+id+" removed");output({removed});});
const codexCmd=program.command("codex").description("ChatGPT-backend OAuth for Codex (not an OpenAI API key). Login prints the authorization URL and stops; the account sign-in happens with the owner present");
codexCmd.command("login").description("Start the browser OAuth flow and print the authorization URL. Does not contact the network and does not complete the login").action(()=>{const started=startCodexLogin(program.opts().workspace);if(program.opts().json)output({url:started.url,state:started.state,redirectUri:started.redirectUri,pending:true,note:"Open the URL while the owner is present. This command does not finish the login."});else console.log(started.url);});
codexCmd.command("status").description("Whether a Codex login is pending or a token is stored. Tokens are never printed").action(()=>output(codexAuthState(program.opts().workspace)));
const agentCmd=program.command("agents").description("Agent profiles: list them and re-pin a profile's model or connector after creation (profiles were create-only; a model switch used to need a direct database UPDATE)");
agentCmd.command("list").description("List every registered agent profile with its model and connector pins").action(()=>{const db=new ChatStore(program.opts().workspace);try{output(db.agents());}finally{db.close();}});
agentCmd.command("set-model").argument("<name>").argument("<model>").description("Re-pin a profile's model; use 'none' to clear the pin so the route tier decides again").action((name:string,model:string)=>{
  const root=program.opts().workspace as string;
  if(name==="sam")throw new Error("Profile \"sam\" is the core profile and carries no pin row; its model is the SAM_MODEL environment value");
  const db=new ChatStore(root);
  try{
    const updated=db.setAgentModel(name,model==="none"?null:model);
    if(!updated)throw new Error("Unknown profile \""+name+"\". Known profiles: "+["sam",...db.agents().map(a=>a.name)].join(", "));
    recordActivity(root,name,"agent-repin","Model pin "+(updated.model?("set to "+updated.model):"cleared (route tier decides)"));
    output(updated);
  }finally{db.close();}
});
agentCmd.command("set-provider").argument("<name>").argument("<provider>").description("Pin a profile to a configured provider id (sam providers list); use 'none' to return the profile to the environment provider. The model pin, if any, still names the model on that provider").action((name:string,provider:string)=>{
  const root=program.opts().workspace as string;
  if(name==="sam")throw new Error("Profile \"sam\" is the core profile and carries no pin row; its provider is the environment provider");
  const providerId=provider==="none"?null:provider;
  if(providerId&&!listProviders(root).some(p=>p.id===providerId))throw new Error("Unknown provider \""+providerId+"\". Configured providers: "+listProviders(root).map(p=>p.id).join(", "));
  const db=new ChatStore(root);
  try{
    const updated=db.setAgentProvider(name,providerId);
    if(!updated)throw new Error("Unknown profile \""+name+"\". Known profiles: "+["sam",...db.agents().map(a=>a.name)].join(", "));
    recordActivity(root,name,"agent-repin","Provider pin "+(updated.provider?("set to "+updated.provider):"cleared (environment provider)"));
    output(updated);
  }finally{db.close();}
});
agentCmd.command("fallbacks").argument("<name>").description("Failover routes for a profile, tried in order after the primary provider+model when a turn fails before any tool has run").action((name:string)=>output({profile:name,fallbacks:fallbackRoutes(program.opts().workspace,name)}));
agentCmd.command("add-fallback").argument("<name>").argument("<provider>").argument("<model>").description("Append a failover route (configured provider id + model). The turn uses it only when the previous route fails before any tool runs").action((name:string,provider:string,model:string)=>{
  const root=program.opts().workspace as string;
  const known=knownProfileNames(root);
  if(!known.includes(name))throw new Error("Unknown profile \""+name+"\". Known profiles: "+known.join(", "));
  const fallbacks=addFallbackRoute(root,name,{provider,model});
  recordActivity(root,name,"failover-route","Fallback route added: "+provider+"/"+model);
  output({profile:name,fallbacks});
});
agentCmd.command("clear-fallbacks").argument("<name>").description("Remove every failover route for a profile. The primary pin is left alone").action((name:string)=>{const root=program.opts().workspace as string;output({profile:name,cleared:clearFallbackRoutes(root,name)});});
agentCmd.command("set-connector").argument("<name>").argument("<connector>").description("Re-pin a profile's MCP connector by registered connector name or id; use 'none' to clear the pin").action((name:string,connector:string)=>{
  const root=program.opts().workspace as string;
  if(name==="sam")throw new Error("Profile \"sam\" is the core profile and carries no pin row; it uses no pinned connector");
  let connectorId:string|null=null;
  if(connector!=="none"){
    if(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(connector))connectorId=connector;
    else{
      const found=connectors(root).find(c=>c.name===connector);
      if(!found)throw new Error("Unknown connector \""+connector+"\". Registered connectors: "+(connectors(root).map(c=>c.name).join(", ")||"(none)"));
      connectorId=found.id;
    }
  }
  const db=new ChatStore(root);
  try{
    const updated=db.setAgentConnector(name,connectorId);
    if(!updated)throw new Error("Unknown profile \""+name+"\". Known profiles: "+["sam",...db.agents().map(a=>a.name)].join(", "));
    recordActivity(root,name,"agent-repin","Connector pin "+(updated.connector_id?("set to "+updated.connector_id):"cleared"));
    output(updated);
  }finally{db.close();}
});
const filesCmd=agentCmd.command("files").description("Standing files (Plan Phase A): the per-profile Markdown files - persona (stable tier), owner brief and ops notes (context tier) - assembled into the system prompt in tiers, replacing the single instructions paragraph");
filesCmd.command("list").argument("<name>").description("List a profile's standing files with tier, size, and updated time").action((name:string)=>output(listStandingFiles(program.opts().workspace,name)));
filesCmd.command("show").argument("<name>").argument("<file>").description("Print one standing file's content; file is one of: "+STANDING_FILES.map(f=>f.name).join(", ")).action((name:string,file:string)=>{const content=readStandingFile(program.opts().workspace,name,file);if(content===null)throw new Error("No standing file \""+file+"\" for profile \""+name+"\" yet");output({profile:name,file,content});});
filesCmd.command("set").argument("<name>").argument("<file>").argument("<text...>").description("Write a standing file from the given text (owner words only; takes effect on the profile's next turn)").action((name:string,file:string,text:string[])=>output(writeStandingFile(program.opts().workspace,name,file,text.join(" "))));
filesCmd.command("clear").argument("<name>").argument("<file>").description("Remove a standing file; the profile falls back to its instructions paragraph alone for that tier").action((name:string,file:string)=>output({cleared:clearStandingFile(program.opts().workspace,name,file)}));
const usageCmd=program.command("usage").description("Token spend (P11): provider-reported usage recorded per call in .sam/usage.jsonl, by model, route, tier, and profile");
usageCmd.command("summary").option("--actor <name>","Only this profile").option("--route <route>","Only this route (chat, heartbeat, background)").option("--model <id>","Only this model").action((o:{actor?:string;route?:string;model?:string})=>output(usageSummary(program.opts().workspace,o)));
usageCmd.command("list").option("--limit <n>","How many recent calls","20").action((o:{limit:string})=>output(readUsage(program.opts().workspace).slice(-Math.max(1,Number(o.limit)||20))));
program.command("relay").description("Send one prompt to 2 or more configured models and print their answers side by side, with latency and token usage. Pass --route provider:model at least twice, or omit it to use a profile's primary route plus its fallbacks. No tools run").argument("<prompt>").option("--route <provider:model>","One provider:model route; repeat for each model",(value:string,prev:string[])=>{prev.push(value);return prev;},[] as string[]).option("--profile <name>","Profile whose routes to use when --route is omitted","sam").option("--chat <id>","Also store the prompt and the side-by-side reply in this chat").action(async(prompt:string,o:{route:string[];profile:string;chat?:string})=>{
  const root=program.opts().workspace as string;
  let targets;
  if(o.route.length)targets=o.route.map(parseRelayRoute);
  else{
    let profile: {provider?:string|null;model?:string|null}|null=null;
    if(o.profile!=="sam"){
      const db=new ChatStore(root);
      try{const found=db.agents().find(a=>a.name===o.profile);if(!found)throw new Error("Unknown profile \""+o.profile+"\"");profile={provider:found.provider??null,model:found.model??null};}finally{db.close();}
    }
    targets=relayTargetsForProfile(root,o.profile,profile);
  }
  const result=await relayPrompt(root,prompt,targets,{actor:o.profile});
  if(o.chat){
    const db=new ChatStore(root);
    try{db.add(o.chat,"user",prompt,"ts-cli");db.add(o.chat,"assistant",result.text.length>20000?result.text.slice(0,19900)+"\n[truncated]":result.text);}finally{db.close();}
  }
  output(result);
  if(result.answers.every(a=>!a.ok))process.exitCode=1;
});
program.command("activity").description("The activity ledger: everything SAM did, newest last").option("--limit <n>","How many lines").option("--actor <name>","Only this actor").option("--kind <kind>","Only this kind").action((o:{limit?:string;actor?:string;kind?:string})=>output(activityView(program.opts().workspace,{limit:o.limit?Number(o.limit):20,actor:o.actor,kind:o.kind})));
program.command("overview").description("One status snapshot, the same payload as the dashboard /api/status route").action(()=>output(statusSnapshot(program.opts().workspace)));
program.command("observe").description("Observability data: provider health, per-agent activity, token spend, and turn failures with reasons. Same shape as /api/status observability").action(()=>output(observabilityReport(program.opts().workspace)));
const eventCmd=program.command("events").description("Event door: a signed local webhook that wakes a profile with one heartbeat-budget turn. The payload is data, never an instruction, and it cannot skip the approval gate");
eventCmd.command("bind").argument("<name>").argument("<profile>").requiredOption("--secret-env <NAME>","Environment variable NAME holding the HMAC secret").description("Bind an event name to a profile. The secret value stays in the environment").action((name:string,profile:string,o:{secretEnv:string})=>{const root=program.opts().workspace as string;const known=knownProfileNames(root);if(!known.includes(profile))throw new Error("Unknown profile: "+profile);const row=bindEvent(root,{name,profile,secretEnv:o.secretEnv});recordActivity(root,"owner","event-bind","Event "+row.name+" bound to "+row.profile+" (secret env "+row.secretEnv+")");output(row);});
eventCmd.command("list").description("Event bindings. Secret values are never printed").action(()=>{const root=program.opts().workspace as string;output(eventBindings(root).map(b=>({...b,secret:process.env[b.secretEnv]?.trim()?"present":"absent"})));});
eventCmd.command("unbind").argument("<name>").action((name:string)=>output({removed:unbindEvent(program.opts().workspace,name)}));
eventCmd.command("accept").argument("<name>").requiredOption("--body <file>","UTF-8 JSON file: {type,id?,data}").option("--signature <hex>","HMAC-SHA256 hex of the file bytes. Omit to sign with the binding's secret env, for a local check").description("Accept one signed event now, the same door the webhook uses").action(async(name:string,o:{body:string;signature?:string})=>{const root=program.opts().workspace as string;const raw=readFileSync(o.body,"utf8");const binding=eventBindings(root).find(b=>b.name===name);if(!binding)throw new Error("Unknown event");const secret=process.env[binding.secretEnv];if(!secret)throw new Error("Event secret missing from environment: "+binding.secretEnv);const signature=o.signature??signEvent(secret,raw);const result=await acceptEvent(root,{name,rawBody:raw,signature});output(result);if(result.status!==200)process.exitCode=1;});
eventCmd.command("serve").option("--port <number>","Loopback port","4392").description("Serve POST /events/<name> on 127.0.0.1. Signature header: x-sam-event-signature").action(async(o:{port:string})=>{const root=program.opts().workspace as string;const port=Number(o.port);await serveEvents(root,port);console.log("SAM event door on 127.0.0.1:"+port);await new Promise(()=>{});});
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
  const sam=new DashboardSamClient(o.dashboardUrl.replace(/\/$/,""),token,fetch,"api");
  console.log("SAM webhook channel "+channel.name+" -> profile "+channel.profile+" on 127.0.0.1:"+o.port);
  await serveWebhookChannel({channel,sam,secret,port:Number(o.port),root});
 });
const chats=program.command("chats").description("Persistent separate chat histories (no model invocation)");
chats.command("new").argument("<title>").option("--profile <name>","Bind the chat to a profile").action((title:string,o:{profile?:string})=>{const db=new ChatStore(program.opts().workspace);try{output(db.create(title,o.profile&&o.profile!=="sam"?o.profile:null));}finally{db.close();}});
chats.command("list").action(()=>{const db=new ChatStore(program.opts().workspace);try{output(db.list());}finally{db.close();}});
chats.command("managed").option("--profile <name>","Acting profile (default sam)").option("--archived","Include archived").action((o:{profile?:string;archived?:boolean})=>output(listManagedChats(program.opts().workspace,o.profile??"sam",{includeArchived:!!o.archived})));
chats.command("rename").argument("<id>").argument("<title>").option("--profile <name>","Acting profile (default sam)").action((id:string,title:string,o:{profile?:string})=>output(renameManagedChat(program.opts().workspace,o.profile??"sam",id,title)));
chats.command("pin").argument("<id>").option("--profile <name>","Acting profile (default sam)").action((id:string,o:{profile?:string})=>output(pinManagedChat(program.opts().workspace,o.profile??"sam",id,true)));
chats.command("unpin").argument("<id>").option("--profile <name>","Acting profile (default sam)").action((id:string,o:{profile?:string})=>output(pinManagedChat(program.opts().workspace,o.profile??"sam",id,false)));
chats.command("branch").argument("<id>").argument("<title>").option("--profile <name>","Acting profile (default sam)").action((id:string,title:string,o:{profile?:string})=>output(branchManagedChat(program.opts().workspace,o.profile??"sam",id,title)));
chats.command("archive").argument("<id>").option("--profile <name>","Acting profile (default sam)").action((id:string,o:{profile?:string})=>output(archiveManagedChat(program.opts().workspace,o.profile??"sam",id)));
chats.command("unarchive").argument("<id>").option("--profile <name>","Acting profile (default sam)").action((id:string,o:{profile?:string})=>output(unarchiveManagedChat(program.opts().workspace,o.profile??"sam",id)));
chats.command("activity").description("Every chat with its last-message time and message count, newest activity first").action(()=>{const db=new ChatStore(program.opts().workspace);try{const act=new Map(db.lastActivity().map(a=>[a.chat_id,a] as const));output(db.list({includeArchived:true}).map(c=>({...c,lastMessageAt:act.get(c.id)?.last_message_at??null,messageCount:act.get(c.id)?.messages??0})).sort((x,y)=>String(y.lastMessageAt??"").localeCompare(String(x.lastMessageAt??""))));}finally{db.close();}});
chats.command("search").argument("<query>").option("--profile <name>","Acting profile (default sam)").option("--limit <n>","Max hits (default 20)").description("Full-text search (FTS5, relevance-ranked, multi-term prefix) across the acting profile's own chats - the engine behind the sam_search_chats chat tool").action((query:string,o:{profile?:string;limit?:string})=>output(searchManagedChats(program.opts().workspace,o.profile??"sam",query,o.limit?Number(o.limit):20)));
chats.command("show").argument("<id>").action((id:string)=>{const db=new ChatStore(program.opts().workspace);try{output(db.messages(id));}finally{db.close();}});
chats.command("resume").argument("<id>").description("Resume a killed turn from the saved partial assistant reply. The row stays partial until the continuation finishes, and is never presented as a complete answer before that").action(async(id:string)=>{
  const root=program.opts().workspace as string;
  const db=new ChatStore(root);
  let content="";
  try{
    const open=db.openPartial(id);
    if(!open)throw new Error("No partial reply to resume");
    const prev=[...db.messages(id)].reverse().find(m=>m.role==="user");
    if(!prev)throw new Error("No partial reply to resume");
    content=prev.content;
  }finally{db.close();}
  const reply=await runChatTurn(root,id,content);
  const check=new ChatStore(root);
  try{const last=[...check.messages(id)].reverse().find(m=>m.role==="assistant");output({reply,partial:last?.partial===1,content:last?.content??null});}
  finally{check.close();}
});
chats.command("react").argument("<chatId>").argument("<messageId>").argument("<emoji>").description("Set an emoji reaction on a message (or clear it with 'none') - the operator parity for sam_react and the dashboard badges").action((chatId:string,messageId:string,emoji:string)=>{const db=new ChatStore(program.opts().workspace);try{const set=db.setReaction(chatId,messageId,emoji==="none"?null:emoji);output({set,message:db.messages(chatId).find(m=>m.id===messageId)??null});}finally{db.close();}});
chats.command("read").argument("<id>").description("Messages plus this chat's action cards").action((id:string)=>output(chatView(program.opts().workspace,id)));
chats.command("send").argument("<id>").argument("<message>").description("Run one real chat turn; any actions SAM proposes are printed with their ids for approval").action(async(id:string,message:string)=>{const ws=program.opts().workspace as string;const since=new Date().toISOString();const reply=await runChatTurn(ws,id,message,{source:"ts-cli"});output({reply,proposed:turnActions(ws,id,since)});});
chats.command("event").argument("<chat-id>").requiredOption("--agent <name>","Registered agent identifier").requiredOption("--kind <kind>","message, tool, result, assignment").requiredOption("--text <text>","Event body").action((id:string,o:{agent:string;kind:string;text:string})=>{const db=new ChatStore(program.opts().workspace);try{output(db.addEvent(id,o.agent,o.kind as "message"|"tool"|"result"|"assignment",o.text));}finally{db.close();}});
const teams=program.command("team").description("Standing team: a lead routes a task to a role member, then a reviewer must approve it. The older research exchange remains when --chat and --objective are set");
const teamMembers=teams.command("member").description("Standing members: each is a profile with a role, its own memory, a model pin, and a tool allowlist");
teamMembers.command("add").argument("<name>").argument("<role>","builder, researcher, qa, or reviewer").option("--tools <names>","Comma-separated tool allowlist").option("--model <id>","Model pin for this member").option("--calls <n>","Max model calls this member may spend on one run","4").action((name:string,role:string,o:{tools?:string;model?:string;calls:string})=>{
  output(addTeamMember(program.opts().workspace,{name,role,tools:o.tools?o.tools.split(",").map(s=>s.trim()).filter(Boolean):[],model:o.model??null,maxCalls:Number(o.calls)}));
});
teamMembers.command("list").action(()=>output(listTeamMembers(program.opts().workspace)));
teamMembers.command("remove").argument("<name>").action((name:string)=>output({removed:removeTeamMember(program.opts().workspace,name)}));
teams.command("run").argument("[task]").option("--chat <uuid>","Existing chat id for the legacy research exchange").option("--objective <text>","Mission objective for the legacy research exchange").option("--live","Explicitly authorize model calls for the legacy research exchange").option("--inspect-workspace","Read a bounded allowlist of local source files").option("--web","Search online with configured Brave Search API key").option("--agent-tools","Allow researcher to choose bounded read-only workspace tools").option("--lead <name>","Lead profile for a standing-team run","sam").option("--rounds <n>","Review rounds before the run stops unapproved","3").description("Standing team: sam team run <task>. Legacy research exchange: sam team run --chat --objective --live").action(async(task:string|undefined,o:{chat?:string;objective?:string;live?:boolean;inspectWorkspace?:boolean;web?:boolean;agentTools?:boolean;lead:string;rounds:string})=>{
 if(o.chat||o.objective||o.live){
  if(!o.chat||!o.objective||!o.live)throw new Error("The research exchange needs --chat, --objective, and --live");
  const selected=process.env.SAM_MODEL_PROVIDER??"";
  const endpoint=process.env.SAM_MODEL_ENDPOINT??(selected==="minimax"?"https://api.minimax.io/v1/chat/completions":undefined);
  const model=process.env.SAM_MODEL;
  if(!endpoint||!model)throw new Error("Configure model endpoint and SAM_MODEL");
  const key=process.env.SAM_MODEL_API_KEY??(selected==="minimax"?process.env.MINIMAX_API_KEY:undefined)??"";
  if(o.web&&!process.env.SAM_WEB_SEARCH_API_KEY)throw new Error("Set SAM_WEB_SEARCH_API_KEY before using --web");
  const provider=new OpenAICompatibleProvider(endpoint,key,60000);
  output(await runResearchTeam(program.opts().workspace,o.chat,o.objective,[{name:"research",role:"Research specialist"},{name:"qa",role:"Critical QA reviewer"}],provider,model,{workspaceEvidence:!!o.inspectWorkspace,webSearchKey:o.web?process.env.SAM_WEB_SEARCH_API_KEY:undefined,agentTools:!!o.agentTools}));
  return;
 }
 if(!task)throw new Error("Usage: sam team run <task>");
 output(await runStandingTeam(program.opts().workspace,task,{lead:o.lead,maxRounds:Number(o.rounds)}));
});
teams.command("status").description("Standing members, recent runs, and agent-to-agent messages").action(()=>output(teamStatus(program.opts().workspace)));
const reviewCmd=program.command("review").description("Reviewer verdicts from standing team runs");
reviewCmd.command("list").description("Recent runs with their verdict").action(()=>output(listTeamRuns(program.opts().workspace).map(run=>({id:run.id,status:run.status,worker:run.worker,reviewer:run.reviewer,rounds:run.rounds,verdict:run.verdict,workerModel:run.workerModel,reviewerModel:run.reviewerModel}))));
reviewCmd.command("show").argument("[id]").description("One run's review trail, or the latest").action((id?:string)=>{
  const runs=listTeamRuns(program.opts().workspace);
  const run=id?runs.find(item=>item.id===id):runs.at(-1);
  if(!run)throw new Error(id?"Unknown team run":"No team runs yet");
  const messages=teamStatus(program.opts().workspace).messages.filter(message=>message.runId===run.id);
  output({run,messages});
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
skills.command("used").option("--limit <n>","Max entries (default 20)").description("Skill use by SAM itself: every sam_read_skill the model made, newest first - the visibility ledger (operator reads never count)").action((o:{limit?:string})=>output(recentSkillUse(program.opts().workspace,o.limit?Number(o.limit):20)));
skills.command("remove").argument("<name>").description("Remove a registry-installed skill (hand-placed skills are never touched)").action((name:string)=>output({removed:removeInstalledSkill(program.opts().workspace,name)}));
skills.command("author").argument("<name>").requiredOption("--description <text>","What task the skill is for (task matching reads this)").option("--instructions <text>","The skill's instructions (steps, checks, pitfalls)").option("--file <path>","Read the instructions from a UTF-8 file instead of --instructions").description("Author a skill directly as the operator (Phase B item 3): writes a validated SKILL.md SAM drafted from a completed workflow, stamped sam-authored; a same-name skill SAM did not author is never overwritten").action((name:string,o:{description:string;instructions?:string;file?:string})=>{if(!!o.instructions===!!o.file)throw new Error("Give exactly one of --instructions or --file");output(writeAuthoredSkill(program.opts().workspace,{name,description:o.description,instructions:o.file?readFileSync(o.file,"utf8"):o.instructions as string},{actor:"operator"}));});
skills.command("propose").argument("<name>").requiredOption("--description <text>","What task the skill is for (task matching reads this)").option("--instructions <text>","The skill's instructions (steps, checks, pitfalls)").option("--file <path>","Read the instructions from a UTF-8 file instead of --instructions").option("--profile <name>","Acting profile (default sam)","sam").description("Draft a skill for owner approval (Phase B item 3): validates the draft and routes it through the ONE proposal gate; nothing is written until the owner approves").action((name:string,o:{description:string;instructions?:string;file?:string;profile:string})=>{if(!!o.instructions===!!o.file)throw new Error("Give exactly one of --instructions or --file");const r=proposeAuthoredSkill(program.opts().workspace,{actor:o.profile,name,description:o.description,instructions:o.file?readFileSync(o.file,"utf8"):o.instructions as string});output({status:r.status,patch:r.patch,proposalId:r.proposal.id,title:r.proposal.title});});
skills.command("authored").description("Skills SAM authored itself, with provenance and version").action(()=>output(authoredSkills(program.opts().workspace)));
skills.command("curator").description("Skill curator (Phase B item 3): run the deterministic library pass now - duplicate, shadowed, orphaned, and unmatchable skills, each with a suggested patch; the same pass runs inside every heartbeat consolidation").action(()=>{const r=runSkillCurator(program.opts().workspace);output({findings:r.findings,changed:r.changed});});
skills.command("curator-findings").description("The curator findings from the last pass, without re-running it").action(()=>output(curatorFindings(program.opts().workspace)));
skills.command("allowlist").argument("<profile>").description("Show one profile's skill allowlist (Phase C item 3): null means unrestricted - the profile holds every installed skill").action((profile:string)=>{const root=program.opts().workspace as string;output({profile,allowlist:skillAllowlist(root,profile),effective:skillsForProfile(root,profile).map(s=>s.name)});});
skills.command("allow").argument("<profile>").argument("<names...>").description("Set one profile's skill allowlist (Phase C item 3): the profile's catalog, sam_list_skills, and sam_read_skill see only these skills; names must be installed skills").action((profile:string,names:string[])=>{const root=program.opts().workspace as string;const known=knownProfileNames(root);if(!known.includes(profile))throw new Error("Unknown profile: "+profile+". Known profiles: "+known.join(", "));output({profile,allowlist:setSkillAllowlist(root,profile,names)});});
skills.command("allow-clear").argument("<profile>").description("Clear one profile's skill allowlist (back to unrestricted)").action((profile:string)=>output({profile,allowlist:setSkillAllowlist(program.opts().workspace,profile,null)}));
const code=program.command("code").description("Coder hands (Phase D item 2): a designated code root outside the SAM home - C1 write/edit hands confined to it, C2 verify hands as a fixed command allowlist");
code.command("root").description("Show the designated code root (operator-set; SAM's chat hands can use it but never move it)").action(()=>output(codeSummary(program.opts().workspace)));
code.command("set-root").argument("<path>").description("Designate the code root: a project tree that is not the SAM home, not inside it, and does not contain it").action((path:string)=>output({root:setCodeRoot(program.opts().workspace,path)}));
code.command("clear-root").description("Clear the code root designation (SAM's coder hands refuse until a new one is set)").action(()=>{clearCodeRoot(program.opts().workspace);output({root:null});});
code.command("list").argument("[path]").description("List files in the code root (or a subfolder)").action((path?:string)=>output(listCodeFiles(program.opts().workspace,path??".")));
code.command("read").argument("<path>").description("Read a text file from the code root (secrets, env files, keys, binaries refused)").action((path:string)=>output(readCodeFile(program.opts().workspace,path)));
code.command("write").argument("<path>").option("--content <text>","The full new file content").option("--file <path>","Read the content from a UTF-8 file instead of --content").description("Write a whole text file in the code root (C1): ledgered with its diff and recorded as an unverified change until build+test pass").action((path:string,o:{content?:string;file?:string})=>{if(!!o.content===!!o.file)throw new Error("Give exactly one of --content or --file");output(writeCodeFile(program.opts().workspace,"operator",path,o.file?readFileSync(o.file,"utf8"):(o.content as string)));});
code.command("edit").argument("<path>").requiredOption("--old <text>","The exact existing text to replace (must appear exactly once)").requiredOption("--new <text>","The replacement text").description("Edit one exact passage in a code-root file (C1): ledgered with its diff").action((path:string,o:{old:string;new:string})=>output(editCodeFile(program.opts().workspace,"operator",path,o.old,o.new)));
code.command("writes").option("--limit <n>","How many recent writes to show","20").description("The ledgered code-write history, newest last, each with its diff readable back").action((o:{limit:string})=>output(codeWrites(program.opts().workspace,Math.max(1,Math.min(100,parseInt(o.limit,10)||20)))));
code.command("commands").description("The C2 verify-hands allowlist: the only command names that can run in the code root (no arbitrary commands, flags, or shell)").action(()=>output({commands:codeCommandNames()}));
code.command("spec").argument("<name>").description("Show the fixed argv one allowlisted command name builds (refuses for a missing package script or unknown name)").action((name:string)=>output(codeCommandSpec(program.opts().workspace,name)));
code.command("run").argument("<name>").option("--timeout <ms>","Timeout in milliseconds (1000-120000)").description("Run one allowlisted verify command in the code root (C2): build/test/lint scripts, read-only git, agent-reach read-only reports; build/test verdicts settle the verification ledger. git-clone is allowlisted too, but it takes a url and a destination: use code clone").action(async(name:string,o:{timeout?:string})=>output(await runCodeCommand(program.opts().workspace,"operator",name,{timeoutMs:o.timeout?parseInt(o.timeout,10):undefined})));
code.command("clone").argument("<url>").argument("<destination>").option("--timeout <ms>","Timeout in milliseconds (1000-120000)").description("git-clone: clone a URL into a directory inside the designated code root. The destination is checked (a path that escapes is refused). The URL and destination are ledgered. No shell, no push.").action(async(url:string,destination:string,o:{timeout?:string})=>output(await cloneIntoCodeRoot(program.opts().workspace,"operator",url,destination,{timeoutMs:o.timeout?parseInt(o.timeout,10):undefined})));
code.command("python").argument("<path>").option("--sandbox <name>","Run a script inside this sandbox instead of the code root").option("--pass-through <names>","Comma-separated environment variable NAMES to keep (connector tokens and model keys are scrubbed otherwise)").option("--timeout <ms>","Timeout in milliseconds (1000-120000)").description("Run one Python script file that already exists in the code root or a sandbox. argv is the interpreter plus that file. The run is ledgered with the script's content hash.").action(async(path:string,o:{sandbox?:string;passThrough?:string;timeout?:string})=>output(await runPython(program.opts().workspace,"operator",path,{sandbox:o.sandbox,passThrough:o.passThrough?o.passThrough.split(",").map(s=>s.trim()).filter(Boolean):[],timeoutMs:o.timeout?parseInt(o.timeout,10):undefined})));
code.command("sandbox-list").description("List sandboxes SAM created under its sandboxes directory (dependency and filesystem isolation, one venv each)").action(()=>output({sandboxes:listSandboxes(program.opts().workspace)}));
code.command("sandbox-create").argument("<name>").description("Create a sandbox with its own venv under the SAM-managed sandboxes directory").action(async(name:string)=>output(await createSandbox(program.opts().workspace,"operator",name)));
code.command("sandbox-destroy").argument("<name>").description("Delete one sandbox SAM created. Anything else under the sandboxes directory is refused").action((name:string)=>output(destroySandbox(program.opts().workspace,"operator",name)));
code.command("sandbox-write").argument("<name>").argument("<path>").option("--content <text>","The full new file content").option("--file <path>","Read the content from a UTF-8 file instead of --content").description("Write a text file inside a sandbox SAM created").action((name:string,path:string,o:{content?:string;file?:string})=>{if(!!o.content===!!o.file)throw new Error("Give exactly one of --content or --file");output(writeSandboxFile(program.opts().workspace,"operator",name,path,o.file?readFileSync(o.file,"utf8"):(o.content as string)));});
code.command("sandbox-pip").argument("<name>").argument("<package>").argument("<version>").description("pip install one exact package==version into a sandbox venv. The package and version are ledgered. No pass-through of connector tokens or model keys.").action(async(name:string,pkg:string,version:string)=>output(await installSandboxPackage(program.opts().workspace,"operator",name,pkg,version)));
code.command("branches").description("Git discipline (C4): the code root's repository, its current branch, and its sam/<task> branches (coding-loop branches; pushing one is an owner-approved git-push proposal, see coding push)").action(()=>output(listTaskBranches(program.opts().workspace)));
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
  const missions=store(), db=openDatabase(dbPath());
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

const subagentCmd=program.command("subagent").description("Debug invisible helpers a chat turn started on its own. list, status, and cancel inspect them. The owner-facing path is the sam_spawn_subagent tool: the chat shows Working on it, then the folded answer, never the helper's own text. A child with no pinned connector runs on the plain chat path");
subagentCmd.command("spawn").requiredOption("--prompt <text>","The child's task").option("--profile <name>","Parent profile","sam").option("--tools <names>","Comma-separated tool allowlist; omit to inherit the parent. Cannot add tools the parent does not have").option("--parent <id>","Spawn under this sub-agent instead of the profile").option("--chat <id>","Chat that receives the result").option("--rounds <n>","Round budget to carve, 1 to 6","2").option("--calls <n>","Tool-call budget to carve, 1 to 16","4").action(async(o:{prompt:string;profile:string;tools?:string;parent?:string;chat?:string;rounds:string;calls:string})=>{
  const tools=o.tools?o.tools.split(",").map(s=>s.trim()).filter(Boolean):undefined;
  output(await spawnSubagent(program.opts().workspace,{profile:o.profile,prompt:o.prompt,tools,parentId:o.parent??null,chatId:o.chat??null,rounds:Number(o.rounds),maxCalls:Number(o.calls)}));
});
subagentCmd.command("list").option("--profile <name>","Only this profile").action((o:{profile?:string})=>output(listSubagents(program.opts().workspace,o.profile)));
subagentCmd.command("status").argument("<id>").action((id:string)=>{const found=getSubagent(program.opts().workspace,id);if(!found)throw new Error("Unknown sub-agent: "+id);output(found);});
subagentCmd.command("cancel").argument("<id>").action((id:string)=>output(cancelSubagent(program.opts().workspace,id)));

const operative=program.command("operative").description("Operative capability registry (declarations, never credentials)");
operative.command("register").argument("<name>").argument("<adapter>").argument("<capabilities>").option("--max <n>","Max concurrent assignments").action((name:string,adapter:string,capabilities:string,options:{max?:string})=>{
  const reg=new OperativeRegistry(dbPath());
  try{ output(reg.register({name,adapter,capabilities:capabilities.split(",").map(x=>x.trim()).filter(Boolean),maxConcurrency:options.max?Number(options.max):undefined})); }
  finally{reg.close();}
});
operative.command("list").action(()=>{
  const reg=new OperativeRegistry(dbPath()); try{output(reg.list());}finally{reg.close();}
});
operative.command("status").description("Each operative with its liveness (fresh, stale, or offline). A stale declaration cannot receive new work").action(()=>{
  const reg=new OperativeRegistry(dbPath());
  try{output(reg.list().map(o=>({...o,liveness:operativeLiveness(o)})));}finally{reg.close();}
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

const delegateCmd=program.command("delegate").description("Delegate a repo coding job to a Codex CLI or Claude Code operative. This creates an approval card (adapter, repo, branch, prompt) and runs nothing until the owner approves. The operative works in a worktree on its own branch, never main, and does not push or open a pull request");
delegateCmd.argument("[adapter]").option("--repo <path>","Git repository to work in").option("--branch <name>","Branch for the worktree (never main or master)").option("--prompt <text>","The job, shown on the approval card").option("--chat <id>","Chat that receives the branch, diff stat, and test result").option("--timeout <ms>","Process budget in milliseconds, 1000 to 600000","120000").option("--actor <name>","Acting profile","sam").action((adapter:string|undefined,o:{repo?:string;branch?:string;prompt?:string;chat?:string;timeout:string;actor:string})=>{
  if(!adapter||!o.repo||!o.branch||!o.prompt)throw new Error("Usage: sam delegate <codex|claude-code> --repo <path> --branch <name> --prompt <text>");
  const root=program.opts().workspace as string;
  const timeoutMs=Number(o.timeout);
  const job=proposeDelegation(root,{actor:o.actor,adapter,repo:o.repo,branch:o.branch,prompt:o.prompt,timeoutMs,chatId:o.chat??null},(detail,title)=>proposeAction(root,{actor:o.actor,kind:"delegate",title,detail,chatId:o.chat??null}));
  output({status:"pending_owner_approval",delegation:job.id,action:job.actionId,adapter:job.adapter,repo:job.repo,branch:job.branch,prompt:job.prompt,auth:job.auth,note:"Nothing runs until the owner approves this card."});
});
delegateCmd.command("status").argument("[id]").description("One delegation, or every delegation when no id is given").action((id?:string)=>{
  const root=program.opts().workspace as string;
  if(!id){output(listDelegations(root));return;}
  const job=getDelegation(root,id);if(!job)throw new Error("Unknown delegation: "+id);output(job);
});
delegateCmd.command("cancel").argument("<id>").description("Cancel a pending card or kill a running operative. Nothing is pushed").action(async(id:string)=>{
  const root=program.opts().workspace as string;
  const current=getDelegation(root,id);if(!current)throw new Error("Unknown delegation: "+id);
  if(current.status==="pending"&&current.actionId){try{await decideAction(root,current.actionId,false);}catch{/* the card may already have been decided */}}
  output(cancelDelegation(root,current.id));
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


const config=program.command("config").description("Configuration: bare `sam config` opens the guided wizard in a terminal (sections over the model-routing, channels, and key stores); show/detect/sections/verify/setup are the scriptable doors (never prints secret values)");
// The wizard under the banner: the S.A.M. splash first (the spin-up is a
// welcome screen, Dip 2026-11-10), then the sectioned flow on readline.
async function runWizardCli(root:string,section?:string):Promise<void>{
  process.stdout.write(samBanner({profile:"sam",model:process.env.SAM_MODEL,workspace:root,color:!!process.stdout.isTTY,cols:process.stdout.columns??0}));
  const rl=createInterface({input:stdin,output:stdout});
  try{ await runConfigWizard(root,{print:(line:string)=>console.log(line),ask:(q:string)=>rl.question(q)},{section}); }
  finally{ rl.close(); }
}
function printSections(root:string,section?:string):void{
  const all=configSections(root);
  const picked=section?all.filter(s=>s.id===section):all;
  if(section&&!picked.length)throw new Error("Unknown config section \""+section+"\". Sections: "+CONFIG_SECTIONS.join(", "));
  if(program.opts().json){output({sections:picked,setup:readSetupRecord(root)});return;}
  for(const s of picked){console.log("== "+s.title+" ("+s.state+") ==");for(const line of s.lines)console.log("  "+line);}
  const rec=readSetupRecord(root);
  console.log(rec?("Verified setup: "+rec.model+" via "+rec.provider+" at "+rec.verifiedAt):"Verified setup: none recorded yet - `sam config setup --live` verifies and records it.");
}
config.action(async()=>{
  const root=resolve(program.opts().workspace);
  if(program.opts().json){output({detection:detectSetup(root),sections:configSections(root),setup:readSetupRecord(root)});return;}
  if(process.stdout.isTTY){await runWizardCli(root);return;}
  printSections(root);
});
config.command("show").description("Show the parsed configuration with secrets reduced to present/absent").action(()=>{
  const cfg=parseSamConfig(process.env); const ready=configReadiness(cfg);
  output({
    modelProvider:cfg.modelProvider, model:cfg.model, cheapModel:cfg.cheapModel, deepModel:cfg.deepModel, models:modelRoutingTable(), minimaxBaseUrl:cfg.minimaxBaseUrl,
    minimaxApiKey:cfg.minimaxApiKey?"present":"absent",
    secondShiftMcpUrl:cfg.secondShiftMcpUrl, secondShiftMcpToken:cfg.secondShiftMcpToken?"present":"absent",
    logLevel:cfg.logLevel, modelReady:ready.modelReady, mcpReady:ready.mcpReady, setup:readSetupRecord(resolve(program.opts().workspace))
  });
});
config.command("detect").description("First-run detection: what this install already has (model + key in env, channel and connector credentials, the coding engine, the senses reader) and the exact next steps for what is missing; values are never printed").action(()=>output(detectSetup(resolve(program.opts().workspace))));
config.command("sections").description("The wizard's sections as data: model, channels, keys, engine & senses - each with its state and lines").option("--section <name>","Only this section").action((o:{section?:string})=>printSections(resolve(program.opts().workspace),o.section));
config.command("verify").description("Verify the configured model with ONE real completion through the existing provider; saves nothing").requiredOption("--live","Explicitly allow one model API request (may incur charges)").action(async()=>{const v=await verifyModel();output(v);if(!v.ok)process.exitCode=1;});
config.command("setup").description("First-run detect -> verify -> save: one real completion, and only on success the verified baseline is recorded (.sam/setup.db + a setup-verified ledger line); a failure saves nothing").requiredOption("--live","Explicitly allow one model API request (may incur charges)").action(async()=>{const root=resolve(program.opts().workspace);const{verify,saved}=await verifyAndSaveSetup(root);output({detection:detectSetup(root),verify,saved});if(!saved)process.exitCode=1;});
config.command("wizard").description("The interactive config wizard under the banner: model pins, channel adds, key states, engine status - saves ride the stores the runtime reads").option("--section <name>","Jump straight to one section").action(async(o:{section?:string})=>{await runWizardCli(resolve(program.opts().workspace),o.section);});

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
