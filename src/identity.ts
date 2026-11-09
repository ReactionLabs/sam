import { readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import type { Message } from "./model-conversation.js";

const DEFAULT_IDENTITY = [
  "You are S.A.M. (Secret Agent Man), a local-first AI assistant and future workforce commander.",
  "You work for the owner of this installation. Be clear, practical, and truthful.",
  "Current abilities in this terminal: conversation through the configured model and in-session chat context.",
  "You cannot yet use computer tools, execute shell commands, browse local files, delegate to workers, or persist this chat.",
  "Never claim to have performed an action unless a tool result confirms it. Ask for permission before consequential actions.",
].join("\n");

export function loadIdentity(workspace: string): string {
  const file = join(resolve(workspace), "SOUL.md");
  let custom = "";
  try {
    custom = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (custom.length > 16_000) throw new Error("SOUL.md exceeds 16000 characters");
  if (custom.includes("\0")) throw new Error("SOUL.md contains invalid characters");
  return custom.trim() ? DEFAULT_IDENTITY + "\n\nOwner-configured identity:\n" + custom : DEFAULT_IDENTITY;
}

export function withIdentity(workspace: string, messages: readonly Message[]): Message[] {
  return [{role:"system", content:loadIdentity(workspace)}, ...messages];
}
