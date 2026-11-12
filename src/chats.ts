import Database from "better-sqlite3";
import { openDatabase } from "./sqlite.js";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join,resolve } from "node:path";

export interface TeamEvent { id:string; chat_id:string; agent:string; kind:"message"|"tool"|"result"|"assignment"; content:string; created_at:string }
export interface ChatRecord { id:string; title:string; created_at:string; updated_at:string; parent_chat_id?:string|null; pinned?:number; agent_name?:string|null; visitor?:number; archived?:number }
export interface AgentProfile { id:string; name:string; instructions:string; created_at:string; model:string|null; connector_id:string|null; provider:string|null }
export interface ChatMessage { id:string; chat_id:string; role:"user"|"assistant"; content:string; created_at:string; reaction:string|null; partial:number }
// A reaction is a single emoji or a short emoji sequence (flags, ZWJ
// families, keycaps, skin tones) - never text. This one validator
// fences the sam_react tool, the dashboard badges, and the CLI verb.
export function isReactionText(value:string):boolean{
  if(typeof value!=="string"||!value||value.length>24)return false;
  return /^(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|[#*0-9]\uFE0F?\u20E3|[\uFE0F\u200D]|\p{Emoji_Modifier})+$/u.test(value);
}
export interface ChatCompaction { chat_id:string; covered:number; summary:string; updated_at:string }
// Turn a person's question into a safe FTS5 MATCH expression: plain
// terms only (letters, numbers, underscore), deduplicated, capped at
// 8, each a prefix term, joined with AND. Quotes, operators, and
// punctuation in the question can never throw an FTS syntax error or
// steer the query - they simply vanish. No terms means no search.
export function ftsChatMatch(query:string):string|null{
  const terms=query.toLowerCase().match(/[\p{L}\p{N}_]+/gu)??[];
  const unique=[...new Set(terms)].slice(0,8);
  if(!unique.length)return null;
  return unique.map(t=>t+"*").join(" AND ");
}
export class ChatStore {
  private db:Database.Database;
  constructor(workspace:string){
    const root=join(resolve(workspace),".sam");mkdirSync(root,{recursive:true});
    this.db=openDatabase(join(root,"chats.db"));
    this.db.exec(`CREATE TABLE IF NOT EXISTS chats (id TEXT PRIMARY KEY,title TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS chat_messages (id TEXT PRIMARY KEY,chat_id TEXT NOT NULL REFERENCES chats(id),role TEXT NOT NULL CHECK(role IN ('user','assistant')),content TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS chat_messages_by_chat ON chat_messages(chat_id,created_at);
      CREATE TABLE IF NOT EXISTS team_events (id TEXT PRIMARY KEY,chat_id TEXT NOT NULL REFERENCES chats(id),agent TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('message','tool','result','assignment')),content TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS team_events_by_chat ON team_events(chat_id,created_at);
      CREATE TABLE IF NOT EXISTS agent_profiles (id TEXT PRIMARY KEY,name TEXT NOT NULL UNIQUE,instructions TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS chat_compactions (chat_id TEXT PRIMARY KEY REFERENCES chats(id),covered INTEGER NOT NULL,summary TEXT NOT NULL,updated_at TEXT NOT NULL);`);
    const cols=this.db.pragma("table_info(chats)") as Array<{name:string}>;
    if(!cols.some(c=>c.name==="parent_chat_id"))this.db.exec("ALTER TABLE chats ADD COLUMN parent_chat_id TEXT REFERENCES chats(id)");
    if(!cols.some(c=>c.name==="pinned"))this.db.exec("ALTER TABLE chats ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0 CHECK(pinned IN (0,1))");
    if(!cols.some(c=>c.name==="agent_name"))this.db.exec("ALTER TABLE chats ADD COLUMN agent_name TEXT");
    // Visitor chats (P12): the person talking is a customer, not the owner.
    // Their text never becomes preference, law, or confirmed fact.
    if(!cols.some(c=>c.name==="visitor"))this.db.exec("ALTER TABLE chats ADD COLUMN visitor INTEGER NOT NULL DEFAULT 0 CHECK(visitor IN (0,1))");
    if(!cols.some(c=>c.name==="archived"))this.db.exec("ALTER TABLE chats ADD COLUMN archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1))");
    const acols=this.db.pragma("table_info(agent_profiles)") as Array<{name:string}>;
    if(!acols.some(c=>c.name==="model"))this.db.exec("ALTER TABLE agent_profiles ADD COLUMN model TEXT");
    if(!acols.some(c=>c.name==="connector_id"))this.db.exec("ALTER TABLE agent_profiles ADD COLUMN connector_id TEXT");
    if(!acols.some(c=>c.name==="provider"))this.db.exec("ALTER TABLE agent_profiles ADD COLUMN provider TEXT");
    const mcols=this.db.pragma("table_info(chat_messages)") as Array<{name:string}>;
    if(!mcols.some(c=>c.name==="reaction"))this.db.exec("ALTER TABLE chat_messages ADD COLUMN reaction TEXT");
    if(!mcols.some(c=>c.name==="partial"))this.db.exec("ALTER TABLE chat_messages ADD COLUMN partial INTEGER NOT NULL DEFAULT 0");
    // Full-text chat search (Plan Phase B item 4): an FTS5 external-content
    // index over chat_messages, the MemoryStore pattern - triggers keep it
    // in step with inserts, and a DB that predates the index gets one
    // rebuild so its existing conversations are searchable from the start.
    const hadFts=!!this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='chat_messages_fts'").get();
    this.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS chat_messages_fts USING fts5(content, content='chat_messages', content_rowid='rowid');
      CREATE TRIGGER IF NOT EXISTS chat_messages_fts_insert AFTER INSERT ON chat_messages BEGIN
        INSERT INTO chat_messages_fts(rowid,content) VALUES(new.rowid,new.content);
      END;
      CREATE TRIGGER IF NOT EXISTS chat_messages_fts_delete AFTER DELETE ON chat_messages BEGIN
        INSERT INTO chat_messages_fts(chat_messages_fts,rowid,content) VALUES('delete',old.rowid,old.content);
      END;
      CREATE TRIGGER IF NOT EXISTS chat_messages_fts_update AFTER UPDATE ON chat_messages BEGIN
        INSERT INTO chat_messages_fts(chat_messages_fts,rowid,content) VALUES('delete',old.rowid,old.content);
        INSERT INTO chat_messages_fts(rowid,content) VALUES(new.rowid,new.content);
      END;`);
    if(!hadFts)this.db.exec("INSERT INTO chat_messages_fts(chat_messages_fts) VALUES('rebuild')");
  }
  create(title:string,agentName?:string|null,opts?:{visitor?:boolean}):ChatRecord {
    if(!title.trim()||title.length>120)throw new Error("Chat title must be 1 to 120 characters");
    if(agentName!==undefined&&agentName!==null&&!/^[a-z][a-z0-9._-]{0,63}$/.test(agentName))throw new Error("Invalid agent profile");
    const now=new Date().toISOString(),item={id:randomUUID(),title:title.trim(),created_at:now,updated_at:now,agent_name:agentName??null,visitor:opts?.visitor?1:0};
    this.db.prepare("INSERT INTO chats (id,title,created_at,updated_at,agent_name,visitor) VALUES (@id,@title,@created_at,@updated_at,@agent_name,@visitor)").run(item);return item;
  }
  isVisitor(id:string):boolean{
    const row=this.db.prepare("SELECT visitor FROM chats WHERE id=?").get(id) as {visitor:number}|undefined;
    return !!row&&row.visitor===1;
  }
  branch(parentId:string,title:string):ChatRecord {
    if(!title.trim()||title.length>120)throw new Error("Invalid branch title");
    const now=new Date().toISOString();
    const item={id:randomUUID(),title:title.trim(),created_at:now,updated_at:now,parent_chat_id:parentId,agent_name:null as string|null,visitor:0};
    this.db.transaction(()=>{
      const parent=this.db.prepare("SELECT agent_name,visitor FROM chats WHERE id=?").get(parentId) as {agent_name:string|null;visitor?:number}|undefined;
      if(!parent)throw new Error("Parent chat not found");
      item.agent_name=parent.agent_name;
      item.visitor=parent.visitor===1?1:0;
      this.db.prepare("INSERT INTO chats (id,title,created_at,updated_at,parent_chat_id,agent_name,visitor) VALUES (@id,@title,@created_at,@updated_at,@parent_chat_id,@agent_name,@visitor)").run(item);
      const history=this.messages(parentId);
      for(const m of history){this.db.prepare("INSERT INTO chat_messages (id,chat_id,role,content,created_at,partial) VALUES (?,?,?,?,?,?)").run(randomUUID(),item.id,m.role,m.content,m.created_at,m.partial?1:0);}
    })();
    return item;
  }
  agents():AgentProfile[]{return this.db.prepare("SELECT * FROM agent_profiles ORDER BY name LIMIT 100").all() as AgentProfile[];}
  createAgent(name:string,instructions:string,opts?:{model?:string|null;connectorId?:string|null;provider?:string|null}):AgentProfile{
    if(!/^[a-z][a-z0-9._-]{0,63}$/.test(name)||!instructions.trim()||instructions.length>4000)throw new Error("Invalid agent profile");
    const model=opts?.model??null,connectorId=opts?.connectorId??null,provider=opts?.provider??null;
    if(model!==null&&!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(model))throw new Error("Invalid agent profile");
    if(provider!==null&&!/^[a-z][a-z0-9._-]{0,31}$/.test(provider))throw new Error("Invalid agent profile");
    if(connectorId!==null&&!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(connectorId))throw new Error("Invalid agent profile");
    if(this.agents().length>=100)throw new Error("Agent limit reached");
    const agent={id:randomUUID(),name,instructions:instructions.trim(),created_at:new Date().toISOString(),model,connector_id:connectorId,provider};
    this.db.prepare("INSERT INTO agent_profiles (id,name,instructions,created_at,model,connector_id,provider) VALUES (@id,@name,@instructions,@created_at,@model,@connector_id,@provider)").run(agent);return agent;
  }
  // Re-pinning (found live 2026-11-09): profiles were create-only, so moving
  // a profile to a new model meant a direct UPDATE on chats.db. These are
  // the store-level update the CLI `agents set-model` / `set-connector`
  // verbs ride on. Validation is exactly createAgent's: a bad value throws
  // "Invalid agent profile"; an unknown name returns null and changes
  // nothing. null clears the pin (back to the route tier / no connector).
  setAgentModel(name:string,model:string|null):AgentProfile|null{
    if(model!==null&&!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(model))throw new Error("Invalid agent profile");
    if(this.db.prepare("UPDATE agent_profiles SET model=? WHERE name=?").run(model,name).changes!==1)return null;
    return this.agents().find(a=>a.name===name)??null;
  }
  setAgentProvider(name:string,provider:string|null):AgentProfile|null{
    if(provider!==null&&!/^[a-z][a-z0-9._-]{0,31}$/.test(provider))throw new Error("Invalid agent profile");
    if(this.db.prepare("UPDATE agent_profiles SET provider=? WHERE name=?").run(provider,name).changes!==1)return null;
    return this.agents().find(a=>a.name===name)??null;
  }
  setAgentConnector(name:string,connectorId:string|null):AgentProfile|null{
    if(connectorId!==null&&!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(connectorId))throw new Error("Invalid agent profile");
    if(this.db.prepare("UPDATE agent_profiles SET connector_id=? WHERE name=?").run(connectorId,name).changes!==1)return null;
    return this.agents().find(a=>a.name===name)??null;
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
  archive(id:string,archived:boolean):boolean{
    if(typeof archived!=="boolean")throw new Error("Invalid archive state");
    return this.db.prepare("UPDATE chats SET archived=? WHERE id=?").run(archived?1:0,id).changes===1;
  }
  get(id:string):ChatRecord|null{
    return (this.db.prepare("SELECT * FROM chats WHERE id=?").get(id) as ChatRecord|undefined)??null;
  }
  list(opts?:{includeArchived?:boolean}):ChatRecord[]{return this.db.prepare("SELECT * FROM chats"+(opts?.includeArchived?"":" WHERE archived=0")+" ORDER BY pinned DESC,updated_at DESC LIMIT 200").all() as ChatRecord[];}
  lastActivity():Array<{chat_id:string;last_message_at:string;messages:number}>{
    return this.db.prepare("SELECT chat_id, MAX(created_at) AS last_message_at, COUNT(*) AS messages FROM chat_messages GROUP BY chat_id").all() as Array<{chat_id:string;last_message_at:string;messages:number}>;
  }
  searchMessages(query:string,chatIds:string[],limit=20):Array<{chat_id:string;role:string;content:string;created_at:string}>{
    if(!query.trim()||!chatIds.length)return [];
    const like="%"+query.replace(/[%_\\]/g,"\\$&")+"%";
    return this.db.prepare("SELECT chat_id,role,content,created_at FROM chat_messages WHERE chat_id IN ("+chatIds.map(()=>"?").join(",")+") AND content LIKE ? ESCAPE '\\' ORDER BY created_at DESC LIMIT ?").all(...chatIds,like,limit) as Array<{chat_id:string;role:string;content:string;created_at:string}>;
  }
  // FTS search over the same store (Phase B item 4): multi-term,
  // prefix-aware, relevance-ranked by bm25, with the snippet cut by
  // FTS around the actual match. The chat-id list is the fence - the
  // caller (chat-manage) computes it from the acting profile, the
  // store never widens it.
  searchMessagesFts(query:string,chatIds:string[],limit=20):Array<{chat_id:string;role:string;content:string;created_at:string;snippet:string;rank:number}>{
    const match=ftsChatMatch(query);
    if(!match||!chatIds.length)return [];
    const capped=Number.isInteger(limit)?Math.min(50,Math.max(1,limit)):20;
    return this.db.prepare("SELECT m.chat_id,m.role,m.content,m.created_at,snippet(chat_messages_fts,0,'','',char(8230),24) AS snippet,bm25(chat_messages_fts) AS rank FROM chat_messages_fts JOIN chat_messages m ON m.rowid=chat_messages_fts.rowid WHERE chat_messages_fts MATCH ? AND m.chat_id IN ("+chatIds.map(()=>"?").join(",")+") ORDER BY rank,m.created_at DESC LIMIT ?").all(match,...chatIds,capped) as Array<{chat_id:string;role:string;content:string;created_at:string;snippet:string;rank:number}>;
  }
  messages(id:string):ChatMessage[]{
    if(!this.db.prepare("SELECT 1 FROM chats WHERE id=?").get(id))throw new Error("Chat not found");
    return this.db.prepare("SELECT * FROM chat_messages WHERE chat_id=? ORDER BY rowid LIMIT 500").all(id) as ChatMessage[];
  }
  add(id:string,role:"user"|"assistant",content:string):ChatMessage {
    if(!["user","assistant"].includes(role)||!content.trim()||content.length>20000)throw new Error("Invalid chat message");
    const now=new Date().toISOString(),item={id:randomUUID(),chat_id:id,role,content,created_at:now,reaction:null as string|null,partial:0};
    this.db.transaction(()=>{
      if(!this.db.prepare("SELECT 1 FROM chats WHERE id=?").get(id))throw new Error("Chat not found");
      this.db.prepare("INSERT INTO chat_messages (id,chat_id,role,content,created_at) VALUES (@id,@chat_id,@role,@content,@created_at)").run(item);
      this.db.prepare("UPDATE chats SET updated_at=? WHERE id=?").run(now,id);
    })();
    return item;
  }
  // A partial assistant row is an interrupted reply. partial=1 until
  // the turn finishes; readers must not treat it as a complete answer.
  openPartial(chatId:string):ChatMessage|null{
    const rows=this.messages(chatId);
    const last=rows[rows.length-1];
    return last&&last.role==="assistant"&&last.partial===1?last:null;
  }
  savePartial(chatId:string,messageId:string|null,content:string):string{
    const text=content.slice(0,20000);
    if(!text.trim())throw new Error("Invalid chat message");
    if(messageId){
      const changed=this.db.prepare("UPDATE chat_messages SET content=?,partial=1 WHERE id=? AND chat_id=? AND role='assistant'").run(text,messageId,chatId).changes;
      if(changed===1)return messageId;
    }
    const now=new Date().toISOString();
    const item={id:randomUUID(),chat_id:chatId,role:"assistant" as const,content:text,created_at:now,reaction:null as string|null,partial:1};
    this.db.transaction(()=>{
      if(!this.db.prepare("SELECT 1 FROM chats WHERE id=?").get(chatId))throw new Error("Chat not found");
      this.db.prepare("INSERT INTO chat_messages (id,chat_id,role,content,created_at,partial) VALUES (@id,@chat_id,@role,@content,@created_at,@partial)").run(item);
      this.db.prepare("UPDATE chats SET updated_at=? WHERE id=?").run(now,chatId);
    })();
    return item.id;
  }
  finishPartial(chatId:string,messageId:string,content:string):boolean{
    const text=content.slice(0,20000);
    if(!text.trim())return false;
    return this.db.prepare("UPDATE chat_messages SET content=?,partial=0 WHERE id=? AND chat_id=? AND role='assistant'").run(text,messageId,chatId).changes===1;
  }
  // Reactions (Dip, 2026-11-10): an emoji stamped on one message -
  // SAM's automatic seen/acknowledged marks and its deliberate
  // sam_react both land here. Null clears. The message must belong
  // to the named chat; a foreign id changes nothing and says so.
  setReaction(chatId:string,messageId:string,reaction:string|null):boolean{
    if(reaction!==null&&!isReactionText(reaction))throw new Error("Invalid reaction: a single emoji or short emoji sequence, no text");
    const res=this.db.prepare("UPDATE chat_messages SET reaction=? WHERE id=? AND chat_id=?").run(reaction,messageId,chatId);
    return res.changes>0;
  }
  // Context compaction (Plan Phase A item 2): one record per chat - how
  // many leading messages the stored summary covers, and the summary
  // itself. The raw messages are never deleted; the summary only
  // replaces them in the prompt. Lives in chats.db, so the nightly
  // backup carries it with the chat it belongs to.
  getCompaction(id:string):ChatCompaction|null{
    return (this.db.prepare("SELECT * FROM chat_compactions WHERE chat_id=?").get(id) as ChatCompaction|undefined)??null;
  }
  setCompaction(id:string,covered:number,summary:string):ChatCompaction{
    if(!Number.isInteger(covered)||covered<0||!summary.trim()||summary.length>20000)throw new Error("Invalid compaction");
    const item:ChatCompaction={chat_id:id,covered,summary,updated_at:new Date().toISOString()};
    this.db.transaction(()=>{
      if(!this.db.prepare("SELECT 1 FROM chats WHERE id=?").get(id))throw new Error("Chat not found");
      this.db.prepare("INSERT INTO chat_compactions (chat_id,covered,summary,updated_at) VALUES (@chat_id,@covered,@summary,@updated_at) ON CONFLICT(chat_id) DO UPDATE SET covered=@covered,summary=@summary,updated_at=@updated_at").run(item);
    })();
    return item;
  }
  listCompactions():ChatCompaction[]{
    return this.db.prepare("SELECT * FROM chat_compactions ORDER BY updated_at DESC LIMIT 200").all() as ChatCompaction[];
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
