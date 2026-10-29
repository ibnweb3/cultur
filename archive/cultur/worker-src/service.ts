// Single dossier-generation service used by REST and MCP.
// Bounded, evidence-dependent workflow: resolve input -> inspect evidence -> choose Qloo/onchain tools ->
// compare candidates -> assess sufficiency -> cited findings. Every step lands in tool_trace.
import * as fp from "./fingerprint";
import * as reg from "./registry";
import * as sc from "./scoring";
import { ADDR_RE, Chain, TX_RE } from "./chain";
import { QlooClient, entId, entitiesOf, etype } from "./qloo";
import { SCHEMA_VERSION, SCORING_VERSION, type Dossier, type DossierRequest, type Evidence, type Origin, type Score, type Store } from "./types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type J = any;

export class InvalidInput extends Error {}

// Only people, artists and brands can anchor a creator/project; an exact name hit on a place or film is a different thing.
const ANCHOR_TYPES = ["urn:entity:person", "urn:entity:artist", "urn:entity:brand"];

export interface Deps {
  store: Store;
  mk: (signal: AbortSignal) => { q: QlooClient; chain: Chain };
  budgetMs?: number;
  ttlDays?: number;
  maxCompareCandidates?: number;
  maxQlooCompareCalls?: number;
}

const iso = (ms: number) => new Date(ms).toISOString().slice(0, 19) + "+00:00";

export function classify(raw: string): [string, string] {
  const s = raw.trim();
  // eslint-disable-next-line no-control-regex
  if (!s || s.length > 200 || /[\x00-\x1f<>]/.test(s)) throw new InvalidInput("input must be a non-empty handle, ENS name, contract address or name (max 200 chars)");
  if (s.toLowerCase().startsWith("0x")) {
    if (ADDR_RE.test(s)) return ["contract", s.toLowerCase()];
    throw new InvalidInput("0x input is not a valid 40-hex-character Ethereum address");
  }
  const m = s.match(/^(?:https?:\/\/)?(?:www\.)?(?:twitter|x)\.com\/@?([A-Za-z0-9_]{1,15})\/?(?:\?.*)?$/i);
  if (m) return ["twitter_handle", m[1]];
  if (s.startsWith("@")) {
    if (/^@[A-Za-z0-9_]{1,15}$/.test(s)) return ["twitter_handle", s.slice(1)];
    throw new InvalidInput("invalid Twitter/X handle");
  }
  if (/^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.eth$/i.test(s)) return ["ens", s.toLowerCase()];
  return ["name", s];
}

class Book {
  items: Evidence[] = [];
  add(source: string, ref: string, subject: unknown, fact: string, freshness: Evidence["freshness"] = "n/a", origin: Origin = "observed", ts?: number): string {
    const id = `e${this.items.length + 1}`;
    this.items.push({ id, source, ref, subject: String(subject), fact, retrieved_at: iso(ts ?? Date.now()), freshness, origin });
    return id;
  }
}

interface Ctx {
  trace: J[]; book: Book; caveats: string[]; qcalls: J[]; provider: J; wallet: J[]; walletItems: { kind: string; verified: boolean }[];
  anchors: string[]; identity: J; ambiguity: J[]; fp: fp.Fingerprint | null; matches: J[]; regSelf: reg.Case | null;
  deadlineHit: boolean; identityConf: number | null; coverage: J; regEv: string[]; hintEv: string[]; fpEv: string[]; audEv: string[];
}

export class Service {
  constructor(public d: Deps) {}

  async get(id: string): Promise<Dossier | null> {
    const raw = await this.d.store.get("dossier:" + id);
    return raw ? JSON.parse(raw) : null;
  }

  async generate(req: DossierRequest): Promise<Dossier> {
    const t0 = Date.now();
    const [itype, normIn] = classify(req.input);
    const ctx: Ctx = { trace: [], book: new Book(), caveats: [], qcalls: [], provider: {}, wallet: [], walletItems: [], anchors: [], identity: null,
      ambiguity: [], fp: null, matches: [], regSelf: null, deadlineHit: false, identityConf: null, coverage: {}, regEv: [], hintEv: [], fpEv: [], audEv: [] };
    const ac = new AbortController();
    const clients = this.d.mk(ac.signal);
    const budget = this.d.budgetMs ?? 25000;
    let timer: ReturnType<typeof setTimeout> | undefined = undefined;
    const deadline = new Promise<"deadline">((r) => { timer = setTimeout(() => r("deadline"), budget); });
    const work = this.pipeline(req, itype, normIn, ctx, clients).catch((e) => { if (!ac.signal.aborted) ctx.caveats.push(`A step failed unexpectedly (${(e as Error)?.name}); result is partial.`); });
    const outcome = await Promise.race([work.then(() => "done" as const), deadline]);
    if (timer !== undefined) clearTimeout(timer);
    if (outcome === "deadline") {
      ctx.deadlineHit = true;
      ac.abort();
      ctx.caveats.push(`Upstream work budget of ${Math.round(budget / 1000)}s reached; unfinished steps were cancelled and the result is partial.`);
    }
    const d = this.assemble(req, itype, ctx, t0);
    await this.d.store.put("dossier:" + d.id, JSON.stringify(d), (this.d.ttlDays ?? 7) * 86400).catch(() => undefined);
    return d;
  }

  private trace(ctx: Ctx, action: string, tool: string, detail: string, ok: boolean, t: number) {
    ctx.trace.push({ step: ctx.trace.length + 1, action, tool, detail, ok, ms: Date.now() - t });
  }
  private noteQ(ctx: Ctx, what: string, r: J, q: QlooClient) {
    ctx.qcalls.push({ what, ok: r.ok, freshness: r.freshness, error: r.error ?? null, ref: r.ref, status: r.status ?? null, ts: r.fetchedAt });
    ctx.provider.qloo = { configured: q.configured, last_error: r.ok ? ctx.provider.qloo?.last_error ?? null : r.error };
  }

  private accept(ctx: Ctx, e: J, r: J, how: string) {
    const ev = ctx.book.add("qloo", r.ref, entId(e), `Qloo entity '${e.name}' (${etype(e) ?? "type n/a"}) resolved via ${how}`, r.freshness, "observed", r.fetchedAt);
    ctx.identity = { qloo_entity_id: entId(e), name: e.name, type: etype(e), method: how, evidence: [ev] };
    ctx.anchors.push(entId(e) as string);
    ctx.identityConf = 60;
    return e;
  }

  /** Fresh, request-specific Qloo lookup. Accepts only unambiguous matches; ambiguity is preserved. */
  private async qlooResolve(ctx: Ctx, q: QlooClient, query: string, itype: string) {
    let t = Date.now();
    if (itype === "twitter_handle") {
      const r = await q.entityByTwitter(query, true);
      this.noteQ(ctx, "entities by external.twitter.ids", r, q);
      const ents = r.ok ? entitiesOf(r.data) : [];
      this.trace(ctx, "resolve handle", "qloo.entities", `external.twitter.ids=${query}`, r.ok, t);
      const owned = ents.filter((e) => String(e?.properties?.external?.twitter?.id ?? "").toLowerCase() === query.toLowerCase());
      if (owned.length && new Set(owned.map((e) => reg.norm(e.name ?? ""))).size === 1) {
        // several Qloo entities (e.g. person + artist) may list the same handle; all are the same named subject
        const first = this.accept(ctx, owned[0], r, "Qloo lookup by external.twitter.ids (handle listed on the entity)");
        for (const x of owned.slice(1, 4)) {
          const xid = entId(x) as string;
          if (!ctx.anchors.includes(xid)) {
            ctx.anchors.push(xid);
            ctx.identity.also_listed_as = [...(ctx.identity.also_listed_as ?? []), { qloo_entity_id: entId(x), type: etype(x) }];
          }
        }
        return first;
      }
      if (ents.length === 1) return this.accept(ctx, ents[0], r, "Qloo lookup by external.twitter.ids");
      if (ents.length > 1) { ctx.ambiguity = ents.slice(0, 5).map((e) => ({ id: entId(e), name: e.name })); return null; }
      // fall back to a name search: CANDIDATES only
    }
    t = Date.now();
    const r = await q.search(query, 5, true);
    this.noteQ(ctx, "search", r, q);
    this.trace(ctx, "search candidates", "qloo.search", `query=${query}`, r.ok, t);
    if (!r.ok) return null;
    const ents = entitiesOf(r.data);
    const exact = ents.filter((e) => reg.norm(e.name ?? "") === reg.norm(query));
    if (exact.length === 1 && !ANCHOR_TYPES.includes(etype(exact[0]) as string)) {
      ctx.ambiguity = [{ id: entId(exact[0]), name: exact[0].name, type: etype(exact[0]), note: "exact name hit is not a person, artist or brand; not used as an anchor" }];
      ctx.caveats.push("The only exact Qloo name match is not a person, artist or brand, so it was not used as an anchor.");
      return null;
    }
    if (exact.length === 1 && itype === "ens_label") {
      ctx.ambiguity = [{ id: entId(exact[0]), name: exact[0].name, type: etype(exact[0]), note: "label match only; the ENS name is not linked to this entity" }];
      return null;
    }
    if (exact.length === 1 && ["name", "twitter_handle"].includes(itype)) {
      if (itype === "twitter_handle") {
        // a name match alone does not prove this handle belongs to that entity
        ctx.ambiguity = [{ id: entId(exact[0]), name: exact[0].name, note: "name match only; handle ownership not verified" }];
        return null;
      }
      return this.accept(ctx, exact[0], r, "exact name match in Qloo search");
    }
    ctx.ambiguity = ents.slice(0, 5).map((e) => ({ id: entId(e), name: e.name, type: etype(e) }));
    if (ents.length) ctx.caveats.push("Qloo returned candidates but none is an unambiguous exact match; none was assumed.");
    return null;
  }

  private async pipeline(req: DossierRequest, itype: string, normIn: string, ctx: Ctx, c: { q: QlooClient; chain: Chain }) {
    const { q, chain } = c;
    const book = ctx.book;
    let t = Date.now();
    const regHits = itype !== "contract" ? reg.findByName(normIn) : reg.findByWallet(normIn);
    if (regHits.length) {
      ctx.regSelf = regHits[0];
      ctx.regEv.push(book.add("curated-registry", `registry/cases.json#${regHits[0].id}`, regHits[0].id,
        `Input matches curated case '${regHits[0].id}'; sources: ${regHits[0].sources.slice(0, 2).join(", ")}`, "n/a", "curated"));
    }
    this.trace(ctx, "check registry", "registry", `matches=${regHits.length}`, true, t);

    let qname = itype === "ens" ? normIn.slice(0, -4) : normIn; // the ENS label is the Qloo query whether or not resolution succeeds
    let address: string | null = null;
    let ensHandle: string | null = null;
    if (itype === "ens") {
      t = Date.now();
      const r = await chain.resolveEns(normIn);
      this.trace(ctx, "resolve ENS", "eth.ens", normIn, r.ok, t);
      ctx.provider.eth_rpc = { ok: r.ok, error: r.error ?? null };
      if (r.ok) {
        address = r.value as string;
        const ev = book.add("ethereum-mainnet", `ENS registry resolver(addr) for ${normIn}`, address, `${normIn} forward-resolves to ${address}`, "fresh");
        ctx.wallet.push({ kind: "ens_forward", address, evidence: [ev], note: "Forward record only; says nothing about cultural interests." });
        ctx.walletItems.push({ kind: "ens_forward_resolved", verified: true });
      } else ctx.caveats.push(`ENS resolution failed: ${r.error}`);
      const tw = await chain.ensText(normIn, "com.twitter");
      const handle = tw.ok ? String(tw.value).trim().replace(/^@/, "").replace(/^https?:\/\/(www\.)?(twitter|x)\.com\//i, "") : "";
      if (/^[A-Za-z0-9_]{1,15}$/.test(handle)) {
        ensHandle = handle;
        ctx.regEv.push(book.add("ethereum-mainnet", `ENS text(${normIn}, "com.twitter")`, normIn, `The ENS record for ${normIn} declares the Twitter/X handle @${handle} (self-asserted by the name's owner; supporting metadata, not verification)`, "fresh"));
      } else ctx.caveats.push("The ENS name has no usable com.twitter text record, so it was not linked to any Qloo entity. A label that merely resembles a Qloo entity name is not evidence.");
    } else if (itype === "contract") address = normIn;
    if (address) await this.walletChecks(req, address, itype === "contract", ctx, chain);

    for (const h of (req.qloo_entity_ids ?? []).slice(0, 5)) {
      ctx.hintEv.push(book.add("caller", "request.qloo_entity_ids", h.entity_id,
        `Caller asserts Qloo entity ${h.entity_id} as seed (attribution: ${h.attribution}); unverified`, "n/a", "caller_supplied"));
      ctx.anchors.push(h.entity_id);
    }

    // live grounding: always at least one request-specific Qloo lookup
    if (q.configured) {
      let text = qname, lt = itype;
      if (itype === "ens") { if (ensHandle) { text = ensHandle; lt = "twitter_handle"; } else { text = qname; lt = "ens_label"; } }
      if (itype === "contract") { text = ctx.regSelf ? ctx.regSelf.names[0] : normIn; lt = ctx.regSelf ? "name" : "contract"; }
      await this.qlooResolve(ctx, q, text, lt);
      if (itype === "contract" && !ctx.regSelf && !ctx.anchors.length)
        ctx.caveats.push("A bare contract address carries no cultural anchor, and Qloo returned no usable entity for it. Provide a sourced project name or Qloo entity IDs.");
    } else {
      ctx.caveats.push("QLOO_API_KEY is not configured: no fresh Qloo grounding is possible, so no cultural analysis or trust verdict is issued.");
      this.trace(ctx, "ground in Qloo", "qloo", "skipped: no credentials", false, Date.now());
    }

    const liveOk = ctx.qcalls.some((x) => x.ok && x.freshness === "fresh");
    if (!ctx.anchors.length || !liveOk) return;

    t = Date.now();
    const f = await fp.build(q, [...new Set(ctx.anchors)]);
    for (const x of f.calls) ctx.qcalls.push({ ...x, status: null, error: x.error ?? null });
    ctx.fp = f;
    const nOk = f.calls.filter((x) => x.ok).length;
    this.trace(ctx, "fingerprint", "qloo.insights", `${nOk}/${f.calls.length} calls ok`, nOk > 0, t);
    for (const [cat, items] of Object.entries(f.entities))
      ctx.fpEv.push(book.add("qloo", `GET /v2/insights filter.type=urn:entity:${cat}`, cat,
        `${items.length} ${cat} associations returned (top: ${items.slice(0, 3).map((i) => i.name).join(", ")})`, "fresh"));
    if (f.tags.length)
      ctx.fpEv.push(book.add("qloo", "GET /v2/insights filter.type=urn:tag", "tags", `${f.tags.length} tag associations (top: ${f.tags.slice(0, 3).map((i) => i.name).join(", ")})`, "fresh"));
    if (Object.keys(f.audience).length)
      ctx.audEv.push(book.add("qloo", "GET /v2/insights filter.type=urn:demographics", "audience", `Aggregated audience context returned (${Object.keys(f.audience).join(", ")}); not a statement about individuals`, "fresh"));

    await this.compare(ctx, q);
  }

  private async walletChecks(req: DossierRequest, address: string, isContract: boolean, ctx: Ctx, chain: Chain) {
    const book = ctx.book;
    let t = Date.now();
    const r = await chain.codeSize(address);
    ctx.provider.eth_rpc = { ok: r.ok, error: r.error ?? null };
    this.trace(ctx, "inspect address", "eth.getCode", address, r.ok, t);
    if (r.ok) {
      const size = parseInt(r.value as string, 10);
      const ev = book.add("ethereum-mainnet", `eth_getCode(${address})`, address, `${address} has ${size} bytes of code (${size ? "contract" : "externally owned account"})`, "fresh");
      ctx.wallet.push({ kind: "code", address, bytes: size, evidence: [ev] });
      if (isContract && size === 0) ctx.caveats.push("Address has no bytecode on Ethereum mainnet; it is not a contract there.");
      if (size) {
        const o = await chain.owner(address);
        if (o.ok) {
          const ev2 = book.add("ethereum-mainnet", `eth_call(${address}, owner())`, o.value, `owner() returns ${o.value}`, "fresh");
          ctx.wallet.push({ kind: "owner", address: o.value, evidence: [ev2], note: "Current owner is not necessarily the creator." });
          if (reg.findByWallet(o.value as string).length) ctx.walletItems.push({ kind: "owner_matches_registry", verified: true });
        } else ctx.wallet.push({ kind: "owner", address: null, evidence: [], note: o.error });
      }
    }
    const b = await chain.balanceEth(address);
    if (b.ok) {
      const ev = book.add("ethereum-mainnet", `eth_getBalance(${address})`, address, `Native balance ${b.value} ETH. Token holdings were not enumerated.`, "fresh");
      ctx.wallet.push({ kind: "native_balance", value_eth: b.value, evidence: [ev], note: "Scope: native ETH only. Standard RPC cannot enumerate all tokens or prior contracts." });
    }
    if (isContract) {
      if (req.creation_tx_hash) {
        if (!TX_RE.test(req.creation_tx_hash)) ctx.caveats.push("creation_tx_hash is not a valid 32-byte hash and was ignored.");
        else {
          const m = await chain.creationMatches(req.creation_tx_hash, address);
          const ev = book.add("ethereum-mainnet", `eth_getTransactionReceipt(${req.creation_tx_hash})`, req.creation_tx_hash,
            `${m.note}; transaction sender ${m.sender}`, "fresh", m.ok ? "observed" : "caller_supplied");
          ctx.wallet.push({ kind: "creation_tx", verified: m.ok, tx: req.creation_tx_hash, sender: m.sender, evidence: [ev],
            note: "Sender is not automatically the attributed creator (factories, deployers and owners can differ)." });
          if (m.ok) ctx.walletItems.push({ kind: "creation_tx_verified", verified: true });
        }
      } else ctx.caveats.push("Contract creation history unavailable: standard RPC cannot look up creators, and no indexer record or creation_tx_hash was supplied.");
    }
  }

  private async compare(ctx: Ctx, q: QlooClient) {
    const book = ctx.book;
    const f = ctx.fp as fp.Fingerprint;
    const { ents, tags } = fp.weightMap(f, sc.popularityWeight);
    if (!Object.keys(ents).length && !Object.keys(tags).length) return;
    const t = Date.now();
    const warmed: [reg.Case, J][] = [];
    const raws = await Promise.all(reg.cases.map((c) => this.d.store.get("regfp:" + c.id).catch(() => null)));
    reg.cases.forEach((c, i) => {
      if (ctx.regSelf && c.id === ctx.regSelf.id) return;
      const raw = raws[i];
      if (!raw) return;
      const rfp = JSON.parse(raw);
      if ((rfp.anchors ?? []).some((a: string) => ctx.anchors.includes(a))) {
        ctx.caveats.push(`Subject shares a Qloo entity with curated case '${c.id}'; that case was excluded from comparison as a self-match.`);
        return;
      }
      warmed.push([c, rfp]);
    });
    ctx.coverage.registry_fingerprints_available = `${warmed.length}/${reg.cases.length}`;
    const scored = warmed.map(([c, rfp]) => {
      const w = fp.weightMap(rfp, sc.popularityWeight);
      const se = sc.weightedJaccard(ents, w.ents), st = sc.weightedJaccard(tags, w.tags);
      const sharedE = Object.keys(ents).filter((k) => k in w.ents).sort();
      const sharedT = Object.keys(tags).filter((k) => k in w.tags).sort();
      return { sim: Math.round((0.7 * se + 0.3 * st) * 10000) / 10000, c, se, st, sharedE, sharedT, rfp };
    }).sort((a, b) => b.sim - a.sim);
    this.trace(ctx, "compare to registry", "local.weighted_jaccard", `${warmed.length} warmed records`, true, t);
    const top = scored.slice(0, this.d.maxCompareCandidates ?? 4);
    const names: Record<string, string> = {};
    for (const x of [f, ...top.map((s) => s.rfp)]) for (const items of Object.values(x.entities ?? {}) as J[][]) for (const e of items) names[e.id] = e.name;
    let qc = 0;
    for (const s of top) {
      const band = sc.similarityBand(s.sim, s.sharedE.length + s.sharedT.length);
      const m: J = {
        registry_id: s.c.id, names: s.c.names, similarity: s.sim,
        method: "weighted Jaccard (0.7 entity + 0.3 tag); weights = 1/(1+rank) discounted by popularity when 0..1",
        entity_overlap: Math.round(s.se * 10000) / 10000, tag_overlap: Math.round(s.st * 10000) / 10000, band,
        shared_entities: s.sharedE.slice(0, 10).map((id) => ({ id, name: names[id] })), shared_tags: s.sharedT.slice(0, 10),
        continuity: { status: s.c.continuity_status, note: s.c.continuity_note ?? "", sources: s.c.sources },
        adverse_history_status: s.c.adverse_status, qloo_compare: null,
        limitations: ["Similarity of taste is an observation, not evidence of common identity."],
      };
      if (band !== "none" && qc < (this.d.maxQlooCompareCalls ?? 3) && ctx.anchors.length && s.rfp.anchors?.length) {
        qc++;
        const r = await q.compare(ctx.anchors, s.rfp.anchors);
        this.noteQ(ctx, "analysis/compare", r, q);
        m.qloo_compare = { ok: r.ok, freshness: r.freshness, error: r.error ?? null, note: "Raw Qloo comparison values are preserved; their scale is not interpreted by Cultur." };
        const tg = r.ok ? r.data?.results?.tags : null;
        if (Array.isArray(tg)) {
          const scored2 = tg.filter((x: J) => typeof x?.query?.score === "number");
          m.qloo_compare.shared_tags_scored = scored2.length;
          m.qloo_compare.top_shared_tags = scored2.slice(0, 5).map((x: J) => ({ name: x.name, score: x.query.score }));
          m.qloo_compare.note = "Qloo compare returns shared tags with per-tag scores (raw values preserved).";
        }
      }
      if (band !== "none") {
        m.evidence = [book.add("local-comparison", "weighted Jaccard over Qloo fingerprints", s.c.id,
          `Overlap with curated case '${s.c.id}': band ${band}, ${s.sharedE.length} shared entities, ${s.sharedT.length} shared tags`, "cached", "inferred")];
        ctx.matches.push(m);
      }
    }
  }

  private assemble(req: DossierRequest, itype: string, ctx: Ctx, t0: number): Dossier {
    const book = ctx.book;
    const f = ctx.fp;
    const freshOk = ctx.qcalls.filter((x) => x.ok && x.freshness === "fresh");
    const live = {
      performed: freshOk.length > 0, fresh_successful_calls: freshOk.length, attempted_calls: ctx.qcalls.length,
      calls: ctx.qcalls.slice(0, 20).map((x) => ({ what: x.what, ok: x.ok, freshness: x.freshness, error: x.error ?? null, ref: x.ref })),
      note: "Grounding requires at least one fresh request-specific Qloo query; an empty result from a relevant lookup counts as a coverage gap, not a failure.",
    };
    const grounded = freshOk.length > 0 && ctx.anchors.length > 0;
    const entN = f ? Object.values(f.entities).reduce((s, v) => s + v.length, 0) : 0;
    const tagN = f ? f.tags.length : 0;
    const cats = f ? Object.keys(f.entities).length : 0;
    const depth = sc.culturalDepth(cats, entN, tagN, grounded && f != null);
    const hasAud = !!f && Object.keys(f.audience).length > 0;
    const auth = sc.communityAuthenticity(hasAud, !!f && Object.keys(f.momentum).length > 0);
    const order: Record<string, number> = { none: 0, low: 1, moderate: 2, high: 3 };
    let best: J = null;
    for (const m of ctx.matches) if (!best || order[m.band] > order[best.band]) best = m;
    const continuity = !!best && best.continuity.status === "established";
    const wallet = sc.walletCorroboration(ctx.walletItems);
    const compared = grounded && f != null && (ctx.coverage.registry_fingerprints_available ?? "0/").split("/")[0] !== "0";
    const rebrand = sc.rebrandRisk(best ? best.band : null, continuity, best ? best.adverse_history_status : null, compared, reg.cases.length);
    const selfHist = ctx.regSelf ? ctx.regSelf.adverse_status : null;
    const trust = sc.trustScore(grounded ? ctx.identityConf : null, wallet, rebrand, selfHist, grounded);
    const scores: Record<string, Score> = { rebrand_risk: rebrand, cultural_depth: depth, community_authenticity: auth, wallet_corroboration: wallet, trust_score: trust };
    const ev: Record<string, string[]> = {
      cultural_depth: ctx.fpEv, community_authenticity: ctx.audEv,
      wallet_corroboration: ctx.wallet.flatMap((w) => w.evidence ?? []),
      rebrand_risk: ctx.matches.flatMap((m) => m.evidence ?? []),
      trust_score: ctx.identity ? ctx.identity.evidence : [],
    };
    for (const k of Object.keys(scores)) scores[k].evidence = [...new Set(ev[k] ?? [])].sort();

    const rep: { text: string; evidence: string[] }[] = [];
    const say = (text: string, e: (string | undefined)[]) => rep.push({ text, evidence: e.filter(Boolean) as string[] });
    if (ctx.identity) say(`Qloo resolved the input to '${ctx.identity.name}' (${ctx.identity.method}). This is an entity match, not proof of who controls an account or wallet.`, ctx.identity.evidence);
    else if (ctx.regSelf) say(`The input matches curated case '${ctx.regSelf.id}'. Case facts are listed in the evidence with sources.`, ctx.regEv);
    if (f && entN) say(`Qloo returns ${entN} cross-domain associations across ${cats} categories and ${tagN} tags for this anchor. They describe audience-level cultural affinity, not private preferences.`, ctx.fpEv);
    if (hasAud) say("Qloo also returned aggregated audience context. It does not show whether followers are real.", ctx.audEv);
    for (const m of ctx.matches) {
      if (m.band === "none") continue;
      const txt = `Cultural overlap with curated case '${m.registry_id}' is in the '${m.band}' band. ` +
        (m.continuity.status === "established" ? "Independently reported identity continuity exists for that case, which makes this a lead worth investigating." : "No independent identity continuity is recorded, so this is only a similarity observation.");
      say(txt, m.evidence);
    }
    for (const w of ctx.wallet) {
      if (w.kind === "creation_tx") say((w.verified ? "The supplied creation transaction creates this contract directly." : "The supplied transaction does not show direct creation of this contract.") + " The sender is not automatically the creator.", w.evidence);
      else if (w.kind === "ens_forward") say(`The ENS name forward-resolves to ${w.address}.`, w.evidence);
    }
    if (!rep.length) say("No supported finding could be produced from the available evidence; see coverage and caveats.", []);

    const caveats = [...ctx.caveats];
    if (!grounded) caveats.push("No fresh Qloo grounding for this input: no fingerprint, rebrand lead or trust verdict was produced.");
    if (grounded && f && entN === 0 && tagN === 0) caveats.push("Zero Qloo footprint found for the anchor. This is a coverage warning that needs follow-up; it does not lower trust or imply suspicious conduct.");
    if (grounded && (ctx.coverage.registry_fingerprints_available ?? "0/").startsWith("0/")) caveats.push("No registry fingerprints are warmed in this instance's cache, so no rebrand comparison was run (the scheduled warm-up fills it within minutes).");
    caveats.push("Momentum is limited to Qloo's raw audience_growth measurements on associated entities; /v2/trending returned no data and is not interpreted.");

    const status = !grounded ? "insufficient_evidence" : ctx.deadlineHit || !f || !entN || f.calls.some((x) => !x.ok) ? "partial" : "complete";
    const ver = ctx.regSelf && ctx.identity ? "verified" : ctx.identity || ctx.walletItems.length ? "partially_verified" : ctx.anchors.length ? "taste_only" : "unverified";
    const valid = new Set(book.items.map((e) => e.id));
    for (const r of rep) r.evidence = r.evidence.filter((e) => valid.has(e));

    const created = Date.now();
    return {
      schema_version: SCHEMA_VERSION, scoring_version: SCORING_VERSION, id: crypto.randomUUID().replace(/-/g, "").slice(0, 16),
      created_at: iso(created), expires_at: iso(created + (this.d.ttlDays ?? 7) * 86400000), input: req.input, input_type: itype, status,
      resolved_identity: ctx.identity, ambiguity: ctx.ambiguity, verification: ver, scores,
      fingerprint: f && grounded ? { anchors: ctx.anchors, entities: f.entities, tags: f.tags, audience: f.audience, momentum: Object.keys(f.momentum).length ? f.momentum : null, provenance: "Qloo, fresh" } : {},
      rebrand_matches: ctx.matches, wallet_findings: ctx.wallet, plain_english_report: rep, evidence: book.items,
      coverage: { ...ctx.coverage, qloo_categories_with_results: cats, registry_size: reg.cases.length, chain: "ethereum-mainnet only" },
      caveats, provider_status: { ...ctx.provider, qloo_configured: ctx.provider.qloo?.configured ?? false }, live_qloo: live, tool_trace: ctx.trace, duration_ms: Date.now() - t0,
    };
  }
}

/** Warm registry fingerprints from Qloo at runtime (stored in KV, never committed). Handles a few cases per call
 *  because the Workers free plan allows 50 subrequests per invocation. */
export async function warmSome(store: Store, q: QlooClient, maxCases = 3): Promise<string[]> {
  const done: string[] = [];
  for (const c of reg.cases) {
    if (done.length >= maxCases) break;
    if (await store.get("regcov:" + c.id)) continue;
    const anchors: string[] = [];
    for (const name of c.qloo_anchor_names ?? []) {
      const r = await q.search(name, 5);
      if (!r.ok) return done; // transient failure: retry on the next tick
      const ex = entitiesOf(r.data).filter((e) => reg.norm(e.name ?? "") === reg.norm(name) && ["urn:entity:person", "urn:entity:brand"].includes(etype(e) as string));
      if (ex.length === 1 && !anchors.includes(entId(ex[0]) as string)) anchors.push(entId(ex[0]) as string);
    }
    const TTL = 30 * 86400;
    if (!anchors.length) { await store.put("regcov:" + c.id, JSON.stringify({ status: "no_qloo_match" }), TTL); done.push(c.id); continue; }
    const f = await fp.build(q, anchors.slice(0, 4));
    f.anchors = anchors.slice(0, 4);
    const has = Object.keys(f.entities).length > 0 || f.tags.length > 0;
    if (has) await store.put("regfp:" + c.id, JSON.stringify(f), TTL);
    await store.put("regcov:" + c.id, JSON.stringify({ status: has ? "covered" : "empty" }), TTL);
    done.push(c.id);
  }
  return done;
}
