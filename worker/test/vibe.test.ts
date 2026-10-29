import { describe, expect, it } from "vitest";
import type { Json } from "../src/types";
import { InvalidInput, parseSeeds } from "../src/vibe";
import { QlooClient } from "../src/qloo";
import { FakeQloo, makeSvc, MemStore } from "./helpers";

describe("parseSeeds", () => {
  it("extracts explicit lists after a natural introduction", () => {
    expect(parseSeeds("fans of A24, Slowdive, Aesop")).toEqual(["A24", "Slowdive", "Aesop"]);
    expect(parseSeeds("audience: Slowdive; Aesop\r\nLe Labo")).toEqual(["Slowdive", "Aesop", "Le Labo"]);
    expect(parseSeeds("Slowdive (artist), Aesop")).toEqual(["Slowdive (artist)", "Aesop"]);
  });
  it("preserves punctuation, conjunctions and words that belong to entity names", () => {
    expect(parseSeeds("Salt & Stone; Pride and Prejudice; Canal+; D'Angelo")).toEqual(["Salt & Stone", "Pride and Prejudice", "Canal+", "D'Angelo"]);
    expect(parseSeeds("fans of Slowdive, Pride and Prejudice")).toEqual(["Slowdive", "Pride and Prejudice"]);
    expect(parseSeeds("fans of The Music")).toEqual(["The Music"]);
    expect(parseSeeds('"The Music", "A24 films"')).toEqual(["The Music", "A24 films"]);
  });
  it("recognizes quoted names and preserves their internal delimiters", () => {
    expect(parseSeeds('"Earth, Wind & Fire" (artist), \'Salt & Stone\'; “Pride and Prejudice”; ‘The Music’')).toEqual(["Earth, Wind & Fire (artist)", "Salt & Stone", "Pride and Prejudice", "The Music"]);
    expect(parseSeeds('"The ""Great"" Artist", Aesop')).toEqual(['The "Great" Artist', "Aesop"]);
  });
  it("keeps newline lists distinct, including CRLF and commas before line breaks", () => {
    expect(parseSeeds("Slowdive\nAesop")).toEqual(["Slowdive", "Aesop"]);
    expect(parseSeeds("Slowdive,\r\n\r\nAesop")).toEqual(["Slowdive", "Aesop"]);
  });
  it("de-duplicates and rejects names that would be silently excluded", () => {
    expect(parseSeeds("a1, A1, b2, c3, d4, e5")).toHaveLength(5);
    expect(() => parseSeeds("a1, A1, b2, c3, d4, e5, f6, g7")).toThrow(InvalidInput);
    expect(() => parseSeeds("   ")).toThrow(InvalidInput);
    expect(() => parseSeeds("x".repeat(301))).toThrow(InvalidInput);
    expect(() => parseSeeds("Slowdive, " + "x".repeat(61))).toThrow(InvalidInput);
  });
  it.each(["Slowdive, X", "Slowdive,,Aesop", "Slowdive;", '""', '"Earth, Wind & Fire', '“The Music', '"Slowdive" Aesop'])('rejects invalid list input %j', (input) => {
    expect(() => parseSeeds(input)).toThrow(InvalidInput);
  });
});

describe("generate", () => {
  it("resolves seeds, filters tags and compiles tokens with receipts", async () => {
    const { svc } = makeSvc();
    const v = await svc.generate({ audience: "fans of Slowdive, Aesop" });
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
  it("returns selectable directions without additional Qloo calls and keeps the default aliases", async () => {
    const { svc, f } = makeSvc();
    const v = await svc.generate({ audience: "Slowdive, Aesop" });
    expect(v.directions).toHaveLength(3);
    expect(f.calls).toHaveLength(10);
    expect(v.selected_direction_id).toBe(v.directions[0].id);
    expect(v.tokens).toEqual(v.directions[0].tokens);
    expect(v.agent_brief).toBe(v.directions[0].agent_brief);
    for (const direction of v.directions) {
      expect(direction.agent_brief).toContain(direction.name);
      expect(direction.agent_brief).toContain(direction.fonts.display.name);
      expect(direction.agent_brief).toContain(direction.tokens.css_qv);
    }
  });
  it("prefers a brand over a more popular same-name video game, and honours a type hint", async () => {
    const v = await makeSvc().svc.generate({ audience: "Slowdive, Apple" });
    expect(v.seeds[1].entity_id).toBe("B9");
    const hinted = await makeSvc().svc.generate({ seeds: ["Apple (game)", "Slowdive"] });
    expect(hinted.seeds[0].entity_id).toBe("G9");
    const canonical = await makeSvc().svc.generate({ seeds: ["Apple (videogame)", "Slowdive"] });
    expect(canonical.seeds[0].entity_id).toBe("G9");
  });
  it.each(["tv_show", "person"])("honours the canonical %s type hint despite a same-name brand", async (type) => {
    const f = new FakeQloo();
    const fetch = f.fetch;
    f.fetch = async (input) => {
      if (new URL(String(input)).pathname === "/search") return new Response(JSON.stringify({ results: [
        { name: "Apple", entity_id: "brand-1", types: ["urn:entity:brand"], popularity: 0.9 },
        { name: "Apple", entity_id: "hinted-1", types: [`urn:entity:${type}`], popularity: 0.1 },
      ] }));
      return fetch(input);
    };
    const v = await makeSvc(f).svc.generate({ seeds: [`Apple (${type})`] });
    expect(v.seeds[0].entity_id).toBe("hinted-1");
    expect(v.seeds[0].type).toBe(`urn:entity:${type}`);
  });
  it("derives per-seed attribution from separate queries, not from Qloo explainability", async () => {
    const { svc } = makeSvc();
    const v = await svc.generate({ audience: "Slowdive, Aesop" });
    const m = v.vocabulary.attribution.find((a: { tag: string }) => a.tag === "Minimalist");
    expect(m.support.map((s: { seed: string }) => s.seed)).toEqual(["Slowdive", "Aesop"]);
    expect(m.support[0].share + m.support[1].share).toBeCloseTo(1, 1);
    expect(v.vocabulary.attribution_note).toContain("not from Qloo explainability");
    const missing = v.vocabulary.attribution.find((a: { tag: string }) => a.tag === "Cozy");
    expect(missing.support[0].affinity).toBeNull();
    expect(missing.support.every((s: { share: unknown }) => s.share === null)).toBe(true);
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
    expect(v.directions).toBeUndefined();
    expect(v.caveats.join(" ")).toContain("no tokens");
    const none = await makeSvc(new FakeQloo(), { key: undefined }).svc.generate({ audience: "Slowdive, Aesop" });
    expect(none.status).toBe("insufficient_evidence");
    expect(none.tokens).toBeUndefined();
    expect(none.directions).toBeUndefined();
    const nosearch = new FakeQloo(); nosearch.opts.failSearch = true;
    expect((await makeSvc(nosearch).svc.generate({ audience: "Slowdive" })).status).toBe("insufficient_evidence");
  });
  it.each(["Family Friendly", "Zzzz"])("does not render default tokens when returned words (%s) provide no mapped evidence", async (tag) => {
    const f = new FakeQloo();
    const fetch = f.fetch;
    f.fetch = async (input) => {
      const u = new URL(String(input));
      if (u.searchParams.get("filter.type") === "urn:tag") return new Response(JSON.stringify({ results: { tags: [{ name: tag, query: { affinity: 0.9 } }] } }));
      return fetch(input);
    };
    const v = await makeSvc(f).svc.generate({ audience: "Slowdive, Aesop" });
    expect(v.status).toBe("insufficient_evidence");
    expect(v.tokens).toBeUndefined();
    expect(v.agent_brief).toBeUndefined();
  });
  it("marks an otherwise complete brief partial when an audience name is excluded", async () => {
    const v = await makeSvc().svc.generate({ audience: "Slowdive, Zorblax" });
    expect(v.unresolved).toEqual(["Zorblax"]);
    expect(v.status).toBe("partial");
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
  it("resolves newline-separated audiences and refuses to silently drop an invalid name", async () => {
    const { svc, f } = makeSvc();
    const v = await svc.generate({ audience: "Slowdive\nAesop" });
    expect(v.status).toBe("complete");
    expect(v.audience.seeds_requested).toEqual(["Slowdive", "Aesop"]);
    expect(v.seeds.map((s: { name: string }) => s.name)).toEqual(["Slowdive", "Aesop"]);
    const calls = f.calls.length;
    await expect(svc.generate({ audience: "Slowdive, X" })).rejects.toThrow(InvalidInput);
    expect(f.calls).toHaveLength(calls);
  });
  it("never leaks the API key into the output", async () => {
    const v = await makeSvc().svc.generate({ audience: "Slowdive, Aesop" });
    expect(JSON.stringify(v)).not.toContain("test-key");
  });
});

describe("critic", () => {
  it("ranks candidates and flags off-audience picks relative to Qloo's top", async () => {
    const r = await makeSvc().svc.check({ audience: "Slowdive, Aesop", candidates: ["Bon Iver", "Metallica", "Nick Drake", "Nobody Known"] });
    expect(r.status).toBe("partial");
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
  it.each([[0.1, 0.3, 0.7, 0.9], [0.1, 0.5, 0.9]])("uses the statistical median of the reference affinities %j", async (...affinities) => {
    const f = new FakeQloo();
    const fetch = f.fetch;
    f.fetch = async (input) => {
      const u = new URL(String(input));
      if (u.pathname === "/v2/insights" && !u.searchParams.has("filter.entities")) return new Response(JSON.stringify({ results: { entities: affinities.map((affinity, i) => ({ entity_id: `ref-${i}`, query: { affinity } })) } }));
      return fetch(input);
    };
    const r = await makeSvc(f).svc.check({ audience: "Slowdive", candidates: ["Bon Iver"] });
    expect(r.results[0].typical_top).toBe(0.5);
  });
  it("does not claim a completed check when a comparison baseline fails", async () => {
    const f = new FakeQloo();
    const fetch = f.fetch;
    f.fetch = async (input) => {
      const u = new URL(String(input));
      if (u.pathname === "/v2/insights" && !u.searchParams.has("filter.entities")) return new Response("unavailable", { status: 503 });
      return fetch(input);
    };
    const r = await makeSvc(f).svc.check({ audience: "Slowdive", candidates: ["Bon Iver"] });
    expect(r.status).toBe("insufficient_evidence");
    expect(r.results[0].verdict).toBe("unknown");
    expect(r.results[0].note).toContain("baseline");
    expect(r.timing?.failed).toBe(1);
  });
});

describe("provider deadline", () => {
  it("stops retrying when the request deadline or cancellation arrives", async () => {
    const controller = new AbortController();
    let calls = 0;
    const q = new QlooClient({ apiKey: "test-key", baseUrl: "https://qloo.test", store: new MemStore(), signal: controller.signal,
      fetchFn: async () => { calls++; controller.abort(); return new Response("busy", { status: 429 }); },
    });
    const result = await q.search("Slowdive");
    expect(result.ok).toBe(false);
    expect(result.error).toBe("cancelled at deadline");
    expect(calls).toBe(1);
  });
});

describe("project text to audience names", () => {
  const suggest = (names: string[]) => async () => ({ names, model: "test-model" });
  const PROJECT = "A site for a student podcast series in Lagos Nigeria";

  it("keeps only names Qloo matches exactly and labels the result as model-suggested", async () => {
    const { svc } = makeSvc(new FakeQloo(), { suggest: suggest(["Slowdive (artist)", "Aesop (brand)", "Iver (artist)", "Nothing Real (artist)"]) });
    const v = await svc.generate({ project: PROJECT });
    expect(v.audience.source).toBe("model_suggested");
    expect(v.audience.suggested_seeds).toEqual(["Slowdive (artist)", "Aesop (brand)", "Iver (artist)", "Nothing Real (artist)"]);
    expect(v.seeds.map((s: Json) => s.name)).toEqual(["Slowdive", "Aesop"]); // "Iver" only matches loosely ("Bon Iver"); dropped
    expect(v.unresolved).toEqual(["Iver (artist)", "Nothing Real (artist)"]);
    expect(v.caveats.join(" ")).toContain("chosen by a language model");
    expect(v.trace.some((t: Json) => t.step.startsWith("suggest audience names") && t.status === "ok")).toBe(true);
    expect(v.tokens).toBeTruthy(); // tokens still come from Qloo vocabulary + rule table
  });
  it("lets explicit names win and never calls the model", async () => {
    let called = 0;
    const { svc } = makeSvc(new FakeQloo(), { suggest: async () => { called++; return { names: ["Aesop"], model: "m" }; } });
    const v = await svc.generate({ seeds: ["Slowdive"], project: PROJECT });
    expect(called).toBe(0);
    expect(v.audience.source).toBe("named");
    expect(v.project_context).toMatchObject({ summary: PROJECT, basis: "user_supplied" });
    expect(v.directions[0].project_fit.join(" ")).toContain(PROJECT);
  });
  it("requires exact model-proposed names, while user-provided prefixes remain disclosed", async () => {
    const { svc } = makeSvc(new FakeQloo(), { suggest: suggest(["Slow (artist)", "Aesop (brand)"]) });
    const inferred = await svc.generate({ project: PROJECT });
    expect(inferred.seeds.map((seed: Json) => seed.name)).toEqual(["Aesop"]);
    expect(inferred.unresolved).toContain("Slow (artist)");
    const named = await svc.generate({ seeds: ["Slow (artist)"] });
    expect(named.seeds[0]).toMatchObject({ name: "Slowdive", match: "prefix" });
  });
  it("exports only a short project excerpt and a safe source filename", async () => {
    const project = PROJECT + " ".repeat(2) + "Public requirements. ".repeat(25) + "PRIVATE_END_OF_DOCUMENT";
    const { svc } = makeSvc();
    const v = await svc.generate({ seeds: ["Slowdive", "Aesop"], project, source_name: "design.md" });
    expect(v.project_context.source_name).toBe("design.md");
    expect(v.project_context.input_excerpt.length).toBeLessThanOrEqual(240);
    expect(v.agent_brief).not.toContain("PRIVATE_END_OF_DOCUMENT");
    expect(JSON.stringify(v)).not.toContain("PRIVATE_END_OF_DOCUMENT");
    await expect(svc.generate({ seeds: ["Slowdive"], project: PROJECT, source_name: "../private/design.md" })).rejects.toThrow(InvalidInput);
  });
  it("treats a long sentence Qloo cannot match as a project description", async () => {
    const { svc } = makeSvc(new FakeQloo(), { suggest: suggest(["Slowdive", "Aesop"]) });
    const v = await svc.generate({ audience: PROJECT });
    expect(v.audience.source).toBe("model_suggested");
    expect(v.seeds).toHaveLength(2);
  });
  it("does not reroute a real multi-word name that Qloo matches exactly", async () => {
    let called = 0;
    const { svc } = makeSvc(new FakeQloo(), { suggest: async () => { called++; return { names: ["Aesop"], model: "m" }; } });
    await svc.generate({ audience: "Slowdive" });
    expect(called).toBe(0);
  });
  it("returns no tokens when the model is missing, fails, or returns nothing", async () => {
    for (const o of [{}, { suggest: async () => { throw new Error("down"); } }, { suggest: suggest([]) }, { suggest: suggest(["Nothing Real"]) }]) {
      const v = await makeSvc(new FakeQloo(), o).svc.generate({ project: PROJECT });
      expect(v.status).toBe("insufficient_evidence");
      expect(v.tokens).toBeUndefined();
      expect(v.directions).toBeUndefined();
      expect(v.caveats.length).toBeGreaterThan(0);
    }
  });
  it("rejects project text outside the length limits", async () => {
    const { svc } = makeSvc(new FakeQloo(), { suggest: suggest(["Slowdive"]) });
    await expect(svc.generate({ project: "too short" })).rejects.toBeInstanceOf(InvalidInput);
    await expect(svc.generate({ project: "x".repeat(8001) })).rejects.toBeInstanceOf(InvalidInput);
  });
  it("lets the critic use project text too", async () => {
    const { svc } = makeSvc(new FakeQloo(), { suggest: suggest(["Slowdive", "Aesop"]) });
    const r = await svc.check({ project: PROJECT, candidates: ["Bon Iver"] });
    expect(r.results).toHaveLength(1);
    expect(r.caveats.join(" ")).toContain("language model");
  });
});
