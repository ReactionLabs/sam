// SAM in the terminal (Dip ask 2026-11-10: a "rat tui" - a Ratatui-grade
// terminal experience). `sam tui` opens with the S.A.M. splash, then drops
// into a live chat that rides the ONE shared turn (runChatTurn), so the
// terminal SAM has the same memory, law, tools, reactions, and skill-use
// ledger as every other surface. Images render in the transcript via
// term-image: /image <file>, or automatically when a reply names an image
// file that exists in the workspace. No new dependencies: raw ANSI and
// Node's own stdin raw mode carry the whole interface.

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { ChatStore } from "./chats.js";
import { runChatTurn } from "./agent-turn.js";
import { cliSourceMark } from "./message-provenance.js";
import { lastSkillByChat } from "./skill-use.js";
import { samBanner } from "./banner.js";
import { detectSetup } from "./config-wizard.js";
import { renderImageFile } from "./term-image.js";

const CYAN = "\x1b[38;2;34;211;238m";
const DIM = "\x1b[90m";
const BOLD = "\x1b[1m";
const RED = "\x1b[38;2;248;113;113m";
const RESET = "\x1b[0m";
const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function wrapText(text: string, width: number): string[] {
  const out: string[] = [];
  for (const rawLine of text.split("\n")) {
    if (rawLine.length <= width) { out.push(rawLine); continue; }
    let line = "";
    for (const word of rawLine.split(/\s+/)) {
      if (word.length > width) {
        if (line) { out.push(line); line = ""; }
        for (let i = 0; i < word.length; i += width) out.push(word.slice(i, i + width));
        continue;
      }
      if (line && line.length + 1 + word.length > width) { out.push(line); line = word; }
      else line = line ? line + " " + word : word;
    }
    if (line) out.push(line);
  }
  return out.length ? out : [""];
}

export async function runTui(root: string, opts: { profile?: string; bannerOnly?: boolean } = {}): Promise<void> {
  const profile = opts.profile ?? "sam";
  const color = !!process.stdout.isTTY;
  const cols = () => Math.max(30, process.stdout.columns ?? 80);
  const paint = (code: string, text: string) => (color ? code + text + RESET : text);
  const banner = () => samBanner({ profile, model: process.env.SAM_MODEL, workspace: root, color, cols: cols() });

  if (opts.bannerOnly) {
    process.stdout.write(banner());
    return;
  }

  // First run (CLI dressing item 1): if detection says the model is not
  // configured, the splash leads to setup, not to a chat whose first
  // message dies on "Model not configured". Print what was detected and
  // the exact setup path, then stop under the banner.
  let firstRun = false;
  let detectionLines: string[] = [];
  try {
    const d = detectSetup(root);
    firstRun = d.firstRun;
    if (firstRun) {
      detectionLines = [
        "SAM is not set up yet on this install - no working model connection was detected.",
        "  model: " + (d.model ?? "(not set)") + " · api key: " + d.apiKey + " · endpoint: " + (d.endpoint ?? "(none resolved)"),
        ...d.nextSteps.map(s => "  - " + s),
        "Run `sam config` to open the setup wizard, or `sam config setup --live` to verify the model and record the setup.",
      ];
    }
  } catch { /* a detection failure never blocks the splash */ }
  if (firstRun) {
    process.stdout.write(banner());
    for (const line of detectionLines) process.stdout.write(paint(DIM, line) + "\n");
    return;
  }

  if (!process.stdin.isTTY) {
    process.stdout.write(banner());
    process.stdout.write(paint(DIM, "The TUI needs an interactive terminal; that was just the splash. Run `sam tui` in your terminal to talk.") + "\n");
    return;
  }

  const db = new ChatStore(root);
  let chatId: string;
  try {
    const existing = db.list({ includeArchived: true }).find((c) => c.title === "Terminal" && (c.agent_name ?? "sam") === profile && !c.visitor && !c.archived);
    chatId = existing ? existing.id : db.create("Terminal", profile === "sam" ? null : profile).id;
  } finally {
    db.close();
  }

  const out = process.stdout;
  const stdin = process.stdin;
  out.write(banner());
  out.write(paint(DIM, "Talking to the \"" + profile + "\" profile. This conversation is saved as the Terminal chat.") + "\n\n");

  let buffer = "";
  let cursor = 0;
  let busy = false;
  let spinner: ReturnType<typeof setInterval> | null = null;
  const history: string[] = [];
  let historyAt = -1;
  const PROMPT = paint(CYAN + BOLD, "you › ");

  const redraw = () => {
    out.write("\r\x1b[2K" + PROMPT + buffer);
    if (cursor < buffer.length) out.write(`\x1b[${buffer.length - cursor}D`);
  };
  const stopSpinner = () => {
    if (spinner) { clearInterval(spinner); spinner = null; }
    out.write("\r\x1b[2K");
  };
  const startSpinner = () => {
    let i = 0;
    spinner = setInterval(() => {
      out.write("\r\x1b[2K" + paint(DIM, FRAMES[i++ % FRAMES.length] + " SAM is working…"));
    }, 120);
  };
  const printBlock = (text: string) => {
    for (const line of wrapText(text, cols() - 2)) out.write(line + "\r\n");
    out.write("\r\n");
  };
  const printReply = (reply: string) => {
    const lines = wrapText(reply, cols() - 7);
    lines.forEach((line, i) => {
      out.write((i === 0 ? paint(CYAN + BOLD, "SAM › ") : "      ") + line + "\r\n");
    });
    out.write("\r\n");
  };
  const showImage = (pathArg: string) => {
    const cleaned = pathArg.trim().replace(/^["']|["']$/g, "");
    if (!cleaned) { out.write(paint(DIM, "Usage: /image <file>") + "\r\n\r\n"); return; }
    const candidate = existsSync(cleaned) ? cleaned : existsSync(join(root, cleaned)) ? join(root, cleaned) : resolve(cleaned);
    if (!existsSync(candidate)) { out.write(paint(RED, "No such file: " + cleaned) + "\r\n\r\n"); return; }
    try {
      out.write(renderImageFile(candidate, { cols: cols() - 2, rows: 20 }).replace(/\n/g, "\r\n"));
      out.write(paint(DIM, cleaned) + "\r\n\r\n");
    } catch (err) {
      out.write(paint(RED, err instanceof Error ? err.message : String(err)) + "\r\n\r\n");
    }
  };
  const autoImages = (reply: string) => {
    const tokens = reply.match(/[^\s"']+\.(?:png|jpe?g)/gi) ?? [];
    for (const token of new Set(tokens)) {
      const candidate = existsSync(token) ? token : existsSync(join(root, token)) ? join(root, token) : null;
      if (!candidate) continue;
      try {
        out.write(renderImageFile(candidate, { cols: cols() - 2, rows: 16 }).replace(/\n/g, "\r\n"));
        out.write(paint(DIM, token) + "\r\n\r\n");
      } catch { /* a picture that cannot render never breaks the conversation */ }
    }
  };

  let resolveDone: () => void = () => {};
  const done = new Promise<void>((r) => { resolveDone = r; });
  const cleanup = () => {
    stopSpinner();
    try { stdin.setRawMode(false); } catch { /* already restored */ }
    stdin.pause();
    stdin.removeListener("data", onData);
  };
  const quit = () => {
    cleanup();
    out.write("\r\n" + paint(DIM, "SAM is still running everywhere else. Bye.") + "\r\n");
    resolveDone();
  };

  const submit = async (text: string) => {
    if (text.startsWith("/")) {
      const [cmd, ...rest] = text.split(/\s+/);
      const arg = rest.join(" ");
      if (cmd === "/quit" || cmd === "/exit") { quit(); return; }
      if (cmd === "/help") {
        printBlock("Commands: /image <file> renders an image here · /clear reprints the splash · /quit leaves (SAM keeps running). Anything else is a message to SAM. Ctrl+C also leaves.");
      } else if (cmd === "/clear") {
        out.write("\x1b[2J\x1b[H");
        out.write(banner().replace(/\n/g, "\r\n"));
      } else if (cmd === "/image") {
        showImage(arg);
      } else {
        out.write(paint(RED, "Unknown command " + cmd + " - /help lists them.") + "\r\n\r\n");
      }
      redraw();
      return;
    }
    busy = true;
    const startedAt = Date.now();
    const mark = cliSourceMark("ts-cli");
    if (mark) out.write(paint(DIM, mark) + "\r\n");
    startSpinner();
    try {
      const reply = await runChatTurn(root, chatId, text, { source: "ts-cli" });
      stopSpinner();
      printReply(reply);
      const used = lastSkillByChat(root).get(chatId);
      if (used && Date.parse(used.at) >= startedAt - 5000) out.write(paint(DIM, "skill: " + used.skill) + "\r\n\r\n");
      autoImages(reply);
    } catch (err) {
      stopSpinner();
      out.write(paint(RED, "Error: " + (err instanceof Error ? err.message : String(err))) + "\r\n\r\n");
    } finally {
      busy = false;
      redraw();
    }
  };

  const onData = (chunk: string) => {
    if (chunk === "\x1b[A" || chunk === "\x1b[B" || chunk === "\x1b[C" || chunk === "\x1b[D") {
      if (busy) return;
      if (chunk === "\x1b[A" && history.length) {
        historyAt = historyAt < 0 ? history.length - 1 : Math.max(0, historyAt - 1);
        buffer = history[historyAt]; cursor = buffer.length; redraw();
      } else if (chunk === "\x1b[B" && historyAt >= 0) {
        historyAt = historyAt + 1 >= history.length ? -1 : historyAt + 1;
        buffer = historyAt < 0 ? "" : history[historyAt]; cursor = buffer.length; redraw();
      } else if (chunk === "\x1b[C") { cursor = Math.min(buffer.length, cursor + 1); redraw(); }
      else if (chunk === "\x1b[D") { cursor = Math.max(0, cursor - 1); redraw(); }
      return;
    }
    for (const ch of chunk) {
      if (ch === "\x03") { quit(); return; }
      if (busy) continue;
      if (ch === "\x04") { if (!buffer) { quit(); return; } continue; }
      if (ch === "\r" || ch === "\n") {
        const text = buffer.trim();
        out.write("\r\n");
        buffer = ""; cursor = 0; historyAt = -1;
        if (!text) { redraw(); continue; }
        history.push(text);
        void submit(text);
        continue;
      }
      if (ch === "\x7f" || ch === "\x08") {
        if (cursor > 0) { buffer = buffer.slice(0, cursor - 1) + buffer.slice(cursor); cursor--; redraw(); }
        continue;
      }
      if (ch === "\x01") { cursor = 0; redraw(); continue; }
      if (ch === "\x05") { cursor = buffer.length; redraw(); continue; }
      if (ch === "\x15") { buffer = ""; cursor = 0; redraw(); continue; }
      if (ch >= " " && ch !== "\x7f") {
        buffer = buffer.slice(0, cursor) + ch + buffer.slice(cursor);
        cursor++;
        redraw();
      }
    }
  };

  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  stdin.on("data", onData);
  stdin.on("end", () => { cleanup(); resolveDone(); });
  redraw();
  await done;
}
