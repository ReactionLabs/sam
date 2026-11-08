import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
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
function audit(sam:string,entry:Record<string,unknown>){
  appendFileSync(join(sam,"execution-audit.jsonl"),JSON.stringify({at:new Date().toISOString(),...entry})+"\n",{encoding:"utf8",flag:"a"});
}
export function requestTestRun(root:string,kind:string){
  if(kind!=="build" && kind!=="test")throw new Error("Only build and test are allowed");
  const {resolved,sam}=safeRoot(root);
  const id=randomUUID(),digest=actionDigest(kind,resolved);
  const request:Request={version:1,id,kind,workspace:resolved,digest,createdAt:Date.now()};
  const fd=openSync(requestPath(sam,id),"wx",0o600);
  try{writeFileSync(fd,JSON.stringify(request));}finally{closeSync(fd);}
  audit(sam,{event:"requested",id,kind,digest});
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
  audit(sam,{event:"started",id,kind:request.kind,digest:request.digest});
  const start=Date.now();
  const result=await new Promise<{exitCode:number|null;signal:string|null;timedOut:boolean;output:string;truncated:boolean;error?:string}>(done=>{
    let output="",truncated=false,timedOut=false,settled=false;
    // Node marks test workers with NODE_TEST_CONTEXT. Never propagate that marker\n    // to a new top-level test runner or it may skip every test and exit 0.\n    const env={...process.env,CI:"true"};\n    delete env.NODE_TEST_CONTEXT;\n    const child=spawn(process.execPath,args,{cwd:resolved,shell:false,windowsHide:true,stdio:["ignore","pipe","pipe"],env});
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
  audit(sam,{event:"finished",id,kind:request.kind,exitCode:result.exitCode,timedOut:result.timedOut,truncated:result.truncated,durationMs:Date.now()-start,error:result.error??null});
  return {id,kind:request.kind,passed:result.exitCode===0&&!result.timedOut,durationMs:Date.now()-start,...result,
    warning:"Executed trusted project code without OS sandbox"};
}
