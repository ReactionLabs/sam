import test from "node:test";
import assert from "node:assert/strict";
import { decodePng, detectImageProtocol, renderHalfblocks, renderImage } from "./term-image.js";

// 4x2 RGB PNG: top row red/green/blue/white, bottom row black/yellow/cyan/magenta.
const FIXTURE = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAQAAAACCAIAAADwyuo0AAAAFklEQVR4nGP4z8DAAMZAwACmwWyG/wCJkAv1LUkLRwAAAABJRU5ErkJggg==", "base64");

test("term image: protocol detection prefers override, then kitty, then iterm2, else halfblock", () => {
  assert.equal(detectImageProtocol({ SAM_TUI_IMAGE: "kitty", TERM_PROGRAM: "iTerm.app" }), "kitty");
  assert.equal(detectImageProtocol({ SAM_TUI_IMAGE: "off" }), "none");
  assert.equal(detectImageProtocol({ KITTY_WINDOW_ID: "1" }), "kitty");
  assert.equal(detectImageProtocol({ TERM: "xterm-kitty" }), "kitty");
  assert.equal(detectImageProtocol({ TERM_PROGRAM: "iTerm.app" }), "iterm2");
  assert.equal(detectImageProtocol({ TERM_PROGRAM: "WezTerm" }), "iterm2");
  assert.equal(detectImageProtocol({}), "halfblock");
});

test("term image: the PNG decoder reads back exact pixels", () => {
  const img = decodePng(FIXTURE);
  assert.equal(img.width, 4);
  assert.equal(img.height, 2);
  const px = (x: number, y: number) => Array.from(img.rgba.subarray((y * 4 + x) * 4, (y * 4 + x) * 4 + 4));
  assert.deepEqual(px(0, 0), [255, 0, 0, 255]);
  assert.deepEqual(px(3, 0), [255, 255, 255, 255]);
  assert.deepEqual(px(1, 1), [255, 255, 0, 255]);
  assert.deepEqual(px(2, 1), [0, 255, 255, 255]);
  assert.throws(() => decodePng(Buffer.from("not a png")), /Not a PNG/);
});

test("term image: halfblocks pair top and bottom pixels into truecolor cells", () => {
  const out = renderHalfblocks(decodePng(FIXTURE), 4, 1);
  const lines = out.split("\n");
  assert.equal(lines.length, 1);
  assert.ok(lines[0].includes("38;2;255;0;0"), "red foreground on the first cell");
  assert.ok(lines[0].includes("48;2;0;0;0"), "black background under it");
  assert.equal((lines[0].match(/▀/g) ?? []).length, 4, "four cells for four columns");
});

test("term image: kitty and iterm2 paths hand the bytes to the terminal", () => {
  const kitty = renderImage(FIXTURE, { cols: 40, rows: 10, env: { SAM_TUI_IMAGE: "kitty" } });
  assert.ok(kitty.startsWith("\x1b_Ga=T,f=100,t=d;"));
  const iterm = renderImage(FIXTURE, { cols: 40, rows: 10, env: { SAM_TUI_IMAGE: "iterm2" }, name: "x.png" });
  assert.ok(iterm.includes("1337;File="));
  assert.throws(() => renderImage(Buffer.from("jpeg-bytes"), { cols: 40, rows: 10, env: {} }), /not a PNG/);
  assert.throws(() => renderImage(FIXTURE, { cols: 40, rows: 10, env: { SAM_TUI_IMAGE: "off" } }), /off/);
});
