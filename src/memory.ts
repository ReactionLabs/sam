import Database from "better-sqlite3";
import { openDatabase } from "./sqlite.js";
import { randomUUID, createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { recordActivity } from "./activity.js";
import { findSuppressionHitInDb, suppressionProfilesForScope, MemorySuppressedError, isCaptureGuardLedgered } from "./capture-guard.js";
import { errorReason } from "./error-reason.js";

export type MemoryKind = "observation" | "decision" | "failure" | "procedure";
export const MEMORY_KINDS: readonly MemoryKind[] = ["observation", "decision", "failure", "procedure"];

function foldMemoryKindName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/** The ONE source for why a memory kind name cannot be
 *  used: the name is not one of the four kinds in this
 *  module's MEMORY_KINDS registry, so the record would be
 *  stored under a kind no reading surface classifies. An
 *  exact kind reads no blocker. Anything else is refused
 *  with the four kinds named as the registry and, when
 *  exactly one kind matches the bad name folded for case
 *  and separators ("Observation" -> "observation";
 *  "pro-cedure", "pro cedure" -> "procedure"), that kind
 *  named as the correction. MemoryStore.add throws this
 *  text - the seam every writer rides (the CLI
 *  `memory add` door, episode and compaction flushes,
 *  approved note actions) - and saveNote in notes.ts
 *  throws it before its tier classification, because a
 *  hard-tier note routes to the approval gate without
 *  touching the store, so the note door (the CLI
 *  `notes save --kind` door and the chat sam_save_note
 *  tool) needs the check at its own seam in the same
 *  words. The two improvised texts this replaces
 *  ("Invalid memory kind. Choose ..." at the store,
 *  "Invalid note kind. Choose ..." at the note door)
 *  refused the same registry in two wordings depending on
 *  the door taken. The "Invalid memory kind" prefix is
 *  kept: its readers match on it (MEMORY_STORE_VALIDATION
 *  below, the memory failure tests). Stored-kind readers
 *  stay permissive by design - the row reader casts the
 *  stored kind, so a kind removed after a record names it
 *  leaves the record readable. */
export function memoryKindBlocker(kind: unknown): string | null {
  if (typeof kind === "string" && (MEMORY_KINDS as readonly string[]).includes(kind)) return null;
  const target = typeof kind === "string" ? foldMemoryKindName(kind) : "";
  const matches = target ? MEMORY_KINDS.filter(k => foldMemoryKindName(k) === target) : [];
  const fix = matches.length === 1 ? matches[0] : null;
  return "Invalid memory kind \"" + String(kind) + "\". Kinds: " + MEMORY_KINDS.join(", ") + (fix ? ". Did you mean \"" + fix + "\"?" : "");
}
export interface MemoryRecord {
  id:string; mission_id:string|null; kind:MemoryKind; content:string;
  source:string; source_hash:string; created_at:string; archived_at:string|null;
  scope:string; aliases:string[];
}
// Topic aliases (QUEUED NEXT Q1, Dip 2026-11-14): a small
// hand-written index of the OTHER wordings a record's topic is
// asked about in ("morning drink order" for a cortado record).
// Aliases are data on the record, never instructions; recall's
// local semantic path matches them so a reworded topic still
// surfaces. Validation keeps them phrase-shaped and bounded.
export const MEMORY_ALIAS_MAX=8;
export function validateMemoryAliases(input:unknown):string[] {
  if(input===undefined||input===null)return [];
  if(!Array.isArray(input))throw new Error("Invalid memory aliases: expected a list of phrases");
  if(input.length>MEMORY_ALIAS_MAX)throw new Error("Invalid memory aliases: at most "+MEMORY_ALIAS_MAX+" per record");
  const out:string[]=[]; const seen=new Set<string>();
  for(const raw of input){
    if(typeof raw!=="string")throw new Error("Invalid memory alias: phrases are text");
    const clean=raw.replace(/\s+/g," ").trim();
    if(clean.length<3||clean.length>60||!/^[a-zA-Z0-9][a-zA-Z0-9 '&-]*$/.test(clean))throw new Error("Invalid memory alias: \""+clean.slice(0,40)+"\" (3-60 chars, words, spaces, hyphens)");
    const key=clean.toLowerCase();
    if(seen.has(key))continue;
    seen.add(key); out.push(clean);
  }
  return out;
}
function parseAliases(raw:unknown):string[] {
  if(Array.isArray(raw))return raw.filter((a):a is string=>typeof a==="string");
  if(typeof raw!=="string"||!raw.trim())return [];
  try{ const parsed:unknown=JSON.parse(raw); return Array.isArray(parsed)?parsed.filter((a):a is string=>typeof a==="string"):[]; }catch{ return []; }
}
type RawRecord=Omit<MemoryRecord,"aliases">&{aliases?:unknown};
function toRecord(row:RawRecord):MemoryRecord { return {...row,aliases:parseAliases(row.aliases)}; }
// Failure visibility (gap found 2026-11-15, hourly run
// 11:04 EST): the memory store is this class riding
// missions.db - the file the TaskScheduler's guard covered
// at 03:04 for its own tables, while the memory side of the
// same file (every recall block, saved note, episode flush,
// compaction flush, patch validation, and memory own-tool)
// opened raw at every touch with no ledger import at all,
// so a dead store threw with the seam unnamed into
// whichever catch wrapped the call, and the seams that fold
// by design (recall degrading to an empty block, flushes
// degrading quietly) would silently empty SAM's memory
// dressed as an install that remembers nothing. Now the
// class's touches own their failure (the chats /
// preferences precedent, adapted to a path-shaped class
// like the tasks store): a failed touch ledgers ONE
// memory-store-failed line (the constructor's open at
// phase write, because the open performs the schema writes
// and migrations; list / search / get at phase read; add /
// setAliases / archive at phase write; actor sam; the
// verbatim reason collapsed and capped; never any memory
// record - content is the owner's words, not failure data),
// tags the error, and rethrows exactly, so every caller's
// handling is unchanged and reads still fail closed. The
// ledger root derives from the store path itself: every
// production door constructs the store at
// <root>/.sam/missions.db, so a path inside a .sam
// directory names its install; a bare-path construction
// (unit tests, scratch harnesses) has no install ledger to
// write to and rethrows bare, exactly as before - never
// dressed as ledgered (the tasks precedent). A touch
// already ledgered by an inner door (the capture guard's
// backstop read inside add, an inner get inside setAliases)
// gains no second line. Validation and data errors (the
// kind / scope / alias shapes, the size and hot-budget
// refusals, the invalid search limit) and
// MemorySuppressedError (the capture guard holding is the
// system working, not a store failure) are not store
// failures and ledger nothing.
export type MemoryStorePhase = "read" | "write";

export function memoryStoreFailureSummary(phase: MemoryStorePhase, reason: string): string {
  const clean = reason.replace(/\s+/g, " ").trim() || "unknown error";
  return ("Memory store " + phase + " failed: " + clean).slice(0, 200);
}

/**
 * The reason a memory-store-failed line carries (census sprint
 * 2026-11-17): recordMemoryStoreFailure took error.message alone,
 * discarding error.cause, so a failure whose wrapper hid
 * its cause was countable but never diagnosable. Now it
 * composes through errorReason (the 04:04 bridge seam):
 * causeless errors keep their plain message, a non-Error
 * reads through String, bot-token segments are redacted,
 * and no record content ever enters the line. */
export function memoryStoreFailureReason(error: unknown): string {
  return errorReason(error);
}

export function recordMemoryStoreFailure(root: string, phase: MemoryStorePhase, error: unknown): void {
  const reason = memoryStoreFailureReason(error);
  recordActivity(root, "sam", "memory-store-failed", memoryStoreFailureSummary(phase, reason));
}

function tagMemoryStoreLedgered(error: unknown): void {
  if (error !== null && (typeof error === "object" || typeof error === "function")) {
    (error as { memoryStoreLedgered?: boolean }).memoryStoreLedgered = true;
  }
}

export function isMemoryStoreLedgered(error: unknown): boolean {
  return error !== null && (typeof error === "object" || typeof error === "function")
    && (error as { memoryStoreLedgered?: boolean }).memoryStoreLedgered === true;
}

/** The install root a store path names, or null when the
 *  path does not live in a .sam directory (a bare-path
 *  construction has no install ledger). */
export function memoryStoreLedgerRoot(path: string): string | null {
  const dir = dirname(resolve(path));
  return basename(dir) === ".sam" ? dirname(dir) : null;
}

const MEMORY_STORE_VALIDATION = [/^Invalid memory kind/, /^Memory requires content and provenance$/, /^Memory exceeds size limit$/, /^Memory record exceeds the hot-memory budget/, /^Invalid memory scope$/, /^Invalid memory alias/, /^Invalid result limit$/];

function isMemoryStoreValidation(error: unknown): boolean {
  if (error instanceof MemorySuppressedError) return true;
  return error instanceof Error && MEMORY_STORE_VALIDATION.some(re => re.test(error.message));
}

function failMemoryStore(root: string | null, phase: MemoryStorePhase, error: unknown): never {
  if (root !== null && !isMemoryStoreLedgered(error) && !isCaptureGuardLedgered(error) && !isMemoryStoreValidation(error)) recordMemoryStoreFailure(root, phase, error);
  if (root !== null && !isMemoryStoreValidation(error)) tagMemoryStoreLedgered(error);
  throw error;
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
  private readonly ledgerRoot:string|null;
  constructor(path:string) {
    this.path=path;
    this.ledgerRoot=memoryStoreLedgerRoot(path);
    this.db=this.touch("write",()=>{
    mkdirSync(dirname(path),{recursive:true});
    const db=openDatabase(path);
    db.exec(`
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
    const columns=db.pragma("table_info(memory_records)") as Array<{name:string}>;
    if(!columns.some(c=>c.name==="scope")){
      db.exec("ALTER TABLE memory_records ADD COLUMN scope TEXT NOT NULL DEFAULT 'core'");
    }
    if(!columns.some(c=>c.name==="aliases")){
      db.exec("ALTER TABLE memory_records ADD COLUMN aliases TEXT NOT NULL DEFAULT '[]'");
    }
    db.exec("CREATE INDEX IF NOT EXISTS memory_scope_idx ON memory_records(scope,created_at)");
    return db;
    });
  }
  private touch<T>(phase:MemoryStorePhase, fn:()=>T):T{
    try { return fn(); }
    catch (error) { failMemoryStore(this.ledgerRoot, phase, error); }
  }
  add(input:{missionId?:string;kind:MemoryKind;content:string;source:string;scope?:string;aliases?:string[]}):MemoryRecord {
    return this.touch("write",()=>{
    const kindBlocker=memoryKindBlocker(input.kind); if(kindBlocker)throw new Error(kindBlocker);
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
    const aliases=validateMemoryAliases(input.aliases);
    const record:MemoryRecord={
      id:randomUUID(),mission_id:input.missionId??null,kind:input.kind,
      content:input.content,source:input.source,
      source_hash:createHash("sha256").update(input.source+"\n"+input.content).digest("hex"),
      created_at:new Date().toISOString(),archived_at:null,scope,aliases
    };
    this.db.prepare(`INSERT INTO memory_records
      (id,mission_id,kind,content,source,source_hash,created_at,archived_at,scope,aliases)
      VALUES (@id,@mission_id,@kind,@content,@source,@source_hash,@created_at,@archived_at,@scope,@aliases)`)
      .run({...record,aliases:JSON.stringify(aliases)});
    return record;
    });
  }
  /** Replace a record's topic aliases (the editable door for
   *  the Q1 index). Returns the updated record, or null when
   *  no such record exists. Validation errors throw. */
  setAliases(id:string,aliases:string[]):MemoryRecord|null {
    return this.touch("write",()=>{
    const clean=validateMemoryAliases(aliases);
    const existing=this.get(id);
    if(!existing)return null;
    this.db.prepare("UPDATE memory_records SET aliases=? WHERE id=?").run(JSON.stringify(clean),id);
    return {...existing,aliases:clean};
    });
  }
  list(missionId?:string,scopes?:string[]):MemoryRecord[] {
    return this.touch("read",()=>{
    const scopeSql=scopes&&scopes.length?" AND scope IN ("+scopes.map(()=>"?").join(",")+")":"";
    const scopeArgs=scopes&&scopes.length?scopes:[];
    const rows=(missionId
      ?this.db.prepare("SELECT * FROM memory_records WHERE archived_at IS NULL AND mission_id=?"+scopeSql+" ORDER BY created_at DESC").all(missionId,...scopeArgs)
      :this.db.prepare("SELECT * FROM memory_records WHERE archived_at IS NULL"+scopeSql+" ORDER BY created_at DESC").all(...scopeArgs)) as RawRecord[];
    return rows.map(toRecord);
    });
  }
  search(query:string,limit=20,scopes?:string[]):MemoryRecord[] {
    return this.touch("read",()=>{
    if(!query.trim())return [];
    if(!Number.isInteger(limit)||limit<1||limit>100)throw new Error("Invalid result limit");
    const scopeSql=scopes&&scopes.length?" AND m.scope IN ("+scopes.map(()=>"?").join(",")+")":"";
    // FTS5 parameter binding prevents query text becoming SQL.
    return (this.db.prepare(`SELECT m.* FROM memory_search s
      JOIN memory_records m ON m.rowid=s.rowid
      WHERE memory_search MATCH ? AND m.archived_at IS NULL${scopeSql}
      ORDER BY bm25(memory_search),m.created_at DESC LIMIT ?`).all(query,...(scopes&&scopes.length?scopes:[]),limit) as RawRecord[]).map(toRecord);
    });
  }
  get(id:string):MemoryRecord|null {
    return this.touch("read",()=>{
    // Includes archived records: patch/supersession validation needs to
    // distinguish "no such record" from "already retired".
    const row=this.db.prepare("SELECT * FROM memory_records WHERE id=?").get(id) as RawRecord|undefined;
    return row?toRecord(row):null;
    });
  }
  archive(id:string):boolean {
    return this.touch("write",()=>
    this.db.prepare("UPDATE memory_records SET archived_at=? WHERE id=? AND archived_at IS NULL")
      .run(new Date().toISOString(),id).changes===1);
  }
  close():void {this.db.close();}
}
// The note-patch target checks as the ONE source (hourly run
// 2026-11-24 13:04 EST, the gate sweep's supersedes tail): a
// note proposal naming a record it supersedes can execute only
// when that record exists, is still live, and sits at the
// proposer's own scope. Until this run the checks lived as
// three separately worded copies - the proposal gate performed
// none of them (the note doors pre-validated, the gate itself
// did not, so a proposal written straight through the gate
// carded a target that could only fail on approval), the
// executor threw its own texts, and notes.ts validatePatchTarget
// threw a third wording. Every seam now rides this blocker,
// carrying the execution seam's exact texts: the gate throws
// it before any card exists, validatePatchTarget throws it at
// the note doors, and execution throws it when the target's
// state changed after a valid card (archived between proposal
// and approval is a state change, not a card that could never
// execute).
export function notePatchBlocker(rec: MemoryRecord | null, id: string, scope: string): string | null {
  if (!rec) return "Cannot patch: record " + id + " no longer exists";
  if (rec.archived_at) return "Cannot patch: record " + id + " is already archived";
  if (rec.scope !== scope) return "Cannot patch: record " + id + " is not in this profile's scope";
  return null;
}
