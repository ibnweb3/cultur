import { describe, expect, it } from "vitest";
import type { Json } from "../src/types";
import { InvalidInput, parseSeeds } from "../src/vibe";
import { FakeQloo, makeSvc } from "./helpers";

describe("parseSeeds", () => {
  it("extracts seeds from natural phrasing", () => {
    expect(parseSeeds("fans of A24 films, Slowdive and Aesop skincare")).toEqual(["A24", "Slowdive", "Aesop"]);
    expect(parseSeeds("Slowdive & Aesop + Le Labo")).toEqual(["Slowdive", "Aesop", "Le Labo"]);
    expect(parseSeeds("Slowdive (artist), Aesop")).toEqual(["Slowdive (artist)", "Aesop"]);
  });
  it("de-duplicates, caps at five and rejects empty or oversized input", () => {
    expect(parseSeeds("a1, A1, b2, c3, d4, e5, f6, g7")).toHaveLength(5);
    expect(() => parseSeeds("   ")).toThrow(InvalidInput);
    expect(() => parseSeeds("x".repeat(301))).toThrow(InvalidInput);
  });
});

describe("generate", () => {
  it("resolves seeds, filters tags and compiles tokens with receipts", async () => {
    const { svc } = makeSvc();
    const v = await svc.generate({ audience: "fans of Slowdive and Aesop" });
    expect(v.status).toBe("complete");
    expect(v.seeds.map((s: { name: string }) => s.name)).toEqual(["Slowdive", "Aesop"]);
    expect(v.seeds[1].type).toBe("urn:entity:brand"); // not the same-name place
    const decor = v.vocabulary.filters.find((f: { family: string }) => f.family === "decor");
    expect(decor.dropped.map((d: { tag: string }) => d.tag)).toEqual(expect.arrayContaining(["French Inspired", "Parisian Bistro", "Family Friendly"]));
    expect(decor.kept.map((k: { tag: string }) => k.tag)[0]).toBe("Minimalist");
    expect(v.tokens.css_qv).toContain(":root");
    expect(v.tokens.palette.contrast.every((c: { pass: boolean }) => c.pass)).toBe(true);
    expect(v.agent_brief).toContain("Design direction for");
    expect(v.voice.words.map((w: { tag: string }) => w.tag)).toEqual(expect.arrayContaining(["Flowing", "Modern"]));
    expect(v.agent_brief).toContain("Microcopy tone words from Qloo (verbatim)");
    expect(v.trace.length).toBeGreaterThanOrEqual(9);
    expect(v.limitations.join(" ")).toContain("rule table");
  });
  it("prefers a brand over a more popular same-name video game, and honours a type hint", async () => {
    const v = await makeSvc().svc.generate({ audience: "Slowdive, Apple" });
    expect(v.seeds[1].entity_id).toBe("B9");
    const hinted = await makeSvc().svc.generate({ seeds: ["Apple (game)", "Slowdive"] });
    expect(hinted.seeds[0].entity_id).toBe("G9");
  });
  it("derives per-seed attribution from separate queries, not from Qloo explainability", async () => {
    const { svc } = makeSvc();
    const v = await svc.generate({ audience: "Slowdive, Aesop" });
    const m = v.vocabulary.attribution.find((a: { tag: string }) => a.tag === "Minimalist");
    expect(m.support.map((s: { seed: string }) => s.seed)).toEqual(["Slowdive", "Aesop"]);
    expect(m.support[0].share + m.support[1].share).toBeCloseTo(1, 1);
    expect(v.vocabulary.attribution_note).toContain("not from Qloo explainability");
  });
  it("returns identical vocabulary and tokens for repeated queries", async () => {
    const { svc } = makeSvc();
    const a = await svc.generate({ audience: "Slowdive, Aesop" }), b = await svc.generate({ audience: "Slowdive, Aesop", fresh: true });
    expect(b.tokens.css_qv).toBe(a.tokens.css_qv);
    expect(b.vocabulary.filters).toEqual(a.vocabulary.filters);
  });
  it("produces no tokens without Qloo grounding", async () => {
    const f = new FakeQloo(); f.opts.failTags = true;
    const v = await makeSvc(f).svc.generate({ audience: "Slowdive, Aesop" });
    expect(v.status).toBe("insufficient_evidence");
    expect(v.tokens).toBeUndefined();
    expect(v.caveats.join(" ")).toContain("no tokens");
    const none = await makeSvc(new FakeQloo(), { key: undefined }).svc.generate({ audience: "Slowdive, Aesop" });
    expect(none.status).toBe("insufficient_evidence");
    expect(none.tokens).toBeUndefined();
    const nosearch = new FakeQloo(); nosearch.opts.failSearch = true;
    expect((await makeSvc(nosearch).svc.generate({ audience: "Slowdive" })).status).toBe("insufficient_evidence");
  });
  it("reports unresolved seeds and returns partial when a family is missing", async () => {
    const f = new FakeQloo(); f.opts.noAmbience = true;
    const v = await makeSvc(f).svc.generate({ audience: "Slowdive, Zorblax" });
    expect(v.unresolved).toEqual(["Zorblax"]);
    expect(v.status).toBe("partial");
    expect(v.caveats.join(" ")).toContain("Not found in Qloo");
  });
  it("stores the brief and returns it unchanged", async () => {
    const { svc } = makeSvc();
    const v = await svc.generate({ audience: "Slowdive, Aesop" });
    expect(await svc.get(v.id)).toEqual(JSON.parse(JSON.stringify(v)));
    expect(await svc.get("missing")).toBeNull();
  });
  it("never leaks the API key into the output", async () => {
    const v = await makeSvc().svc.generate({ audience: "Slowdive, Aesop" });
    expect(JSON.stringify(v)).not.toContain("test-key");
  });
});

describe("critic", () => {
  it("ranks candidates and flags off-audience picks relative to Qloo's top", async () => {
    const r = await makeSvc().svc.check({ audience: "Slowdive, Aesop", candidates: ["Bon Iver", "Metallica", "Nick Drake", "Nobody Known"] });
    expect(r.status).toBe("complete");
    const by: Record<string, Json> = Object.fromEntries((r.results as Json[]).map((x) => [x.candidate, x]));
    expect(by["Bon Iver"].rank).toBe(1);
    expect(by["Metallica"].verdict).toBe("off-audience");
    expect(by["Bon Iver"].verdict).toBe("strong");
    expect(by["Nobody Known"].verdict).toBe("unknown");
    expect(r.method).toContain("heuristic");
  });
  it("rejects an empty candidate list", async () => {
    await expect(makeSvc().svc.check({ audience: "Slowdive", candidates: [] })).rejects.toThrow(InvalidInput);
  });
});
