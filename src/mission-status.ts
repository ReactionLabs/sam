/**
 * The Claudia Mission Status wall (Dip ruling 2026-11-19 ~16:41
 * EST, Review Sam chat: "full Claudia, futuristic vibe with the
 * dashboard"). Claudia is the dashboard's face and greeter; Sam
 * stays the agent underneath. The wall is ONE plain-language
 * line per system, and every light is derived here, in code,
 * from a real check Sam already runs - the auth status and its
 * recorded probes, the context audit, the vault and backup
 * shelves, the connector registry, the channel registry, the
 * approval queue, the doctor report, and the verification
 * ledger. A light is green ONLY when its check is actually
 * green: a configured-but-never-probed model is amber, a
 * connector with no approved tools is amber, a Telegram channel
 * still in pairing mode is amber, approvals waiting are amber
 * (visible, never hidden), a failing doctor check is red, and
 * an unverified change backlog is amber. Nothing here rounds a
 * state up, and nothing here reads a clock into a sentence -
 * the only time input is the payload's own stamp, used solely
 * to judge backup freshness, so the CLI text form stays
 * P3-stable for a held install.
 */

export type MissionLightLevel = "green" | "amber" | "red";

export interface MissionLight {
  id: string;
  name: string;
  level: MissionLightLevel;
  sentence: string;
}

export interface MissionStatus {
  greeting: string;
  headline: string;
  allGreen: boolean;
  counts: { green: number; amber: number; red: number; total: number };
  lights: MissionLight[];
}

export interface MissionDoctorInput {
  checks: Array<{ id: string; status: string }>;
}

interface AuthLike {
  key?: string;
  endpoint?: string | null;
  routes?: Array<{ route: string | null; model: string | null; key: string; lastProbe: { bucket: string } | null }>;
}

export interface MissionStatusInput {
  at?: string;
  auth?: AuthLike;
  contextAudit?: { overall: { passed: number; total: number }; findings: unknown[] } | null;
  readiness?: { vault: { held: number }; backups: { count: number; newest: { created_at: string } | null } };
  vault?: { credentials: unknown[] };
  connectors?: Array<{ name: string; enabled: boolean; credentialPresent?: boolean; allowedTools: string[] }>;
  channels?: Array<{ kind: string; enabled: boolean; credentialPresent?: boolean; ownerIds: number[] }>;
  pendingActions?: unknown[];
  verification?: { state: string; pendingChanges: unknown[] };
}

const GREETING = "Hi, I am Claudia. Here is how Sam is doing right now.";
export const CLAUDIA_CREDIT = "Claudia, an open character by anabology";

function light(id: string, name: string, level: MissionLightLevel, sentence: string): MissionLight {
  return { id, name, level, sentence };
}

function modelLight(auth: AuthLike | undefined): MissionLight {
  const chat = (auth?.routes ?? []).find(r => r.route === "chat") ?? (auth?.routes ?? [])[0];
  if (!auth || auth.key !== "present" || !chat?.model || !auth.endpoint) {
    return light("model", "Model answering", "red", "The model is not fully configured, so Sam cannot answer yet.");
  }
  const bucket = chat.lastProbe?.bucket ?? null;
  if (bucket === "ok") {
    return light("model", "Model answering", "green", "The model answered its last recorded probe, so chats are live.");
  }
  if (bucket !== null) {
    return light("model", "Model answering", "red", "The model's last recorded probe did not pass (" + bucket + "), so answers are not proven right now.");
  }
  return light("model", "Model answering", "amber", "The model is configured, but no successful probe is on record yet, so this light waits for a real answer check.");
}

function memoryLight(input: MissionStatusInput): MissionLight {
  const audit = input.contextAudit;
  if (!audit) {
    return light("memory", "Memory", "amber", "The context audit has not run yet, so memory loading is not proven.");
  }
  if (audit.findings.length > 0) {
    return light("memory", "Memory", "amber", "The context audit passed " + String(audit.overall.passed) + " of " + String(audit.overall.total) + " checks with " + String(audit.findings.length) + " finding(s) about how memory and context load.");
  }
  return light("memory", "Memory", "green", "The context audit passed all " + String(audit.overall.total) + " checks, so memory loads the way it should.");
}

function vaultLight(input: MissionStatusInput): MissionLight {
  const held = input.readiness?.vault.held ?? input.vault?.credentials.length ?? 0;
  if (held > 0) {
    return light("vault", "Vault", "green", "The vault holds " + String(held) + " credential(s), names only here, values never shown.");
  }
  return light("vault", "Vault", "amber", "The vault holds no credentials yet, so nothing can be spent on Sam's behalf.");
}

function connectorLights(input: MissionStatusInput): MissionLight[] {
  const connectors = input.connectors ?? [];
  if (!connectors.length) {
    return [light("connectors", "Connectors", "amber", "No connectors are configured yet.")];
  }
  return connectors.map(c => {
    const name = c.name === "second-shift" ? "Second Shift" : c.name;
    const id = "connector:" + c.name;
    const label = "Connector: " + name;
    if (!c.enabled) return light(id, label, "red", name + " is switched off in the registry.");
    if (!c.credentialPresent) return light(id, label, "red", name + " has no credential ready, so its tools cannot be called.");
    if (!c.allowedTools.length) return light(id, label, "amber", name + " is paired and its credential is ready, but no tools are approved yet.");
    return light(id, label, "green", name + " is on, its credential is ready, and " + String(c.allowedTools.length) + " read-only tool(s) are approved.");
  });
}

function backupLight(input: MissionStatusInput): MissionLight {
  const backups = input.readiness?.backups;
  if (!backups || backups.count === 0 || !backups.newest) {
    return light("backups", "Backups", "red", "No backups are on the shelf, so there is nothing to restore from.");
  }
  const atMs = input.at ? Date.parse(input.at) : NaN;
  const newestMs = Date.parse(backups.newest.created_at);
  if (Number.isFinite(atMs) && Number.isFinite(newestMs) && atMs - newestMs > 48 * 3600 * 1000) {
    return light("backups", "Backups", "amber", "There are " + String(backups.count) + " backup(s) on the shelf, but the newest is more than two days old.");
  }
  return light("backups", "Backups", "green", "There are " + String(backups.count) + " backup(s) on the shelf and the newest is fresh.");
}

function telegramLight(input: MissionStatusInput): MissionLight {
  const tg = (input.channels ?? []).find(c => c.kind === "telegram");
  if (!tg) return light("telegram", "Telegram", "amber", "No Telegram channel is set up yet.");
  if (!tg.enabled) return light("telegram", "Telegram", "red", "The Telegram channel is switched off.");
  if (!tg.credentialPresent) return light("telegram", "Telegram", "red", "The Telegram channel has no bot credential ready, so the bridge cannot poll.");
  if (!tg.ownerIds.length) return light("telegram", "Telegram", "amber", "Telegram is ready but still in pairing mode, so nobody is paired to talk yet.");
  return light("telegram", "Telegram", "green", "Telegram is live and " + String(tg.ownerIds.length) + " owner(s) are paired.");
}

function approvalsLight(input: MissionStatusInput): MissionLight {
  const pending = (input.pendingActions ?? []).length;
  if (pending > 0) {
    return light("approvals", "Approvals waiting", "amber", String(pending) + " approval(s) are waiting for the owner's tap. Nothing runs until then.");
  }
  return light("approvals", "Approvals waiting", "green", "No approvals are waiting. The queue is clear.");
}

function doctorLight(doctor: MissionDoctorInput | null | undefined): MissionLight {
  if (!doctor) {
    return light("doctor", "Doctor", "amber", "Doctor has not run on this surface yet, so this light waits for the real diagnosis.");
  }
  const failing = doctor.checks.filter(c => c.status === "fail");
  const warning = doctor.checks.filter(c => c.status === "warn");
  if (failing.length) {
    const names = failing.map(c => c.id.replace(/-/g, " ")).join(", ");
    return light("doctor", "Doctor", "red", "Doctor found a failing check: " + names + ". It stays red until the check itself passes.");
  }
  if (warning.length) {
    const names = warning.map(c => c.id.replace(/-/g, " ")).join(", ");
    return light("doctor", "Doctor", "amber", "Doctor finished with a warning on: " + names + ".");
  }
  return light("doctor", "Doctor", "green", "Doctor ran and every check passed or was cleanly skipped.");
}

function verifyLight(input: MissionStatusInput): MissionLight {
  const v = input.verification;
  if (!v) return light("verify", "Verify", "amber", "The verification ledger has not been read on this surface yet.");
  if (v.state === "failed") {
    return light("verify", "Verify", "red", "The last verification after a change failed, so that work is closed as failed, never as done.");
  }
  if (v.state === "unverified") {
    return light("verify", "Verify", "amber", String(v.pendingChanges.length) + " change(s) are still waiting for a fresh build and test to pass after them.");
  }
  if (v.state === "verified") {
    return light("verify", "Verify", "green", "The latest changes have a fresh passing build and test after them.");
  }
  return light("verify", "Verify", "green", "No changes are waiting on verification.");
}

export function missionStatusFromPayload(input: MissionStatusInput, opts: { doctor?: MissionDoctorInput | null } = {}): MissionStatus {
  const lights: MissionLight[] = [
    modelLight(input.auth),
    memoryLight(input),
    vaultLight(input),
    ...connectorLights(input),
    backupLight(input),
    telegramLight(input),
    approvalsLight(input),
    doctorLight(opts.doctor ?? null),
    verifyLight(input),
  ];
  const counts = {
    green: lights.filter(l => l.level === "green").length,
    amber: lights.filter(l => l.level === "amber").length,
    red: lights.filter(l => l.level === "red").length,
    total: lights.length,
  };
  const allGreen = counts.amber === 0 && counts.red === 0;
  const headline = allGreen
    ? "All systems groovy"
    : counts.red > 0
      ? "Some systems need attention"
      : "Mostly groovy, a few things need a look";
  return { greeting: GREETING, headline, allGreen, counts, lights };
}

/**
 * The wall as plain text with no clock reading (the CLI-first
 * surface, and the sam-mission script job's stdout): headline,
 * counts, then one level, name, and sentence per light. Two
 * reads of the same install state produce byte-identical text,
 * so a daily script job P3-diffs it and a flipped light is the
 * news.
 */
export function missionStatusText(status: MissionStatus): string {
  const lines: string[] = [];
  lines.push("Mission status: " + status.headline);
  lines.push("Lights: " + String(status.counts.green) + " green, " + String(status.counts.amber) + " amber, " + String(status.counts.red) + " red, " + String(status.counts.total) + " total");
  for (const l of status.lights) lines.push(l.name + ": " + l.level + " - " + l.sentence);
  lines.push(CLAUDIA_CREDIT);
  return lines.join("\n");
}
