import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addChannel } from "./channels.js";
import { errorReason, bridgeFailureSummary, bridgePollFailureSummary, runTelegramBridge, type SamClient, type TelegramApi } from "./telegram.js";
import { readActivity } from "./activity.js";

// Bridge poll failures carry their cause (gap found 2026-11-16,
// hourly run 04:04 EST): the live ledger held 61
// bridge-poll-failed lines, 60 of them the bare undici
// "fetch failed", because the summaries took error.message
// alone and dropped error.cause - the class was countable but
// not diagnosable. The reason now walks the cause chain.

test("errorReason walks the cause chain and names the errno code", () => {
  const cause = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
  const err = new TypeError("fetch failed", { cause });
  assert.equal(errorReason(err), "fetch failed: read ECONNRESET");
  const dns = Object.assign(new Error("getaddrinfo ENOTFOUND api.telegram.org"), { code: "ENOTFOUND" });
  assert.equal(errorReason(new TypeError("fetch failed", { cause: dns })), "fetch failed: getaddrinfo ENOTFOUND api.telegram.org");
});

test("errorReason dedupes, bounds a cyclic chain, and survives non-Error values", () => {
  const a: Error & { cause?: unknown } = new Error("fetch failed");
  const b: Error & { cause?: unknown } = new Error("fetch failed");
  a.cause = b; b.cause = a;
  assert.equal(errorReason(a), "fetch failed");
  assert.equal(errorReason("plain string failure"), "plain string failure");
  assert.equal(errorReason(null), "unknown error");
});

test("errorReason never lets a bot token into the line", () => {
  const url = "https://api.telegram.org/bot123456:AAE-secret_token/getUpdates";
  const err = new TypeError("fetch failed", { cause: new Error("request to " + url + " failed") });
  const reason = errorReason(err);
  assert.equal(reason.includes("AAE-secret_token"), false);
  assert.match(reason, /bot<redacted>/);
  assert.equal(bridgePollFailureSummary("Dip Telegram", err).includes("123456"), false);
});

test("bridge summaries carry the cause in the house shape, capped at 200", () => {
  const err = new TypeError("fetch failed", { cause: Object.assign(new Error("socket hang up"), { code: "UND_ERR_SOCKET" }) });
  assert.equal(bridgePollFailureSummary("Dip Telegram", err),
    "Telegram bridge poll failed for channel Dip Telegram: fetch failed: socket hang up (UND_ERR_SOCKET)");
  assert.equal(bridgeFailureSummary("Dip Telegram", 42, err),
    "Telegram bridge failed on update 42 for channel Dip Telegram: fetch failed: socket hang up (UND_ERR_SOCKET)");
  // A causeless HTTP error reads exactly as before.
  assert.equal(bridgePollFailureSummary("Dip Telegram", new Error("Telegram request failed (HTTP 502)")),
    "Telegram bridge poll failed for channel Dip Telegram: Telegram request failed (HTTP 502)");
  const long = bridgePollFailureSummary("Dip Telegram", new Error("x".repeat(500)));
  assert.equal(long.length, 200);
});

test("a poll outage ledgers the transport cause once per streak", async () => {
  const root = mkdtempSync(join(tmpdir(), "sam-tg-cause-"));
  try {
    const channel = addChannel(root, "telegram", "Dip Telegram", "trading", "SAM_CHANNEL_TG_MAIN", [111]);
    const sam: SamClient = { ensureChat: async () => "sam-chat-1", postMessage: async () => "unused" };
    let polls = 0;
    const api = {
      getUpdates: async () => {
        polls++;
        throw new TypeError("fetch failed", { cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }) });
      },
      sendMessage: async () => {},
    };
    await runTelegramBridge({ root, channel, sam, api: api as unknown as TelegramApi, pollRetryDelayMs: 0, stop: () => polls >= 3 });
    const failures = readActivity(root, 50).filter(l => l.kind === "bridge-poll-failed");
    assert.equal(failures.length, 1);
    assert.match(failures[0].summary, /fetch failed: read ECONNRESET/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
