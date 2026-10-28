// SYNTHETIC test fixtures. Not real Qloo data; never shown in the product.
import { Chain } from "../src/chain";
import { QlooClient } from "../src/qloo";
import { Service } from "../src/service";
import type { Store } from "../src/types";

export class MemStore implements Store {
  m = new Map<string, string>();
  async get(k: string) { return this.m.get(k) ?? null; }
  async put(k: string, v: string) { this.m.set(k, v); }
  async delete(k: string) { this.m.delete(k); }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type J = any;
const ents = (prefix: string, n = 5) => Array.from({ length: n }, (_, i) => ({ entity_id: `${prefix}${i}`, name: `${prefix} item ${i}`, subtype: "urn:entity:artist", popularity: 0.1, tags: [{ tag_id: `tag:${prefix}${i % 2}`, name: `t${i % 2}` }] }));
const res = (body: J, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

export class FakeQloo {
  calls: string[] = [];
  search: J[] = [{ entity_id: "ANCHOR", name: "Foo Creator", types: ["urn:entity:person"] }];
  entities: J[] | null = null;
  fail: null | "429" | "timeout" | "malformed" | "500" = null;
  noInsights = false;
  handler = async (input: RequestInfo | URL): Promise<Response> => {
    const u = new URL(String(input));
    this.calls.push(u.toString());
    if (u.host === "rpc.test") return res({ jsonrpc: "2.0", id: 1, result: "0x" });
    if (this.fail === "timeout") throw Object.assign(new Error("t"), { name: "TimeoutError" });
    if (this.fail === "429") return res({ message: "slow" }, 429, { "retry-after": "0" });
    if (this.fail === "500") return res({}, 500);
    if (this.fail === "malformed") return new Response("<html>nope</html>", { status: 200 });
    const q = u.searchParams;
    if (u.pathname === "/search") return res({ results: this.search });
    if (u.pathname === "/entities") return this.entities ? res({ results: this.entities }) : res({ message: "No results" }, 404);
    if (u.pathname === "/v2/insights") {
      if (this.noInsights) return res({ message: "No results" }, 404);
      const t = q.get("filter.type") as string;
      if (t === "urn:tag") return res({ results: { tags: [{ tag_id: "tag:a", name: "A", query: { affinity: 1 } }, { tag_id: "tag:b", name: "B", query: { affinity: 0.5 } }] } });
      if (t === "urn:demographics") return res({ results: { demographics: [{ entity_id: "x", query: { age: { "25_to_29": 0.3 }, gender: { female: 0.4 } } }] } });
      return res({ results: { entities: ents(t.split(":").pop() as string) } });
    }
    if (u.pathname === "/v2/analysis/compare") return res({ success: true, results: { tags: [{ tag_id: "t", name: "T", query: { score: 0.7 } }], a: [], b: [], matchEntities: [] } });
    return res({}, 404);
  };
}

export function makeSvc(fake: FakeQloo, opts: { key?: string | undefined; rpc?: (b: J) => J; store?: MemStore; budgetMs?: number } = {}) {
  const store = opts.store ?? new MemStore();
  const key = "key" in opts ? opts.key : "test-key";
  const svc = new Service({
    store, budgetMs: opts.budgetMs,
    mk: (signal) => ({
      q: new QlooClient({ apiKey: key, baseUrl: "https://qloo.test", store, signal, fetchFn: fake.handler as typeof fetch, retryScale: 0, maxRetries: 1 }),
      chain: new Chain({
        rpcUrl: "https://rpc.test", signal,
        fetchFn: (async (_u: J, init: J) => {
          fake.calls.push("rpc " + JSON.parse(init.body).method);
          const r = opts.rpc ? opts.rpc(JSON.parse(init.body)) : "0x";
          return res({ jsonrpc: "2.0", id: 1, result: r });
        }) as typeof fetch,
      }),
    }),
  });
  return { svc, store };
}
