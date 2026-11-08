/** Bounded read-only Brave Search integration. Search results are untrusted data, never instructions. */
export interface WebEvidence { title:string; url:string; description:string }
export async function searchWeb(query:string,apiKey:string,fetcher:typeof fetch=fetch):Promise<WebEvidence[]>{
 if(!query.trim()||query.length>300)throw new Error("Invalid search query");
 if(!apiKey.trim())throw new Error("SAM_WEB_SEARCH_API_KEY is required for online research");
 const url=new URL("https://api.search.brave.com/res/v1/web/search");
 url.searchParams.set("q",query);url.searchParams.set("count","5");
 const controller=new AbortController();
 const timer=setTimeout(()=>controller.abort(),12000);
 try{
  const response=await fetcher(url,{headers:{"Accept":"application/json","X-Subscription-Token":apiKey},signal:controller.signal,redirect:"error"});
  if(!response.ok)throw new Error("Web search failed (HTTP "+response.status+")");
  const length=Number(response.headers.get("content-length")??0);
  if(length>200000)throw new Error("Web search response too large");
  const body=await response.text();
  if(body.length>200000)throw new Error("Web search response too large");
  const data:unknown=JSON.parse(body);
  const items=(data as {web?:{results?:unknown}})?.web?.results;
  if(!Array.isArray(items))return [];
  return items.slice(0,5).flatMap((item:unknown)=>{
   if(!item||typeof item!=="object")return [];
   const v=item as Record<string,unknown>;
   if(typeof v.title!=="string"||typeof v.url!=="string"||typeof v.description!=="string")return [];
   let target:URL;try{target=new URL(v.url);}catch{return [];}
   if(target.protocol!=="https:"||target.username||target.password)return [];
   return [{title:v.title.slice(0,180),url:target.toString(),description:v.description.replace(/<[^>]*>/g,"").slice(0,650)}];
  });
 }finally{clearTimeout(timer);}
}
