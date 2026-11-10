import test from "node:test";
import assert from "node:assert/strict";
import { samBanner, samWordmark } from "./banner.js";

test("banner: the wordmark spells S.A.M. in five block rows of equal width", () => {
  const rows = samWordmark();
  assert.equal(rows.length, 5);
  assert.ok(rows.every((r) => r.length === rows[0].length), "rows align");
  assert.ok(rows.every((r) => r.includes("█")), "every row carries blocks");
  assert.ok(rows[2].includes(">"), "the prompt glyph rides the middle row");
  assert.ok(rows[4].includes("██"), "the periods land on the baseline row");
});

test("banner: tagline, status, and hints; color only when asked", () => {
  const plain = samBanner({ profile: "dip", model: "MiniMax-M2.5", workspace: "/opt/sam/home", color: false });
  assert.match(plain, /Self-directed AI Workforce/);
  assert.match(plain, /profile dip · model MiniMax-M2\.5 · \/opt\/sam\/home/);
  assert.match(plain, /\/image <file> shows an image/);
  assert.ok(!plain.includes("\x1b"), "no escapes in plain mode");
  const colored = samBanner({ profile: "dip", workspace: "/opt/sam/home", color: true });
  assert.ok(colored.includes("\x1b[38;2;"), "truecolor gradient in color mode");
});
