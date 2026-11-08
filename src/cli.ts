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
import { proposeModelEdit } from "./model-edit.js";
import { discoverSkills, findSkill, searchSkills } from "./skills.js";
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
edits.command("reject").argument("<id>").description("Discard proposal without modifying target")
  .action((id:string)=>output(rejectEdit(program.opts().workspace,id)));
edits.command("apply").requiredOption("--id <uuid>","Proposal ID")
  .requiredOption("--confirm <sha256>","Exact digest printed by edit propose")
  .action((options:{id:string;confirm:string})=>output(applyEdit(program.opts().workspace,options.id,options.confirm)));
const skills=program.command("skills").description("Read-only discovery of project-local SKILL.md files; never executes skill content");
skills.command("list").description("List validated local skill metadata").action(()=>output(discoverSkills(program.opts().workspace)));
skills.command("find").argument("<query>").description("Search installed skill metadata").action((query:string)=>output(searchSkills(program.opts().workspace,query)));
skills.command("show").argument("<name>").description("Show skill metadata (not executable instructions)").action((name:string)=>output(findSkill(program.opts().workspace,name)));
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
  .option("--workspace-tools","Allow read-only model tools within the selected workspace (includes memory search)")
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
