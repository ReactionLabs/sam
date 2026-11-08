import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { connect } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { requestDaemon, socketPath } from "./daemon.js";

function sendRaw(workspace:string, payload:string):Promise<string> {
  return new Promise((resolve,reject)=>{
    const socket=connect(socketPath(workspace));
    let response="";
    socket.setTimeout(1500,()=>socket.destroy(new Error("Timed out")));
    socket.on("error",reject);
    socket.on("connect",()=>socket.end(payload));
    socket.on("data",chunk=>{response+=chunk.toString("utf8");});
    socket.on("end",()=>resolve(response));
  });
}


test("daemon serves status and stops over workspace-local socket",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"sam-daemon-"));
  const child=spawn(process.execPath,[join(import.meta.dirname,"cli.js"),"--workspace",dir,"daemon","serve"],{stdio:"ignore"});
  try{
    let reply;
    for(let i=0;i<80;i++){
      if(child.exitCode!==null)throw new Error("Daemon exited before ready");
      try{reply=await requestDaemon(dir,"ping",200);break;}catch{await delay(50);}
    }
    assert.equal(reply?.ok,true,"Daemon did not start");
    assert.equal(reply?.pid,child.pid);
    const duplicate=spawn(process.execPath,[join(import.meta.dirname,"cli.js"),"--workspace",dir,"daemon","serve"],{stdio:"ignore"});
    try{
      const exit=await Promise.race([new Promise<number|null>(r=>duplicate.once("exit",r)),delay(3000).then(()=>null)]);
      assert.equal(exit,1,"Second daemon must not steal live socket");
    }finally{duplicate.kill();}
    assert.equal((await requestDaemon(dir,"ping")).instance,reply?.instance);
    // Malformed or unknown commands must not stop the live daemon.
    const malformed=JSON.parse((await sendRaw(dir,"not-json\\n")).trim());
    assert.deepEqual(malformed,{ok:false,error:"Invalid request"});
    const unsupported=JSON.parse((await sendRaw(dir,JSON.stringify({command:"restart"})+"\\n")).trim());
    assert.deepEqual(unsupported,{ok:false,error:"Unsupported command"});
    assert.equal((await requestDaemon(dir,"ping")).instance,reply?.instance);
    assert.equal((await requestDaemon(dir,"stop")).ok,true);
    const exit=await Promise.race([new Promise<number|null>(r=>child.once("exit",r)),delay(3000).then(()=>null)]);
    assert.equal(exit,0);
  }finally{
    child.kill();
    rmSync(dir,{recursive:true,force:true});
  }
});
