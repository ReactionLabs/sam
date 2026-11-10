// Images in the terminal (Dip ask 2026-11-10: SAM's TUI should "show
// images in the terminal"). Three render paths, picked by what the
// terminal in front of SAM actually supports:
// - Kitty graphics protocol and the iTerm2 inline-image protocol hand the
//   file bytes to the terminal, which decodes and draws the real image.
// - Everywhere else, a self-contained PNG decoder (Node's built-in zlib is
//   the only machinery) feeds an ANSI truecolor half-block renderer, so a
//   picture still appears, just at character resolution.
// SAM_TUI_IMAGE overrides detection: kitty | iterm2 | halfblock | off.

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { inflateSync } from "node:zlib";

export type ImageProtocol = "kitty" | "iterm2" | "halfblock" | "none";

export function detectImageProtocol(env: NodeJS.ProcessEnv): ImageProtocol {
  const override = (env.SAM_TUI_IMAGE ?? "").toLowerCase();
  if (override === "kitty" || override === "iterm2" || override === "halfblock") return override;
  if (override === "off" || override === "none") return "none";
  if (env.KITTY_WINDOW_ID || (env.TERM ?? "").includes("kitty")) return "kitty";
  const program = env.TERM_PROGRAM ?? "";
  if (program === "iTerm.app" || program === "WezTerm") return "iterm2";
  return "halfblock";
}

export interface DecodedImage {
  width: number;
  height: number;
  rgba: Uint8Array;
}

export function decodePng(bytes: Uint8Array): DecodedImage {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 8 || signature.some((b, i) => bytes[i] !== b)) throw new Error("Not a PNG file");
  const u32 = (o: number) => ((bytes[o] << 24) | (bytes[o + 1] << 16) | (bytes[o + 2] << 8) | bytes[o + 3]) >>> 0;
  let width = 0, height = 0, colorType = -1;
  let palette: Uint8Array | null = null;
  let transparency: Uint8Array | null = null;
  const idat: Buffer[] = [];
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = u32(offset);
    const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
    const dataAt = offset + 8;
    if (type === "IHDR") {
      width = u32(dataAt);
      height = u32(dataAt + 4);
      const bitDepth = bytes[dataAt + 8];
      colorType = bytes[dataAt + 9];
      const interlace = bytes[dataAt + 12];
      if (bitDepth !== 8) throw new Error("Only 8-bit PNG images render in the fallback path");
      if (interlace !== 0) throw new Error("Interlaced PNG images do not render in the fallback path");
    } else if (type === "IDAT") {
      idat.push(Buffer.from(bytes.subarray(dataAt, dataAt + length)));
    } else if (type === "PLTE") {
      palette = Uint8Array.from(bytes.subarray(dataAt, dataAt + length));
    } else if (type === "tRNS") {
      transparency = Uint8Array.from(bytes.subarray(dataAt, dataAt + length));
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + length;
  }
  if (!width || !height || colorType < 0 || idat.length === 0) throw new Error("PNG is missing its header or image data");
  const channels = colorType === 0 || colorType === 3 ? 1 : colorType === 2 ? 3 : colorType === 4 ? 2 : colorType === 6 ? 4 : 0;
  if (!channels) throw new Error("Unsupported PNG color type " + colorType);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const plain = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const row = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const out = plain.subarray(y * stride, y * stride + stride);
    const up = y > 0 ? plain.subarray((y - 1) * stride, (y - 1) * stride + stride) : null;
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? out[x - channels] : 0;
      const above = up ? up[x] : 0;
      const aboveLeft = up && x >= channels ? up[x - channels] : 0;
      let value = row[x];
      if (filter === 1) value = (value + left) & 0xff;
      else if (filter === 2) value = (value + above) & 0xff;
      else if (filter === 3) value = (value + Math.floor((left + above) / 2)) & 0xff;
      else if (filter === 4) {
        const p = left + above - aboveLeft;
        const pa = Math.abs(p - left), pb = Math.abs(p - above), pc = Math.abs(p - aboveLeft);
        value = (value + (pa <= pb && pa <= pc ? left : pb <= pc ? above : aboveLeft)) & 0xff;
      } else if (filter !== 0) {
        throw new Error("Unsupported PNG filter " + filter);
      }
      out[x] = value;
    }
  }
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const s = i * channels, d = i * 4;
    if (colorType === 0) {
      rgba[d] = rgba[d + 1] = rgba[d + 2] = plain[s];
      rgba[d + 3] = 255;
    } else if (colorType === 2) {
      rgba[d] = plain[s]; rgba[d + 1] = plain[s + 1]; rgba[d + 2] = plain[s + 2]; rgba[d + 3] = 255;
    } else if (colorType === 3) {
      const index = plain[s];
      if (!palette || index * 3 + 2 >= palette.length) throw new Error("PNG palette index out of range");
      rgba[d] = palette[index * 3]; rgba[d + 1] = palette[index * 3 + 1]; rgba[d + 2] = palette[index * 3 + 2];
      rgba[d + 3] = transparency && index < transparency.length ? transparency[index] : 255;
    } else if (colorType === 4) {
      rgba[d] = rgba[d + 1] = rgba[d + 2] = plain[s];
      rgba[d + 3] = plain[s + 1];
    } else {
      rgba[d] = plain[s]; rgba[d + 1] = plain[s + 1]; rgba[d + 2] = plain[s + 2]; rgba[d + 3] = plain[s + 3];
    }
  }
  return { width, height, rgba };
}

function sample(img: DecodedImage, x0: number, y0: number, x1: number, y1: number): [number, number, number] {
  let r = 0, g = 0, b = 0, n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * img.width + x) * 4;
      const a = img.rgba[i + 3] / 255;
      r += img.rgba[i] * a; g += img.rgba[i + 1] * a; b += img.rgba[i + 2] * a;
      n++;
    }
  }
  if (!n) return [0, 0, 0];
  return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
}

export function renderHalfblocks(img: DecodedImage, maxCols: number, maxRows: number): string {
  let outW = Math.max(1, Math.min(maxCols, img.width));
  let outH = Math.max(1, Math.round((img.height * outW) / img.width));
  if (Math.ceil(outH / 2) > maxRows) {
    outH = Math.max(1, maxRows * 2);
    outW = Math.max(1, Math.round((img.width * outH) / img.height));
  }
  const cellRows = Math.ceil(outH / 2);
  const lines: string[] = [];
  for (let cy = 0; cy < cellRows; cy++) {
    let line = "";
    for (let cx = 0; cx < outW; cx++) {
      const sx0 = Math.floor((cx * img.width) / outW), sx1 = Math.max(sx0 + 1, Math.floor(((cx + 1) * img.width) / outW));
      const ty = cy * 2, by = cy * 2 + 1;
      const sy0 = Math.floor((ty * img.height) / outH), sy1 = Math.max(sy0 + 1, Math.floor(((ty + 1) * img.height) / outH));
      const top = sample(img, sx0, sy0, sx1, sy1);
      let bottom: [number, number, number] = [0, 0, 0];
      if (by < outH) {
        const by0 = Math.floor((by * img.height) / outH), by1 = Math.max(by0 + 1, Math.floor(((by + 1) * img.height) / outH));
        bottom = sample(img, sx0, by0, sx1, by1);
      }
      line += `\x1b[38;2;${top[0]};${top[1]};${top[2]}m\x1b[48;2;${bottom[0]};${bottom[1]};${bottom[2]}m\u2580`;
    }
    lines.push(line + "\x1b[0m");
  }
  return lines.join("\n");
}

export function renderImage(bytes: Uint8Array, opts: { cols: number; rows: number; env?: NodeJS.ProcessEnv; name?: string }): string {
  const env = opts.env ?? process.env;
  const protocol = detectImageProtocol(env);
  if (protocol === "none") throw new Error("Terminal images are off (SAM_TUI_IMAGE=off)");
  if (protocol === "kitty") {
    const b64 = Buffer.from(bytes).toString("base64");
    const CHUNK = 4096;
    if (b64.length <= CHUNK) return `\x1b_Ga=T,f=100,t=d;${b64}\x1b\\` + "\n";
    let out = "";
    for (let i = 0; i < b64.length; i += CHUNK) {
      const last = i + CHUNK >= b64.length;
      const head = i === 0 ? "a=T,f=100,t=d," : "";
      out += `\x1b_G${head}m=${last ? 0 : 1};${b64.slice(i, i + CHUNK)}\x1b\\`;
    }
    return out + "\n";
  }
  if (protocol === "iterm2") {
    const b64 = Buffer.from(bytes).toString("base64");
    const name = Buffer.from(opts.name ?? "image").toString("base64");
    return `\x1b]1337;File=name=${name};size=${bytes.length};inline=1;width=${Math.max(1, opts.cols)};preserveAspectRatio=1:${b64}\x07` + "\n";
  }
  const isPng = bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  if (!isPng) throw new Error("This terminal renders PNG images at character resolution; that file is not a PNG. In a Kitty or iTerm2 terminal the same file displays natively.");
  return renderHalfblocks(decodePng(bytes), opts.cols, opts.rows) + "\n";
}

export function renderImageFile(path: string, opts: { cols: number; rows: number; env?: NodeJS.ProcessEnv }): string {
  return renderImage(readFileSync(path), { ...opts, name: basename(path) });
}
