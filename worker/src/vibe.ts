// QlooVibe service: audience -> Qloo design vocabulary -> published rule table -> tokens, plus the critic check.
// Without fresh Qloo grounding there is no vocabulary and therefore no tokens.
import { compileTokens, filterTags, type FilterTrace, type KeptTag, type Tokens } from "./compile";
import { RULE_TABLE_VERSION } from "./rules";
import { QlooClient, entId, entitiesOf, etype, tagsOf, type QResult } from "./qloo";
import { FAMILIES, SCHEMA_VERSION, type Family, type Json, type Store, type TraceStep } from "./types";

export class InvalidInput extends Error {}

const SEED_TYPES = ["urn:entity:brand", "urn:entity:artist", "urn:entity:movie", "urn:entity:tv_show", "urn:entity:book", "urn:entity:videogame", "urn:entity:podcast", "urn:entity:person"];
const SHORT: Record<string, string> = { brand: "urn:entity:brand", artist: "urn:entity:artist", movie: "urn:entity:movie", film: "urn:entity:movie", tv: "urn:entity:tv_show", show: "urn:entity:tv_show", book: "urn:entity:book", game: "urn:entity:videogame", podcast: "urn:entity:podcast" };
const MAX_SEEDS = 5;
const BUDGET_MS = 25000;

export interface Seed { query: string; entity_id: string; name: string; type: string; match: "exact" | "prefix" | "closest"; popularity: number | null }

/** "fans of A24 films, Slowdive and Aesop skincare" -> ["A24", "Slowdive", "Aesop"]. Optional "(artist)" type hints are kept. */
export function parseSeeds(audience: string): string[] {
  const s = audience.replace(/\s+/g, " ").trim();
  if (!s) throw new InvalidInput("audience is empty");
  if (s.length > 300) throw new InvalidInput("audience is too long (max 300 characters)");
  const body = s.replace(/^.*?\b(?:fans of|lovers of|people who (?:like|love)|who (?:like|love)|audience of|audience:)\s+/i, "");
  const out: string[] = [];
  for (let part of body.split(/\s*(?:,|;|\band\b|&|\+|\n)\s*/i)) {
    part = part.replace(/\s+(?:films?|movies?|skincare|music|brand|band|songs?|series|fans?)$/i, "").trim();
    if (part.length >= 2 && part.length <= 60 && !out.some((o) => o.toLowerCase() === part.toLowerCase())) out.push(part);
  }
  if (!out.length) throw new InvalidInput("no seeds found; name 1-5 things the audience loves, e.g. \"Slowdive, Aesop, A24\"");
  return out.slice(0, MAX_SEEDS);
}

function chooseSeed(query: string, results: Json[]): Seed | null {
  const m = query.match(/^(.*?)\s*\((\w+)\)\s*$/);
  const name = (m ? m[1]! : query).trim().toLowerCase();
  const hint = m ? SHORT[m[2]!.toLowerCase()] : undefined;
  const ok = results.filter((r) => SEED_TYPES.includes(etype(r) ?? "") && (!hint || etype(r) === hint));
  // same-name collisions: brands and artists first, then screen/print media, then the rest; popularity breaks ties inside a tier
  const tier = (r: Json) => { const i = SEED_TYPES.indexOf(etype(r) ?? ""); return i < 2 ? 0 : i < 5 ? 1 : 2; };
  const rank = (r: Json) => tier(r) * 10 - (r.popularity ?? 0);
  const pick = (cands: Json[], match: Seed["match"]): Seed | null => {
    if (!cands.length) return null;
    const r = [...cands].sort((a, b) => rank(a) - rank(b))[0]!;
    return { query, entity_id: entId(r)!, name: r.name, type: etype(r)!, match, popularity: typeof r.popularity === "number" ? r.popularity : null };
  };
  return pick(ok.filter((r) => String(r.name).toLowerCase() === name), "exact")
    ?? pick(ok.filter((r) => String(r.name).toLowerCase().startsWith(name)), "prefix")
    ?? pick(ok, "closest");
}

interface Deps { store: Store; q: QlooClient; now?: () => number }
interface Ctx { trace: TraceStep[]; fresh: boolean; now: () => number }

async function timed(ctx: Ctx, step: string, run: () => Promise<QResult>, note?: string): Promise<QResult> {
  const t0 = ctx.now();
  const r = await run();
  ctx.trace.push({ step, call: r.ref, freshness: r.freshness, status: r.ok ? "ok" : "error", ms: ctx.now() - t0, ...(note || !r.ok ? { note: note ?? r.error } : {}) });
  return r;
}

export class Service {
  constructor(private d: Deps) {}
  private ctx(fresh: boolean): Ctx { return { trace: [], fresh, now: this.d.now ?? (() => Date.now()) }; }

  private async resolveAll(ctx: Ctx, names: string[]): Promise<{ seeds: Seed[]; unresolved: string[] }> {
    const rs = await Promise.all(names.map(async (n) => {
      const base = n.replace(/\s*\(\w+\)\s*$/, "");
      const r = await timed(ctx, `resolve "${n}"`, () => this.d.q.search(base, 8, ctx.fresh));
      return { n, seed: r.ok ? chooseSeed(n, entitiesOf(r.data)) : null };
    }));
    return { seeds: rs.flatMap((r) => (r.seed ? [r.seed] : [])), unresolved: rs.filter((r) => !r.seed).map((r) => r.n) };
  }

  async generate(req: { audience?: string; seeds?: string[]; fresh?: boolean }) {
    const names = req.seeds?.length ? req.seeds.map((s) => String(s).trim()).filter(Boolean).slice(0, MAX_SEEDS) : parseSeeds(String(req.audience ?? ""));
    if (!names.length) throw new InvalidInput("provide an audience string or 1-5 seeds");
    const ctx = this.ctx(!!req.fresh);
    const started = ctx.now();
    const caveats: string[] = [];
    const base = {
      id: crypto.randomUUID().replace(/-/g, "").slice(0, 12), schema_version: SCHEMA_VERSION, rule_table_version: RULE_TABLE_VERSION,
      created_at: new Date().toISOString(), audience: { input: req.audience ?? names.join(", "), seeds_requested: names },
    };
    if (!this.d.q.configured) return this.finish({ ...base, status: "insufficient_evidence", seeds: [], unresolved: names, caveats: ["QLOO_API_KEY is not configured; QlooVibe produces no design vocabulary without Qloo."] }, ctx, started);

    const { seeds, unresolved } = await this.resolveAll(ctx, names);
    if (unresolved.length) caveats.push(`Not found in Qloo: ${unresolved.join(", ")}`);
    if (seeds.some((s) => s.match === "closest")) caveats.push("Some seeds matched only the closest Qloo entity; check the resolved names.");
    if (!seeds.length) return this.finish({ ...base, status: "insufficient_evidence", seeds, unresolved, caveats: [...caveats, "No seed resolved to a Qloo entity, so there is no grounded vocabulary."] }, ctx, started);
    const ids = seeds.map((s) => s.entity_id);

    const [joint, perSeed, anchors] = await Promise.all([
      Promise.all(FAMILIES.map((f) => timed(ctx, `${f} tags (audience)`, () => this.d.q.tagInsights(ids, f, 25, ctx.fresh)))),
      Promise.all(seeds.length > 1 ? seeds.map((s) => timed(ctx, `decor tags (seed: ${s.name})`, () => this.d.q.tagInsights([s.entity_id], "decor", 40, ctx.fresh))) : []),
      Promise.all([["brand", 8], ["artist", 8], ["movie", 5]].map(([t, n]) =>
        timed(ctx, `${t} touchstones`, () => this.d.q.entityInsights(ids, `urn:entity:${t}`, n as number, { explain: true }, ctx.fresh)))),
    ]);

    const rawBy = {} as Record<Family, { name: string; affinity: number }[]>;
    FAMILIES.forEach((f, i) => {
      rawBy[f] = joint[i]!.ok ? tagsOf(joint[i]!.data).filter((t) => t.name && typeof t.query?.affinity === "number").map((t) => ({ name: String(t.name), affinity: t.query.affinity as number })) : [];
    });
    if (!rawBy.decor.length) {
      return this.finish({ ...base, status: "insufficient_evidence", seeds, unresolved, caveats: [...caveats, "Qloo returned no decor vocabulary for this audience; no tokens are produced from defaults or from a model's guess."] }, ctx, started);
    }
    for (const f of FAMILIES) if (!rawBy[f].length) caveats.push(`No ${f} tags returned by Qloo for this audience.`);

    const filters: FilterTrace[] = []; const kept: KeptTag[] = [];
    for (const f of FAMILIES) { const r = filterTags(f, rawBy[f]); filters.push(r.trace); kept.push(...r.kept); }
    const tokens = compileTokens(kept);
    // Tone words are passed through verbatim from Qloo's style and ambience tags: no rule, no mapping, nothing invented.
    const seenVoice = new Set<string>();
    const voice = {
      words: [...kept.filter((k) => k.family === "style").slice(0, 6), ...kept.filter((k) => k.family === "ambience").slice(0, 4)]
        .filter((k) => { const n = k.name.toLowerCase(); if (seenVoice.has(n)) return false; seenVoice.add(n); return true; })
        .map((k) => ({ tag: k.name, family: k.family, affinity: round(k.affinity) })),
      note: "Verbatim Qloo style and ambience tags for this audience. Use them as microcopy tone; applying a space or music descriptor to interface copy is an analogy.",
    };
    if (Object.values(tokens.dims).every((d) => d.source === "default")) caveats.push("None of the kept tags matched a rule, so every token is a default.");
    else if (Object.values(tokens.dims).some((d) => d.source === "default")) caveats.push("Tokens marked default had too little mapped Qloo evidence.");
    if (tokens.unmapped_tags.length) caveats.push(`${tokens.unmapped_tags.length} kept tag(s) have no rule yet: ${tokens.unmapped_tags.join(", ")}`);

    // Per-seed attribution for decor tags: derived from separate per-seed Qloo queries (Qloo gives no per-tag explainability).
    const seedLists = seeds.length > 1 ? seeds.map((s, i) => ({ seed: s.name, map: new Map(perSeed[i]!.ok ? tagsOf(perSeed[i]!.data).map((t) => [String(t.name).trim(), t.query?.affinity as number] as const) : []) })) : [];
    const attribution = kept.filter((k) => k.family === "decor").map((k) => {
      const support = seedLists.map((s) => ({ seed: s.seed, affinity: s.map.get(k.name) ?? null }));
      const tot = support.reduce((a, b) => a + (b.affinity ?? 0), 0);
      return { tag: k.name, support: support.map((s) => ({ ...s, share: tot && s.affinity ? Math.round((s.affinity / tot) * 100) / 100 : 0 })) };
    });

    const names2 = new Map(seeds.map((s) => [s.entity_id, s.name]));
    const touchstones = (["brand", "artist", "movie"] as const).map((t, i) => ({
      type: t,
      items: anchors[i]!.ok ? entitiesOf(anchors[i]!.data).map((e) => ({
        name: String(e.name), entity_id: entId(e), affinity: round(e.query?.affinity), popularity: round(e.popularity),
        why: ((e.query?.explainability?.["signal.interests.entities"] ?? []) as Json[]).map((x) => ({ seed: names2.get(x.entity_id) ?? x.entity_id, share: round(x.score) })),
      })) : [],
    }));

    const failed = ctx.trace.filter((t) => t.status === "error").length;
    const partial = failed > 0 || !rawBy.ambience.length || !rawBy.style.length;
    return this.finish({
      ...base, status: partial ? "partial" : "complete", seeds, unresolved,
      vocabulary: { filters, attribution_note: seeds.length > 1 ? "Per-seed shares are derived from separate per-seed Qloo tag queries, not from Qloo explainability (which Qloo returns only for entity results)." : "Single seed: no attribution split." , attribution },
      touchstones, voice, tokens, agent_brief: agentBrief(base.audience.input, seeds, tokens, touchstones, voice.words.map((w) => w.tag)),
      caveats, limitations: LIMITS,
    }, ctx, started);
  }

  private async finish(v: Json, ctx: Ctx, started: number) {
    v.trace = ctx.trace;
    v.timing = { total_ms: ctx.now() - started, qloo_calls: ctx.trace.length, fresh: ctx.trace.filter((t) => t.freshness === "fresh").length, cached: ctx.trace.filter((t) => t.freshness === "cached").length, failed: ctx.trace.filter((t) => t.status === "error").length };
    try { await this.d.store.put(`vibe:${v.id}`, JSON.stringify(v), 7 * 24 * 3600); } catch { /* storage must not break the response */ }
    return v;
  }

  async get(id: string) { const s = await this.d.store.get(`vibe:${id}`); return s ? JSON.parse(s) : null; }

  /** Critic mode: score candidate references against an audience with Qloo. Flags are relative to what Qloo ranks highest for the same audience. */
  async check(req: { audience?: string; seeds?: string[]; candidates: string[]; fresh?: boolean }) {
    const names = req.seeds?.length ? req.seeds.slice(0, MAX_SEEDS) : parseSeeds(String(req.audience ?? ""));
    const cands = [...new Set((req.candidates ?? []).map((c) => String(c).trim()).filter(Boolean))].slice(0, 12);
    if (!cands.length) throw new InvalidInput("candidates must list 1-12 names (artists, brands, films, shows, books) to check");
    const ctx = this.ctx(!!req.fresh); const started = ctx.now();
    if (!this.d.q.configured) return { status: "insufficient_evidence", caveats: ["QLOO_API_KEY is not configured."], results: [], trace: [] };
    const [{ seeds, unresolved }, candRes] = await Promise.all([
      this.resolveAll(ctx, names),
      Promise.all(cands.map(async (c) => {
        const r = await timed(ctx, `resolve candidate "${c}"`, () => this.d.q.search(c.replace(/\s*\(\w+\)\s*$/, ""), 8, ctx.fresh));
        return { c, seed: r.ok ? chooseSeed(c, entitiesOf(r.data)) : null };
      })),
    ]);
    if (!seeds.length) return { status: "insufficient_evidence", caveats: ["No audience seed resolved in Qloo."], unresolved, results: [], trace: ctx.trace };
    const ids = seeds.map((s) => s.entity_id);
    const byType = new Map<string, Seed[]>();
    for (const r of candRes) if (r.seed) byType.set(r.seed.type, [...(byType.get(r.seed.type) ?? []), r.seed]);
    const scored = new Map<string, number>(); const typical = new Map<string, number>();
    await Promise.all([...byType.entries()].map(async ([type, list]) => {
      const [only, top] = await Promise.all([
        timed(ctx, `score ${type.split(":").pop()} candidates`, () => this.d.q.entityInsights(ids, type, list.length + 2, { only: list.map((x) => x.entity_id) }, ctx.fresh)),
        timed(ctx, `${type.split(":").pop()} reference (what Qloo ranks highest)`, () => this.d.q.entityInsights(ids, type, 10, {}, ctx.fresh)),
      ]);
      if (only.ok) for (const e of entitiesOf(only.data)) if (typeof e.query?.affinity === "number") scored.set(entId(e)!, e.query.affinity);
      if (top.ok) { const a = entitiesOf(top.data).map((e) => e.query?.affinity).filter((x): x is number => typeof x === "number").sort((x, y) => x - y); if (a.length) typical.set(type, a[Math.floor(a.length / 2)]!); }
    }));
    const rows = candRes.map(({ c, seed }) => {
      if (!seed) return { candidate: c, resolved: null, affinity: null, typical_top: null, gap: null, verdict: "unknown", note: "not found in Qloo" };
      const aff = scored.get(seed.entity_id) ?? null; const typ = typical.get(seed.type) ?? null;
      const gap = aff != null && typ != null ? round(typ - aff) : null;
      const verdict = gap == null ? "unknown" : gap <= 0.05 ? "strong" : gap <= 0.1 ? "ok" : gap <= 0.18 ? "weak" : "off-audience";
      return { candidate: c, resolved: { name: seed.name, type: seed.type.split(":").pop(), entity_id: seed.entity_id, match: seed.match }, affinity: aff == null ? null : round(aff), typical_top: typ == null ? null : round(typ), gap, verdict, ...(aff == null ? { note: "Qloo returned no affinity for this entity" } : {}) };
    });
    const ranked = rows.filter((r) => r.affinity != null).sort((a, b) => b.affinity! - a.affinity!).map((r, i) => ({ ...r, rank: i + 1 }));
    const out = [...ranked, ...rows.filter((r) => r.affinity == null)];
    return {
      status: out.some((r) => r.affinity != null) ? "complete" : "insufficient_evidence", audience_seeds: seeds.map((s) => s.name), unresolved, results: out,
      method: "verdict compares a candidate's Qloo affinity with the median affinity of the top-10 Qloo ranks for the same audience and type: gap <= .05 strong, <= .10 ok, <= .18 weak, else off-audience. Thresholds are a heuristic; Qloo affinities are compressed, so read rank and gap, not the raw number.",
      trace: ctx.trace, timing: { total_ms: ctx.now() - started, qloo_calls: ctx.trace.length },
    };
  }
}

const round = (n: unknown) => (typeof n === "number" ? Math.round(n * 1000) / 1000 : null);

const LIMITS = [
  "Qloo supplies ranked taste tags and entities. It does not supply colours, fonts or CSS: every token comes from the published rule table (GET /api/rules), which is our hypothesis and not validated in user studies.",
  "Decor, ambience and style tags describe physical spaces and music styles; applying them to interfaces is an analogy.",
  "Palette hex values are derived from rule-chosen hue/chroma/mode and forced through a WCAG AA contrast gate (our code).",
  "Colours extracted from Qloo images did not separate audiences in our test (p = 0.22 to 0.70), so no colour is taken from images.",
  "Same query and data version return identical output; Qloo data can change over time.",
];

function agentBrief(audience: string, seeds: Seed[], t: Tokens, touch: { type: string; items: { name: string }[] }[], voice: string[]): string {
  const top = (type: string) => (touch.find((x) => x.type === type)?.items ?? []).slice(0, 4).map((i) => i.name).join(", ");
  const d = t.dims;
  return [
    `# Design direction for: ${audience}`,
    `Grounded in Qloo taste data for ${seeds.map((s) => `${s.name} (${s.type.split(":").pop()})`).join(", ")}. Rule table ${t.rule_table_version}; tokens are rule-mapped hypotheses, not Qloo output.`,
    ``,
    `Use a standard accessible component set (shadcn/ui, Radix). Do not invent layout patterns. Change only the skin with these variables:`,
    "```css", t.css_shadcn, "", t.css_qv, "```",
    ``,
    `- Colour mode: ${d.mode.value}; corner radius ${d.radius.value}px; spacing unit ${Math.round((d.density.value as number) * 4 * 100) / 100}px; display type: ${d.font.value}; motion ${d.motion.value}ms.`,
    `- Contrast gate: ${t.palette.gate} (all AA pairs ${t.palette.contrast.every((c) => c.pass) ? "pass" : "NOT all passing"}).`,
    `- Microcopy tone words from Qloo (verbatim): ${voice.join(", ") || "n/a"}.`,
    `- Touchstones this audience loves (use for tone and imagery references, not logos): brands ${top("brand") || "n/a"}; artists ${top("artist") || "n/a"}; films ${top("movie") || "n/a"}.`,
    `- Before shipping copy or imagery that names artists, brands or films, call check_audience_fit to score each against this audience.`,
  ].join("\n");
}
