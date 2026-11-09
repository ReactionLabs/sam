import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join,resolve } from "node:path";

export interface TeamEvent { id:string; chat_id:string; agent:string; kind:"message"|"tool"|"result"|"assignment"; content:string; created_at:string }
export interface ChatRecord { id:string; title:string; created_at:string; updated_at:string; parent_chat_id?:string|null; pinned?:number; agent_name?:string|null }
export interface AgentProfile { id:string; name:string; instructions:string; created_at:string; model:string|null; connector_id:string|null }
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
      CREATE INDEX IF NOT EXISTS team_events_by_chat ON team_events(chat_id,created_at);
      CREATE TABLE IF NOT EXISTS agent_profiles (id TEXT PRIMARY KEY,name TEXT NOT NULL UNIQUE,instructions TEXT NOT NULL,created_at TEXT NOT NULL);`);
    const cols=this.db.pragma("table_info(chats)") as Array<{name:string}>;
    if(!cols.some(c=>c.name==="parent_chat_id"))this.db.exec("ALTER TABLE chats ADD COLUMN parent_chat_id TEXT REFERENCES chats(id)");
    if(!cols.some(c=>c.name==="pinned"))this.db.exec("ALTER TABLE chats ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0 CHECK(pinned IN (0,1))");
    if(!cols.some(c=>c.name==="agent_name"))this.db.exec("ALTER TABLE chats ADD COLUMN agent_name TEXT");
    const acols=this.db.pragma("table_info(agent_profiles)") as Array<{name:string}>;
    if(!acols.some(c=>c.name==="model"))this.db.exec("ALTER TABLE agent_profiles ADD COLUMN model TEXT");
    if(!acols.some(c=>c.name==="connector_id"))this.db.exec("ALTER TABLE agent_profiles ADD COLUMN connector_id TEXT");
  }
  create(title:string,agentName?:string|null):ChatRecord {
    if(!title.trim()||title.length>120)throw new Error("Chat title must be 1 to 120 characters");
    if(agentName!==undefined&&agentName!==null&&!/^[a-z][a-z0-9._-]{0,63}$/.test(agentName))throw new Error("Invalid agent profile");
    const now=new Date().toISOString(),item={id:randomUUID(),title:title.trim(),created_at:now,updated_at:now,agent_name:agentName??null};
    this.db.prepare("INSERT INTO chats (id,title,created_at,updated_at,agent_name) VALUES (@id,@title,@created_at,@updated_at,@agent_name)").run(item);return item;
  }
  branch(parentId:string,title:string):ChatRecord {
    if(!title.trim()||title.length>120)throw new Error("Invalid branch title");
    const now=new Date().toISOString();
    const item={id:randomUUID(),title:title.trim(),created_at:now,updated_at:now,parent_chat_id:parentId,agent_name:null as string|null};
    this.db.transaction(()=>{
      const parent=this.db.prepare("SELECT agent_name FROM chats WHERE id=?").get(parentId) as {agent_name:string|null}|undefined;
      if(!parent)throw new Error("Parent chat not found");
      item.agent_name=parent.agent_name;
      this.db.prepare("INSERT INTO chats (id,title,created_at,updated_at,parent_chat_id,agent_name) VALUES (@id,@title,@created_at,@updated_at,@parent_chat_id,@agent_name)").run(item);
      const history=this.messages(parentId);
      for(const m of history){this.db.prepare("INSERT INTO chat_messages (id,chat_id,role,content,created_at) VALUES (?,?,?,?,?)").run(randomUUID(),item.id,m.role,m.content,m.created_at);}
    })();
    return item;
  }
  agents():AgentProfile[]{return this.db.prepare("SELECT * FROM agent_profiles ORDER BY name LIMIT 100").all() as AgentProfile[];}
  createAgent(name:string,instructions:string,opts?:{model?:string|null;connectorId?:string|null}):AgentProfile{
    if(!/^[a-z][a-z0-9._-]{0,63}$/.test(name)||!instructions.trim()||instructions.length>4000)throw new Error("Invalid agent profile");
    const model=opts?.model??null,connectorId=opts?.connectorId??null;
    if(model!==null&&!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(model))throw new Error("Invalid agent profile");
    if(connectorId!==null&&!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(connectorId))throw new Error("Invalid agent profile");
    if(this.agents().length>=100)throw new Error("Agent limit reached");
    const agent={id:randomUUID(),name,instructions:instructions.trim(),created_at:new Date().toISOString(),model,connector_id:connectorId};
    this.db.prepare("INSERT INTO agent_profiles (id,name,instructions,created_at,model,connector_id) VALUES (@id,@name,@instructions,@created_at,@model,@connector_id)").run(agent);return agent;
  }
  rename(id:string,title:string):boolean{
    if(!title.trim()||title.length>120)throw new Error("Chat title must be 1 to 120 characters");
    return this.db.prepare("UPDATE chats SET title=?,updated_at=? WHERE id=?").run(title.trim(),new Date().toISOString(),id).changes===1;
  }
  setAgent(id:string,agentName:string|null):boolean{
    if(agentName!==null&&!/^[a-z][a-z0-9._-]{0,63}$/.test(agentName))throw new Error("Invalid agent profile");
    return this.db.prepare("UPDATE chats SET agent_name=?,updated_at=? WHERE id=?").run(agentName,new Date().toISOString(),id).changes===1;
  }
  pin(id:string,pinned:boolean):boolean{
    if(typeof pinned!=="boolean")throw new Error("Invalid pin state");
    return this.db.prepare("UPDATE chats SET pinned=? WHERE id=?").run(pinned?1:0,id).changes===1;
  }
  list():ChatRecord[]{return this.db.prepare("SELECT * FROM chats ORDER BY pinned DESC,updated_at DESC LIMIT 200").all() as ChatRecord[];}
  messages(id:string):ChatMessage[]{
    if(!this.db.prepare("SELECT 1 FROM chats WHERE id=?").get(id))throw new Error("Chat not found");
    return this.db.prepare("SELECT * FROM chat_messages WHERE chat_id=? ORDER BY rowid LIMIT 500").all(id) as ChatMessage[];
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
    return this.db.prepare("SELECT * FROM team_events WHERE chat_id=? ORDER BY rowid LIMIT 500").all(id) as TeamEvent[];
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
