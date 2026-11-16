// The S.A.M. startup splash (Dip ask 2026-11-10: "spell out Sam when u
// first start it"). Bubble-letter wordmark in the spirit of Dip's 70s
// SAM poster (restyle 2026-11-15): rounded block glyphs running a
// mustard-to-burnt-orange gradient, the tagline from the original
// reference art between two poster sparkles, the status line in CRT
// green (the instrument color), hints in olive. Pure string building
// so the splash is unit-testable and
// identical on every surface that prints it; color is the caller's
// call (theme.ts owns the TTY / NO_COLOR / SAM_PLAIN decision).

const GLYPHS: Record<string, string[]> = {
  S: [
    " ▄████▄ ",
    "██      ",
    " ▀████▄ ",
    "      ██",
    " ▄████▀ ",
  ],
  A: [
    " ▄████▄ ",
    "██    ██",
    "████████",
    "██    ██",
    "██    ██",
  ],
  M: [
    "███    ███",
    "████  ████",
    "██ ▀██▀ ██",
    "██      ██",
    "██      ██",
  ],
  ".": [
    "   ",
    "   ",
    "   ",
    "   ",
    "██ ",
  ],
  PROMPT: [
    "    ",
    "    ",
    " >_ ",
    "    ",
    "    ",
  ],
};

// Poster gradient between Dip's specified tokens (2026-11-15):
// mustard #D5AC40 at the top edge to burnt orange #E86C25 at the baseline.
const ROW_COLORS: Array<[number, number, number]> = [
  [213, 172, 64],
  [218, 156, 57],
  [222, 140, 50],
  [227, 124, 44],
  [232, 108, 37],
];

const TAGLINE_RGB: [number, number, number] = [213, 172, 64];
const SPARKLE_RGB: [number, number, number] = [232, 108, 37];
const STATUS_RGB: [number, number, number] = [134, 226, 154];
const HINTS_RGB: [number, number, number] = [78, 88, 57];

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
  const tagline = "✶ Self-directed AI Workforce ✶";
  const tagPad = cols > width + 4 ? " ".repeat(Math.max(0, Math.floor((cols - tagline.length) / 2))) : pad;
  lines.push("");
  if (opts.color) {
    const sparkle = `\x1b[38;2;${SPARKLE_RGB[0]};${SPARKLE_RGB[1]};${SPARKLE_RGB[2]}m`;
    const gold = `\x1b[1m\x1b[38;2;${TAGLINE_RGB[0]};${TAGLINE_RGB[1]};${TAGLINE_RGB[2]}m`;
    lines.push(tagPad + sparkle + "✶" + "\x1b[0m " + gold + "Self-directed AI Workforce" + "\x1b[0m " + sparkle + "✶" + "\x1b[0m");
  } else {
    lines.push(tagPad + tagline);
  }
  const statusRgb = `\x1b[38;2;${STATUS_RGB[0]};${STATUS_RGB[1]};${STATUS_RGB[2]}m`;
  const hintsRgb = `\x1b[38;2;${HINTS_RGB[0]};${HINTS_RGB[1]};${HINTS_RGB[2]}m`;
  const status = `profile ${opts.profile}` + (opts.model ? ` · model ${opts.model}` : "") + ` · ${opts.workspace}`;
  lines.push(pad + (opts.color ? statusRgb + status + "\x1b[0m" : status));
  const hints = "Type to talk · /image <file> shows an image · /help · /quit";
  lines.push(pad + (opts.color ? hintsRgb + hints + "\x1b[0m" : hints));
  lines.push("");
  return lines.join("\n") + "\n";
}
