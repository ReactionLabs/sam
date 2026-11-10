import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addChannel } from "./channels.js";
import { listBindings, removeBinding, resolveBindingProfile, setBinding } from "./bindings.js";
import { readSkillForProfile, setSkillAllowlist, skillAllowlist, skillsForProfile } from "./skills.js";
import { executeOwnTool, skillCatalogForPrompt } from "./own-tools.js";
import { handleTelegramUpdate, loadBridgeState, type SamClient } from "./telegram.js";
import { handleWebhook } from "./webhook.js";
import { addHeartbeatJob, heartbeatJobs, heartbeatLog, runHeartbeat } from "./heartbeat.js";

function skill(root: string, name: string, description: string) {
  const dir = join(root, ".agents", "skills", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), "---\nname: " + name + "\ndescription: " + description + "\n---\n\nSteps for " + name + ".\n");
}

test("bindings: most specific wins - peer beats channel-wide beats the channel profile", () => {
  const root = mkdtempSync(join(tmpdir(), "sam-bind-"));
  try {
    const channel = addChannel(root, "telegram", "Dip Telegram", "trading", "SAM_CHANNEL_TG_MAIN", [111, 222]);
    assert.deepEqual(resolveBindingProfile(root, channel, 111), { profile: "trading", via: "default", binding: null });
    setBinding(root, { channelId: channel.id, peer: null, profile: "researcher" });
    assert.equal(resolveBindingProfile(root, channel, 111).profile, "researcher");
    assert.equal(resolveBindingProfile(root, channel, 111).via, "channel");
    setBinding(root, { channelId: channel.id, peer: "111", profile: "second-shift" });
    const peer = resolveBindingProfile(root, channel, 111);
    assert.equal(peer.profile, "second-shift");
    assert.equal(peer.via, "peer");
    // A different peer still falls to the channel-wide rule.
    assert.equal(resolveBindingProfile(root, channel, 222).profile, "researcher");
    // Setting the same (channel, peer) again moves it - no stacked rules.
    setBinding(root, { channelId: channel.id, peer: "111", profile: "trading" });
    assert.equal(listBindings(root).filter(b => b.peer === "111").length, 1);
    assert.equal(resolveBindingProfile(root, channel, "111").profile, "trading");
    // Removal restores the next rule down.
    const wide = listBindings(root).find(b => b.peer === null)!;
    assert.equal(removeBinding(root, wide.id), true);
    assert.equal(resolveBindingProfile(root, channel, 222).via, "default");
    assert.equal(removeBinding(root, wide.id), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("bindings: validation refuses unknown channels, bad profiles, and bad peers", () => {
  const root = mkdtempSync(join(tmpdir(), "sam-bind-"));
  try {
    const channel = addChannel(root, "telegram", "Dip Telegram", "trading", "SAM_CHANNEL_TG_MAIN", []);
    assert.throws(() => setBinding(root, { channelId: "nope", peer: null, profile: "trading" }), /Channel not found/);
    assert.throws(() => setBinding(root, { channelId: channel.id, peer: null, profile: "Trading" }), /Invalid profile/);
    assert.throws(() => setBinding(root, { channelId: channel.id, peer: "  ", profile: "trading" }), /Invalid peer/);
    assert.equal(listBindings(root).length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("bindings: telegram routes a bound peer to its own profile and chat, others keep the channel profile", async () => {
  const root = mkdtempSync(join(tmpdir(), "sam-bind-tg-"));
  try {
    const channel = addChannel(root, "telegram", "Dip Telegram", "trading", "SAM_CHANNEL_TG_MAIN", [111, 222]);
    setBinding(root, { channelId: channel.id, peer: "222", profile: "researcher" });
    const seen: string[] = [];
    const sam: SamClient = {
      ensureChat: async (title, profile) => { seen.push(title + "|" + profile); return "chat-" + profile; },
      postMessage: async (id, content) => "Reply in " + id + " to: " + content,
    };
    const state = loadBridgeState(root);
    const deps = { channel, sam, send: async () => {}, state, root };
    await handleTelegramUpdate(deps, { update_id: 1, message: { chat: { id: 555 }, from: { id: 111 }, text: "stack?" } });
    await handleTelegramUpdate(deps, { update_id: 2, message: { chat: { id: 555 }, from: { id: 222 }, text: "research?" } });
    assert.deepEqual(seen, ["Telegram · trading|trading", "Telegram · researcher|researcher"]);
    // Same telegram chat, two SAM chats: the routed key is profile-suffixed.
    assert.equal(state.chats["555"], "chat-trading");
    assert.equal(state.chats["555:researcher"], "chat-researcher");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("bindings: webhook peer routes through the same resolver", async () => {
  const root = mkdtempSync(join(tmpdir(), "sam-bind-wh-"));
  try {
    const channel = addChannel(root, "webhook", "Stack hook", "trading", "SAM_CHANNEL_WH_MAIN", []);
    setBinding(root, { channelId: channel.id, peer: "nines-monitor", profile: "researcher" });
    const seen: string[] = [];
    const sam: SamClient = {
      ensureChat: async (title, profile) => { seen.push(profile); return "chat-" + profile; },
      postMessage: async () => "ok",
    };
    const secret = "s".repeat(32);
    const routed = await handleWebhook({ channel, sam, secret, root }, { secret, body: { text: "alert", peer: "nines-monitor" } });
    assert.equal(routed.profile, "researcher");
    const plain = await handleWebhook({ channel, sam, secret, root }, { secret, body: { text: "alert" } });
    assert.equal(plain.profile, "trading");
    assert.deepEqual(seen, ["researcher", "trading"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("skill allowlists: no entry is unrestricted; an entry fences catalog, list, and read for that profile only", () => {
  const root = mkdtempSync(join(tmpdir(), "sam-allow-"));
  try {
    skill(root, "alpha", "Alpha playbook for alpha tasks");
    skill(root, "beta", "Beta playbook for beta tasks");
    // Unrestricted by default - today's behavior for every profile.
    assert.equal(skillAllowlist(root, "trading"), null);
    assert.deepEqual(skillsForProfile(root, "trading").map(s => s.name), ["alpha", "beta"]);
    assert.match(readSkillForProfile(root, "trading", "beta").instructions, /Steps for beta/);
    // Unknown skill names refuse at set time, naming what is installed.
    assert.throws(() => setSkillAllowlist(root, "trading", ["gamma"]), /Unknown skill\(s\): gamma.*alpha/);
    setSkillAllowlist(root, "trading", ["alpha"]);
    assert.deepEqual(skillAllowlist(root, "trading"), ["alpha"]);
    assert.deepEqual(skillsForProfile(root, "trading").map(s => s.name), ["alpha"]);
    assert.throws(() => readSkillForProfile(root, "trading", "beta"), /not on profile trading's allowlist/);
    assert.match(readSkillForProfile(root, "trading", "alpha").instructions, /Steps for alpha/);
    // Another profile is untouched by trading's list.
    assert.deepEqual(skillsForProfile(root, "researcher").map(s => s.name), ["alpha", "beta"]);
    // The chat surfaces ride the same fence: catalog, list tool, read tool.
    const catalog = skillCatalogForPrompt(root, "trading");
    assert.match(catalog, /alpha/);
    assert.doesNotMatch(catalog, /beta/);
    const listed = executeOwnTool(root, "trading", "sam_list_skills", {}) as { skills: Array<{ name: string }> };
    assert.deepEqual(listed.skills.map(s => s.name), ["alpha"]);
    const refused = executeOwnTool(root, "trading", "sam_read_skill", { name: "beta" }) as { error: string };
    assert.match(refused.error, /allowlist/);
    // An empty entry means no skills at all, and clearing restores all.
    setSkillAllowlist(root, "trading", []);
    assert.deepEqual(skillsForProfile(root, "trading"), []);
    assert.equal(skillCatalogForPrompt(root, "trading"), "");
    setSkillAllowlist(root, "trading", null);
    assert.equal(skillAllowlist(root, "trading"), null);
    assert.deepEqual(skillsForProfile(root, "trading").map(s => s.name), ["alpha", "beta"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("heartbeat isolation: one job's failed turn fails only that job - the tick, the other jobs, and the drain continue", async () => {
  const root = mkdtempSync(join(tmpdir(), "sam-hb-iso-"));
  try {
    addHeartbeatJob(root, "fragile watch", 30, "trading", "Check the fragile thing");
    addHeartbeatJob(root, "steady watch", 30, "trading", "Check the steady thing");
    const deps = {
      ensureChat: async (title: string) => "chat-" + title,
      runTurn: async (chatId: string) => {
        if (chatId.includes("fragile")) throw new Error("Empty model response");
        return "Steady facts: 42 candidates, all present and accounted for in full detail today";
      },
    } as never;
    const r = await runHeartbeat(root, deps);
    assert.deepEqual(r.failed, ["fragile watch"]);
    assert.deepEqual(r.changed, ["steady watch"]);
    // The failure is recorded once, with its reason, in the log.
    const failedLines = heartbeatLog(root, 50).filter(l => l.type === "job-failed");
    assert.equal(failedLines.length, 1);
    assert.match(String(failedLines[0].reason), /Empty model response/);
    // The failed job's schedule advanced: it is not due again right away,
    // so a persistently failing model cannot wedge every later tick.
    const jobs = heartbeatJobs(root);
    assert.ok(jobs.every(j => j.lastRun !== null));
    const again = await runHeartbeat(root, deps);
    assert.deepEqual(again.ran, []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
