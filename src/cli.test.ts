import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

test("CLI creates mission and dependency-aware tasks across processes",()=>{
  const workspace=mkdtempSync(join(tmpdir(),"sam-cli-"));
  const cli=fileURLToPath(new URL("./cli.js",import.meta.url));
  const run=(...args:string[])=>{
    const result=spawnSync(process.execPath,[cli,"--workspace",workspace,"--json",...args],{encoding:"utf8"});
    assert.equal(result.status,0,result.stderr);
    return JSON.parse(result.stdout);
  };
  try {
    run("init");
    const mission=run("mission","create","Ship a safe feature");
    const first=run("task","add",mission.code,"Inspect repository");
    const second=run("task","add",mission.code,"Implement change","--after",first.id);
    const tasks=run("task","list",mission.code);
    assert.equal(tasks.length,2);
    assert.equal(tasks[0].id,first.id);
    assert.equal(tasks[1].id,second.id);
    const invalid=spawnSync(process.execPath,[cli,"--workspace",workspace,"task","add",mission.code,"Invalid","--after","not-a-task"],{encoding:"utf8"});
    assert.notEqual(invalid.status,0);
  } finally { rmSync(workspace,{recursive:true,force:true}); }
});

test("CLI runs one offline task and retrieves durable verified evidence",()=>{
  const workspace=mkdtempSync(join(tmpdir(),"sam-cli-offline-"));
  const cli=fileURLToPath(new URL("./cli.js",import.meta.url));
  const run=(...args:string[])=>{
    const r=spawnSync(process.execPath,[cli,"--workspace",workspace,"--json",...args],{encoding:"utf8"});
    assert.equal(r.status,0,r.stderr);
    return JSON.parse(r.stdout);
  };
  try {
    run("init");
    const m=run("mission","create","offline mission");
    const t=run("task","add",m.code,"test output");
    run("mission","transition",m.code,"PLANNING");
    run("mission","transition",m.code,"READY");
    run("mission","transition",m.code,"RUNNING");
    const result=run("task","run-offline",m.code);
    assert.equal(result.task_id,t.id);
    assert.equal(result.output,"test output");
    assert.equal(result.output_sha256.length,64);
    assert.deepEqual(run("task","result",t.id),result);
    assert.equal(run("task","list",m.code)[0].status,"SUCCEEDED");
    assert.equal(run("task","run-offline",m.code).status,"NO_ELIGIBLE_TASK");
  } finally {rmSync(workspace,{recursive:true,force:true});}
});
