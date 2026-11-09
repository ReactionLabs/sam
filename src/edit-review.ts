import { inspectProposal } from "./file-edits.js";
import { lineDiff, unifiedDiff } from "./line-diff.js";

export type Finding={severity:"BLOCKER"|"WARNING"|"INFO";code:string;detail:string};
export function reviewEdit(root:string,id:string) {
  const {proposal,original,stale}=inspectProposal(root,id);
  const ops=lineDiff(original,proposal.replacement);
  const rendered=unifiedDiff(proposal.path,ops);
  const {removedLines,addedLines,diff,truncated}=rendered;
  const findings:Finding[]=[];
  if(stale)findings.push({severity:"BLOCKER",code:"STALE_SOURCE",detail:"File changed after proposal; do not apply"});
  if(proposal.replacement===original)findings.push({severity:"WARNING",code:"NO_CHANGE",detail:"Proposal has no changes"});
  if(removedLines>20 || addedLines>20)
    findings.push({severity:"WARNING",code:"LARGE_CHANGE",detail:"More than 20 changed lines; review carefully"});
  const tags=["<think>","</think>","<script>","</script>"];
  for(const tag of tags) {
    if(original.includes(tag) && !proposal.replacement.includes(tag))
      findings.push({severity:"WARNING",code:"REMOVED_LITERAL",detail:"Existing literal "+tag+" disappeared"});
  }
  if(removedLines>0 && addedLines===0)
    findings.push({severity:"WARNING",code:"PURE_DELETION",detail:"Proposal removes content without replacement"});
  return {id,path:proposal.path,digest:proposal.digest,stale,findings,
    removedLines,addedLines,diff,truncated,
    approval:"Review is advisory; explicit apply with digest remains required"};
}
