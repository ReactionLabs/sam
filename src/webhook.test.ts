import test from "node:test";
import assert from "node:assert/strict";
import { handleWebhook } from "./webhook.js";
import type { SamClient } from "./telegram.js";
import type { Channel } from "./channels.js";

test("webhook trigger requires the secret and relays the prompt through the profile",async()=>{
 const channel:Channel={id:"c1",kind:"webhook",name:"nines-alerts",profile:"trading",tokenEnv:"SAM_CHANNEL_HOOK",ownerIds:[],enabled:true};
 const sam:SamClient={ensureChat:async()=>"chat-9",postMessage:async(id,content)=>"Worked: "+content};
 const deps={channel,sam,secret:"a-very-long-shared-secret"};
 assert.equal((await handleWebhook(deps,{secret:"wrong",body:{text:"hi"}})).status,401);
 assert.equal((await handleWebhook(deps,{body:{text:"hi"}})).status,401);
 assert.equal((await handleWebhook(deps,{secret:deps.secret,body:{text:""}})).status,400);
 const ok=await handleWebhook(deps,{secret:deps.secret,body:{text:"check the stack"}});
 assert.equal(ok.status,200);
 assert.equal(ok.reply,"Worked: check the stack");
 assert.equal(ok.chatId,"chat-9");
});
