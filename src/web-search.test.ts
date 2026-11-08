import test from "node:test";
import assert from "node:assert/strict";
import { searchWeb } from "./web-search.js";

test("online search validates query, keeps only HTTPS results, and caps evidence",async()=>{
 let requested="";
 const fake=async(input:URL|RequestInfo,init?:RequestInit):Promise<Response>=>{
  const url=new URL(String(input));requested=url.searchParams.get("q")??"";
  assert.equal(url.hostname,"api.search.brave.com");
  assert.equal((init?.headers as Record<string,string>)["X-Subscription-Token"],"test-key");
  return new Response(JSON.stringify({web:{results:[
   {title:"Official",url:"https://example.com/docs",description:"Relevant result"},
   {title:"Unsafe",url:"http://example.com",description:"Discard"},
   {title:"Second",url:"https://example.org",description:"Other"}
  ]}}),{status:200,headers:{"content-type":"application/json"}});
 };
 const results=await searchWeb("agent runtime","test-key",fake as typeof fetch);
 assert.equal(requested,"agent runtime");
 assert.deepEqual(results.map(x=>x.title),["Official","Second"]);
 await assert.rejects(()=>searchWeb("","test-key",fake as typeof fetch),/Invalid search query/);
 await assert.rejects(()=>searchWeb("query","",fake as typeof fetch),/API_KEY/);
});
