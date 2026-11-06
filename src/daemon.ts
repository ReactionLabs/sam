import { createServer, connect, type Server } from "node:net";
import { chmodSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

export function socketPath(workspace:string):string {
  return join(resolve(workspace),".sam","daemon.sock");
}
export type DaemonReply = {ok:boolean; pid?:number; instance?:string; uptime?:number; error?:string};
export function requestDaemon(workspace:string,command:"ping"|"stop",timeoutMs=1500):Promise<DaemonReply> {
  return new Promise((resolveReply,reject)=>{
    const socket=connect(socketPath(workspace));
    let buffer="",settled=false;
    const finish=(error?:Error,reply?:DaemonReply)=>{
      if(settled)return;settled=true;socket.destroy();
      if(error)reject(error);else resolveReply(reply!);
    };
    socket.setTimeout(timeoutMs,()=>finish(new Error("Daemon request timed out")));
    socket.on("error",(error)=>finish(error));
    socket.on("connect",()=>socket.write(JSON.stringify({command})+"\n"));
    socket.on("data",chunk=>{
      buffer+=chunk.toString("utf8");
      if(buffer.length>4096){finish(new Error("Daemon reply too large"));return;}
      const line=buffer.indexOf("\n");
      if(line!==-1){
        try{finish(undefined,JSON.parse(buffer.slice(0,line)) as DaemonReply);}
        catch{finish(new Error("Invalid daemon response"));}
      }
    });
    socket.on("end",()=>{if(!settled)finish(new Error("Daemon closed without response"));});
  });
}
export async function serveDaemon(workspace:string):Promise<void> {
  const path=socketPath(workspace);
  mkdirSync(join(resolve(workspace),".sam"),{recursive:true,mode:0o700});
  // Only remove a stale socket after a failed connection. Never unlink a live daemon.
  if(existsSync(path)){
    try{await requestDaemon(workspace,"ping");throw new Error("Daemon already running");}
    catch(error){
      if(error instanceof Error && error.message==="Daemon already running")throw error;
      if(!(error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code==="ECONNREFUSED"))
        throw new Error("Socket exists but daemon health cannot be verified; refusing to remove it");
      unlinkSync(path);
    }
  }
  const instance=randomUUID(),started=Date.now();
  let stopping=false;
  const server:Server=createServer(socket=>{
    socket.setEncoding("utf8");
    socket.setTimeout(2000,()=>socket.destroy());
    let input="";
    socket.on("data",(chunk:string)=>{
      input+=chunk;
      if(input.length>1024){socket.destroy();return;}
      const index=input.indexOf("\n");
      if(index<0)return;
      let command:string;
      try{command=(JSON.parse(input.slice(0,index)) as {command:string}).command;}
      catch{socket.end(JSON.stringify({ok:false,error:"Invalid request"})+"\n");return;}
      if(command==="ping"){
        socket.end(JSON.stringify({ok:true,pid:process.pid,instance,uptime:Date.now()-started})+"\n");
      }else if(command==="stop"){
        socket.end(JSON.stringify({ok:true,pid:process.pid})+"\n",()=>{if(!stopping){stopping=true;server.close();}});
      }else socket.end(JSON.stringify({ok:false,error:"Unsupported command"})+"\n");
    });
  });
  try{
    await new Promise<void>((res,rej)=>{
      server.once("error",rej);
      server.listen(path,()=>{server.off("error",rej);res();});
    });
    chmodSync(path,0o600);
    await new Promise<void>(res=>{
      const shutdown=()=>{if(!stopping){stopping=true;server.close();}};
      process.once("SIGINT",shutdown);
      process.once("SIGTERM",shutdown);
      server.once("close",res);
    });
  }finally{
    // The socket belongs to this instance only while no replacement exists.
    // A second daemon cannot bind until the first closes.
    try{unlinkSync(path);}catch(error){
      if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;
    }
  }
}
