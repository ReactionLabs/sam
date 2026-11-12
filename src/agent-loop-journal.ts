import Database from "better-sqlite3";
import { openDatabase } from "./sqlite.js";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type LoopState = "running" | "completed" | "failed" | "interrupted";
export type LoopRecord = {
  id: string; goal: string; state: LoopState; created_at: string;
  updated_at: string; rounds: number; calls: number; result: string | null;
};

/** Durable event journal. It records evidence, never auto-replays an action after a crash. */
export class AgentLoopJournal {
  private db: Database.Database;
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = openDatabase(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_loops (
        id TEXT PRIMARY KEY, goal TEXT NOT NULL, state TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        rounds INTEGER NOT NULL DEFAULT 0, calls INTEGER NOT NULL DEFAULT 0,
        result TEXT
      );
      CREATE TABLE IF NOT EXISTS agent_loop_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, loop_id TEXT NOT NULL,
        event TEXT NOT NULL, detail TEXT NOT NULL, at TEXT NOT NULL,
        FOREIGN KEY(loop_id) REFERENCES agent_loops(id)
      );
      CREATE INDEX IF NOT EXISTS agent_loop_events_idx ON agent_loop_events(loop_id,seq);
    `);
  }
  create(goal: string): LoopRecord {
    if (!goal.trim() || goal.length > 4000) throw new Error("Invalid agent goal");
    const now = new Date().toISOString();
    const record: LoopRecord = { id: randomUUID(), goal, state: "running", created_at: now,
      updated_at: now, rounds: 0, calls: 0, result: null };
    this.db.prepare(`INSERT INTO agent_loops
      (id,goal,state,created_at,updated_at,rounds,calls,result)
      VALUES (@id,@goal,@state,@created_at,@updated_at,@rounds,@calls,@result)`).run(record);
    this.event(record.id,"started","Goal accepted");
    return record;
  }
  event(id: string, event: string, detail: string): void {
    if (!/^[a-z_]{1,40}$/.test(event) || detail.length > 1000) throw new Error("Invalid loop event");
    const tx = this.db.transaction(() => {
      const loop = this.get(id);
      if (!loop) throw new Error("Loop not found");
      if (loop.state !== "running") throw new Error("Loop is not running");
      this.db.prepare("INSERT INTO agent_loop_events(loop_id,event,detail,at) VALUES (?,?,?,?)")
        .run(id,event,detail,new Date().toISOString());
      this.db.prepare("UPDATE agent_loops SET updated_at=? WHERE id=?").run(new Date().toISOString(),id);
    });
    tx();
  }
  progress(id: string, rounds: number, calls: number): void {
    if (!Number.isSafeInteger(rounds) || !Number.isSafeInteger(calls) ||
        rounds < 0 || calls < 0 || rounds > 100 || calls > 1000)
      throw new Error("Invalid loop progress");
    const result = this.db.prepare(`UPDATE agent_loops SET rounds=?, calls=?, updated_at=?
      WHERE id=? AND state='running' AND rounds<=? AND calls<=?`)
      .run(rounds,calls,new Date().toISOString(),id,rounds,calls);
    if (result.changes !== 1) throw new Error("Loop progress rejected");
  }
  finish(id: string, state: Exclude<LoopState,"running">, result: string): void {
    if (result.length > 8000) throw new Error("Loop result too large");
    const update = this.db.prepare(`UPDATE agent_loops SET state=?, result=?, updated_at=?
      WHERE id=? AND state='running'`).run(state,result,new Date().toISOString(),id);
    if (update.changes !== 1) throw new Error("Loop transition rejected");
  }
  get(id: string): LoopRecord | undefined {
    return this.db.prepare("SELECT * FROM agent_loops WHERE id=?").get(id) as LoopRecord | undefined;
  }
  events(id: string): {seq:number;event:string;detail:string;at:string}[] {
    return this.db.prepare("SELECT seq,event,detail,at FROM agent_loop_events WHERE loop_id=? ORDER BY seq")
      .all(id) as {seq:number;event:string;detail:string;at:string}[];
  }
  list(limit = 20): LoopRecord[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new Error("Invalid loop list limit");
    return this.db.prepare("SELECT * FROM agent_loops ORDER BY created_at DESC, rowid DESC LIMIT ?")
      .all(limit) as LoopRecord[];
  }
  /** On restart, old running loops become interrupted. Never replay tool calls automatically. */
  interruptOrphans(): number {
    return this.db.prepare(`UPDATE agent_loops SET state='interrupted',
      result='Process ended before completion; inspect evidence before resuming',
      updated_at=? WHERE state='running'`).run(new Date().toISOString()).changes;
  }
  close(): void { this.db.close(); }
}
