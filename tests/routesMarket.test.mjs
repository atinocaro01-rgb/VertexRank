// Guards the wiring that unit tests of lib/market.js can't see: every AI route must validate the country and
// append the market instruction to its system prompt(s). A route that forgets quietly goes back to assuming the US.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (r) => readFileSync(new URL(`../app/api/${r}/route.js`, import.meta.url), "utf8");
const MARKET_ROUTES = ["site-aeo-analysis", "site-geo-analysis", "site-keyword-clusters", "content-ideas", "competitor-suggestions", "site-competitor-analysis", "site-insights", "content-plan", "backlink-opportunities"];

for (const r of MARKET_ROUTES) {
  test(`${r}: validates the country and applies the market block to every system prompt`, () => {
    const src = read(r);
    assert.match(src, /const country = normalizeCountry\(body\?\.country\)/);
    const systems = [...src.matchAll(/const (system|pageSystem) = `[^`]*`( \+ marketPromptBlock\(country\))?;/g)];
    assert.ok(systems.length >= 1, "found no system prompt");
    for (const m of systems) assert.ok(m[2], `${m[1]} is missing marketPromptBlock(country)`);
  });
}

test("the AI visibility simulator validates its country too", () => {
  assert.match(read("ai-visibility-simulator"), /normalizeCountry\(body\?\.country\)/);
});
