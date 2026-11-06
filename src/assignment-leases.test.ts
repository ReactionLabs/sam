import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {OperativeRegistry} from "./operatives.js";
import {AssignmentLeases} from "./assignment-leases.js";

test("durable capacity, exclusive task claim and stale lease fencing",()=>{
 const dir=mkdtempSync(join(tmpdir(),"sam-assignment-"));
 try{
  const path=join(dir,"db.sqlite"), registry=new OperativeRegistry(path);
  const a=registry.register({name:"mita",adapter:"local",capabilities:["code"]});
  const b=registry.register({name:"eugene",adapter:"local",capabilities:["code"]});
  registry.setState(a.id,"available");registry.setState(b.id,"available");
  const leases=new AssignmentLeases(path), now=Date.now();
  const first=leases.claim(a.id,"task-1",now,100);
  assert.ok(first);
  assert.equal(leases.claim(a.id,"task-2",now,100),undefined);
  assert.equal(leases.claim(b.id,"task-1",now,100),undefined);
  leases.close();
  const restarted=new AssignmentLeases(path);
  assert.equal(restarted.active(a.id,now).length,1);
  const retry=restarted.claim(b.id,"task-1",now+100,100);
  assert.ok(retry);
  assert.equal(retry.generation,2);
  assert.equal(restarted.finish(first.id,a.id,first.generation,now+101),false);
  assert.equal(restarted.renew(first.id,a.id,first.generation,now+101),false);
  assert.equal(restarted.finish(retry.id,b.id,retry.generation,now+150),true);
  assert.equal(restarted.finish(retry.id,b.id,retry.generation,now+151),false);
  assert.ok(restarted.claim(a.id,"task-2",now+151,100));
  restarted.close();registry.close();
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test("paused operatives cannot renew",()=>{
 const dir=mkdtempSync(join(tmpdir(),"sam-assignment-"));
 try{
  const path=join(dir,"db.sqlite"),registry=new OperativeRegistry(path);
  const a=registry.register({name:"mita",adapter:"local",capabilities:["code"]});
  registry.setState(a.id,"available");
  const leases=new AssignmentLeases(path),now=Date.now();
  const lease=leases.claim(a.id,"task-1",now,1000);
  assert.ok(lease);
  registry.setState(a.id,"paused");
  assert.equal(leases.renew(lease.id,a.id,lease.generation,now+1),false);
  leases.close();registry.close();
 }finally{rmSync(dir,{recursive:true,force:true});}
});
