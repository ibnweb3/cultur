import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker, { limited } from "../src/index";
import { FakeQloo } from "./helpers";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type J = any;
const kv = () => {
  const m = new Map<string, string>();
  return { get: async (k: string) => m.get(k) ?? null, put: async (k: string, v: string) => void m.set(k, v), delete: async (k: string) => void m.delete(k) };
};
let env: J, fake: FakeQloo;
beforeEach(() => {
  fake = new FakeQloo();
  vi.stubGlobal("fetch", (i: J, init: J) => {
    const u = String(i);
    if (u.includes("ethereum-rpc") || u.includes("rpc.test")) return Promise.resolve(new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x" })));
    return fake.handler(i);
  });
  env = { KV: kv(), ASSETS: { fetch: async () => new Response("<html>ui</html>") }, QLOO_API_KEY: "test-key", QLOO_BASE_URL: "https://qloo.test", RATE_LIMIT_PER_MIN: "100" };
});
afterEach(() => vi.unstubAllGlobals());

const post = (body: unknown, ip = "1.1.1.1") => new Request("https://x.test/api/dossier", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body), headers: { "cf-connecting-ip": ip } });

describe("REST", () => {
  it("health, openapi, docs, ui", async () => {
    expect(((await (await worker.fetch(new Request("https://x.test/health"), env)).json()) as J).status).toBe("ok");
    expect((await worker.fetch(new Request("https://x.test/openapi.json"), env)).status).toBe(200);
    expect((await worker.fetch(new Request("https://x.test/docs"), env)).status).toBe(200);
    expect(await (await worker.fetch(new Request("https://x.test/"), env)).text()).toContain("ui");
  });
  it("POST then GET returns the same dossier; errors are structured", async () => {
    const r = await worker.fetch(post({ input: "Foo Creator" }), env);
    expect(r.status).toBe(200);
    const d = (await r.json()) as J;
    const g = await worker.fetch(new Request(`https://x.test/api/dossier/${d.id}`), env);
    expect(await g.json()).toEqual(d);
    expect((await worker.fetch(new Request("https://x.test/api/dossier/nope"), env)).status).toBe(404);
    expect((await worker.fetch(post({}), env)).status).toBe(422);
    expect((await worker.fetch(post({ input: "0x12" }), env)).status).toBe(422);
    expect((await worker.fetch(post("not json"), env)).status).toBe(422);
    const bad = await worker.fetch(post({ input: "" }), env);
    expect(JSON.stringify(await bad.json())).not.toContain("stack");
  });
  it("rate limits with 429 and Retry-After", () => {
    const now = Date.now();
    expect([limited("9.9.9.9", 2, now), limited("9.9.9.9", 2, now), limited("9.9.9.9", 2, now)]).toEqual([false, false, true]);
  });
});

describe("MCP", () => {
  const rpc = (method: string, params: J = {}, id = 1) => new Request("https://x.test/mcp", {
    method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  it("initialize, list tools, and call generate_dossier with the same schema as REST", async () => {
    const init = await worker.fetch(rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } }), env);
    expect(init.status).toBe(200);
    const list = (await (await worker.fetch(rpc("tools/list"), env)).json()) as J;
    expect(list.result.tools.map((t: J) => t.name)).toContain("generate_dossier");
    const call = (await (await worker.fetch(rpc("tools/call", { name: "generate_dossier", arguments: { input: "Foo Creator" } }), env)).json()) as J;
    const mcpD = JSON.parse(call.result.content[0].text);
    const restD = (await (await worker.fetch(post({ input: "Foo Creator" }), env)).json()) as J;
    expect(Object.keys(mcpD).sort()).toEqual(Object.keys(restD).sort());
    expect(mcpD.schema_version).toBe(restD.schema_version);
  });
  it("reports invalid input as a tool error", async () => {
    const call = (await (await worker.fetch(rpc("tools/call", { name: "generate_dossier", arguments: { input: "0x12" } }), env)).json()) as J;
    expect(call.result.isError).toBe(true);
  });
});
