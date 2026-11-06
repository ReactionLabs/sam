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
export function canTransition(from: MissionStatus, to: MissionStatus): boolean {
  return transitions[from].includes(to);
}
