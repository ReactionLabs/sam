// The poster theme (Dip order 2026-11-15): Sam's human-facing command
// line dressed in the palette Dip specified from his 70s SAM poster -
// what 1967 imagined the year 2000 looked like. Groovy skin, precise
// text: styling only ever WRAPS the exact words the plain path prints,
// and error text is never routed through here.
//
// The hard guardrail (CLI-first parity: scripts are first-class
// consumers and must never see the costume): paint exists ONLY when
// stdout is a TTY and NO_COLOR is unset and SAM_PLAIN is not "1".
// Every helper is the identity function when the theme is off, so a
// piped or --json run is byte-identical to the unthemed CLI.
//
// This module is the ONE home of the palette: when the shared Design
// Bible tokens land, their ANSI mapping drops in here and every
// surface follows. Roles: mustard and burnt orange are the
// headquarters layer (headers, keys, the wordmark); deep purple is
// structural (rules); olive is the quiet tone (nulls, hints); CRT
// green is the instrument color, reserved for live status readouts
// (numbers, states, the success sparkle).

type Rgb = readonly [number, number, number];

export const POSTER = {
  /** Mustard #D5AC40 - headquarters: headers, keys, the wordmark. */
  mustard: [213, 172, 64] as Rgb,
  /** Burnt orange #E86C25 - headquarters: leads, values, command names. */
  orange: [232, 108, 37] as Rgb,
  /** Deep purple #392348 - structure: rules and dividers. */
  purple: [57, 35, 72] as Rgb,
  /** Olive #4E5839 - the quiet tone: nulls, hints, secondary text. */
  olive: [78, 88, 57] as Rgb,
  /** CRT green #86E29A - the instrument color: live status readouts. */
  crt: [134, 226, 154] as Rgb,
};

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";

function fg(rgb: Rgb): string {
  return `\x1b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m`;
}

/** The one decision every painted surface shares. */
export function grooveEnabled(
  env: NodeJS.ProcessEnv = process.env,
  stream: { isTTY?: boolean } = process.stdout,
): boolean {
  if (!stream.isTTY) return false;
  if (env.NO_COLOR !== undefined) return false;
  if (env.SAM_PLAIN === "1") return false;
  return true;
}

export function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

const JSON_TOKEN = /("(?:\\.|[^"\\])*")(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false)\b|\b(null)\b/g;

/**
 * Paint a pretty-printed JSON document in the palette: keys bold
 * mustard, string values burnt orange, numbers CRT green (the
 * instrument readout), booleans plain mustard, null quiet olive.
 * Pure decoration: stripAnsi(colorizeJson(x)) === x.
 */
export function colorizeJson(text: string): string {
  return text.replace(JSON_TOKEN, (match, str?: string, colon?: string, num?: string, bool?: string, nul?: string) => {
    if (str !== undefined) {
      return colon !== undefined
        ? BOLD + fg(POSTER.mustard) + str + RESET + colon
        : fg(POSTER.orange) + str + RESET;
    }
    if (num !== undefined) return fg(POSTER.crt) + num + RESET;
    if (bool !== undefined) return fg(POSTER.mustard) + bool + RESET;
    if (nul !== undefined) return fg(POSTER.olive) + nul + RESET;
    return match;
  });
}

const HELP_SECTIONS = new Set(["Options:", "Arguments:", "Commands:", "Global Options:"]);

/**
 * Paint a commander help screen: the Usage lead and section headers
 * bold in the palette, command names in burnt orange. Wording,
 * spacing, and order are untouched: stripAnsi(colorizeHelp(x)) === x.
 */
export function colorizeHelp(text: string): string {
  let section = "";
  return text
    .split("\n")
    .map((line) => {
      if (line.startsWith("Usage:")) return BOLD + fg(POSTER.orange) + "Usage:" + RESET + line.slice("Usage:".length);
      const trimmed = line.trim();
      if (HELP_SECTIONS.has(trimmed) && line === trimmed) {
        section = trimmed;
        return BOLD + fg(POSTER.mustard) + line + RESET;
      }
      if (section === "Commands:") {
        const m = /^(\s+)(\S+)(.*)$/.exec(line);
        if (m) return m[1] + fg(POSTER.orange) + m[2] + RESET + m[3];
        if (trimmed === "") section = "";
      }
      return line;
    })
    .join("\n");
}

export interface Theme {
  readonly on: boolean;
  /** A success / confirmation line: a CRT-green sparkle, the words untouched. */
  ok(text: string): string;
  /** A startup lead line, bold burnt orange. */
  lead(text: string): string;
  /** A quiet supporting line, olive. */
  dim(text: string): string;
  /** The `== Title (state) ==` section header shape, painted. */
  sectionHeader(title: string, state: string): string;
  /** A purple rule with a mustard sparkle at its heart. */
  divider(width?: number): string;
  /** Pretty-printed JSON, painted when on, untouched when off. */
  json(text: string): string;
  /** A commander help screen, painted when on, untouched when off. */
  help(text: string): string;
}

export function makeTheme(on: boolean): Theme {
  if (!on) {
    return {
      on: false,
      ok: (t) => t,
      lead: (t) => t,
      dim: (t) => t,
      sectionHeader: (title, state) => `== ${title} (${state}) ==`,
      divider: () => "",
      json: (t) => t,
      help: (t) => t,
    };
  }
  return {
    on: true,
    ok: (t) => BOLD + fg(POSTER.crt) + "✦" + RESET + " " + t,
    lead: (t) => BOLD + fg(POSTER.orange) + t + RESET,
    dim: (t) => fg(POSTER.olive) + t + RESET,
    sectionHeader: (title, state) =>
      BOLD + fg(POSTER.mustard) + `== ${title} ==` + RESET + " " + fg(POSTER.crt) + `(${state})` + RESET,
    divider: (width = 44) => {
      const half = Math.max(1, Math.floor((width - 1) / 2));
      return fg(POSTER.purple) + "─".repeat(half) + RESET + fg(POSTER.mustard) + "✶" + RESET + fg(POSTER.purple) + "─".repeat(width - 1 - half) + RESET;
    },
    json: (t) => colorizeJson(t),
    help: (t) => colorizeHelp(t),
  };
}
