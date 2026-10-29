// QlooVibe service: audience -> Qloo design vocabulary -> published rule table -> tokens, plus the critic check.
// Without fresh Qloo grounding there is no vocabulary and therefore no tokens.
import { compileTokens, filterTags, type FilterTrace, type KeptTag, type Tokens } from "./compile";
import { RULE_TABLE_VERSION } from "./rules";
import { QlooClient, entId, entitiesOf, etype, tagsOf, type QResult } from "./qloo";
import { FAMILIES, SCHEMA_VERSION, type Family, type Json, type Store, type TraceStep } from "./types";

export class InvalidInput extends Error {}

const SEED_TYPES = ["urn:entity:brand", "urn:entity:artist", "urn:entity:movie", "urn:entity:tv_show", "urn:entity:book", "urn:entity:videogame", "urn:entity:podcast", "urn:entity:person"];
const SHORT: Record<string, string> = { brand: "urn:entity:brand", artist: "urn:entity:artist", movie: "urn:entity:movie", film: "urn:entity:movie", tv: "urn:entity:tv_show", show: "urn:entity:tv_show", tv_show: "urn:entity:tv_show", book: "urn:entity:book", game: "urn:entity:videogame", videogame: "urn:entity:videogame", podcast: "urn:entity:podcast", person: "urn:entity:person" };
const MAX_SEEDS = 5;

export interface Seed { query: string; entity_id: string; name: string; type: string; match: "exact" | "prefix" | "closest"; popularity: number | null }

/** Explicit lists use commas, semicolons or newlines; quote names containing those delimiters. */
export function parseSeeds(audience: string): string[] {
  const s = audience.trim();
  if (!s) throw new InvalidInput("audience is empty");
  if (audience.length > 300) throw new InvalidInput("audience is too long (max 300 characters)");
  const body = s.replace(/^(?:(?:fans of|lovers of|people who (?:like|love)|who (?:like|love)|audience of)\s+|audience:\s*)/i, "");
  const quotes: Record<string, string> = { '"': '"', "'": "'", "“": "”", "‘": "’" };
  const out: string[] = [];
  let part = "", tail = "", closeQuote: string | undefined, quoted = false;
  const add = () => {
    if (quoted && !/^\s*(?:\(\w+\))?\s*$/.test(tail)) throw new InvalidInput("Separate audience names with commas, semicolons or newlines after a closing quote.");
    const name = (part + tail).trim();
    if (name.length < 2 || name.length > 60) throw new InvalidInput("Each audience name must be between 2 and 60 characters. Separate names with commas, semicolons or newlines.");
    if (!out.some((o) => o.toLowerCase() === name.toLowerCase())) out.push(name);
    part = ""; tail = ""; quoted = false;
  };
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (closeQuote) {
      if (c === closeQuote) {
        if (body[i + 1] === closeQuote) { part += c; i++; }
        else closeQuote = undefined;
      } else part += c;
    } else if (c === "," || c === ";" || c === "\n" || c === "\r") {
      // Ignore blank lines, including the newline after a comma and the LF in CRLF.
      if ((c === "\n" || c === "\r") && !part.trim() && !quoted) continue;
      add();
    } else if (!quoted && !part.trim() && quotes[c]) {
      part = ""; quoted = true; closeQuote = quotes[c];
    } else if (quoted) tail += c;
    else part += c;
  }
  if (closeQuote) throw new InvalidInput("Close the quote around each audience name.");
  add();
  if (out.length > MAX_SEEDS) throw new InvalidInput("Use up to 5 audience references so every name can be included.");
  return out;
}

function requestedSeeds(req: { audience?: string; seeds?: string[] }): string[] {
  if (req.seeds !== undefined) {
    if (!Array.isArray(req.seeds) || !req.seeds.length || req.seeds.length > MAX_SEEDS || req.seeds.some((s) => typeof s !== "string" || s.trim().length < 2 || s.length > 60)) {
      throw new InvalidInput("Provide 1-5 audience names, each between 2 and 60 characters.");
    }
    const seen = new Set<string>();
    return req.seeds.map((s) => s.trim()).filter((s) => { const key = s.toLowerCase(); if (seen.has(key)) return false; seen.add(key); return true; });
  }
  return parseSeeds(String(req.audience ?? ""));
}

function chooseSeed(query: string, results: Json[]): Seed | null {
  const m = query.match(/^(.*?)\s*\((\w+)\)\s*$/);
  const name = (m ? m[1]! : query).trim().toLowerCase();
  const hint = m ? SHORT[m[2]!.toLowerCase()] : undefined;
  const ok = results.filter((r) => typeof entId(r) === "string" && entId(r)!.length > 0 && typeof r.name === "string" && r.name.trim() && SEED_TYPES.includes(etype(r) ?? "") && (!hint || etype(r) === hint));
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

/** Proposes audience names from free text (a project description or design.md). Only the names come from the model; Qloo verifies them and supplies all vocabulary. */
export type SuggestFn = (project: string) => Promise<{ names: string[]; model: string }>;
interface Deps { store: Store; q: QlooClient; now?: () => number; suggest?: SuggestFn }
export interface AudienceReq { audience?: string; seeds?: string[]; project?: string }
interface Audience { names: string[]; seeds: Seed[]; unresolved: string[]; unavailable: string[]; source: "named" | "model_suggested"; suggested: string[]; caveats: string[]; input: string }
export const MAX_PROJECT = 8000, MIN_PROJECT = 20;
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

  private async resolveAll(ctx: Ctx, names: string[]): Promise<{ seeds: Seed[]; unresolved: string[]; unavailable: string[] }> {
    const rs = await Promise.all(names.map(async (n) => {
      const base = n.replace(/\s*\(\w+\)\s*$/, "");
      const r = await timed(ctx, `resolve "${n}"`, () => this.d.q.search(base, 8, ctx.fresh));
      return { n, seed: r.ok ? chooseSeed(n, entitiesOf(r.data)) : null, unavailable: !r.ok };
    }));
    return { seeds: rs.flatMap((r) => (r.seed ? [r.seed] : [])), unresolved: rs.filter((r) => !r.seed).map((r) => r.n), unavailable: rs.filter((r) => r.unavailable).map((r) => r.n) };
  }


  /** Names the user gave win. Free text (`project`, or a long sentence that Qloo cannot match as one name) goes through the suggester, and only names Qloo matches exactly are kept. */
  private async audienceFor(ctx: Ctx, req: AudienceReq): Promise<Audience> {
    const hasNamed = req.seeds !== undefined || !!req.audience?.trim();
    let project = hasNamed ? undefined : req.project?.trim();
    if (project !== undefined && (project.length < MIN_PROJECT || project.length > MAX_PROJECT)) throw new InvalidInput(`project must be ${MIN_PROJECT}-${MAX_PROJECT} characters.`);
    const names = hasNamed || !project ? requestedSeeds(req) : [];
    const prose = req.seeds === undefined && names.length === 1 && names[0]!.split(/\s+/).length >= 6 && !!this.d.suggest;
    const named = names.length ? await this.resolveAll(ctx, names) : { seeds: [], unresolved: [], unavailable: [] };
    if (prose && !named.seeds.some((x) => x.match !== "closest")) project = req.audience!.trim();
    if (!project) return { names, ...named, source: "named", suggested: [], caveats: [], input: req.audience ?? names.join(", ") };

    const input = project.length > 140 ? `${project.slice(0, 137).replace(/\s+\S*$/, "")}...` : project;
    const none = (caveat: string): Audience => ({ names: [], seeds: [], unresolved: [], unavailable: [], source: "model_suggested", suggested: [], caveats: [caveat], input });
    if (!this.d.suggest) return none("Describing a project needs the language model, which is not configured here. Pass audience names (seeds) instead.");
    const t0 = ctx.now();
    let proposed: string[] = [];
    try {
      const r = await this.d.suggest(project);
      proposed = [...new Map(r.names.map((n) => [n.toLowerCase(), n])).values()].slice(0, 8);
      ctx.trace.push({ step: "suggest audience names from project text", call: `Workers AI ${r.model} (names only)`, freshness: "fresh", status: "ok", ms: ctx.now() - t0 });
    } catch (e) {
      ctx.trace.push({ step: "suggest audience names from project text", call: "Workers AI", freshness: "fresh", status: "error", ms: ctx.now() - t0, note: "language model unavailable" });
      return none("The language model that turns a project description into audience names was unavailable. Pass audience names (seeds) instead.");
    }
    if (!proposed.length) return none("The language model returned no usable audience names. Pass audience names (seeds) instead.");
    const r = await this.resolveAll(ctx, proposed);
    const exact = r.seeds.filter((x) => x.match !== "closest").slice(0, MAX_SEEDS);
    const kept = new Set(exact.map((x) => x.query));
    return {
      names: proposed, seeds: exact, unresolved: proposed.filter((n) => !kept.has(n)), unavailable: r.unavailable, source: "model_suggested", suggested: proposed, input,
      caveats: ["Audience names were chosen by a language model from your project text and then checked against Qloo; names Qloo did not match exactly were dropped. All design vocabulary comes from Qloo, not the model. If the names look wrong, pass your own seeds."],
    };
  }

  async generate(req: AudienceReq & { fresh?: boolean }) {
    const ctx = this.ctx(!!req.fresh);
    const started = ctx.now();
    const stamp = { id: crypto.randomUUID().replace(/-/g, "").slice(0, 12), schema_version: SCHEMA_VERSION, rule_table_version: RULE_TABLE_VERSION, created_at: new Date().toISOString() };
    if (!this.d.q.configured) {
      const names = req.project && req.seeds === undefined && !req.audience?.trim() ? [] : requestedSeeds(req);
      return this.finish({ ...stamp, audience: { input: req.audience ?? names.join(", "), seeds_requested: names, source: "named" }, status: "insufficient_evidence", seeds: [], unresolved: names, caveats: ["QLOO_API_KEY is not configured; QlooVibe produces no design vocabulary without Qloo."] }, ctx, started);
    }
    const aud = await this.audienceFor(ctx, req);
    const { names, seeds, unresolved, unavailable } = aud;
    const caveats: string[] = [...aud.caveats];
    const base = { ...stamp, audience: { input: aud.input, seeds_requested: names, source: aud.source, ...(aud.source === "model_suggested" ? { suggested_seeds: aud.suggested } : {}) } };
    const notFound = unresolved.filter((n) => !unavailable.includes(n));
    if (notFound.length) caveats.push(`Not found in Qloo: ${notFound.join(", ")}`);
    if (unavailable.length) caveats.push(`Qloo could not check these audience names: ${unavailable.join(", ")}. Try again.`);
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
    if (Object.values(tokens.dims).every((d) => d.source === "default")) {
      return this.finish({ ...base, status: "insufficient_evidence", seeds, unresolved, vocabulary: { filters }, caveats: [...caveats, "The returned tags do not provide enough mapped design evidence. No tokens or preview were generated. Try different audience names."] }, ctx, started);
    }
    if (Object.values(tokens.dims).some((d) => d.source === "default")) caveats.push("Tokens marked default had too little mapped Qloo evidence.");
    if (tokens.unmapped_tags.length) caveats.push(`${tokens.unmapped_tags.length} kept tag(s) have no rule yet: ${tokens.unmapped_tags.join(", ")}`);

    // Per-seed attribution for decor tags: derived from separate per-seed Qloo queries (Qloo gives no per-tag explainability).
    const seedLists = seeds.length > 1 ? seeds.map((s, i) => ({ seed: s.name, map: new Map(perSeed[i]!.ok ? tagsOf(perSeed[i]!.data).map((t) => [String(t.name).trim(), t.query?.affinity as number] as const) : []) })) : [];
    const attribution = kept.filter((k) => k.family === "decor").map((k) => {
      const support = seedLists.map((s) => ({ seed: s.seed, affinity: s.map.get(k.name) ?? null }));
      const tot = support.reduce((a, b) => a + (b.affinity ?? 0), 0);
      const complete = support.length > 0 && support.every((s) => typeof s.affinity === "number" && Number.isFinite(s.affinity)) && tot > 0;
      return { tag: k.name, support: support.map((s) => ({ ...s, share: complete ? Math.round((s.affinity! / tot) * 100) / 100 : null })) };
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
    const partial = failed > 0 || unresolved.length > 0 || seeds.some((s) => s.match === "closest") || !rawBy.ambience.length || !rawBy.style.length;
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
  async check(req: AudienceReq & { candidates: string[]; fresh?: boolean }) {
    if (!Array.isArray(req.candidates) || !req.candidates.length || req.candidates.length > 12 || req.candidates.some((c) => typeof c !== "string" || c.trim().length < 2 || c.length > 60)) {
      throw new InvalidInput("Provide 1-12 reference names, each between 2 and 60 characters.");
    }
    const cands = [...new Set(req.candidates.map((c) => c.trim()))];
    const ctx = this.ctx(!!req.fresh); const started = ctx.now();
    if (!this.d.q.configured) return { status: "insufficient_evidence", caveats: ["QLOO_API_KEY is not configured."], results: [], trace: [] };
    const [aud, candRes] = await Promise.all([
      this.audienceFor(ctx, req),
      Promise.all(cands.map(async (c) => {
        const r = await timed(ctx, `resolve candidate "${c}"`, () => this.d.q.search(c.replace(/\s*\(\w+\)\s*$/, ""), 8, ctx.fresh));
        return { c, seed: r.ok ? chooseSeed(c, entitiesOf(r.data)) : null, unavailable: !r.ok };
      })),
    ]);
    const { seeds, unresolved, unavailable } = aud;
    if (!seeds.length) return { status: "insufficient_evidence", caveats: [...aud.caveats, "No audience seed resolved in Qloo."], unresolved, results: [], trace: ctx.trace };
    const caveats: string[] = [...aud.caveats];
    if (unresolved.length) caveats.push(`Audience names excluded from this check: ${unresolved.join(", ")}.${unavailable.length ? " Some names could not be checked because Qloo was unavailable; try again." : " Try a more specific name."}`);
    if (seeds.some((s) => s.match === "closest")) caveats.push("Some audience names matched the closest available Qloo entity. Check the resolved audience names.");
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
      if (top.ok) {
        const a = entitiesOf(top.data).map((e) => e.query?.affinity).filter((x): x is number => typeof x === "number").sort((x, y) => x - y);
        if (a.length) typical.set(type, (a[Math.floor((a.length - 1) / 2)]! + a[Math.floor(a.length / 2)]!) / 2);
      }
    }));
    const rows = candRes.map(({ c, seed, unavailable }) => {
      if (!seed) return { candidate: c, resolved: null, affinity: null, typical_top: null, gap: null, verdict: "unknown", note: unavailable ? "Qloo could not check this name. Try again." : "Name not found in Qloo. Try a more specific name or add a type such as (artist)." };
      const aff = scored.get(seed.entity_id) ?? null; const typ = typical.get(seed.type) ?? null;
      const gap = aff != null && typ != null ? round(typ - aff) : null;
      const verdict = gap == null ? "unknown" : gap <= 0.05 ? "strong" : gap <= 0.1 ? "ok" : gap <= 0.18 ? "weak" : "off-audience";
      const notes = [
        ...(seed.match === "closest" ? [`Closest available match: ${seed.name}. Confirm this is the intended reference.`] : []),
        ...(aff == null ? ["Qloo returned no affinity for this entity."] : []),
        ...(typ == null ? ["A comparison baseline was unavailable, so fit could not be determined."] : []),
      ];
      return { candidate: c, resolved: { name: seed.name, type: seed.type.split(":").pop(), entity_id: seed.entity_id, match: seed.match }, affinity: aff == null ? null : round(aff), typical_top: typ == null ? null : round(typ), gap, verdict, ...(notes.length ? { note: notes.join(" ") } : {}) };
    });
    const ranked = rows.filter((r) => r.affinity != null).sort((a, b) => b.affinity! - a.affinity!).map((r, i) => ({ ...r, rank: i + 1 }));
    const out = [...ranked, ...rows.filter((r) => r.affinity == null)];
    const failed = ctx.trace.filter((t) => t.status === "error").length;
    if (failed) caveats.push("Some Qloo requests failed. Results with unavailable data have not been given a fit verdict.");
    const hasVerdict = out.some((r) => r.verdict !== "unknown");
    const partial = failed > 0 || unresolved.length > 0 || out.some((r) => r.verdict === "unknown" || r.resolved?.match === "closest") || seeds.some((s) => s.match === "closest");
    return {
      status: hasVerdict ? (partial ? "partial" : "complete") : "insufficient_evidence", audience_seeds: seeds.map((s) => s.name), unresolved, results: out, caveats,
      method: "verdict compares a candidate's Qloo affinity with the median affinity of the top-10 Qloo ranks for the same audience and type: gap <= .05 strong, <= .10 ok, <= .18 weak, else off-audience. Thresholds are a heuristic; Qloo affinities are compressed, so read rank and gap, not the raw number.",
      trace: ctx.trace, timing: { total_ms: ctx.now() - started, qloo_calls: ctx.trace.length, fresh: ctx.trace.filter((t) => t.freshness === "fresh").length, cached: ctx.trace.filter((t) => t.freshness === "cached").length, failed },
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
