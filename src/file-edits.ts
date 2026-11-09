import { createHash, randomUUID } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, writeFileSync, renameSync, unlinkSync, openSync, closeSync, mkdirSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const LIMIT = 32_000;
const hash = (s: Buffer | string) => createHash("sha256").update(s).digest("hex");
const PROTECTED = /^(?:\.env(?:\..*)?|\.git|\.sam|node_modules|id_(?:rsa|ed25519)|.*\.(?:pem|key|p12|pfx))$/i;
type Proposal = { version:1; path:string; originalHash:string; replacement:string; replacementHash:string; digest:string };

function targetPath(root:string, path:string):string {
  if (!path || path.includes("\0") || isAbsolute(path) || /^[a-zA-Z]:/.test(path) || path.startsWith("\\\\")) throw new Error("Invalid relative file path");
  const base=realpathSync(resolve(root));
  const target=resolve(base,path), rel=relative(base,target);
  if (!rel || rel===".." || rel.startsWith(".."+sep)) throw new Error("File outside workspace");
  let current=base;
  for(const part of rel.split(sep)) {
    if(part.startsWith(".") || PROTECTED.test(part)) throw new Error("Protected path");
    current=join(current,part);
    if(lstatSync(current).isSymbolicLink()) throw new Error("Symlink denied");
  }
  const stat=lstatSync(target);
  if(!stat.isFile() || stat.size>LIMIT || stat.nlink!==1) throw new Error("File is not a safe regular file");
  return target;
}
function proposalDir(root:string):string {
  const base=realpathSync(resolve(root));
  const dir=join(base,".sam");
  mkdirSync(dir,{recursive:true,mode:0o700});
  if(lstatSync(dir).isSymbolicLink()) throw new Error("Unsafe proposal directory");
  return dir;
}
function payload(path:string,originalHash:string,replacement:string):Proposal {
  const replacementHash=hash(replacement);
  const digest=hash(JSON.stringify([1,path,originalHash,replacementHash]));
  return {version:1,path,originalHash,replacement,replacementHash,digest};
}
/** Only expose files that pass the same protection checks as edit proposals. */
export function readEditableFile(root:string,path:string):string {
  const content=readFileSync(targetPath(root,path));
  if(content.includes(0)) throw new Error("Binary file denied");
  return content.toString("utf8");
}
export function inspectProposal(root:string,id:string) {
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) throw new Error("Invalid proposal ID");
  const file=join(proposalDir(root),"edit-"+id+".json");
  const stat=lstatSync(file);
  if(!stat.isFile() || stat.isSymbolicLink() || stat.nlink!==1 || stat.size>LIMIT+2048) throw new Error("Unsafe proposal");
  const proposal=JSON.parse(readFileSync(file,"utf8")) as Proposal;
  if(proposal.version!==1 || typeof proposal.path!=="string" || typeof proposal.originalHash!=="string" ||
    typeof proposal.replacement!=="string" || typeof proposal.replacementHash!=="string" ||
    typeof proposal.digest!=="string" || Buffer.byteLength(proposal.replacement)>LIMIT ||
    proposal.replacement.includes("\0")) throw new Error("Malformed proposal");
  const expected=payload(proposal.path,proposal.originalHash,proposal.replacement);
  if(expected.digest!==proposal.digest || expected.replacementHash!==proposal.replacementHash)
    throw new Error("Proposal integrity check failed");
  const original=readEditableFile(root,proposal.path);
  const stale=hash(Buffer.from(original))!==proposal.originalHash;
  return {file,proposal,original,stale};
}
export function rejectEdit(root:string,id:string) {
  const inspected=inspectProposal(root,id);
  unlinkSync(inspected.file);
  return {rejected:true,id,path:inspected.proposal.path};
}
/** CLI-controlled proposal. This does not authorize model writes. */
export function proposeEdit(root:string,path:string,replacement:string) {
  if(Buffer.byteLength(replacement)>LIMIT || replacement.includes("\0")) throw new Error("Replacement too large or binary");
  const target=targetPath(root,path), old=readFileSync(target);
  if(old.includes(0)) throw new Error("Binary file denied");
  const rel=relative(realpathSync(resolve(root)),target).split(sep).join("/");
  const proposal=payload(rel,hash(old),replacement);
  const id=randomUUID();
  const file=join(proposalDir(root),"edit-"+id+".json");
  const fd=openSync(file,"wx",0o600);
  try { writeFileSync(fd,JSON.stringify(proposal),"utf8"); } finally { closeSync(fd); }
  return {id,path:rel,originalHash:proposal.originalHash,replacementHash:proposal.replacementHash,digest:proposal.digest,
    original:old.toString("utf8"),replacement};
}
/** Explicit digest confirmation, single-use proposal, and optimistic concurrency guard. */
export function applyEdit(root:string,id:string,confirmedDigest:string) {
  if(!/^[0-9a-f-]{36}$/.test(id) || !/^[0-9a-f]{64}$/.test(confirmedDigest)) throw new Error("Invalid proposal ID or digest");
  const file=join(proposalDir(root),"edit-"+id+".json");
  if(lstatSync(file).isSymbolicLink() || lstatSync(file).size>LIMIT+2048) throw new Error("Unsafe proposal");
  const proposal=JSON.parse(readFileSync(file,"utf8")) as Proposal;
  if(proposal.version!==1 || typeof proposal.path!=="string" || typeof proposal.replacement!=="string" ||
     typeof proposal.originalHash!=="string" || typeof proposal.replacementHash!=="string" ||
     proposal.digest!==confirmedDigest) throw new Error("Proposal not approved");
  const expected=payload(proposal.path,proposal.originalHash,proposal.replacement);
  if(expected.digest!==confirmedDigest || expected.replacementHash!==proposal.replacementHash || Buffer.byteLength(proposal.replacement)>LIMIT)
    throw new Error("Proposal integrity check failed");
  const target=targetPath(root,proposal.path);
  if(hash(readFileSync(target))!==proposal.originalHash) throw new Error("Target changed since proposal");
  const temp=join(dirname(target),".sam-edit-"+randomUUID()+".tmp");
  const fd=openSync(temp,"wx",0o600);
  try {
    writeFileSync(fd,proposal.replacement,"utf8");
    closeSync(fd);
    // Recheck immediately before replace; concurrent external writers remain outside this CLI's control.
    if(hash(readFileSync(target))!==proposal.originalHash || targetPath(root,proposal.path)!==target)
      throw new Error("Target changed during edit");
    renameSync(temp,target);
    unlinkSync(file);
  } catch(error) {
    try { closeSync(fd); } catch {}
    try { unlinkSync(temp); } catch {}
    throw error;
  }
  return {applied:true,path:proposal.path,replacementHash:proposal.replacementHash};
}
