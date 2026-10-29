import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { ruleTable } from "./compile";
import { QlooClient } from "./qloo";
import type { Env, Json, Store } from "./types";
import { InvalidInput, Service } from "./vibe";

const kvStore = (kv: KVNamespace): Store => ({
  get: (k) => kv.get(k),
  put: (k, v, ttl) => kv.put(k, v, { expirationTtl: Math.max(60, Math.floor(ttl)) }),
  delete: (k) => kv.delete(k),
});

export function makeService(env: Env, store: Store = kvStore(env.KV)): Service {
  const q = new QlooClient({ apiKey: env.QLOO_API_KEY, baseUrl: (env.QLOO_BASE_URL ?? "https://hackathon.api.qloo.com").replace(/\/$/, ""), store, timeoutMs: 12000 });
  return new Service({ store, q });
}

const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type, authorization, mcp-session-id, mcp-protocol-version, accept", "access-control-allow-methods": "GET, POST, PUT, OPTIONS" };
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", ...CORS, ...headers } });
const err = (status: number, code: string, message: string, headers: Record<string, string> = {}) => json({ error: { code, message } }, status, headers);

// Best-effort per-isolate limiter (the free plan has no shared counter); documented in the README.
const hits = new Map<string, number[]>();
export function limited(ip: string, perMin: number, now = Date.now()): boolean {
  const q = (hits.get(ip) ?? []).filter((t) => now - t < 60000);
  if (q.length >= perMin) { hits.set(ip, q); return true; }
  q.push(now); hits.set(ip, q);
  if (hits.size > 5000) hits.clear();
  return false;
}

const isAdmin = (req: Request, env: Env) => {
  const t = env.ADMIN_TOKEN, h = req.headers.get("authorization") ?? "";
  if (!t || !h.startsWith("Bearer ")) return false;
  const a = new TextEncoder().encode(h.slice(7)), b = new TextEncoder().encode(t);
  if (a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a[i]! ^ b[i]!;
  return d === 0;
};

function parseVibeBody(b: Json): { audience?: string; seeds?: string[]; fresh?: boolean } | null {
  if (!b || typeof b !== "object") return null;
  const o: { audience?: string; seeds?: string[]; fresh?: boolean } = {};
  if (b.audience != null) { if (typeof b.audience !== "string" || b.audience.length > 300) return null; o.audience = b.audience; }
  if (b.seeds != null) { if (!Array.isArray(b.seeds) || b.seeds.length > 5 || b.seeds.some((s: unknown) => typeof s !== "string" || (s as string).length > 60)) return null; o.seeds = b.seeds; }
  if (!o.audience && !o.seeds?.length) return null;
  if (b.fresh === true) o.fresh = true;
  return o;
}

const text = (t: string) => ({ type: "text" as const, text: t });
function mcpServer(svc: Service): McpServer {
  const s = new McpServer({ name: "qloovibe", version: "1.0.0" });
  const wrap = async (run: () => Promise<Json>, brief = false) => {
    try {
      const out = await run();
      return { content: brief && out.agent_brief ? [text(out.agent_brief), text(JSON.stringify(out))] : [text(JSON.stringify(out))] };
    } catch (e) {
      const msg = e instanceof InvalidInput ? e.message : "Unexpected server error";
      return { content: [text(JSON.stringify({ error: { code: e instanceof InvalidInput ? "invalid_input" : "internal_error", message: msg } }))], isError: true };
    }
  };
  s.registerTool("design_brief", {
    description: "Ground a UI in an audience's taste. Resolves the audience to Qloo entities, pulls ranked decor/ambience/style tags, filters them, and compiles design tokens through a published rule table (WCAG AA gated). Returns a markdown brief (CSS variables + touchstones) and the full receipts. Qloo supplies the tags; the token mapping is our documented rule table.",
    inputSchema: {
      audience: z.string().min(2).max(300).describe('What the audience loves, e.g. "fans of Slowdive, Aesop and A24"'),
      seeds: z.array(z.string().max(60)).max(5).optional().describe('Optional explicit seeds; add a type hint like "Slowdive (artist)" to disambiguate'),
    },
  }, (a) => wrap(() => svc.generate(a), true));
  s.registerTool("check_audience_fit", {
    description: "Critic: score artists, brands, films, shows or books you plan to reference in copy or imagery against an audience, using Qloo affinity. Flags off-audience picks relative to what Qloo ranks highest for the same audience.",
    inputSchema: {
      audience: z.string().min(2).max(300),
      candidates: z.array(z.string().max(60)).min(1).max(12).describe("Names to check, e.g. [\"Bon Iver\", \"Metallica\"]"),
    },
  }, (a) => wrap(() => svc.check(a)));
  s.registerTool("get_rule_table", { description: "Return the published rule table that maps Qloo design tags to tokens (our hypotheses, versioned).", inputSchema: {} }, () => wrap(async () => ruleTable()));
  return s;
}

const OPENAPI = {
  openapi: "3.1.0",
  info: { title: "QlooVibe", version: "1.0", description: "Audience-grounded design direction for coding agents, from Qloo taste data. Qloo supplies ranked tags and entities; tokens come from a published rule table. MCP (Streamable HTTP) is served at /mcp." },
  paths: {
    "/api/vibe": { post: { summary: "Design brief + tokens for an audience", requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { audience: { type: "string", maxLength: 300, example: "fans of Slowdive, Aesop and A24" }, seeds: { type: "array", items: { type: "string" }, maxItems: 5 }, fresh: { type: "boolean" } } } } } }, responses: { "200": { description: "complete, partial or insufficient_evidence" }, "422": { description: "invalid input" }, "429": { description: "rate limited" } } } },
    "/api/vibe/{id}": { get: { summary: "Retrieve a stored brief", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { "200": { description: "brief" }, "404": { description: "missing or expired" } } } },
    "/api/check": { post: { summary: "Score references against an audience (critic)", requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["audience", "candidates"], properties: { audience: { type: "string" }, candidates: { type: "array", items: { type: "string" }, maxItems: 12 } } } } } }, responses: { "200": { description: "scores" } } } },
    "/api/rules": { get: { summary: "The published rule table", responses: { "200": { description: "rules" } } } },
    "/api/benchmark": { get: { summary: "Latest measured Qloo vs LLM-only comparison (batch run)", responses: { "200": { description: "benchmark" }, "404": { description: "not yet run" } } } },
    "/health": { get: { summary: "Health", responses: { "200": { description: "ok" } } } },
  },
};
const DOCS = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>QlooVibe API</title>
<link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5.17.14/swagger-ui.css"></head><body><div id="ui"></div>
<script src="https://unpkg.com/swagger-ui-dist@5.17.14/swagger-ui-bundle.js"></script><script>SwaggerUIBundle({url:"/openapi.json",dom_id:"#ui"})</script></body></html>`;

const LLM_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

async function llmPick(env: Env, b: Json) {
  if (!env.AI) return { error: "Workers AI binding not configured" };
  const vocab: string[] = Array.isArray(b.vocabulary) ? b.vocabulary.map(String).slice(0, 400) : [];
  const seeds: string[] = Array.isArray(b.seeds) ? b.seeds.map(String).slice(0, 5) : [];
  const k = Math.min(15, Math.max(1, Number(b.k) || 8)), runs = Math.min(5, Math.max(1, Number(b.runs) || 1));
  const temperature = typeof b.temperature === "number" ? Math.min(1.5, Math.max(0, b.temperature)) : 0.7;
  if (!vocab.length || !seeds.length) return { error: "seeds and vocabulary are required" };
  const prompt = `An audience loves: ${seeds.join(", ")}.\nFrom the list below, pick the ${k} words that best describe the interior and visual aesthetic this audience would feel at home in.\nList: ${JSON.stringify(vocab)}\nReply with ONLY a JSON array of ${k} strings copied exactly from the list.`;
  const out: string[][] = [];
  for (let i = 0; i < runs; i++) {
    let r: Json;
    try { r = (await env.AI.run(LLM_MODEL as keyof AiModels, { messages: [{ role: "user", content: prompt }], temperature, max_tokens: 300 } as never)) as Json; }
    catch (e) { return { error: `Workers AI call failed: ${String((e as Error).message).slice(0, 200)}` }; } // admin-only route
    const resp = r?.response ?? r?.choices?.[0]?.message?.content ?? "";
    let arr: unknown = [];
    if (Array.isArray(resp)) arr = resp; // some models return already-parsed JSON
    else { const raw = String(resp); try { arr = JSON.parse(raw.slice(raw.indexOf("["), raw.lastIndexOf("]") + 1)); } catch { /* unparsable run */ } }
    const allowed = new Set(vocab);
    out.push((Array.isArray(arr) ? arr : []).map(String).filter((w) => allowed.has(w)).slice(0, k));
  }
  return { model: LLM_MODEL, temperature, k, runs: out };
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const p = url.pathname;
    try {
      if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
      if (p === "/health") return json({ status: "ok", qloo_configured: !!env.QLOO_API_KEY, ai_configured: !!env.AI, version: "1.0" });
      if (p === "/openapi.json") return json(OPENAPI);
      if (p === "/docs") return new Response(DOCS, { headers: { "content-type": "text/html; charset=utf-8" } });
      if (p === "/api/rules" && req.method === "GET") return json(ruleTable());
      if (p === "/api/benchmark" && req.method === "GET") {
        const b = await env.KV.get("benchmark:v1");
        return b ? new Response(b, { headers: { "content-type": "application/json; charset=utf-8", ...CORS } }) : err(404, "not_found", "No benchmark has been run yet");
      }
      if (p === "/api/benchmark" && req.method === "PUT") {
        if (!isAdmin(req, env)) return err(401, "unauthorized", "Admin token required");
        const body = await req.text();
        if (body.length > 400000) return err(413, "too_large", "Benchmark payload too large");
        JSON.parse(body);
        await env.KV.put("benchmark:v1", body);
        return json({ ok: true });
      }
      if (p === "/api/admin/llm-pick" && req.method === "POST") {
        if (!isAdmin(req, env)) return err(401, "unauthorized", "Admin token required");
        return json(await llmPick(env, await req.json()));
      }
      if (p === "/mcp") {
        const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        await mcpServer(makeService(env)).connect(transport);
        const res = await transport.handleRequest(req);
        const h = new Headers(res.headers);
        for (const [k, v] of Object.entries(CORS)) h.set(k, v);
        return new Response(res.body, { status: res.status, headers: h });
      }
      if ((p === "/api/vibe" || p === "/api/check") && req.method === "POST") {
        const ip = req.headers.get("cf-connecting-ip") ?? "unknown";
        if (limited(ip, parseInt(env.RATE_LIMIT_PER_MIN ?? "12", 10))) return err(429, "rate_limited", "Too many requests; retry in a minute.", { "retry-after": "60" });
        let body: Json;
        try { body = await req.json(); } catch { return err(422, "invalid_input", "Request body must be JSON"); }
        try {
          const svc = makeService(env);
          if (p === "/api/vibe") {
            const parsed = parseVibeBody(body);
            if (!parsed) return err(422, "invalid_input", 'Body must be JSON like {"audience": "fans of Slowdive, Aesop and A24"} (audience max 300 chars, or 1-5 seeds)');
            return json(await svc.generate(parsed));
          }
          const parsed = parseVibeBody(body);
          if (!parsed || !Array.isArray(body.candidates) || body.candidates.some((c: unknown) => typeof c !== "string")) return err(422, "invalid_input", 'Body must be {"audience": "...", "candidates": ["Bon Iver", "Metallica"]}');
          return json(await svc.check({ ...parsed, candidates: body.candidates }));
        } catch (e) { if (e instanceof InvalidInput) return err(422, "invalid_input", e.message); throw e; }
      }
      const m = p.match(/^\/api\/vibe\/([A-Za-z0-9]{1,64})$/);
      if (m && req.method === "GET") {
        const d = await makeService(env).get(m[1]!);
        return d ? json(d) : err(404, "not_found", "Brief not found or expired");
      }
      if (p.startsWith("/api/")) return err(404, "not_found", "Unknown route");
      return env.ASSETS.fetch(req);
    } catch {
      return err(500, "internal_error", "Unexpected server error");
    }
  },
};
