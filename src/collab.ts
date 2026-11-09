import { ChatStore } from "./chats.js";
import { links } from "./links.js";

// Collaboration between profiles. Isolation is the default; a LINK is the one
// bridge, and collaboration only ever happens across a link. Two linked
// profiles share a collab chat: either side can speak into it, and the other
// side answers as itself, with its own profile, law, and memory scope. The
// transcript is the shared plan: both sides see the same thread, attributed by
// name, and work back and forth in it.
// One exchange = one attributed message in, one turn out. The responder's turn
// runs through the normal turn runner, so everything a profile is (its
// connector pin, its law, its tools) applies to how it answers.
export interface CollabDeps { runTurn:(chatId:string,content:string)=>Promise<string> }
export function collabChatTitle(linkName:string):string{return "Link · "+linkName;}
export async function linkExchange(root:string,linkId:string,from:string,to:string,message:string,deps:CollabDeps):Promise<string>{
  if(from===to)throw new Error("A profile cannot exchange with itself");
  if(!message.trim()||message.length>4000)throw new Error("Invalid exchange message");
  const group=links(root).find(g=>g.id===linkId);
  if(!group)throw new Error("Link not found");
  if(!group.members.includes(from)||!group.members.includes(to))throw new Error("Both profiles must belong to the link");
  const db=new ChatStore(root);
  let chatId:string;
  try{
    const title=collabChatTitle(group.name);
    const found=db.list().find(c=>c.title===title);
    chatId=found?found.id:db.create(title,null).id;
    // The chat answers as the responder: bind it to them for this exchange.
    db.setAgent(chatId,to==="sam"?null:to);
  }finally{db.close();}
  return deps.runTurn(chatId,"["+from+"] "+message.trim());
}
