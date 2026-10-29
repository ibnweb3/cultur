// Qloo client. Auth: X-Api-Key on https://hackathon.api.qloo.com. Routes and response shapes verified live 2026-10-27.
import type { Store } from "./types";

export interface QResult {
  ok: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data?: any;
  freshness: "fresh" | "cached";
  status?: number;
  error?: string;
  ref: string; // redacted reproducible query (no credentials)
  fetchedAt: number;
}

export interface QlooOpts {
  apiKey?: string;
  baseUrl: string;
  store: Store;
  signal?: AbortSignal;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
  maxRetries?: number;
  retryScale?: number; // test hook: 0 disables sleeping
  cacheTtlS?: number;
  cacheVersion?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function sha(s: string) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type J = any;
export const entitiesOf = (d: J): J[] => {
  let r = d?.results;
  if (r && !Array.isArray(r)) r = r.entities;
  return Array.isArray(r) ? r.filter((e) => e && typeof e === "object") : [];
};
export const tagsOf = (d: J): J[] => {
  let r = d?.results;
  if (r && !Array.isArray(r)) r = r.tags ?? r.entities;
  return Array.isArray(r) ? r.filter((e) => e && typeof e === "object") : [];
};
export const entId = (e: J): string | undefined => e?.entity_id ?? e?.id;
/** /search and /entities use `types` (list); /v2/insights uses `subtype`. */
export const etype = (e: J): string | undefined => (Array.isArray(e?.types) && e.types.length ? e.types[0] : e?.subtype ?? e?.type);

export class QlooClient {
  callsTotal = 0;
  constructor(private o: QlooOpts) {}
  get configured() { return !!this.o.apiKey; }

  private async key(path: string, params: Record<string, unknown>) {
    const ns = this.o.apiKey ? (await sha(this.o.apiKey)).slice(0, 8) : "nokey";
    const norm = JSON.stringify(Object.keys(params).sort().map((k) => [k, params[k]]));
    return "q:" + (await sha(`qloo|${this.o.baseUrl}|${path}|${norm}|v${this.o.cacheVersion ?? "1"}|${ns}`));
  }

  /** fresh=true bypasses the cache read (live grounding) but still stores the response. */
  async get(path: string, params: Record<string, string | number>, fresh = false): Promise<QResult> {
    const ref = `GET ${path}?` + Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join("&");
    const now = () => Date.now();
    if (!this.o.apiKey) return { ok: false, error: "QLOO_API_KEY not configured", ref, freshness: "fresh", fetchedAt: now() };
    const key = await this.key(path, params);
    if (!fresh) {
      try {
        const hit = await this.o.store.get(key);
        if (hit) { const j = JSON.parse(hit); return { ok: true, data: j.d, freshness: "cached", status: 200, ref, fetchedAt: j.t }; }
      } catch { /* cache miss */ }
    }
    const f = this.o.fetchFn ?? fetch;
    const retries = this.o.maxRetries ?? 2;
    const scale = this.o.retryScale ?? 1;
    let lastErr = "unknown", status: number | undefined;
    const url = this.o.baseUrl + path + "?" + new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString();
    for (let attempt = 0; attempt <= retries; attempt++) {
      this.callsTotal++;
      try {
        const sig = this.o.signal ? AbortSignal.any([this.o.signal, AbortSignal.timeout(this.o.timeoutMs ?? 8000)]) : AbortSignal.timeout(this.o.timeoutMs ?? 8000);
        const r = await f(url, { headers: { "X-Api-Key": this.o.apiKey }, signal: sig });
        status = r.status;
        if (status === 429 || status >= 500) {
          lastErr = `HTTP ${status}`;
          if (attempt < retries) {
            const ra = Math.min(parseFloat(r.headers.get("Retry-After") ?? ""), 5);
            await sleep(scale * ((Number.isFinite(ra) ? ra * 1000 : 400 * 2 ** attempt) + Math.random() * 250));
            continue;
          }
          break;
        }
        if (status === 404) return { ok: true, data: { results: [] }, freshness: "fresh", status, ref, fetchedAt: now() }; // documented "No results"
        if (status >= 400) return { ok: false, status, error: `HTTP ${status}`, ref, freshness: "fresh", fetchedAt: now() };
        let data: J;
        try { data = await r.json(); } catch { return { ok: false, status, error: "malformed JSON from provider", ref, freshness: "fresh", fetchedAt: now() }; }
        if (data === null || typeof data !== "object") return { ok: false, status, error: "unexpected response type", ref, freshness: "fresh", fetchedAt: now() };
        const t = now();
        try { await this.o.store.put(key, JSON.stringify({ d: data, t }), this.o.cacheTtlS ?? 6 * 3600); } catch { /* storage limits must not break requests */ }
        return { ok: true, data, freshness: "fresh", status, ref, fetchedAt: t };
      } catch (e) {
        if (this.o.signal?.aborted) return { ok: false, error: "cancelled at deadline", ref, freshness: "fresh", fetchedAt: now() };
        lastErr = (e as Error)?.name === "TimeoutError" ? "timeout" : `transport error: ${(e as Error)?.name}`;
      }
      if (attempt < retries) await sleep(scale * (300 * 2 ** attempt + Math.random() * 200));
    }
    return { ok: false, status, error: lastErr, ref, freshness: "fresh", fetchedAt: now() };
  }

  search(query: string, take = 5, fresh = false) { return this.get("/search", { query, take }, fresh); }
  /** Ranked design-vocabulary tags for an audience (tag family = decor | ambience | style). */
  tagInsights(ids: string[], family: string, take = 25, fresh = false) {
    return this.get("/v2/insights", { "filter.type": "urn:tag", "filter.tag.types": `urn:tag:${family}:qloo`, "signal.interests.entities": ids.join(","), take }, fresh);
  }
  /** Taste-ranked entities of one type for an audience; `only` scores specific candidate ids (critic mode). */
  entityInsights(ids: string[], type: string, take: number, o: { explain?: boolean; only?: string[] } = {}, fresh = false) {
    const p: Record<string, string | number> = { "filter.type": type, "signal.interests.entities": ids.join(","), take };
    if (o.explain) p["feature.explainability"] = "true";
    if (o.only?.length) p["filter.entities"] = o.only.join(",");
    return this.get("/v2/insights", p, fresh);
  }
}
