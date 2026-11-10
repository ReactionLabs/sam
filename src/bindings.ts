import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { channels, type Channel } from "./channels.js";
import { recordActivity } from "./activity.js";

// Deterministic bindings (Plan Phase C item 3): which profile an incoming
// channel message lands on is a routing decision, and routing is never the
// model's call. A binding maps (channel, peer) -> profile, where peer is
// the sender's id on that channel as a string (a Telegram user id, a
// webhook caller name). Resolution is most-specific-wins, the OpenClaw
// routing discipline the plan adopted:
//   1. a binding for this channel AND this peer
//   2. a binding for this channel with no peer (channel-wide)
//   3. the channel's own profile (the pre-bindings behavior, unchanged)
// Bindings are operator-set records in .sam/bindings.json; a profile the
// registry no longer knows is refused at write time by the CLI, and a
// binding whose channel disappears resolves to nothing (the caller falls
// back to the channel it already holds).
export interface Binding { id: string; channelId: string; peer: string | null; profile: string; createdAt: string }
export interface BindingResolution { profile: string; via: "peer" | "channel" | "default"; binding: Binding | null }

const profilePattern = /^[a-z][a-z0-9._-]{0,63}$/;
const MAX_BINDINGS = 64;
function storePath(root: string): string { return join(resolve(root), ".sam", "bindings.json"); }
export function listBindings(root: string): Binding[] {
  if (!existsSync(storePath(root))) return [];
  const value: unknown = JSON.parse(readFileSync(storePath(root), "utf8"));
  if (!Array.isArray(value) || value.length > MAX_BINDINGS) throw Error("Invalid bindings store");
  return value as Binding[];
}
function saveBindings(root: string, items: Binding[]): void {
  mkdirSync(join(resolve(root), ".sam"), { recursive: true });
  writeFileSync(storePath(root), JSON.stringify(items, null, 2), { mode: 0o600 });
}
export function validPeer(peer: string): string {
  const trimmed = peer.trim();
  if (!trimmed || trimmed.length > 128 || /[\u0000-\u001f\u007f]/.test(trimmed)) throw Error("Invalid peer: give the sender id as it appears on the channel (1-128 printable characters)");
  return trimmed;
}
// One binding per (channel, peer): setting the same pair again moves it to
// the new profile instead of stacking a second rule the resolver would
// have to arbitrate. peer null is the channel-wide rule.
export function setBinding(root: string, input: { channelId: string; peer: string | null; profile: string }): Binding {
  const channel = channels(root).find(c => c.id === input.channelId);
  if (!channel) throw Error("Channel not found: " + input.channelId);
  if (!profilePattern.test(input.profile)) throw Error("Invalid profile: " + input.profile);
  const peer = input.peer === null ? null : validPeer(input.peer);
  const items = listBindings(root);
  const existing = items.find(b => b.channelId === channel.id && b.peer === peer);
  if (existing) {
    existing.profile = input.profile;
    saveBindings(root, items);
    recordActivity(root, input.profile, "binding-set", "Binding updated: channel " + channel.name + (peer ? ", peer " + peer : " (all peers)") + " -> profile " + input.profile);
    return existing;
  }
  if (items.length >= MAX_BINDINGS) throw Error("Binding limit reached (" + MAX_BINDINGS + ")");
  const item: Binding = { id: randomUUID(), channelId: channel.id, peer, profile: input.profile, createdAt: new Date().toISOString() };
  saveBindings(root, [...items, item]);
  recordActivity(root, input.profile, "binding-set", "Binding set: channel " + channel.name + (peer ? ", peer " + peer : " (all peers)") + " -> profile " + input.profile);
  return item;
}
export function removeBinding(root: string, id: string): boolean {
  const items = listBindings(root), rest = items.filter(b => b.id !== id);
  if (rest.length === items.length) return false;
  const gone = items.find(b => b.id === id) as Binding;
  saveBindings(root, rest);
  recordActivity(root, gone.profile, "binding-removed", "Binding removed: channel " + gone.channelId + (gone.peer ? ", peer " + gone.peer : " (all peers)") + " -> profile " + gone.profile);
  return true;
}
// The one resolver every channel surface rides. peer may be a number
// (Telegram ids are numeric) or a string; it is compared in its trimmed
// string form, exactly as setBinding stored it.
export function resolveBindingProfile(root: string, channel: Channel, peer?: string | number | null): BindingResolution {
  let items: Binding[];
  try { items = listBindings(root); } catch { return { profile: channel.profile, via: "default", binding: null }; }
  const mine = items.filter(b => b.channelId === channel.id);
  if (peer !== undefined && peer !== null && String(peer).trim() !== "") {
    const peerBinding = mine.find(b => b.peer === String(peer).trim());
    if (peerBinding) return { profile: peerBinding.profile, via: "peer", binding: peerBinding };
  }
  const channelBinding = mine.find(b => b.peer === null);
  if (channelBinding) return { profile: channelBinding.profile, via: "channel", binding: channelBinding };
  return { profile: channel.profile, via: "default", binding: null };
}
