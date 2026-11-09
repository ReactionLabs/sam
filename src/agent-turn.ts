import { ChatStore } from "./chats.js";
import { OpenAICompatibleProvider } from "./openai-compatible.js";
import { connectorChat } from "./connector-chat.js";
import { ownToolsChat } from "./own-tools.js";
import { connectors } from "./connectors.js";
import { PreferenceStore, extractPreferences, lawPromptBlock } from "./preferences.js";
import { detectCorrection, proposeCorrection, withoutCorrectedRules } from "./corrections.js";
import { readDashboardConfig } from "./dashboard.js";
import { recordActivity } from "./activity.js";
import { toolBudget, type TurnRoute } from "./budgets.js";

// One chat turn, shared by the dashboard and the heartbeat runner so SAM behaves
// identically however you reach it. The turn: captures the person's preferences
// from their message (an explicit rule becomes law immediately and already
// applies to this turn), routes a correction through the P1 gate as a proposed
// law instead (P6: it applies to this reply, but it is not law until the owner
// approves it), resolves the chat's profile, injects that profile's standing
// law, routes to the profile's pinned connector or the plain model, and
// persists both sides of the exchange.
export async function runChatTurn(root:string,chatId:string,content:string,opts?:{route?:TurnRoute}):Promise<string>{
  const budget=toolBudget(opts?.route??"chat");
  const providerName=process.env.SAM_MODEL_PROVIDER??"";
  const endpoint=process.env.SAM_MODEL_ENDPOINT??(providerName==="minimax"?"https://api.minimax.io/v1/chat/completions":undefined);
  if(!endpoint)throw Error("Model not configured");
  const key=process.env.SAM_MODEL_API_KEY??(providerName==="minimax"?process.env.MINIMAX_API_KEY:undefined)??"";
  const provider=new OpenAICompatibleProvider(endpoint,key,60000);
  const look=new ChatStore(root);let chatAgent:string|null=null;let profiles;
  try{chatAgent=look.list().find(c=>c.id===chatId)?.agent_name??null;profiles=look.agents();}finally{look.close();}
  const config=readDashboardConfig(root);
  const profileName=chatAgent??config.defaultAgent;
  const active=profiles.find(a=>a.name===profileName);
  const model=active?.model??process.env.SAM_MODEL;
  if(!model)throw Error("Model not configured");
  const db=new ChatStore(root);let history;
  try{history=db.messages(chatId);if(history.length>=100)throw Error("Chat history limit reached");db.add(chatId,"user",content);}finally{db.close();}
  const prefs=new PreferenceStore(root);let lawBlock="";
  try{
    // Corrections (P6) ride the gate on live chat routes only: heartbeat and
    // background turn text is SAM's own prompting, not a fresh correction.
    let correctionNote="";
    const correction=detectCorrection(content);
    if(correction&&(opts?.route??"chat")==="chat"){
      try{
        const routed=proposeCorrection(root,{actor:profileName,chatId,text:content});
        if(routed)correctionNote=" The owner just corrected you. That correction is now a proposed standing law pending owner approval (\""+routed.proposal.detail+"\"): follow it in this reply, and briefly acknowledge that it has been proposed as law and is not standing law yet. Do not claim it is already law.";
      }catch{/* correction plumbing never breaks a turn */}
    }
    for(const found of withoutCorrectedRules(extractPreferences(content),correction))prefs.note(profileName,found.statement,found.kind,chatId);
    lawBlock=lawPromptBlock(prefs.lawsFor(profileName))+correctionNote;
  }finally{prefs.close();}
  const messages=[{role:"system" as const,content:"You are SAM, a local-first mission assistant. This dashboard supports creating chats, branching the selected chat using Branch chat, pinning/unpinning, renaming, and setting a chat profile using the three-dot menu, creating named agent profiles (a profile may pin its own model and one MCP connector), and selecting a default agent under Config. These are real UI capabilities, not tools you can call. Explain how to use them accurately. You cannot directly operate dashboard controls or spawn agents from this chat. Approved read-only MCP connector tools may be available if configured for the active profile. Do not invent folders, archive, search, or other unsupported UI features. "+(active?"Adopt the role of agent "+active.name+": "+active.instructions:"")+lawBlock},...history.slice(-24).map(m=>({role:m.role,content:m.content})),{role:"user" as const,content}];
  let reply:string;
  if(active?.connector_id){
    const pinned=connectors(root).find(c=>c.id===active.connector_id);
    if(!pinned||!pinned.enabled||!process.env[pinned.tokenEnv])throw Error("Profile connector unavailable");
    reply=await connectorChat(root,provider,model,messages,active.connector_id,{actor:profileName,runTurn:(cid,content)=>runChatTurn(root,cid,content),chatId},budget);
  }else if(chatAgent){
    reply=await ownToolsChat(root,profileName,provider,model,messages,(cid,content)=>runChatTurn(root,cid,content),chatId,budget);
  }else{
    const useConnectors=connectors(root).some(c=>c.enabled&&!!process.env[c.tokenEnv]);
    if(useConnectors)reply=await connectorChat(root,provider,model,messages,undefined,{actor:profileName,runTurn:(cid,content)=>runChatTurn(root,cid,content),chatId},budget);
    else reply=await ownToolsChat(root,profileName,provider,model,messages,(cid,content)=>runChatTurn(root,cid,content),chatId,budget);
  }
  const saved=new ChatStore(root);try{saved.add(chatId,"assistant",reply);}finally{saved.close();}
  recordActivity(root,profileName,"turn","Answered in chat "+chatId.slice(0,8));
  return reply;
}
