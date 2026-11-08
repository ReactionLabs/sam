import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join,resolve } from "node:path";

export interface TeamEvent { id:string; chat_id:string; agent:string; kind:"message"|"tool"|"result"|"assignment"; content:string; created_at:string }
export interface ChatRecord { id:string; title:string; created_at:string; updated_at:string }
export interface ChatMessage { id:string; chat_id:string; role:"user"|"assistant"; content:string; created_at:string }
export class ChatStore {
  private db:Database.Database;
  constructor(workspace:string){
    const root=join(resolve(workspace),".sam");mkdirSync(root,{recursive:true});
    this.db=new Database(join(root,"chats.db"));
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`CREATE TABLE IF NOT EXISTS chats (id TEXT PRIMARY KEY,title TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS chat_messages (id TEXT PRIMARY KEY,chat_id TEXT NOT NULL REFERENCES chats(id),role TEXT NOT NULL CHECK(role IN ('user','assistant')),content TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS chat_messages_by_chat ON chat_messages(chat_id,created_at);
      CREATE TABLE IF NOT EXISTS team_events (id TEXT PRIMARY KEY,chat_id TEXT NOT NULL REFERENCES chats(id),agent TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('message','tool','result','assignment')),content TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS team_events_by_chat ON team_events(chat_id,created_at);`);
  }
  create(title:string):ChatRecord {
    if(!title.trim()||title.length>120)throw new Error("Chat title must be 1 to 120 characters");
    const now=new Date().toISOString(),item={id:randomUUID(),title:title.trim(),created_at:now,updated_at:now};
    this.db.prepare("INSERT INTO chats VALUES (@id,@title,@created_at,@updated_at)").run(item);return item;
  }
  list():ChatRecord[]{return this.db.prepare("SELECT * FROM chats ORDER BY updated_at DESC LIMIT 200").all() as ChatRecord[];}
  messages(id:string):ChatMessage[]{
    if(!this.db.prepare("SELECT 1 FROM chats WHERE id=?").get(id))throw new Error("Chat not found");
    return this.db.prepare("SELECT * FROM chat_messages WHERE chat_id=? ORDER BY created_at,id LIMIT 500").all(id) as ChatMessage[];
  }
  add(id:string,role:"user"|"assistant",content:string):ChatMessage {
    if(!["user","assistant"].includes(role)||!content.trim()||content.length>20000)throw new Error("Invalid chat message");
    const now=new Date().toISOString(),item={id:randomUUID(),chat_id:id,role,content,created_at:now};
    this.db.transaction(()=>{
      if(!this.db.prepare("SELECT 1 FROM chats WHERE id=?").get(id))throw new Error("Chat not found");
      this.db.prepare("INSERT INTO chat_messages VALUES (@id,@chat_id,@role,@content,@created_at)").run(item);
      this.db.prepare("UPDATE chats SET updated_at=? WHERE id=?").run(now,id);
    })();
    return item;
  }
  events(id:string):TeamEvent[]{
    if(!this.db.prepare("SELECT 1 FROM chats WHERE id=?").get(id))throw new Error("Chat not found");
    return this.db.prepare("SELECT * FROM team_events WHERE chat_id=? ORDER BY created_at,id LIMIT 500").all(id) as TeamEvent[];
  }
  addEvent(id:string,agent:string,kind:TeamEvent["kind"],content:string):TeamEvent{
    if(!/^[a-z][a-z0-9._-]{0,63}$/.test(agent)||!["message","tool","result","assignment"].includes(kind)||!content.trim()||content.length>12000)throw new Error("Invalid team event");
    const item:TeamEvent={id:randomUUID(),chat_id:id,agent,kind,content,created_at:new Date().toISOString()};
    this.db.transaction(()=>{
      if(!this.db.prepare("SELECT 1 FROM chats WHERE id=?").get(id))throw new Error("Chat not found");
      this.db.prepare("INSERT INTO team_events VALUES (@id,@chat_id,@agent,@kind,@content,@created_at)").run(item);
      this.db.prepare("UPDATE chats SET updated_at=? WHERE id=?").run(item.created_at,id);
    })();return item;
  }
  close(){this.db.close();}
}
