import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordSkillUse, skillUseEntries, recentSkillUse, lastSkillByChat } from "./skill-use.js";

test("skill-use ledger: records fold into recent + per-chat last skill; a torn line is skipped", () => {
  const root = mkdtempSync(join(tmpdir(), "sam-skilluse-"));
  try {
    assert.deepEqual(skillUseEntries(root), []);
    recordSkillUse(root, { actor: "sam", chatId: "chat-1", skill: "agent-reach" });
    recordSkillUse(root, { actor: "dip", chatId: "chat-1", skill: "webclaw" });
    recordSkillUse(root, { actor: "sam", chatId: null, skill: "git-commit" });
    const recent = recentSkillUse(root, 10);
    assert.equal(recent.length, 3);
    assert.equal(recent[0].skill, "git-commit");
    assert.equal(recentSkillUse(root, 2).length, 2);
    const byChat = lastSkillByChat(root);
    assert.equal(byChat.get("chat-1")?.skill, "webclaw");
    assert.equal(byChat.size, 1);
    mkdirSync(join(root, ".sam"), { recursive: true });
    writeFileSync(join(root, ".sam", "skill-use.jsonl"), "{torn\n" + JSON.stringify({ at: "2026-11-10T00:00:00.000Z", actor: "sam", chatId: "chat-9", skill: "docker-patterns" }) + "\n", { flag: "a" });
    assert.equal(lastSkillByChat(root).get("chat-9")?.skill, "docker-patterns");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
