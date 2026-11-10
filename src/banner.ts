// The S.A.M. startup splash (Dip ask 2026-11-10: "spell out Sam when u
// first start it"). Block-letter wordmark in a cyan top-to-bottom gradient,
// matching the terminal-glow reference art Dip supplied, with the tagline
// from that art. Pure string building so the splash is unit-testable and
// identical on every surface that prints it.

const GLYPHS: Record<string, string[]> = {
  S: [
    " ██████",
    "██     ",
    " █████ ",
    "     ██",
    "██████ ",
  ],
  A: [
    " █████ ",
    "██   ██",
    "███████",
    "██   ██",
    "██   ██",
  ],
  M: [
    "███   ███",
    "████ ████",
    "██ ███ ██",
    "██  █  ██",
    "██     ██",
  ],
  ".": [
    "  ",
    "  ",
    "  ",
    "  ",
    "██",
  ],
  PROMPT: [
    "    ",
    "    ",
    " >_ ",
    "    ",
    "    ",
  ],
};

// Cyan gradient, bright at the top edge to deep at the baseline.
const ROW_COLORS: Array<[number, number, number]> = [
  [165, 243, 252],
  [103, 232, 249],
  [34, 211, 238],
  [6, 182, 212],
  [8, 145, 178],
];

export function samWordmark(): string[] {
  const parts = [GLYPHS.PROMPT, GLYPHS.S, GLYPHS["."], GLYPHS.A, GLYPHS["."], GLYPHS.M];
  const rows: string[] = [];
  for (let r = 0; r < 5; r++) rows.push(parts.map((g) => g[r]).join(" "));
  return rows;
}

export function samBanner(opts: { profile: string; model?: string; workspace: string; color: boolean; cols?: number }): string {
  const mark = samWordmark();
  const width = mark[0].length;
  const cols = opts.cols ?? 0;
  const pad = cols > width + 4 ? " ".repeat(Math.floor((cols - width) / 2)) : "";
  const lines: string[] = [""];
  mark.forEach((row, i) => {
    if (opts.color) {
      const [r, g, b] = ROW_COLORS[i];
      lines.push(pad + `\x1b[1m\x1b[38;2;${r};${g};${b}m` + row + "\x1b[0m");
    } else {
      lines.push(pad + row);
    }
  });
  const tagline = "Self-directed AI Workforce";
  const tagPad = cols > width + 4 ? " ".repeat(Math.max(0, Math.floor((cols - tagline.length) / 2))) : pad;
  lines.push("");
  lines.push(tagPad + (opts.color ? "\x1b[38;2;34;211;238m" + tagline + "\x1b[0m" : tagline));
  const status = `profile ${opts.profile}` + (opts.model ? ` · model ${opts.model}` : "") + ` · ${opts.workspace}`;
  lines.push(pad + (opts.color ? "\x1b[90m" + status + "\x1b[0m" : status));
  const hints = "Type to talk · /image <file> shows an image · /help · /quit";
  lines.push(pad + (opts.color ? "\x1b[90m" + hints + "\x1b[0m" : hints));
  lines.push("");
  return lines.join("\n") + "\n";
}
