// Build a Qloo-derived cultural fingerprint. Parsing is defensive; unrecognised shapes yield empty lists, never invented values.
import { QlooClient, entId, entitiesOf, tagsOf } from "./qloo";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type J = any;
export const CATEGORIES = ["urn:entity:artist", "urn:entity:brand", "urn:entity:person", "urn:entity:place"];

// Entity tags are capped: Qloo returns hundreds per entity and the Workers free plan has a small CPU budget.
const TAG_CAP = 25;

function ent(e: J, rank: number) {
  const tags = (Array.isArray(e.tags) ? e.tags : []).slice(0, TAG_CAP).flatMap((t: J) => {
    const id = t?.tag_id ?? t?.id ?? t?.name;
    return id ? [{ id, name: t.name ?? id }] : [];
  });
  const q = e.query && typeof e.query === "object" ? e.query : {};
  return {
    id: entId(e), name: e.name, rank,
    affinity_raw: q.affinity ?? e.affinity ?? e.score, // scale as returned by Qloo (0..1 observed); not reinterpreted
    popularity: e.popularity, tags,
    audience_growth: q.measurements && typeof q.measurements === "object" ? q.measurements.audience_growth : undefined,
  };
}

/** Verified: results.demographics[0].query = {age:{bucket:signed score}, gender:{...}} (aggregated audience). */
function audience(data: J) {
  const it = data?.results?.demographics;
  const q = Array.isArray(it) && it[0]?.query;
  if (!q || typeof q !== "object") return {};
  const out: J = {};
  for (const k of ["age", "gender"]) if (q[k] && typeof q[k] === "object") out[k] = q[k];
  return out;
}

export interface Fingerprint {
  entities: Record<string, J[]>;
  tags: J[];
  audience: J;
  momentum: J;
  calls: { what: string; ok: boolean; error?: string; ref: string; freshness: string; ts?: number }[];
  anchors?: string[];
}

export async function build(q: QlooClient, anchors: string[], take = 10): Promise<Fingerprint> {
  const labels = [...CATEGORIES, "urn:tag", "urn:demographics"];
  const res = await Promise.allSettled(labels.map((l) => q.insights(anchors, l, take, true)));
  const out: Fingerprint = { entities: {}, tags: [], audience: {}, momentum: {}, calls: [] };
  res.forEach((r, i) => {
    const label = labels[i];
    if (r.status === "rejected") { out.calls.push({ what: label, ok: false, error: "exception", ref: "", freshness: "n/a" }); return; }
    const v = r.value;
    out.calls.push({ what: label, ok: v.ok, error: v.error, ref: v.ref, freshness: v.freshness, ts: v.fetchedAt });
    if (!v.ok) return;
    if (label === "urn:tag") {
      out.tags = tagsOf(v.data).slice(0, take).map((t: J) => ({ id: t.tag_id ?? t.id ?? t.name, name: t.name, affinity_raw: t.query?.affinity ?? t.affinity }));
    } else if (label === "urn:demographics") {
      out.audience = audience(v.data);
    } else {
      const ents = entitiesOf(v.data).map((e, k) => ent(e, k)).filter((e) => e.id);
      if (ents.length) {
        const cat = label.split(":").pop() as string;
        out.entities[cat] = ents;
        const growth = ents.map((e) => e.audience_growth).filter((g) => typeof g === "number");
        if (growth.length) out.momentum[cat] = { audience_growth_values: growth.slice(0, 10), note: "Raw query.measurements.audience_growth of associated entities; meaning/scale not interpreted." };
      }
    }
  });
  return out;
}

/** Rank-based weights (scale-free): w = 1/(1+rank), discounted for very popular items. */
export function weightMap(fp: { entities: Record<string, J[]>; tags: J[] }, popularityWeight: (p: unknown) => number) {
  const ents: Record<string, number> = {}, tags: Record<string, number> = {};
  for (const items of Object.values(fp.entities ?? {})) {
    for (const e of items) {
      ents[e.id] = Math.max(ents[e.id] ?? 0, popularityWeight(e.popularity) / (1 + e.rank));
      for (const t of e.tags ?? []) tags[t.id] = Math.max(tags[t.id] ?? 0, 0.5 / (1 + e.rank));
    }
  }
  (fp.tags ?? []).forEach((t, i) => { if (t.id) tags[t.id] = Math.max(tags[t.id] ?? 0, 1 / (1 + i)); });
  return { ents, tags };
}
