import { afterEach, describe, expect, it, vi } from "vitest";
import worker, { limited } from "../src/index";
import { FakeQloo, MemStore } from "./helpers";

function env(extra: Record<string, unknown> = {}) {
  const store = new MemStore();
  return {
    KV: { get: (k: string) => store.get(k), put: (k: string, v: string) => store.put(k, v), delete: (k: string) => store.delete(k) },
    ASSETS: { fetch: async () => new Response("<html>ui</html>", { headers: { "content-type": "text/html" } }) },
    QLOO_API_KEY: "test-key", QLOO_BASE_URL: "https://qloo.test", RATE_LIMIT_PER_MIN: "100", ADMIN_TOKEN: "admin-secret", ...extra,
  } as never;
}
const call = (e: unknown, path: string, init?: RequestInit) => worker.fetch(new Request("https://qv.test" + path, init), e as never);
const post = (e: unknown, path: string, body: unknown) => call(e, path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

afterEach(() => vi.unstubAllGlobals());

describe("api", () => {
  it("serves health, rules, openapi and static assets", async () => {
    const e = env();
    expect(((await (await call(e, "/health")).json()) as { status: string }).status).toBe("ok");
    const rules = (await (await call(e, "/api/rules")).json()) as { rules: unknown[]; status: string };
    expect(rules.rules.length).toBeGreaterThan(10);
    expect(rules.status).toContain("hypotheses");
    expect(((await (await call(e, "/openapi.json")).json()) as { openapi: string }).openapi).toBe("3.1.0");
    expect(await (await call(e, "/")).text()).toContain("ui");
    expect((await call(e, "/api/nope")).status).toBe(404);
  });
  it("validates input", async () => {
    const e = env();
    expect((await post(e, "/api/vibe", {})).status).toBe(422);
    expect((await post(e, "/api/vibe", { audience: "x".repeat(301) })).status).toBe(422);
    expect((await post(e, "/api/vibe", { seeds: ["a", "b", "c", "d", "e", "f"] })).status).toBe(422);
    expect((await post(e, "/api/check", { audience: "Slowdive" })).status).toBe(422);
    expect((await call(e, "/api/vibe", { method: "POST", body: "nope" })).status).toBe(422);
  });
  it("generates, stores and retrieves a brief", async () => {
    vi.stubGlobal("fetch", new FakeQloo().fetch);
    const e = env();
    const r = await post(e, "/api/vibe", { audience: "fans of Slowdive and Aesop" });
    expect(r.status).toBe(200);
    const v = (await r.json()) as { id: string; status: string };
    expect(v.status).toBe("complete");
    const g = await call(e, `/api/vibe/${v.id}`);
    expect(g.status).toBe(200);
    expect(((await g.json()) as { id: string }).id).toBe(v.id);
    expect((await call(e, "/api/vibe/doesnotexist")).status).toBe(404);
  });
  it("runs the critic", async () => {
    vi.stubGlobal("fetch", new FakeQloo().fetch);
    const r = await post(env(), "/api/check", { audience: "Slowdive, Aesop", candidates: ["Bon Iver", "Metallica"] });
    expect(r.status).toBe(200);
    expect(((await r.json()) as { results: unknown[] }).results).toHaveLength(2);
  });
  it("protects admin routes and stores the benchmark", async () => {
    const e = env();
    expect((await call(e, "/api/benchmark")).status).toBe(404);
    expect((await call(e, "/api/benchmark", { method: "PUT", body: "{}" })).status).toBe(401);
    expect((await call(e, "/api/admin/llm-pick", { method: "POST", body: "{}" })).status).toBe(401);
    const ok = await call(e, "/api/benchmark", { method: "PUT", headers: { authorization: "Bearer admin-secret" }, body: JSON.stringify({ n: 1 }) });
    expect(ok.status).toBe(200);
    expect(((await (await call(e, "/api/benchmark")).json()) as { n: number }).n).toBe(1);
  });
  it("rate limits", () => {
    for (let i = 0; i < 3; i++) expect(limited("1.1.1.1", 3, 1000 + i)).toBe(false);
    expect(limited("1.1.1.1", 3, 1010)).toBe(true);
    expect(limited("1.1.1.1", 3, 1000 + 61000)).toBe(false);
  });
  it("serves MCP tools over streamable HTTP", async () => {
    vi.stubGlobal("fetch", new FakeQloo().fetch);
    const e = env();
    const rpc = (id: number, method: string, params: unknown = {}) =>
      call(e, "/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) });
    await rpc(1, "initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "1" } });
    const list = (await (await rpc(2, "tools/list")).json()) as { result: { tools: { name: string }[] } };
    expect(list.result.tools.map((t) => t.name).sort()).toEqual(["check_audience_fit", "design_brief", "get_rule_table"]);
    const run = (await (await rpc(3, "tools/call", { name: "design_brief", arguments: { audience: "Slowdive, Aesop" } })).json()) as { result: { content: { text: string }[] } };
    expect(run.result.content[0]!.text).toContain("Design direction for");
    expect(JSON.parse(run.result.content[1]!.text).status).toBe("complete");
  });
});
