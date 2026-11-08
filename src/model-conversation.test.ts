import test from "node:test";
import assert from "node:assert/strict";
import { converse, FakeModelProvider, type ModelProvider } from "./model-conversation.js";

test("fake provider repeats last user message deterministically", async () => {
  const provider = new FakeModelProvider();
  const request = {model:"test-model",messages:[{role:"user" as const,content:"first"},{role:"assistant" as const,content:"prior"},{role:"user" as const,content:"hello"}]};
  assert.deepEqual(await converse(provider,request),await converse(provider,request));
  assert.equal((await converse(provider,request)).message.content,"FAKE: hello");
});
test("empty and malformed messages are rejected", async () => {
  const provider = new FakeModelProvider();
  await assert.rejects(converse(provider,{model:"",messages:[{role:"user",content:"hello"}]}));
  await assert.rejects(converse(provider,{model:"x",messages:[]}));
  await assert.rejects(converse(provider,{model:"x",messages:[{role:"user",content:" " }]}));
});
test("untrusted provider output is validated", async () => {
  const bad:ModelProvider = {id:"bad",async complete(){return {provider:"bad",model:"x",message:{role:"assistant",content:""}};}};
  await assert.rejects(converse(bad,{model:"x",messages:[{role:"user",content:"hi"}]}));
});
