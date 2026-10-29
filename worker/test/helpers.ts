// Synthetic Qloo fixtures. Clearly fake data used only by tests; never shown by the app and never real Qloo output.
import { QlooClient } from "../src/qloo";
import type { Json, Store } from "../src/types";
import { Service } from "../src/vibe";

export class MemStore implements Store {
  m = new Map<string, string>();
  async get(k: string) { return this.m.get(k) ?? null; }
  async put(k: string, v: string) { this.m.set(k, v); }
  async delete(k: string) { this.m.delete(k); }
}

const CATALOG = [
  { name: "Slowdive", id: "A1", type: "urn:entity:artist", popularity: 0.6 },
  { name: "Aesop", id: "B1", type: "urn:entity:brand", popularity: 0.7 },
  { name: "Bon Iver", id: "A3", type: "urn:entity:artist", popularity: 0.8 },
  { name: "Metallica", id: "A2", type: "urn:entity:artist", popularity: 0.9 },
  { name: "Nick Drake", id: "A4", type: "urn:entity:artist", popularity: 0.6 },
  { name: "Le Labo", id: "B2", type: "urn:entity:brand", popularity: 0.5 },
  { name: "Aesop", id: "P9", type: "urn:entity:place", popularity: 0.2 }, // same-name place: must not be chosen
  { name: "Apple", id: "B9", type: "urn:entity:brand", popularity: 0.5 },
  { name: "Apple", id: "G9", type: "urn:entity:videogame", popularity: 0.95 }, // more popular, but a brand must win the tie
];
const AFF: Record<string, number> = { A3: 0.93, A4: 0.9, A2: 0.73, B2: 0.91 };
const TOP: Record<string, { id: string; name: string; aff: number }[]> = {
  "urn:entity:artist": [0.95, 0.95, 0.94, 0.94, 0.93, 0.93, 0.92, 0.92, 0.91, 0.91].map((aff, i) => ({ id: `T${i}`, name: `Top Artist ${i}`, aff })),
  "urn:entity:brand": [0.95, 0.94, 0.94, 0.93, 0.93, 0.92, 0.92, 0.91].map((aff, i) => ({ id: `TB${i}`, name: `Top Brand ${i}`, aff })),
  "urn:entity:movie": [0.9, 0.89, 0.88, 0.87, 0.86].map((aff, i) => ({ id: `TM${i}`, name: `Top Film ${i}`, aff })),
};
const JOINT: Record<string, [string, number][]> = {
  decor: [["Minimalist", 0.84], [" Parisian Bistro", 0.83], ["Cozy", 0.8], ["Industrial", 0.78], ["French Inspired", 0.77], ["Dark Wood", 0.75], ["Vintage", 0.7], ["Family Friendly", 0.69], ["Hipster", 0.66], ["Artistic", 0.6]],
  ambience: [["Modern", 0.8], ["Convenient", 0.7], ["Authentic", 0.6]],
  style: [["Flowing", 0.8], ["Time Capsule", 0.7]],
};
const SOLO: Record<string, [string, number][]> = {
  A1: [["Minimalist", 0.8], ["Dark Wood", 0.7], ["Vintage", 0.6]],
  B1: [["Minimalist", 0.9], ["Cozy", 0.8], ["Industrial", 0.6]],
};

export interface FakeOpts { failTags?: boolean; failSearch?: boolean; noAmbience?: boolean }
export class FakeQloo {
  calls: string[] = [];
  opts: FakeOpts = {};
  fetch = async (input: RequestInfo | URL): Promise<Response> => {
    const u = new URL(String(input));
    const p = u.searchParams;
    this.calls.push(u.pathname + "?" + p.toString());
    const ok = (data: Json) => new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } });
    if (u.pathname === "/search") {
      if (this.opts.failSearch) return new Response("x", { status: 500 });
      const q = (p.get("query") ?? "").toLowerCase();
      return ok({ results: CATALOG.filter((c) => c.name.toLowerCase().includes(q)).map((c) => ({ name: c.name, entity_id: c.id, types: [c.type], popularity: c.popularity })) });
    }
    if (u.pathname === "/v2/insights") {
      const ty = p.get("filter.type") ?? "";
      const ids = (p.get("signal.interests.entities") ?? "").split(",");
      if (ty === "urn:tag") {
        if (this.opts.failTags) return new Response("x", { status: 500 });
        const fam = (p.get("filter.tag.types") ?? "").split(":")[2]!;
        if (fam !== "decor" && this.opts.noAmbience) return ok({ results: { tags: [] } });
        const list = ids.length === 1 && SOLO[ids[0]!] ? SOLO[ids[0]!]! : JOINT[fam]!;
        return ok({ results: { tags: list.map(([name, a]) => ({ name, type: "urn:tag", query: { affinity: a } })) } });
      }
      const only = p.get("filter.entities")?.split(",");
      if (only) return ok({ results: { entities: only.filter((i) => AFF[i] != null).map((i) => ({ name: CATALOG.find((c) => c.id === i)!.name, entity_id: i, popularity: 0.5, query: { affinity: AFF[i] } })) } });
      const top = (TOP[ty] ?? []).slice(0, Number(p.get("take") ?? 10));
      const explain = p.get("feature.explainability") === "true";
      return ok({ results: { entities: top.map((t) => ({ name: t.name, entity_id: t.id, popularity: 0.4, query: { affinity: t.aff, ...(explain ? { explainability: { "signal.interests.entities": ids.map((id) => ({ entity_id: id, score: 1 / ids.length })) } } : {}) } })) } });
    }
    return new Response("not found", { status: 404 });
  };
}

export function makeSvc(f = new FakeQloo(), o: { key?: string | undefined; store?: MemStore } = {}) {
  const store = o.store ?? new MemStore();
  const q = new QlooClient({ apiKey: "key" in o ? o.key : "test-key", baseUrl: "https://qloo.test", store, fetchFn: f.fetch as typeof fetch, retryScale: 0, maxRetries: 1 });
  return { svc: new Service({ store, q }), store, f };
}
