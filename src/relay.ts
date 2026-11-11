import { readProviderKey, resolveTurnConnection } from "./providers.js";
import { turnRoutes } from "./failover.js";
import { OpenAICompatibleProvider, type TokenUsage } from "./openai-compatible.js";
import { recordUsage } from "./usage.js";
import { recordActivity } from "./activity.js";

// Relay (sprint item 3): the same prompt, sent to two or more configured
// models, answered side by side. This compares brains; it does not merge
// them, and it does not run tools. A failure on one model is a labeled
// row, not a reason to hide the others.

export interface RelayTarget { provider: string; model: string }
export interface RelayUsage { promptTokens: number; completionTokens: number; totalTokens: number }
export interface RelayAnswer {
  provider: string;
  model: string;
  ok: boolean;
  content: string | null;
  error: string | null;
  latencyMs: number;
  usage: RelayUsage | null;
}
export interface RelayResult { prompt: string; answers: RelayAnswer[]; text: string }

export type RelayCompleter = (target: RelayTarget, prompt: string) => Promise<{ content: string; usage: TokenUsage | null }>;

const ROUTE_RE = /^([a-z][a-z0-9._-]{0,63}):([A-Za-z0-9][A-Za-z0-9._-]{0,79})$/;

export function parseRelayRoute(value: string): RelayTarget {
  const match = ROUTE_RE.exec(value.trim());
  if (!match) throw new Error("Relay route must be provider:model (example openai:gpt-4.1)");
  return { provider: match[1], model: match[2] };
}

export function relayCommandPrompt(content: string): string | null {
  const match = /^\/relay\s+([\s\S]+)$/.exec(content.trim());
  if (!match) return null;
  const prompt = match[1].trim();
  return prompt || null;
}

export function formatRelay(result: { answers: RelayAnswer[] }): string {
  if (!result.answers.length) return "Relay produced no answers.";
  return result.answers.map(a => {
    const usage = a.usage ? a.usage.totalTokens + " tokens" : "usage not reported";
    const head = a.provider + " / " + a.model + " (" + a.latencyMs + " ms, " + usage + ")";
    const body = a.ok ? (a.content ?? "") : "FAILED: " + (a.error ?? "unknown error");
    return head + "\n" + body;
  }).join("\n\n");
}

function dedupe(targets: RelayTarget[]): RelayTarget[] {
  const seen = new Set<string>();
  const out: RelayTarget[] = [];
  for (const t of targets) {
    const key = t.provider + "\n" + t.model;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

export function relayTargetsForProfile(root: string, profileName: string, profile: { provider?: string | null; model?: string | null } | null, env: NodeJS.ProcessEnv = process.env): RelayTarget[] {
  const routes = turnRoutes(root, env, profileName, profile, "chat");
  return dedupe(routes.filter(r => !r.unavailable && r.endpoint && r.model).map(r => ({ provider: r.providerId, model: r.model as string })));
}

async function defaultComplete(root: string, env: NodeJS.ProcessEnv, actor: string, target: RelayTarget, prompt: string): Promise<{ content: string; usage: TokenUsage | null }> {
  const conn = resolveTurnConnection(root, env, { provider: target.provider, model: target.model }, "chat");
  if (conn.unavailable || !conn.endpoint || !conn.model) throw new Error(conn.unavailable ?? "Model not configured");
  const provider = new OpenAICompatibleProvider(conn.endpoint, readProviderKey(env, conn.keyEnv) ?? "", 60_000);
  let usage: TokenUsage | null = null;
  provider.onUsage = (reported, model) => {
    usage = reported;
    recordUsage(root, { actor, route: "chat", tier: conn.tier, model, ...reported });
  };
  const res = await provider.complete({ model: conn.model, messages: [{ role: "user", content: prompt }] });
  return { content: res.message.content, usage };
}

export async function relayPrompt(root: string, prompt: string, targets: RelayTarget[], opts?: { env?: NodeJS.ProcessEnv; actor?: string; complete?: RelayCompleter }): Promise<RelayResult> {
  const text = prompt.trim();
  if (!text || text.length > 8000) throw new Error("Relay prompt must be 1 to 8000 characters");
  const list = dedupe(targets);
  if (list.length < 2) throw new Error("Relay needs at least two routes. Add one with `sam agents add-fallback`, or pass --route provider:model twice.");
  if (list.length > 4) throw new Error("Relay accepts at most 4 routes");
  const env = opts?.env ?? process.env;
  const actor = opts?.actor ?? "sam";
  const answers = await Promise.all(list.map(async (target): Promise<RelayAnswer> => {
    const started = Date.now();
    try {
      const done = opts?.complete
        ? await opts.complete(target, text)
        : await defaultComplete(root, env, actor, target, text);
      return { provider: target.provider, model: target.model, ok: true, content: done.content, error: null, latencyMs: Date.now() - started, usage: done.usage };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { provider: target.provider, model: target.model, ok: false, content: null, error: message.slice(0, 200), latencyMs: Date.now() - started, usage: null };
    }
  }));
  const result: RelayResult = { prompt: text, answers, text: formatRelay({ answers }) };
  const ok = answers.filter(a => a.ok).length;
  recordActivity(root, actor, "relay", "Relay to " + answers.map(a => a.provider + "/" + a.model).join(", ") + ": " + ok + "/" + answers.length + " answered");
  return result;
}
