// sam_reach's engine (Dip ruling 2026-11-10, after SAM's Telegram search
// starved on setup calls): SAM's hands on agent-reach's CONTENT actions,
// not just its status reports. agent-reach is read-only by design (it
// never posts, comments, or logs in as anyone), and this wrapper keeps it
// that way: the (channel, action) pair must exist in the CLI's own live
// `channels` declaration, arguments travel as discrete argv (never a
// shell), and the channel's own error payload - code, message, hint - is
// returned to the model as data, because the skill's standing rule is
// that the channel speaks for its own readiness and stop-codes
// (RATE_LIMITED, PLATFORM_BLOCKED, NEED_LOGIN, BUSY) end the attempt.

import { execFile } from "node:child_process";
import { readActivity } from "./activity.js";
import { errorReason } from "./error-reason.js";

export interface ReachChannel {
  id: string;
  actions: string[];
}

export interface ReachError {
  code: string;
  message?: string;
  hint?: string;
}

export interface ReachResult {
  ok: boolean;
  channel?: string;
  action?: string;
  items?: Array<Record<string, unknown>>;
  error?: ReachError;
  note?: string;
}

const RESULT_CAP = 14_000;
const ITEM_TEXT_CAP = 1_500;
const TIMEOUT_MS = 90_000;
const ZERO_ARG_ACTIONS = new Set(["hot", "hot_posts", "hot_stocks"]);

export function reachBin(env: NodeJS.ProcessEnv = process.env): string {
  return env.SAM_AGENT_REACH_BIN || "agent-reach";
}

interface BinRun {
  stdout: string;
  timedOut: boolean;
  spawnError?: string;
}

function runBin(bin: string, argv: string[], timeoutMs: number): Promise<BinRun> {
  return new Promise((resolveRun) => {
    // A .js shim runs through the current node: the portable form for
    // pointing SAM_AGENT_REACH_BIN at a script (and the only form a
    // test stub can take on Windows, which has no shebang execution).
    const file = bin.toLowerCase().endsWith(".js") ? process.execPath : bin;
    const args = file === bin ? argv : [bin, ...argv];
    execFile(file, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err) {
        const e = err as NodeJS.ErrnoException & { killed?: boolean; signal?: string };
        if (e.code === "ENOENT") { resolveRun({ stdout: "", timedOut: false, spawnError: "NOT_INSTALLED" }); return; }
        if (e.killed && e.signal === "SIGTERM") { resolveRun({ stdout: String(stdout ?? ""), timedOut: true }); return; }
        // A non-zero exit still carries the CLI's JSON on stdout in
        // agent-reach's contract; let the caller parse what arrived.
        resolveRun({ stdout: String(stdout ?? ""), timedOut: false });
        return;
      }
      resolveRun({ stdout: String(stdout ?? ""), timedOut: false });
    });
  });
}

let channelCache: { bin: string; at: number; channels: ReachChannel[] } | null = null;

export function resetReachCache(): void {
  channelCache = null;
}

export async function listReachChannels(env: NodeJS.ProcessEnv = process.env): Promise<ReachChannel[]> {
  const bin = reachBin(env);
  if (channelCache && channelCache.bin === bin && Date.now() - channelCache.at < 5 * 60_000) return channelCache.channels;
  const run = await runBin(bin, ["channels"], 30_000);
  if (run.spawnError) throw new Error("agent-reach is not installed on this machine");
  if (run.timedOut) throw new Error("agent-reach channels timed out");
  let parsed: unknown;
  try { parsed = JSON.parse(run.stdout); } catch { throw new Error("agent-reach channels returned unparseable output"); }
  const list = Array.isArray(parsed) ? parsed : (parsed as { channels?: unknown[] }).channels ?? [];
  const channels: ReachChannel[] = [];
  for (const entry of list as Array<Record<string, unknown>>) {
    const id = typeof entry.id === "string" ? entry.id : typeof entry.name === "string" ? entry.name : "";
    if (!id) continue;
    const actions = (Array.isArray(entry.actions) ? entry.actions : []).map((a) =>
      typeof a === "string" ? a : a && typeof a === "object" && typeof (a as { name?: unknown }).name === "string" ? (a as { name: string }).name : "",
    ).filter(Boolean);
    channels.push({ id, actions });
  }
  channelCache = { bin, at: Date.now(), channels };
  return channels;
}

const ITEM_KEYS = ["title", "url", "author", "published_at", "text"];

function trimItem(item: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of ITEM_KEYS) {
    const value = item[key];
    if (typeof value === "string") out[key] = value.length > ITEM_TEXT_CAP ? value.slice(0, ITEM_TEXT_CAP) + "…" : value;
    else if (value !== undefined) out[key] = value;
  }
  return Object.keys(out).length ? out : { text: JSON.stringify(item).slice(0, ITEM_TEXT_CAP) };
}

function capResult(result: ReachResult): ReachResult {
  let serialized = JSON.stringify(result);
  while (serialized.length > RESULT_CAP && result.items && result.items.length > 1) {
    result.items.pop();
    result.note = "Results truncated to fit the turn.";
    serialized = JSON.stringify(result);
  }
  if (serialized.length > RESULT_CAP && result.items?.length === 1) {
    const text = result.items[0].text;
    if (typeof text === "string") result.items[0].text = text.slice(0, 2_000) + "…";
    result.note = "Results truncated to fit the turn.";
  }
  return result;
}

function foldReachName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/** The ONE source for why a reach call cannot name this
 *  channel: the name is not in the agent-reach CLI's own live
 *  channel declaration, so no call can be spent on it. Every
 *  reach call rides runReach (the sam_reach chat tool and the
 *  CLI `reach call` door), and this text is the refusal both
 *  surfaces return - as BAD_INPUT data, never a throw, because
 *  reach errors are data by design. The bad value is echoed,
 *  the declared channels are named as the registry, and when
 *  exactly one declared channel matches the bad name folded
 *  for case and separators, the refusal names it ("you-tube"
 *  -> "youtube"). Null means the channel can be named (the
 *  lookup itself folds case, exactly as before). */
export function reachChannelBlocker(channels: ReachChannel[], channel: string): string | null {
  const asked = String(channel ?? "");
  if (channels.some((c) => c.id.toLowerCase() === asked.toLowerCase())) return null;
  const target = foldReachName(asked);
  const matches = target ? channels.filter((c) => foldReachName(c.id) === target) : [];
  const fix = matches.length === 1 ? matches[0] : null;
  return "Unknown channel " + JSON.stringify(asked) + ". Declared channels: " + (channels.length ? channels.map((c) => c.id).join(", ") : "none declared") + (fix ? ". Did you mean " + JSON.stringify(fix.id) + "?" : "");
}

/** The ONE source for why a reach call cannot name this
 *  action on a declared channel: the action is not in the
 *  channel's own declaration. Same shape as the channel
 *  refusal above - the bad value echoed, the channel's
 *  declared actions named as the registry, and a fold
 *  correction when exactly one matches folded for case and
 *  separators ("Search" -> "search"). Null means the action
 *  is declared. */
export function reachActionBlocker(channel: ReachChannel, action: string): string | null {
  const asked = String(action ?? "");
  if (channel.actions.includes(asked)) return null;
  const target = foldReachName(asked);
  const matches = target ? channel.actions.filter((a) => foldReachName(a) === target) : [];
  const fix = matches.length === 1 ? matches[0] : null;
  return "Channel " + channel.id + " does not declare action " + JSON.stringify(asked) + ". Its actions: " + (channel.actions.length ? channel.actions.join(", ") : "none declared") + (fix ? ". Did you mean " + JSON.stringify(fix) + "?" : "");
}

export async function runReach(
  input: { channel: string; action: string; query?: string; limit?: number },
  env: NodeJS.ProcessEnv = process.env,
): Promise<ReachResult> {
  const bin = reachBin(env);
  let channels: ReachChannel[];
  try {
    channels = await listReachChannels(env);
  } catch (e) {
    return { ok: false, error: { code: "UNAVAILABLE", message: e instanceof Error ? errorReason(e) : "agent-reach unavailable" } };
  }
  const channelBlocker = reachChannelBlocker(channels, String(input.channel ?? ""));
  if (channelBlocker) {
    return { ok: false, error: { code: "BAD_INPUT", message: channelBlocker } };
  }
  const channel = channels.find((c) => c.id.toLowerCase() === String(input.channel ?? "").toLowerCase())!;
  const action = String(input.action ?? "");
  const actionBlocker = reachActionBlocker(channel, action);
  if (actionBlocker) {
    return { ok: false, error: { code: "BAD_INPUT", message: actionBlocker } };
  }
  const query = typeof input.query === "string" ? input.query.trim() : "";
  if (!query && !ZERO_ARG_ACTIONS.has(action)) {
    return { ok: false, error: { code: "BAD_INPUT", message: "Action " + channel.id + " " + action + " needs a query: a search phrase, a URL, a handle, or an id" } };
  }
  if (query.length > 500) return { ok: false, error: { code: "BAD_INPUT", message: "Query is capped at 500 characters" } };
  const argv = [channel.id, action];
  if (query) argv.push(query);
  if (action === "search" && typeof input.limit === "number" && Number.isFinite(input.limit)) {
    argv.push("--limit", String(Math.max(1, Math.min(25, Math.round(input.limit)))));
  }
  const run = await runBin(bin, argv, TIMEOUT_MS);
  if (run.spawnError) return { ok: false, error: { code: "NOT_INSTALLED", message: "agent-reach is not installed on this machine" } };
  if (run.timedOut) return { ok: false, error: { code: "TIMEOUT", message: "agent-reach did not answer within " + TIMEOUT_MS / 1000 + "s", hint: "Do not retry in a loop; a deep research ask belongs in background work." } };
  let parsed: { ok?: boolean; items?: Array<Record<string, unknown>>; error?: ReachError };
  try {
    parsed = JSON.parse(run.stdout) as typeof parsed;
  } catch {
    return { ok: false, error: { code: "BAD_OUTPUT", message: "agent-reach returned unparseable output: " + run.stdout.slice(0, 300) } };
  }
  if (parsed.ok === true) {
    const items = (parsed.items ?? []).slice(0, 12).map(trimItem);
    return capResult({ ok: true, channel: channel.id, action, items });
  }
  const err: ReachError = parsed.error ?? { code: "FAILED" };
  return {
    ok: false,
    channel: channel.id,
    action,
    error: {
      code: typeof err.code === "string" ? err.code : "FAILED",
      message: typeof err.message === "string" ? err.message : undefined,
      hint: typeof err.hint === "string" ? err.hint : undefined,
    },
  };
}

// The ONE writer for a reach call's activity line, so the
// scorecard's parser below can never drift from the seam it
// counts. The shape is byte-identical to what the sam_reach
// tool wrote inline before this writer existed: the channel
// and action the model asked for, then the raw query.
export function reachLedgerSummary(channel: string, action: string, query: string): string {
  return ("Reach " + channel + " " + action + " " + query).trim();
}

// The reach scorecard (2026-11-18, the measured-proof
// series): every sam_reach call ledgers one "reach" line
// carrying the channel, the action, and the raw query text -
// but no daily surface ever counted the calls, so reach
// going silent or a channel mix shift was invisible in
// aggregate. The line carries no outcome (it is written
// after runReach returns, whatever the channel answered),
// so this text folds volume and mix only and claims nothing
// about success: the total calls, counts per fixed action
// bucket (search / read / other), the distinct channel and
// action counts as NUMBERS only, and the no-query call
// count parsed from the fixed summaries. A summary matching
// no fixed shape counts as a call under "other", and no
// stamp, actor, channel name, action token beyond the fixed
// buckets, or any part of a query is ever printed - read
// queries are URLs and search queries are the owner's own
// words, and neither belongs in a trending surface. The
// verdict is attention when any line is unparseable, else
// clear. No stamp and no actor enters the text, so a quiet
// day is byte-identical and P3-silent, and a malformed line
// or a mix shift is the news. A pure read: it creates
// nothing, spends no model call, and reaches for nothing -
// the ledger and the reach seam are untouched, and reaching
// stays runReach's job.
const REACH_ACTIONS = ["search", "read", "other"] as const;
export function parseReachSummary(summary: string): { action: string; bucket: string; channel: string; hasQuery: boolean } | null {
  const m = /^Reach (\S+) (\S+)( (.*))?$/.exec(summary);
  if (!m) return null;
  const bucket = m[2] === "search" || m[2] === "read" ? m[2] : "other";
  return { action: m[2], bucket, channel: m[1], hasQuery: !!(m[4] && m[4].trim()) };
}
export function reachScorecardText(root: string): string {
  const lines = readActivity(root, Number.MAX_SAFE_INTEGER, { kind: "reach" });
  const actions: Record<string, number> = {};
  const channels = new Set<string>();
  const actionTokens = new Set<string>();
  let noQuery = 0;
  let unparseable = 0;
  for (const line of lines) {
    const parsed = parseReachSummary(line.summary);
    if (!parsed) {
      unparseable += 1;
      actions["other"] = (actions["other"] ?? 0) + 1;
      continue;
    }
    actions[parsed.bucket] = (actions[parsed.bucket] ?? 0) + 1;
    channels.add(parsed.channel);
    actionTokens.add(parsed.action);
    if (!parsed.hasQuery) noQuery += 1;
  }
  const actionText = (REACH_ACTIONS as readonly string[]).filter(a => actions[a]).map(a => a + " " + String(actions[a])).join(", ") || "none";
  const out: string[] = [];
  out.push("Reach calls: " + (unparseable > 0 ? "attention" : "clear"));
  out.push("Calls: " + String(lines.length));
  out.push("By action: " + actionText);
  out.push("Distinct channels: " + String(channels.size));
  out.push("Distinct actions: " + String(actionTokens.size));
  out.push("Calls with no query: " + String(noQuery));
  out.push("Note: counts only, cumulative over the activity ledger - the scorecard never reaches, never prints a channel name or any part of a query, and claims nothing about call outcomes, which the ledger line does not carry; a malformed line or a mix shift is the news");
  return out.join("\n");
}

export async function reachDoctor(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const run = await runBin(reachBin(env), ["doctor", "--text"], 30_000);
  if (run.spawnError) return "agent-reach is not installed on this machine\n";
  return (run.stdout || "agent-reach doctor returned nothing") + (run.stdout.endsWith("\n") ? "" : "\n");
}
