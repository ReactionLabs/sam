/** Bounded line-oriented Myers diff. Never invokes Git or a shell. */
export type DiffOp={kind:"equal"|"remove"|"add";text:string};
export function lineDiff(original:string,replacement:string):DiffOp[] {
  const a=original.split("\n"),b=replacement.split("\n");
  // Cap pathological files to prevent quadratic time/memory exhaustion.
  if(a.length+b.length>1800)throw new Error("Too many lines for detailed review");
  const max=a.length+b.length;
  const trace:Map<number,number>[]=[];
  let v=new Map<number,number>([[1,0]]);
  let distance=0,done=false;
  for(let d=0;d<=max && !done;d++){
    trace.push(new Map(v));
    for(let k=-d;k<=d;k+=2){
      const down=k===-d || (k!==d && (v.get(k-1)??-1)<(v.get(k+1)??-1));
      let x=down?(v.get(k+1)??0):(v.get(k-1)??0)+1;
      let y=x-k;
      while(x<a.length && y<b.length && a[x]===b[y]){x++;y++;}
      v.set(k,x);
      if(x>=a.length && y>=b.length){distance=d;done=true;break;}
    }
  }
  const out:DiffOp[]=[];
  let x=a.length,y=b.length;
  for(let d=distance;d>=0;d--){
    const previous=trace[d],k=x-y;
    const down=k===-d || (k!==d && (previous.get(k-1)??-1)<(previous.get(k+1)??-1));
    const prevK=down?k+1:k-1;
    const prevX=previous.get(prevK)??0;
    const prevY=prevX-prevK;
    while(x>prevX && y>prevY){out.push({kind:"equal",text:a[--x]});y--;}
    if(d>0){if(down)out.push({kind:"add",text:b[--y]});else out.push({kind:"remove",text:a[--x]});}
  }
  return out.reverse();
}
export function unifiedDiff(path:string,ops:DiffOp[],context=3,maxChars=16000){
  const changed:number[]=[];
  for(let i=0;i<ops.length;i++)if(ops[i].kind!=="equal")changed.push(i);
  if(!changed.length)return {diff:"No changes",truncated:false,removedLines:0,addedLines:0};
  const ranges:Array<[number,number]>=[];
  for(const i of changed){
    const start=Math.max(0,i-context),end=Math.min(ops.length,i+context+1);
    const last=ranges[ranges.length-1];
    if(last && start<=last[1])last[1]=Math.max(last[1],end);
    else ranges.push([start,end]);
  }
  const oldPositions=[1],newPositions=[1];
  for(const op of ops){
    oldPositions.push(oldPositions[oldPositions.length-1]+(op.kind==="add"?0:1));
    newPositions.push(newPositions[newPositions.length-1]+(op.kind==="remove"?0:1));
  }
  const lines=["--- a/"+path,"+++ b/"+path];
  for(const [start,end] of ranges){
    const oldCount=oldPositions[end]-oldPositions[start],newCount=newPositions[end]-newPositions[start];
    lines.push("@@ -"+oldPositions[start]+","+oldCount+" +"+newPositions[start]+","+newCount+" @@");
    for(const op of ops.slice(start,end))lines.push((op.kind==="equal"?" ":op.kind==="add"?"+":"-")+op.text);
  }
  const full=lines.join("\n");
  return {diff:full.slice(0,maxChars),truncated:full.length>maxChars,
    removedLines:ops.filter(x=>x.kind==="remove").length,addedLines:ops.filter(x=>x.kind==="add").length};
}
