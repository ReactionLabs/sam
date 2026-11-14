import Database from "better-sqlite3";
import { openDatabase } from "./sqlite.js";
import { randomUUID, createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { findSuppressionHitInDb, suppressionProfilesForScope, MemorySuppressedError } from "./capture-guard.js";

export type MemoryKind = "observation" | "decision" | "failure" | "procedure";
export interface MemoryRecord {
  id:string; mission_id:string|null; kind:MemoryKind; content:string;
  source:string; source_hash:string; created_at:string; archived_at:string|null;
  scope:string;
}
// Memory levels: "core" is the operator SAM's own memory. "profile:<name>" is
// one profile's private memory, invisible to every other profile. "link:<id>"
// is a link group's shared memory, visible to exactly that group's members.
// Isolation is the default; sharing exists only where a link was made.
export function isMemoryScope(value:string):boolean{
  return value==="core"||/^profile:[a-z][a-z0-9._-]{0,63}$/.test(value)||/^link:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
// The hot-memory budget (Program H, filed requirement 1): hot
// memory is an INDEX, not an archive - what matters now, in
// ~3,000 words, with the full text living in cold storage (files,
// the chat record) behind a pointer. The budget binds at WRITE
// time in add() below: a single record larger than the entire
// hot budget can never be an index entry, whatever door wrote
// it, so it is refused with a named error instead of quietly
// becoming the thing every future recall has to carry. The
// per-tier prompt caps (law, recall, summary) already bound
// what one turn injects; this bounds what one write can add
// to the store those tiers draw from.
export const MEMORY_RECORD_MAX_WORDS=3000;
export function countWords(text:string):number{
  const trimmed=text.trim();
  return trimmed?trimmed.split(/\s+/).length:0;
}
export class MemoryStore {
  private db:Database.Database;
  private path:string;
  constructor(path:string) {
    this.path=path;
    mkdirSync(dirname(path),{recursive:true});
    this.db=openDatabase(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory_records (
        id TEXT PRIMARY KEY, mission_id TEXT, kind TEXT NOT NULL,
        content TEXT NOT NULL, source TEXT NOT NULL, source_hash TEXT NOT NULL,
        created_at TEXT NOT NULL, archived_at TEXT
      );
      CREATE INDEX IF NOT EXISTS memory_mission_idx ON memory_records(mission_id,created_at);
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_search USING fts5(content, source, content='memory_records', content_rowid='rowid');
      CREATE TRIGGER IF NOT EXISTS memory_insert AFTER INSERT ON memory_records BEGIN
        INSERT INTO memory_search(rowid,content,source) VALUES(new.rowid,new.content,new.source);
      END;
      CREATE TRIGGER IF NOT EXISTS memory_delete AFTER DELETE ON memory_records BEGIN
        INSERT INTO memory_search(memory_search,rowid,content,source) VALUES('delete',old.rowid,old.content,old.source);
      END;
      CREATE TRIGGER IF NOT EXISTS memory_update AFTER UPDATE ON memory_records BEGIN
        INSERT INTO memory_search(memory_search,rowid,content,source) VALUES('delete',old.rowid,old.content,old.source);
        INSERT INTO memory_search(rowid,content,source) VALUES(new.rowid,new.content,new.source);
      END;
    `);
    const columns=this.db.pragma("table_info(memory_records)") as Array<{name:string}>;
    if(!columns.some(c=>c.name==="scope")){
      this.db.exec("ALTER TABLE memory_records ADD COLUMN scope TEXT NOT NULL DEFAULT 'core'");
    }
    this.db.exec("CREATE INDEX IF NOT EXISTS memory_scope_idx ON memory_records(scope,created_at)");
  }
  add(input:{missionId?:string;kind:MemoryKind;content:string;source:string;scope?:string}):MemoryRecord {
    if(!["observation","decision","failure","procedure"].includes(input.kind))throw new Error("Invalid memory kind. Choose observation, decision, failure, or procedure.");
    if(!input.content.trim() || !input.source.trim())throw new Error("Memory requires content and provenance");
    if(input.content.length>100_000)throw new Error("Memory exceeds size limit");
    const words=countWords(input.content);
    if(words>MEMORY_RECORD_MAX_WORDS)throw new Error("Memory record exceeds the hot-memory budget: "+words+" words against the "+MEMORY_RECORD_MAX_WORDS+"-word cap. Memory is an index, not an archive - store the full text as a file and note the pointer instead.");
    const scope=input.scope??"core";
    if(!isMemoryScope(scope))throw new Error("Invalid memory scope");
    // The capture-guard backstop (Program H item A): a standing
    // do-not-store instruction binds at the store itself, so
    // every writer - episode flush, compaction flush, saved
    // notes, approved actions, the operator CLI, and any future
    // door - is held by it. preferences.db lives beside
    // missions.db in .sam; the guard's own module owns the
    // matching. Automatic paths catch MemorySuppressedError,
    // ledger one memory-suppressed line, and degrade; explicit
    // doors let it surface.
    const suppressionHit=findSuppressionHitInDb(join(dirname(this.path),"preferences.db"),suppressionProfilesForScope(scope),input.content);
    if(suppressionHit)throw new MemorySuppressedError(suppressionHit);
    const record:MemoryRecord={
      id:randomUUID(),mission_id:input.missionId??null,kind:input.kind,
      content:input.content,source:input.source,
      source_hash:createHash("sha256").update(input.source+"\n"+input.content).digest("hex"),
      created_at:new Date().toISOString(),archived_at:null,scope
    };
    this.db.prepare(`INSERT INTO memory_records
      (id,mission_id,kind,content,source,source_hash,created_at,archived_at,scope)
      VALUES (@id,@mission_id,@kind,@content,@source,@source_hash,@created_at,@archived_at,@scope)`).run(record);
    return record;
  }
  list(missionId?:string,scopes?:string[]):MemoryRecord[] {
    const scopeSql=scopes&&scopes.length?" AND scope IN ("+scopes.map(()=>"?").join(",")+")":"";
    const scopeArgs=scopes&&scopes.length?scopes:[];
    return (missionId
      ?this.db.prepare("SELECT * FROM memory_records WHERE archived_at IS NULL AND mission_id=?"+scopeSql+" ORDER BY created_at DESC").all(missionId,...scopeArgs)
      :this.db.prepare("SELECT * FROM memory_records WHERE archived_at IS NULL"+scopeSql+" ORDER BY created_at DESC").all(...scopeArgs)) as MemoryRecord[];
  }
  search(query:string,limit=20,scopes?:string[]):MemoryRecord[] {
    if(!query.trim())return [];
    if(!Number.isInteger(limit)||limit<1||limit>100)throw new Error("Invalid result limit");
    const scopeSql=scopes&&scopes.length?" AND m.scope IN ("+scopes.map(()=>"?").join(",")+")":"";
    // FTS5 parameter binding prevents query text becoming SQL.
    return this.db.prepare(`SELECT m.* FROM memory_search s
      JOIN memory_records m ON m.rowid=s.rowid
      WHERE memory_search MATCH ? AND m.archived_at IS NULL${scopeSql}
      ORDER BY bm25(memory_search),m.created_at DESC LIMIT ?`).all(query,...(scopes&&scopes.length?scopes:[]),limit) as MemoryRecord[];
  }
  get(id:string):MemoryRecord|null {
    // Includes archived records: patch/supersession validation needs to
    // distinguish "no such record" from "already retired".
    const row=this.db.prepare("SELECT * FROM memory_records WHERE id=?").get(id) as MemoryRecord|undefined;
    return row??null;
  }
  archive(id:string):boolean {
    return this.db.prepare("UPDATE memory_records SET archived_at=? WHERE id=? AND archived_at IS NULL")
      .run(new Date().toISOString(),id).changes===1;
  }
  close():void {this.db.close();}
}
