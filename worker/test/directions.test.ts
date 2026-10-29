import { describe, expect, it } from "vitest";
import { compileTokens, filterTags, type KeptTag } from "../src/compile";
import { buildDirections, directionGuide } from "../src/directions";
import { matchRule, RULES } from "../src/rules";

const evidence = (names: string[]): KeptTag[] => filterTags("decor", names.map((name, index) => ({ name, affinity: Math.round((0.95 - index * 0.04) * 100) / 100 }))).kept;
const TAGS = evidence(["Minimalist", "Cozy", "Industrial", "Vintage", "Dark Wood", "Artistic", "Botanical", "Playful"]);

describe("design directions", () => {
  it("publishes the interpretation lenses and named-font choices", () => {
    const guide = directionGuide();
    expect(guide.max_directions).toBe(3);
    for (const lens of guide.lenses) for (const rule of lens.rules) expect(RULES.some((entry) => entry.id === rule)).toBe(true);
    for (const pair of Object.values(guide.fonts.pairs)) for (const name of pair) expect(guide.fonts.catalog.some((font) => font.name === name)).toBe(true);
    expect(guide.fonts.source).toContain("Qloo supplies no font names");
  });
  it("offers three genuinely different deterministic readings of the same evidence", () => {
    const directions = buildDirections(TAGS);
    expect(directions).toHaveLength(3);
    expect(buildDirections(TAGS)).toEqual(directions);
    expect(new Set(directions.map((direction) => JSON.stringify(direction.tokens.dims))).size).toBe(3);
    expect(new Set(directions.map((direction) => direction.tokens.css_qv)).size).toBe(3);
    expect(directions[0]!.tokens.dims).toEqual(compileTokens(TAGS).dims);
    for (const direction of directions) {
      expect(direction.tokens.palette.contrast.every((pair) => pair.pass)).toBe(true);
      expect(direction.provenance.tags.length).toBeGreaterThan(0);
      for (const tag of direction.provenance.tags) {
        expect(TAGS).toContainEqual(expect.objectContaining({ name: tag.tag, family: tag.family, affinity: tag.affinity }));
        expect(matchRule(tag.tag)?.rule.id).toBe(tag.rule);
      }
      for (const receipt of direction.tokens.receipts) for (const contribution of receipt.contributions) {
        expect(direction.provenance.tags).toContainEqual(expect.objectContaining({ tag: contribution.tag, family: contribution.family, affinity: contribution.affinity, rule: contribution.rule }));
      }
    }
  });
  it("exports the named recommended pair with matching receipts and loading guidance", () => {
    for (const direction of buildDirections(TAGS)) {
      expect(direction.fonts.source).toBe("qloovibe_recommendation");
      expect(direction.fonts.note).toContain("Qloo supplies no font names or font validation");
      expect(direction.tokens.css_qv).toContain(`--qv-font-display: ${direction.fonts.display.stack};`);
      expect(direction.tokens.css_qv).toContain(`--qv-font-body: ${direction.fonts.body.stack};`);
      expect(direction.tokens.css_shadcn).toContain(`--font-display: ${direction.fonts.display.stack};`);
      expect(direction.tokens.css_shadcn).toContain(`--font-sans: ${direction.fonts.body.stack};`);
      expect(direction.tokens.css_shadcn).toContain(direction.fonts.font_face_css);
      expect(direction.tokens.receipts.find((receipt) => receipt.token.includes("--qv-font-display"))).toMatchObject({ value: direction.fonts.display.stack, source: "derived" });
      expect(direction.tokens.receipts.find((receipt) => receipt.token.includes("--qv-font-body"))).toMatchObject({ value: direction.fonts.body.stack, source: "derived" });
      const receipted = new Set(direction.tokens.receipts.flatMap((receipt) => receipt.token.match(/--[a-z-]+/g) ?? []));
      for (const match of (direction.tokens.css_qv + direction.tokens.css_shadcn).matchAll(/(--[a-z-]+):/g)) expect(receipted.has(match[1]!)).toBe(true);
      expect(direction.fonts.font_face_css).toContain('url("/fonts/figtree-latin.woff2")');
      expect(direction.fonts.loading_guidance).toContain("Figtree-OFL.txt");
      expect(direction.fonts.stylesheet_url).toBeNull();
    }
  });
  it("does not invent duplicate or unsupported options to fill three slots", () => {
    expect(buildDirections([])).toEqual([]);
    expect(buildDirections(evidence(["Zzzz"]))).toEqual([]);
    expect(buildDirections([{ name: "Minimalist", affinity: 0.05, family: "decor", rank: 0 }])).toEqual([]);
    const sparse = buildDirections(evidence(["Dark Wood"]));
    expect(sparse).toHaveLength(1);
    expect(sparse[0]!.fonts.note).toContain("published default sans");
    expect(sparse[0]!.tokens.receipts.some((receipt) => receipt.source === "default")).toBe(true);
  });
  it("keeps supplied project context separate from Qloo provenance", () => {
    const context = { summary: "An independent journal about music in Lagos.", input_excerpt: "An independent journal about music in Lagos.", source_name: "design.md", basis: "user_supplied" as const };
    const [direction] = buildDirections(TAGS, context);
    expect(direction!.project_fit.join(" ")).toContain(context.summary);
    expect(direction!.project_fit.join(" ")).toContain("design.md");
    expect(JSON.stringify(direction!.provenance)).not.toContain("Lagos");
  });
});
