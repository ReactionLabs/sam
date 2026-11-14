import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { recordVerification } from "./verification.js";
import { recordActivity } from "./activity.js";
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync, unlinkSync, openSync, closeSync } from "node:fs";
import { join, resolve } from "node:path";

export type TestKind="build"|"test";
type Request={version:1;id:string;kind:TestKind;workspace:string;digest:string;createdAt:number};
const sha=(s:string)=>createHash("sha256").update(s).digest("hex");
const validId=(id:string)=>/^[0-9a-f]{8}-[0-9a-f-]{27}$/.test(id);
function safeRoot(root:string) {
  const resolved=realpathSync(resolve(root));
  if(!lstatSync(resolved).isDirectory())throw new Error("Workspace is not a directory");
  const sam=join(resolved,".sam");
  mkdirSync(sam,{recursive:true,mode:0o700});
  if(lstatSync(sam).isSymbolicLink())throw new Error("Unsafe SAM state directory");
  return {resolved,sam};
}
function requestPath(sam:string,id:string){if(!validId(id))throw new Error("Invalid run ID");return join(sam,"run-"+id+".json");}
function actionDigest(kind:TestKind,workspace:string){return sha(JSON.stringify(["sam-approved-run-v1",kind,workspace]));}
function auditPath(root:string){return join(resolve(root),".sam","execution-audit.jsonl");}
// The execution-audit ledger follows the house contract, split
// by what the append records (gap found 2026-11-13, hourly run
// 23:04). APPENDING never breaks the work it records and never
// fails silently: every audit event already happened in the
// world when its append runs - the request file is written,
// the one-use authorization is already consumed (the "started"
// append runs after the claim unlink, so a bare throw there
// spent the owner's tap on a bookkeeping failure and the
// approved run never executed), the run already finished (a
// bare throw there discarded its result AND left the
// verification gate unsettled, so verified work read
// unverified). A dead append therefore ledgers one
// execution-audit-failed line and returns whether the record
// landed, instead of throwing. READING is the opposite call
// (the family fail-closed precedent): status folds this
// ledger's tail as the audit history, so a dead read ledgers
// one line and rethrows exactly instead of presenting an
// empty history as truth; an absent ledger still reads [].
export function executionAuditFailureSummary(phase:"read"|"append",eventLabel:string,reason:string):string{
  const clean=String(reason??"").replace(/\s+/g," ").trim()||"unknown error";
  return ("Execution audit "+phase+" failed for "+eventLabel+": "+clean).slice(0,200);
}
export function recordExecutionAuditFailure(root:string,phase:"read"|"append",eventLabel:string,error:unknown):void{
  const reason=error instanceof Error?error.message:String(error);
  recordActivity(root,"sam","execution-audit-failed",executionAuditFailureSummary(phase,eventLabel,reason));
}
function auditEventLabel(entry:Record<string,unknown>):string{
  const event=typeof entry.event==="string"?entry.event:"event";
  const kind=typeof entry.kind==="string"?" "+entry.kind:"";
  const run=typeof entry.id==="string"?" (run "+entry.id.slice(0,8)+")":"";
  return event+kind+run;
}
function audit(root:string,entry:Record<string,unknown>):boolean{
  try{
    appendFileSync(auditPath(root),JSON.stringify({at:new Date().toISOString(),...entry})+"\n",{encoding:"utf8",flag:"a"});
    return true;
  }catch(error){
    recordExecutionAuditFailure(root,"append",auditEventLabel(entry),error);
    return false;
  }
}
/** The status payload's audit tail: the last lines of the
 *  execution-audit ledger, presentation byte-unchanged from
 *  the inline read it replaces. A failed filesystem touch
 *  ledgers one execution-audit-failed:read line and rethrows
 *  exactly (see above); an absent ledger reads []. */
export function recentExecutionAuditLogs(root:string):string[]{
  const audit=auditPath(root);
  let raw:string|null;
  try{
    raw=existsSync(audit)?readFileSync(audit,"utf8"):null;
  }catch(error){
    recordExecutionAuditFailure(root,"read","ledger",error);
    throw error;
  }
  if(raw===null)return [];
  return raw.slice(-16000).split("\n").filter(Boolean).slice(-20).map(line=>line.slice(0,800));
}
export function requestTestRun(root:string,kind:string){
  if(kind!=="build" && kind!=="test")throw new Error("Only build and test are allowed");
  const {resolved,sam}=safeRoot(root);
  const id=randomUUID(),digest=actionDigest(kind,resolved);
  const request:Request={version:1,id,kind,workspace:resolved,digest,createdAt:Date.now()};
  const fd=openSync(requestPath(sam,id),"wx",0o600);
  try{writeFileSync(fd,JSON.stringify(request));}finally{closeSync(fd);}
  audit(resolved,{event:"requested",id,kind,digest});
  return {id,kind,digest,warning:"Runs trusted project code. No OS sandbox. Review project scripts and dependencies before approval."};
}
function executable(root:string,kind:TestKind):string[]{
  if(kind==="build"){
    const compiler=join(root,"node_modules","typescript","bin","tsc");
    if(!existsSync(compiler)||lstatSync(compiler).isSymbolicLink()||!lstatSync(compiler).isFile())throw new Error("Local TypeScript compiler missing or unsafe");
    return [compiler,"-p","tsconfig.json"];
  }
  const dir=join(root,"dist");
  if(!existsSync(dir)||lstatSync(dir).isSymbolicLink()||!lstatSync(dir).isDirectory())throw new Error("Build first: dist missing");
  const files=readdirSync(dir).filter(x=>x.endsWith(".test.js")).sort();
  if(!files.length||files.length>200)throw new Error("No bounded test set found");
  for(const file of files){const path=join(dir,file);const st=lstatSync(path);if(!st.isFile()||st.isSymbolicLink())throw new Error("Unsafe test file");}
  return ["--test",...files.map(x=>join(dir,x))];
}
export async function executeApprovedTestRun(root:string,id:string,confirmedDigest:string,timeoutMs=30_000){
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1000||timeoutMs>120_000)throw new Error("Timeout must be 1000 to 120000 milliseconds");
  const {resolved,sam}=safeRoot(root);
  const path=requestPath(sam,id);
  const st=lstatSync(path);
  if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1||st.size>2048)throw new Error("Unsafe run request");
  const request=JSON.parse(readFileSync(path,"utf8")) as Request;
  if(request.version!==1||request.id!==id||!["build","test"].includes(request.kind)||
    request.workspace!==resolved||request.digest!==confirmedDigest||
    request.digest!==actionDigest(request.kind,resolved))throw new Error("Run approval digest mismatch");
  if(Date.now()-request.createdAt>300_000||request.createdAt>Date.now())throw new Error("Run approval expired");
  const args=executable(resolved,request.kind);
  // Claim before starting, including if spawn fails. Replays are never authorized.
  unlinkSync(path);
  audit(resolved,{event:"started",id,kind:request.kind,digest:request.digest});
  const start=Date.now();
  const result=await new Promise<{exitCode:number|null;signal:string|null;timedOut:boolean;output:string;truncated:boolean;error?:string}>(done=>{
    let output="",truncated=false,timedOut=false,settled=false;
    // Do not propagate Node's test-worker marker to a new test runner.
    const env: NodeJS.ProcessEnv={...process.env,CI:"true"};
    delete env.NODE_TEST_CONTEXT;
    const child=spawn(process.execPath,args,{cwd:resolved,shell:false,windowsHide:true,stdio:["ignore","pipe","pipe"],env});
    const collect=(chunk:Buffer)=>{
      const str=chunk.toString("utf8");
      const remaining=16000-output.length;
      if(remaining>0)output+=str.slice(0,remaining);
      if(str.length>remaining)truncated=true;
    };
    child.stdout.on("data",collect);child.stderr.on("data",collect);
    const timer=setTimeout(()=>{timedOut=true;child.kill("SIGKILL");},timeoutMs);
    const finish=(value:{exitCode:number|null;signal:string|null;error?:string})=>{
      if(settled)return;settled=true;clearTimeout(timer);done({...value,timedOut,output,truncated});
    };
    child.on("error",error=>finish({exitCode:null,signal:null,error:error.message}));
    child.on("close",(code,signal)=>finish({exitCode:code,signal}));
  });
  audit(resolved,{event:"finished",id,kind:request.kind,exitCode:result.exitCode,timedOut:result.timedOut,truncated:result.truncated,durationMs:Date.now()-start,error:result.error??null});
  const passed=result.exitCode===0&&!result.timedOut;
  // Verify-on-stop: every approved run settles the verification
  // ledger, so an applied change can only become "verified" through
  // a fresh run recorded here, never through a text claim.
  recordVerification(root,{kind:request.kind,passed,runId:id});
  return {id,kind:request.kind,passed,durationMs:Date.now()-start,...result,
    warning:"Executed trusted project code without OS sandbox"};
}
