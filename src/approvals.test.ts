import test from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "./sqlite.js";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {MissionStore} from "./storage.js";
import {ApprovalStore,actionDigest} from "./approvals.js";

test("approval is scoped, action-bound, expiring, one-shot and requires running mission",()=>{
  const dir=mkdtempSync(join(tmpdir(),"sam-approval-"));
  try {
    const path=join(dir,"mission.db"), missions=new MissionStore(path), db=openDatabase(path), approvals=new ApprovalStore(db);
    const mission=missions.create("Safe test"),other=missions.create("Other");
    const action={tool:"github.create_pr",args:{title:"Test",branch:"feature"}};
    const request=approvals.request(mission.id,"EXTERNAL_WRITE",action,1000,500);
    assert.equal(approvals.decide(request.id,"owner",true,1100),true);
    assert.equal(approvals.decide(request.id,"owner",true,1101),false);
    assert.equal(approvals.consume(request.id,mission.id,"EXTERNAL_WRITE",action,1200),false);
    missions.transition(mission.code,"PLANNING");
    missions.transition(mission.code,"READY");
    missions.transition(mission.code,"RUNNING");
    assert.equal(approvals.consume(request.id,other.id,"EXTERNAL_WRITE",action,1200),false);
    assert.equal(approvals.consume(request.id,mission.id,"PRODUCTION",action,1200),false);
    assert.equal(approvals.consume(request.id,mission.id,"EXTERNAL_WRITE",{...action,args:{title:"Changed"}},1200),false);
    assert.equal(approvals.consume(request.id,mission.id,"EXTERNAL_WRITE",action,1500),false);
    assert.equal(approvals.consume(request.id,mission.id,"EXTERNAL_WRITE",action,1300),true);
    assert.equal(approvals.consume(request.id,mission.id,"EXTERNAL_WRITE",action,1301),false);
    assert.equal(approvals.get(request.id)?.status,"CONSUMED");
    db.close();missions.close();
  }finally{rmSync(dir,{recursive:true,force:true});}
});
test("canonical digest independent of key order, denied requests cannot authorize",()=>{
  const dir=mkdtempSync(join(tmpdir(),"sam-approval-"));
  try{
    assert.equal(actionDigest({b:2,a:{z:3,y:1}}),actionDigest({a:{y:1,z:3},b:2}));
    const path=join(dir,"mission.db"),missions=new MissionStore(path),db=openDatabase(path),approvals=new ApprovalStore(db);
    const mission=missions.create("test");
    const req=approvals.request(mission.id,"DESTRUCTIVE",{path:"/tmp/example"},100,100);
    assert.equal(approvals.decide(req.id,"owner",false,101),true);
    assert.equal(approvals.decide(req.id,"owner",true,102),false);
    assert.throws(()=>approvals.request(mission.id,"LOCAL_WRITE",{x:1},100,0),/lifetime/);
    db.close();missions.close();
  }finally{rmSync(dir,{recursive:true,force:true});}
});
