import { ChatStore } from "./chats.js";
import { converse, type ModelProvider } from "./model-conversation.js";

export interface TeamMember { name:string; role:string }
export interface TeamRunResult { chatId:string; research:string; review:string; summary:string }
const identifier=/^[a-z][a-z0-9._-]{0,63}$/;

/** Two isolated model contexts, bounded turns and explicit human initiation.
 * No shell, web, file write, skill execution or automatic permission escalation. */
export async function runResearchTeam(workspace:string,chatId:string,objective:string,members:readonly TeamMember[],provider:ModelProvider,model:string):Promise<TeamRunResult>{
 if(typeof objective!=="string"||!objective.trim()||objective.length>3000)throw new Error("Invalid objective");
 if(!model.trim()||members.length!==2||new Set(members.map(m=>m.name)).size!==2||
   members.some(m=>!identifier.test(m.name)||!m.role.trim()||m.role.length>160))throw new Error("Invalid team");
 const db=new ChatStore(workspace);
 try {
  db.messages(chatId);
  db.addEvent(chatId,"sam","assignment","Mission: "+objective);
  const [researcher,reviewer]=members;
  db.addEvent(chatId,"sam","assignment",researcher.name+": "+researcher.role);
  db.addEvent(chatId,"sam","assignment",reviewer.name+": "+reviewer.role);
  const research=await converse(provider,{model,messages:[
   {role:"system",content:"You are "+researcher.name+". Role: "+researcher.role+". You have no external tools, browsing or filesystem access. Do not invent sources, verification or completed actions. Produce a concise research plan and reasoned findings, clearly marking unverified claims."},
   {role:"user",content:objective}
  ]});
  db.addEvent(chatId,researcher.name,"message",research.message.content.slice(0,12000));
  const review=await converse(provider,{model,messages:[
   {role:"system",content:"You are "+reviewer.name+". Role: "+reviewer.role+". Independently critique the research. You have no external tools. Do not claim to have verified sources. Identify assumptions, gaps and next validation steps."},
   {role:"user",content:"Objective: "+objective+"\n\nResearcher "+researcher.name+" reports:\n"+research.message.content.slice(0,12000)}
  ]});
  db.addEvent(chatId,reviewer.name,"message",review.message.content.slice(0,12000));
  const summary=await converse(provider,{model,messages:[
   {role:"system",content:"You are SAM, the mission coordinator. Summarize the agent exchange, disagreements, evidence limitations, and actionable next steps. Do not claim tools ran or facts were verified. No external tools are available."},
   {role:"user",content:"Objective: "+objective+"\n\nResearch: "+research.message.content.slice(0,10000)+"\n\nQA review: "+review.message.content.slice(0,10000)}
  ]});
  db.addEvent(chatId,"sam","result",summary.message.content.slice(0,12000));
  return {chatId,research:research.message.content,review:review.message.content,summary:summary.message.content};
 } finally { db.close(); }
}
