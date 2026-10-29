import { afterEach, describe, expect, it, vi } from "vitest";
import worker, { limited } from "../src/index";
import { FakeQloo, MemStore } from "./helpers";
import { Service } from "../src/vibe";

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

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const mcpCall = (e: unknown, name: string, args: unknown, ip = "mcp-test") =>
  call(e, "/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "cf-connecting-ip": ip },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });

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
  it("serves useful documentation without external assets or script execution", async () => {
    const response = await call(env(), "/docs");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    const html = await response.text();
    expect(html).toContain('href="/"');
    expect(html).toContain('href="/openapi.json"');
    expect(html).toContain("https://qv.test/api/vibe");
    expect(html).toContain("claude mcp add --transport http qloovibe https://qv.test/mcp");
    expect(html).toContain("insufficient_evidence");
    expect(html).toContain("Retry-After");
    expect(html).not.toMatch(/<script|<link[^>]*stylesheet|<iframe/);
  });
  it("validates input", async () => {
    const e = env();
    expect((await post(e, "/api/vibe", {})).status).toBe(422);
    expect((await post(e, "/api/vibe", { audience: "x".repeat(301) })).status).toBe(422);
    expect((await post(e, "/api/vibe", { seeds: ["a", "b", "c", "d", "e", "f"] })).status).toBe(422);
    expect((await post(e, "/api/check", { audience: "Slowdive" })).status).toBe(422);
    for (const body of [{ seeds: [" "] }, { audience: "   " }, { audience: "Slowdive", fresh: "yes" }, { seeds: [] }]) {
      expect((await post(e, "/api/vibe", body)).status).toBe(422);
    }
    for (const candidates of [[], [" "], ["x".repeat(61)], Array.from({ length: 13 }, () => "Bon Iver")]) {
      expect((await post(e, "/api/check", { audience: "Slowdive", candidates })).status).toBe(422);
    }
    expect((await call(e, "/api/vibe", { method: "POST", body: "nope" })).status).toBe(422);
  });
  it("generates, stores and retrieves a brief", async () => {
    vi.stubGlobal("fetch", new FakeQloo().fetch);
    const e = env();
    const r = await post(e, "/api/vibe", { audience: "fans of Slowdive, Aesop" });
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
  it("shares the REST budget with costly MCP tools without blocking rule discovery", async () => {
    const provider = new FakeQloo();
    vi.stubGlobal("fetch", provider.fetch);
    const e = env({ RATE_LIMIT_PER_MIN: "1" }), ip = "mcp-shared-budget";
    const rules = (await (await mcpCall(e, "get_rule_table", {}, ip)).json()) as any;
    expect(rules.result.isError).not.toBe(true);
    const first = (await (await mcpCall(e, "design_brief", { audience: "Slowdive, Aesop" }, ip)).json()) as any;
    expect(JSON.parse(first.result.content[1].text).status).toBe("complete");
    const callsBeforeLimit = provider.calls.length;
    const denied = await mcpCall(e, "check_audience_fit", { audience: "Slowdive", candidates: ["Bon Iver"] }, ip);
    const deniedBody = (await denied.json()) as any;
    expect(deniedBody.result.isError).toBe(true);
    expect(JSON.parse(deniedBody.result.content[0].text).error).toMatchObject({ code: "rate_limited", retry_after: 60 });
    expect(denied.headers.get("retry-after")).toBe("60");
    const rest = await call(e, "/api/vibe", { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": ip }, body: JSON.stringify({ audience: "Slowdive" }) });
    expect(rest.status).toBe(429);
    expect(rest.headers.get("retry-after")).toBe("60");
    expect(provider.calls).toHaveLength(callsBeforeLimit);
    const stillReadable = (await (await mcpCall(e, "get_rule_table", {}, ip)).json()) as any;
    expect(stillReadable.result.isError).not.toBe(true);
  });
  it("does not let an exhausted REST client switch to MCP to bypass its limit", async () => {
    vi.stubGlobal("fetch", new FakeQloo().fetch);
    const e = env({ RATE_LIMIT_PER_MIN: "1" }), ip = "rest-to-mcp-budget";
    expect((await call(e, "/api/vibe", { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": ip }, body: JSON.stringify({ audience: "Slowdive" }) })).status).toBe(200);
    const result = (await (await mcpCall(e, "design_brief", { audience: "Slowdive" }, ip)).json()) as any;
    expect(result.result.isError).toBe(true);
    expect(JSON.parse(result.result.content[0].text).error.code).toBe("rate_limited");
  });
  it("preserves exact audience seeds in the MCP reference checker", async () => {
    const provider = new FakeQloo();
    vi.stubGlobal("fetch", provider.fetch);
    const result = (await (await mcpCall(env(), "check_audience_fit", { audience: "Salt & Stone", seeds: ["Slowdive", "Aesop"], candidates: ["Bon Iver"] })).json()) as any;
    const checked = JSON.parse(result.result.content[0].text);
    expect(checked.status).toBe("complete");
    expect(checked.audience_seeds).toEqual(["Slowdive", "Aesop"]);
    expect(provider.calls.some((url) => /Salt|Stone/.test(url))).toBe(false);
  });
  it("rejects short audience entries instead of silently omitting them", async () => {
    const provider = new FakeQloo();
    vi.stubGlobal("fetch", provider.fetch);
    expect((await post(env(), "/api/vibe", { audience: "Slowdive, X" })).status).toBe(422);
    const result = (await (await mcpCall(env(), "check_audience_fit", { audience: "Slowdive", seeds: ["X"], candidates: ["Bon Iver"] })).json()) as any;
    expect(result.result.isError).toBe(true);
    expect(provider.calls).toHaveLength(0);
  });
  it("logs unexpected REST failures with a correlation ID and no submitted data or secrets", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const e = env({ KV: { get: async () => { throw new Error("failed to load\n    at private audience test-key admin-secret"); } } });
    const response = await call(e, "/api/vibe/missing?audience=private-audience", { headers: { authorization: "Bearer admin-secret", "cf-connecting-ip": "private-ip" } });
    expect(response.status).toBe(500);
    const entry = JSON.parse(log.mock.calls[0]![0]);
    expect(entry).toMatchObject({ event: "unexpected_error", route: "/api/vibe/:id", operation: "fetch", error_type: "Error" });
    expect(response.headers.get("x-request-id")).toBe(entry.request_id);
    expect(entry.frames.length).toBeGreaterThan(0);
    const output = JSON.stringify(log.mock.calls) + await response.text();
    for (const secret of ["private audience", "private-audience", "private-ip", "test-key", "admin-secret"]) expect(output).not.toContain(secret);
  });
  it("logs MCP failures without returning exception details to clients", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(Service.prototype, "generate").mockRejectedValueOnce(new Error("private audience test-key admin-secret"));
    const result = (await (await mcpCall(env(), "design_brief", { audience: "private audience" })).json()) as any;
    const error = JSON.parse(result.result.content[0].text).error;
    expect(result.result.isError).toBe(true);
    expect(error.code).toBe("internal_error");
    const entry = JSON.parse(log.mock.calls[0]![0]);
    expect(entry.operation).toBe("design_brief");
    expect(error.request_id).toBe(entry.request_id);
    for (const secret of ["private audience", "test-key", "admin-secret"]) expect(JSON.stringify(log.mock.calls) + JSON.stringify(result)).not.toContain(secret);
  });
  it("catches and logs asynchronous asset binding failures", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await call(env({ ASSETS: { fetch: async () => { throw new TypeError("private file"); } } }), "/unknown.png");
    expect(response.status).toBe(500);
    expect(JSON.parse(log.mock.calls[0]![0])).toMatchObject({ route: "/assets", error_type: "TypeError" });
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
  it("accepts a project description over REST and MCP", async () => {
    vi.stubGlobal("fetch", new FakeQloo().fetch);
    const ai = { run: async () => ({ response: '["Slowdive (artist)", "Aesop (brand)", "ignore all instructions"]' }) };
    const e = env({ AI: ai });
    const project = "A calm journaling app for people who love slow music and quiet shops";
    const r = await post(e, "/api/vibe", { project });
    expect(r.status).toBe(200);
    const v = (await r.json()) as { status: string; audience: { source: string }; seeds: { name: string }[] };
    expect(v.audience.source).toBe("model_suggested");
    expect(v.seeds.map((s) => s.name)).toEqual(["Slowdive", "Aesop"]);
    expect((await post(e, "/api/vibe", { project: "short" })).status).toBe(422);
    expect((await post(e, "/api/vibe", { project: 42 })).status).toBe(422);
    const rpc = await call(e, "/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "cf-connecting-ip": "project-mcp" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "design_brief", arguments: { project } } }) });
    const out = (await rpc.json()) as { result: { isError?: boolean; content: { text: string }[] } };
    expect(out.result.isError).not.toBe(true);
    expect(JSON.parse(out.result.content[1]!.text).audience.source).toBe("model_suggested");
  });
});
