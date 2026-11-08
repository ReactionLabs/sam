import { inspectProposal } from "./file-edits.js";

export type Finding={severity:"BLOCKER"|"WARNING"|"INFO";code:string;detail:string};
export function reviewEdit(root:string,id:string) {
  const {proposal,original,stale}=inspectProposal(root,id);
  const before=original.split("\n"),after=proposal.replacement.split("\n");
  let prefix=0;
  while(prefix<before.length && prefix<after.length && before[prefix]===after[prefix])prefix++;
  let suffix=0;
  while(suffix<before.length-prefix && suffix<after.length-prefix &&
    before[before.length-1-suffix]===after[after.length-1-suffix])suffix++;
  const removed=before.slice(prefix,before.length-suffix);
  const added=after.slice(prefix,after.length-suffix);
  const findings:Finding[]=[];
  if(stale)findings.push({severity:"BLOCKER",code:"STALE_SOURCE",detail:"File changed after proposal; do not apply"});
  if(proposal.replacement===original)findings.push({severity:"WARNING",code:"NO_CHANGE",detail:"Proposal has no changes"});
  if(removed.length>20 || added.length>20)
    findings.push({severity:"WARNING",code:"LARGE_CHANGE",detail:"More than 20 changed lines; review carefully"});
  const tags=["<think>","</think>","<script>","</script>"];
  for(const tag of tags) {
    if(original.includes(tag) && !proposal.replacement.includes(tag))
      findings.push({severity:"WARNING",code:"REMOVED_LITERAL",detail:"Existing literal "+tag+" disappeared"});
  }
  if(removed.length>0 && added.length===0)
    findings.push({severity:"WARNING",code:"PURE_DELETION",detail:"Proposal removes content without replacement"});
  const MAX_LINES=100;
  const diff=[
    "--- a/"+proposal.path,"+++ b/"+proposal.path,
    "@@ -"+(prefix+1)+","+removed.length+" +"+(prefix+1)+","+added.length+" @@",
    ...removed.slice(0,MAX_LINES).map(x=>"-"+x),
    ...added.slice(0,MAX_LINES).map(x=>"+"+x)
  ].join("\n");
  return {id,path:proposal.path,digest:proposal.digest,stale,findings,
    removedLines:removed.length,addedLines:added.length,
    diff:diff.slice(0,16000),truncated:removed.length>MAX_LINES || added.length>MAX_LINES || diff.length>16000,
    approval:"Review is advisory; explicit apply with digest remains required"};
}
