import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeOwnTool, personalToolFailureError } from "./own-tools.js";
import { ChatStore } from "./chats.js";

// Sync personal-tool failures carry their cause (gap found
// 2026-11-17, hourly run 08:04 EST): the last message-alone
// inner catches in executeOwnToolInner - the Address Book
// catch and the skill / react / self-work family
// (sam_list_skills, sam_read_skill, sam_react,
// sam_save_note, sam_patch_note, sam_author_skill,
// sam_propose_action) - returned the bare message for an
// Error and a bare label (or String(e)) for a non-Error,
// discarding error.cause and any errno-style code riding on
// the error itself. The tool result is the only record of
// the death and the model reading it is the voice that
// reports it, so each catch now composes through
// errorReason (the 04:04 bridge seam) via
// personalToolFailureError: an Error rides errorReason
// (causeless byte-identical), a non-Error keeps its existing
// bare label exactly, the Address Book catch's null fallback
// keeps String(error) for a non-Error, no bot token leaks,
// and the tool's arguments never enter the error.

const dnsErr = () => new TypeError("fetch failed", {
  cause: Object.assign(new Error("getaddrinfo ENOTFOUND store.invalid"), { code: "ENOTFOUND" }),
});

test("a personal tool failure reason names the cause behind the wrapper", () => {
  assert.equal(personalToolFailureError("Skill list failed", dnsErr()), "fetch failed: getaddrinfo ENOTFOUND store.invalid");
});

test("an errno code riding only on the cause is appended when the message omits it", () => {
  const err = new TypeError("fetch failed", { cause: Object.assign(new Error("read"), { code: "ECONNRESET" }) });
  assert.equal(personalToolFailureError("Note refused", err), "fetch failed: read (ECONNRESET)");
});

test("causeless errors surface their plain message; a non-Error throw keeps its bare label", () => {
  assert.equal(personalToolFailureError("Skill read failed", new Error("no such skill")), "no such skill");
  assert.equal(personalToolFailureError("Reaction failed", "plain string failure"), "Reaction failed");
  assert.equal(personalToolFailureError("Proposal refused", 42), "Proposal refused");
});

test("the null fallback keeps String(error) for a non-Error throw", () => {
  assert.equal(personalToolFailureError(null, "plain string failure"), "plain string failure");
  assert.equal(personalToolFailureError(null, new Error("database is locked")), "database is locked");
});

test("no bot token leaks through a personal tool failure reason", () => {
  const url = "https://api.telegram.org/bot987654:AAE-secret_token/getMe";
  const err = new TypeError("fetch failed", { cause: new Error("request to " + url + " failed") });
  const reason = personalToolFailureError("Skill list failed", err);
  assert.equal(reason.includes("AAE-secret_token"), false);
  assert.equal(reason.includes("987654"), false);
  assert.match(reason, /bot<redacted>/);
});

test("an address book read dying on a planted store hands the model the composed reason, not the bare message", () => {
  const root = mkdtempSync(join(tmpdir(), "sam-personal-cause-"));
  try {
    // A directory where the contacts database file belongs:
    // the store cannot open, and the death carries a code the
    // bare message alone would not name in full.
    mkdirSync(join(root, ".sam", "contacts.db"), { recursive: true });
    const cs = new ChatStore(root);
    const chat = cs.create("people chat");
    cs.close();
    const failed = executeOwnTool(root, "sam", "sam_address_book", { action: "show", name: "Secret Person Wording" }, chat.id) as { error?: string };
    assert.ok(failed.error, "the dispatch returned an error");
    assert.match(failed.error ?? "", /unable to open|not a database|directory|SQLITE_CANTOPEN/i);
    assert.equal((failed.error ?? "").includes("Secret Person Wording"), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a healthy address book list is untouched by the failure seam", () => {
  const root = mkdtempSync(join(tmpdir(), "sam-personal-cause-"));
  try {
    const cs = new ChatStore(root);
    const chat = cs.create("people chat");
    cs.close();
    const ok = executeOwnTool(root, "sam", "sam_address_book", { action: "list" }, chat.id) as { error?: string; contacts?: unknown[] };
    assert.equal(ok.error, undefined);
    assert.deepEqual(ok.contacts, []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
