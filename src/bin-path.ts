import { existsSync } from "node:fs";
import { delimiter as hostDelimiter, join } from "node:path";

/**
 * PATH lookup shared by the engine binary and the senses reader.
 *
 * A hard-coded ":" split cuts a Windows drive path in half
 * (`C:\Program Files\...` becomes `C` and `\Program Files\...`).
 * The separator is path.delimiter on the host, and tests can inject
 * a platform and a delimiter so a Linux run can prove the win32
 * shape. On win32 a command is resolved as .exe, then .cmd, then
 * the bare name. The caller still decides with lstat whether the
 * candidate is a file; this module only builds the path strings.
 */
export interface BinaryProbe {
  platform?: NodeJS.Platform;
  delimiter?: string;
}

export function probePlatform(probe?: BinaryProbe): NodeJS.Platform {
  return probe?.platform ?? process.platform;
}

/** path.delimiter when resolving for this host. An injected platform
 *  that is not the host uses ";" on win32 and ":" elsewhere, unless
 *  the caller passes a delimiter of its own. */
export function probeDelimiter(probe?: BinaryProbe): string {
  if (probe?.delimiter !== undefined) return probe.delimiter;
  const platform = probePlatform(probe);
  if (!probe?.platform || platform === process.platform) return hostDelimiter;
  return platform === "win32" ? ";" : ":";
}

export function commandFileNames(command: string, platform: NodeJS.Platform): string[] {
  if (platform !== "win32") return [command];
  const lower = command.toLowerCase();
  if (lower.endsWith(".exe") || lower.endsWith(".cmd")) return [command];
  return [command + ".exe", command + ".cmd", command];
}

/** Full candidate paths, PATH order, then extension order. */
export function commandCandidates(pathValue: string | undefined, delimiter: string, command: string, platform: NodeJS.Platform): string[] {
  const names = commandFileNames(command, platform);
  const found: string[] = [];
  for (const dir of (pathValue ?? "").split(delimiter).filter(Boolean)) {
    for (const name of names) found.push(join(dir, name));
  }
  return found;
}

/** SAM_ENGINE_BIN / SAM_GOG_BIN. On win32, a path that is not
 *  present may still have a .exe or .cmd beside it. An exact hit
 *  is kept, including when it is a symlink: the caller's lstat
 *  probe is what decides, and this function does not follow links
 *  to invent a file the probe would reject. */
export function namedExecutable(named: string, platform: NodeJS.Platform): string {
  if (platform !== "win32") return named;
  if (existsSync(named)) return named;
  const lower = named.toLowerCase();
  if (lower.endsWith(".exe") || lower.endsWith(".cmd")) return named;
  if (existsSync(named + ".exe")) return named + ".exe";
  if (existsSync(named + ".cmd")) return named + ".cmd";
  return named;
}

/** The win32 entry the fixture points SAM_ENGINE_BIN at: cmd.exe
 *  runs node on the .mjs and forwards the engine's argv. */
export function windowsCmdShim(nodePath: string, scriptPath: string): string {
  return `@echo off\r\n"${nodePath}" "${scriptPath}" %*\r\n`;
}
