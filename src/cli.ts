#!/usr/bin/env node
import { Command } from "commander";
import { homedir } from "node:os";
import { join,resolve } from "node:path";
import { mkdirSync } from "node:fs";
import { MissionStore } from "./storage.js";
import { missionStatuses, type MissionStatus } from "./kernel.js";

const program=new Command();
program.name("sam").description("S.A.M. | Secret Agent Man mission commander").version("0.1.0");
program.option("--workspace <path>","Workspace directory",process.cwd()).option("--json","JSON output");
function store():MissionStore {
  const path=resolve(program.opts().workspace);
  return new MissionStore(join(path,".sam","missions.db"));
}
function output(data:unknown):void { console.log(program.opts().json?JSON.stringify(data,null,2):typeof data==="string"?data:JSON.stringify(data,null,2)); }
program.command("init").description("Initialize local mission workspace").action(()=>{
  const dir=join(resolve(program.opts().workspace),".sam");mkdirSync(dir,{recursive:true});
  const db=store();db.close();output("SAM initialized at "+dir);
});
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
program.command("doctor").description("Check local runtime prerequisites").action(()=>{
  output({node:process.version,platform:process.platform,workspace:resolve(program.opts().workspace),status:"CLI ready; daemon and agent execution not implemented"});
});
program.command("status").action(()=>{const db=store();try{output({missions:db.list().length,daemon:"not implemented"});}finally{db.close();}});
program.parseAsync().catch((err:unknown)=>{console.error("SAM error:",err instanceof Error?err.message:String(err));process.exitCode=1;});
