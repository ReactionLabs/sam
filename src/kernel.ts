export const missionStatuses = ["DRAFT","RECON","PLANNING","READY","RUNNING","WAITING_APPROVAL","PAUSING","PAUSED","VERIFYING","COMPLETED","FAILED","CANCELLED"] as const;
export type MissionStatus = typeof missionStatuses[number];
export const transitions: Record<MissionStatus, readonly MissionStatus[]> = {
  DRAFT:["RECON","PLANNING","CANCELLED"], RECON:["PLANNING","PAUSING","FAILED","CANCELLED"],
  PLANNING:["READY","RECON","PAUSING","FAILED","CANCELLED"],
  READY:["RUNNING","PAUSED","CANCELLED"],
  RUNNING:["WAITING_APPROVAL","PAUSING","VERIFYING","FAILED","CANCELLED"],
  WAITING_APPROVAL:["RUNNING","PAUSING","FAILED","CANCELLED"],
  PAUSING:["PAUSED","FAILED","CANCELLED"],
  PAUSED:["READY","RUNNING","CANCELLED"],
  VERIFYING:["COMPLETED","RUNNING","FAILED","CANCELLED"],
  COMPLETED:[], FAILED:[], CANCELLED:[]
};
export function foldMissionStatusName(value: string): string {
  return (value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}
/** The ONE source for why a mission door cannot name this
 *  status: the status is a registry name (missionStatuses)
 *  a person types at the CLI `mission transition` door, and
 *  the two doors that refused it improvised two different
 *  texts for the same registry - the CLI's bare "Invalid
 *  status: X" and MissionStore.transition's "Unknown
 *  status: X" - neither naming the twelve statuses and
 *  neither offering a fold correction, so a folded name
 *  ("running", "waiting approval", "waiting_approval")
 *  dead-ended. An exact status reads no blocker. Anything
 *  else is refused with the statuses named as the registry
 *  and, when exactly one status matches the bad value
 *  folded for case and separators, that correction. The
 *  "Invalid status" prefix is kept: the CLI door's readers
 *  match it. Both doors throw this text before any mission
 *  is touched. Stored-status readers stay permissive by
 *  design - a stored mission's status is read back as
 *  stored, and canTransition / the transitions table are
 *  untouched. Null means the status can be named. */
export function missionStatusBlocker(value: unknown): string | null {
  if (typeof value === "string" && (missionStatuses as readonly string[]).includes(value)) return null;
  const target = typeof value === "string" ? foldMissionStatusName(value) : "";
  const matches = target ? missionStatuses.filter(s => foldMissionStatusName(s) === target) : [];
  const fix = matches.length === 1 ? matches[0] : null;
  return "Invalid status \"" + String(value) + "\". Statuses: " + missionStatuses.join(", ") + (fix ? ". Did you mean \"" + fix + "\"?" : "");
}
export function canTransition(from: MissionStatus, to: MissionStatus): boolean {
  return transitions[from].includes(to);
}
