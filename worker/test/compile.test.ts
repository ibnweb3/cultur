import { describe, expect, it } from "vitest";
import { buildPalette, contrast, toHex } from "../src/color";
import { compileDims, compileTokens, filterTags, type KeptTag } from "../src/compile";
import { RULES, matchRule, nonVisualReason, norm } from "../src/rules";

const kept = (names: [string, number][]): KeptTag[] => names.map(([name, affinity], rank) => ({ name, family: "decor", affinity, rank }));

describe("tag filter", () => {
  it("drops origin, venue and non-visual tags and keeps the top N by affinity", () => {
    const raw = [["French Inspired", 0.9], [" Parisian Bistro", 0.88], ["Minimalist", 0.85], ["Family Friendly", 0.8], ["Cozy", 0.7], ["Industrial", 0.6]].map(([name, affinity]) => ({ name: name as string, affinity: affinity as number }));
    const { kept: k, trace } = filterTags("decor", raw);
    expect(k.map((t) => t.name)).toEqual(["Minimalist", "Cozy", "Industrial"]);
    expect(trace.dropped.map((d) => d.tag)).toEqual(expect.arrayContaining(["French Inspired", "Parisian Bistro", "Family Friendly"]));
    expect(trace.dropped.every((d) => d.reason.length > 0)).toBe(true);
    expect(trace.kept.every((t) => t.rule !== null)).toBe(true);
  });
  it("caps kept tags at 8 and reports the rest as dropped", () => {
    const raw = Array.from({ length: 12 }, (_, i) => ({ name: `Vintage ${i}x`, affinity: 0.9 - i * 0.01 }));
    const { kept: k, trace } = filterTags("decor", raw);
    expect(k).toHaveLength(8);
    expect(trace.dropped.filter((d) => d.reason.startsWith("below top"))).toHaveLength(4);
  });
  it("classifies reasons", () => {
    expect(nonVisualReason("Japanese Inspired")).toContain("origin");
    expect(nonVisualReason("Wine Bar")).toContain("venue");
    expect(nonVisualReason("Americana")).toBeNull();
    expect(nonVisualReason("Mid Century")).toBeNull();
  });
});

describe("rule table", () => {
  it("has unique ids and no tag claimed by two rules", () => {
    expect(new Set(RULES.map((r) => r.id)).size).toBe(RULES.length);
    const seen = new Map<string, string>();
    for (const r of RULES) for (const t of r.tags) { const n = norm(t); expect(seen.has(n) ? `${n} in ${seen.get(n)} and ${r.id}` : "ok").toBe("ok"); seen.set(n, r.id); }
  });
  it("matches exact tags fully and single words partially", () => {
    expect(matchRule("Minimalist")?.match).toBe("exact");
    expect(matchRule("Vintage Chic")?.rule.id).toBe("R08");
    expect(matchRule("Rustic Chic")?.match).toBe("exact");
    expect(matchRule("Gothic Industrial Loft")?.match).toBe("word");
    expect(matchRule("Zzzz")).toBeNull();
  });
});

describe("token compilation", () => {
  it("is deterministic for the same tags", () => {
    const t = kept([["Minimalist", 0.84], ["Industrial", 0.78], ["Dark Wood", 0.75]]);
    expect(JSON.stringify(compileTokens(t))).toBe(JSON.stringify(compileTokens(t)));
  });
  it("derives values from rules and marks unsupported dimensions as defaults", () => {
    const { dims } = compileDims(kept([["Minimalist", 0.84], ["Industrial", 0.78]]));
    expect(dims.radius.source).toBe("rule");
    expect(Number(dims.radius.value)).toBeLessThan(3);
    expect(dims.motion.source).toBe("default");
    expect(dims.hue.source).toBe("default");
  });
  it("votes dark mode from dark-leaning tags and light from airy ones", () => {
    expect(compileDims(kept([["Dark Wood", 0.9], ["Speakeasy", 0.8]])).dims.mode.value).toBe("dark");
    expect(compileDims(kept([["Airy", 0.9], ["Coastal", 0.8]])).dims.mode.value).toBe("light");
  });
  it("takes the heaviest-weighted hue instead of averaging opposing ones", () => {
    expect(Number(compileDims(kept([["Western", 0.9], ["Warm", 0.9]])).dims.hue.value)).toBe(50);
    const opposed = compileDims(kept([["Coastal", 0.9], ["Beachy", 0.85], ["Nautical", 0.8], ["Western", 0.7]])).dims.hue.value;
    expect(Number(opposed)).toBe(215); // a circular mean would land on teal (~180), a colour neither tag implies
  });
  it("lists tags with no rule instead of guessing", () => {
    expect(compileTokens(kept([["Zzzz", 0.9], ["Cozy", 0.8]])).unmapped_tags).toEqual(["Zzzz"]);
  });
  it("gives every receipt a source and rule-sourced receipts at least one contribution", () => {
    const t = compileTokens(kept([["Minimalist", 0.84], ["Cozy", 0.8], ["Vintage", 0.7]]));
    for (const r of t.receipts) {
      expect(["rule", "default", "derived"]).toContain(r.source);
      if (r.source === "rule") expect(r.contributions.length).toBeGreaterThan(0);
    }
    expect(t.css_qv).toContain("--qv-radius");
    expect(t.css_shadcn).toContain("--primary-foreground");
  });
});

describe("accessibility gate", () => {
  it("passes WCAG AA for every pair across modes, hues and chroma", () => {
    for (const mode of ["light", "dark"] as const) for (const hue of [0, 45, 90, 145, 215, 260, 300, 340]) for (const chroma of [0.005, 0.05, 0.12, 0.2]) {
      const p = buildPalette({ mode, hue, chroma });
      for (const row of p.contrast) expect(row.pass, `${mode} ${hue} ${chroma} ${row.pair} ${row.ratio}`).toBe(true);
    }
  });
  it("computes contrast like WCAG", () => {
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 0);
    expect(contrast("#777777", "#ffffff")).toBeGreaterThan(4);
    expect(toHex({ l: 1, c: 0, h: 0 })).toBe("#ffffff");
  });
  it("records adjustments when it had to move a colour", () => {
    const p = buildPalette({ mode: "light", hue: 90, chroma: 0.2 });
    expect(p.gate === "pass" || p.adjustments.length > 0).toBe(true);
  });
});
