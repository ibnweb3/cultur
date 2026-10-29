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

export function makeService(env: Env, store: Store = kvStore(env.KV), signal?: AbortSignal): Service {
  const deadline = AbortSignal.timeout(25000);
  const q = new QlooClient({ apiKey: env.QLOO_API_KEY, baseUrl: (env.QLOO_BASE_URL ?? "https://hackathon.api.qloo.com").replace(/\/$/, ""), store, timeoutMs: 12000, signal: signal ? AbortSignal.any([signal, deadline]) : deadline });
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
  if (!b || typeof b !== "object" || Array.isArray(b)) return null;
  const o: { audience?: string; seeds?: string[]; fresh?: boolean } = {};
  if (b.audience != null) { if (typeof b.audience !== "string" || b.audience.trim().length < 2 || b.audience.length > 300) return null; o.audience = b.audience.trim(); }
  if (b.seeds != null) { if (!Array.isArray(b.seeds) || !b.seeds.length || b.seeds.length > 5 || b.seeds.some((s: unknown) => typeof s !== "string" || s.trim().length < 2 || s.length > 60)) return null; o.seeds = b.seeds.map((s: string) => s.trim()); }
  if (!o.audience && !o.seeds?.length) return null;
  if (b.fresh !== undefined && typeof b.fresh !== "boolean") return null;
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

const NAME_SCHEMA = { type: "string", minLength: 2, maxLength: 60, description: "A nonblank entity name. Optional type hint, e.g. Slowdive (artist)." };
const AUDIENCE_PROPERTIES = {
  audience: { type: "string", minLength: 2, maxLength: 300, example: "fans of Slowdive, Aesop and A24", description: "Name 1-5 things the audience loves. Each parsed name must be 2-60 characters." },
  seeds: { type: "array", items: NAME_SCHEMA, minItems: 1, maxItems: 5, description: "Explicit audience names. Overrides parsing audience when supplied." },
  fresh: { type: "boolean", description: "Bypass the 6-hour provider cache. Default false." },
};
const RESULT_RESPONSES = { "200": { description: "Inspect status: complete, partial, or insufficient_evidence. Partial data is disclosed in caveats, unresolved, and per-result notes." }, "422": { description: "Invalid JSON or input outside the documented bounds" }, "429": { description: "Rate limited; Retry-After specifies seconds to wait" }, "500": { description: "Unexpected server error" } };
const OPENAPI = {
  openapi: "3.1.0",
  info: { title: "QlooVibe", version: "1.0", description: "Audience-grounded design direction for coding agents, from Qloo taste data. Qloo supplies ranked tags and entities; tokens come from a published rule table. MCP (Streamable HTTP) is served at /mcp." },
  paths: {
    "/api/vibe": { post: { summary: "Design brief + tokens for an audience", requestBody: { required: true, content: { "application/json": { schema: { type: "object", anyOf: [{ required: ["audience"] }, { required: ["seeds"] }], properties: AUDIENCE_PROPERTIES } } } }, responses: RESULT_RESPONSES } },
    "/api/vibe/{id}": { get: { summary: "Retrieve a stored brief", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { "200": { description: "brief" }, "404": { description: "missing or expired" } } } },
    "/api/check": { post: { summary: "Score references against an audience (critic)", requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["candidates"], anyOf: [{ required: ["audience"] }, { required: ["seeds"] }], properties: { ...AUDIENCE_PROPERTIES, candidates: { type: "array", items: NAME_SCHEMA, minItems: 1, maxItems: 12 } } } } } }, responses: RESULT_RESPONSES } },
    "/api/rules": { get: { summary: "The published rule table", responses: { "200": { description: "rules" } } } },
    "/api/benchmark": { get: { summary: "Latest measured Qloo vs LLM-only comparison (batch run)", responses: { "200": { description: "benchmark" }, "404": { description: "not yet run" } } } },
    "/health": { get: { summary: "Health", responses: { "200": { description: "ok" } } } },
  },
};
function docs(origin: string): string {
  const base = origin.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>API reference · QlooVibe</title>
<style>*{box-sizing:border-box}body{margin:0;background:#f7f5ef;color:#242622;font:16px/1.65 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}main{max-width:850px;margin:auto;padding:28px 24px 72px}nav{display:flex;flex-wrap:wrap;justify-content:space-between;gap:16px;padding-bottom:24px;border-bottom:1px solid #cecec4}a{color:#31543e;text-underline-offset:3px}a:focus-visible{outline:3px solid #31543e;outline-offset:4px}h1,h2,h3{line-height:1.2;letter-spacing:-.035em}h1{font-size:clamp(2rem,6vw,3rem);margin:42px 0 16px}h2{font-size:1.4rem;margin:0 0 14px}h3{font-size:1.05rem;margin:24px 0 8px}p{margin:10px 0 16px}section{padding:30px 0;border-bottom:1px solid #cecec4}.intro{max-width:66ch;color:#4f554c}code{font: .9em ui-monospace,SFMono-Regular,Consolas,monospace;overflow-wrap:anywhere}pre{overflow:auto;padding:18px;border:1px solid #d5d6cb;border-radius:5px;background:#eeeee5;white-space:pre;font-size:.88rem;line-height:1.6}pre code{font:inherit;overflow-wrap:normal}.endpoint{display:block;font-size:1.05rem;letter-spacing:0}.method{color:#31543e}.label{font-size:.8rem;color:#535b50;margin-bottom:4px}dl{margin:16px 0}dt{font-weight:650;margin-top:14px}dd{margin:4px 0 14px;color:#4f554c}ul{padding-left:22px}.note{padding-left:16px;border-left:3px solid #71866d;color:#4f554c}@media(max-width:500px){main{padding:20px 18px 48px}pre{padding:13px;font-size:.8rem}}</style></head><body><main>
<nav aria-label="Documentation navigation"><a href="/">← Back to QlooVibe</a><a href="/openapi.json">OpenAPI specification (JSON)</a></nav>
<header><h1>API reference</h1><p class="intro">Use the same audience research, design tokens and reference checks as the web app. Public endpoints need no account or API key.</p><p class="note">Qloo supplies taste data. QlooVibe maps it to design tokens using a <a href="/api/rules">published rule table</a>. The mapping is a design hypothesis, not a prediction of how people will respond to an interface.</p></header>
<section aria-labelledby="brief"><h2 id="brief"><code class="endpoint"><span class="method">POST</span> /api/vibe</code></h2><p>Create an audience brief with CSS, design vocabulary, cultural references and the evidence behind each token.</p><p class="label">curl · Bash</p><pre><code>curl -sS -X POST '${base}/api/vibe' \\
  -H 'content-type: application/json' \\
  --data '{"audience":"fans of Slowdive, Aesop and A24"}'</code></pre>
<dl><dt><code>audience</code> or <code>seeds</code></dt><dd>Supply a nonblank audience description of 2–300 characters naming 1–5 things people love, or an explicit array of 1–5 names. Each name must be 2–60 characters. Explicit <code>seeds</code> take priority and preserve punctuation within names.</dd><dt><code>fresh</code> · optional boolean</dt><dd>Set to <code>true</code> to bypass the provider cache. Otherwise, provider responses may be reused for up to 6 hours; the trace identifies cached requests.</dd></dl>
<p>For ambiguous names, add a type hint: <code>Apple (brand)</code>. Supported types are <code>brand</code>, <code>artist</code>, <code>movie</code>, <code>tv_show</code>, <code>book</code>, <code>videogame</code>, <code>podcast</code> and <code>person</code>. Aliases include <code>film</code>, <code>tv</code>, <code>show</code> and <code>game</code>.</p><p>Successful responses include an <code>id</code>, <code>seeds</code>, <code>trace</code> and <code>caveats</code>. With enough evidence, they also include <code>tokens</code> and a copyable <code>agent_brief</code>. Default token dimensions are explicitly labelled. Entirely default briefs are withheld.</p></section>
<section aria-labelledby="check"><h2 id="check"><code class="endpoint"><span class="method">POST</span> /api/check</code></h2><p>Check named artists, brands, films and other references against the same audience.</p><p class="label">curl · Bash</p><pre><code>curl -sS -X POST '${base}/api/check' \\
  -H 'content-type: application/json' \\
  --data '{"audience":"Slowdive, Aesop","candidates":["Bon Iver","Metallica"]}'</code></pre>
<p>Uses the same audience fields and optional <code>fresh</code> flag. <code>candidates</code> is required: an array of 1–12 nonblank names, each 2–60 characters. Duplicate names are checked once.</p><p>Each result includes the resolved name, affinity, comparison baseline, gap and verdict: <code>strong</code>, <code>ok</code>, <code>weak</code>, <code>off-audience</code> or <code>unknown</code>. The baseline is the median of Qloo’s top references for that audience and entity type, up to 10 results. Verdict thresholds are heuristic. Missing data stays unknown; it is never a zero score.</p></section>
<section aria-labelledby="responses"><h2 id="responses">Read the response status</h2><p>An HTTP <code>200</code> means the request was processed. Always inspect the JSON <code>status</code> and any caveats before using the result.</p><dl><dt><code>complete</code></dt><dd>Enough data was returned for the requested result. Read the evidence and any default token labels.</dd><dt><code>partial</code></dt><dd>Some data or names could not be included, or an entity matched only the closest available name. Inspect <code>unresolved</code>, <code>caveats</code> and individual result notes.</dd><dt><code>insufficient_evidence</code></dt><dd>No supported design direction or fit verdict could be produced. A brief has no tokens in this state. Try more specific names, or retry if the provider was unavailable.</dd></dl>
<p><code>422</code> means invalid JSON or input outside the limits above. <code>429</code> means too many requests: wait the number of seconds in the <code>Retry-After</code> header. <code>500</code> means an unexpected server error; retry later. Error bodies use <code>{"error":{"code":"…","message":"…"}}</code>.</p><p>Provider work has a 25-second deadline. Requests can return partial or insufficient evidence when the provider is slow or unavailable.</p></section>
<section aria-labelledby="mcp"><h2 id="mcp">Connect an MCP client</h2><p>The stateless Streamable HTTP endpoint is <code>${base}/mcp</code>. For Claude Code:</p><pre><code>claude mcp add --transport http qloovibe ${base}/mcp</code></pre>
<dl><dt><code>design_brief(audience, seeds?)</code></dt><dd>Returns the brief plus its full evidence. An audience string is required; explicit seeds are optional.</dd><dt><code>check_audience_fit(audience, candidates)</code></dt><dd>Returns reference scores and qualified fit verdicts.</dd><dt><code>get_rule_table()</code></dt><dd>Returns the versioned tag-to-token mapping.</dd></dl><p>MCP tools use the same name and input limits as the REST endpoints. Tool failures include <code>isError: true</code>; successful tool responses still require checking the result status.</p></section>
<section aria-labelledby="read"><h2 id="read">Read-only endpoints</h2><dl><dt><code>GET /api/vibe/{id}</code></dt><dd>Retrieve a saved brief by its returned ID. Briefs expire after 7 days. Missing, expired or unsaved briefs return <code>404</code>.</dd><dt><a href="/api/rules"><code>GET /api/rules</code></a></dt><dd>Inspect all mapping rules, defaults and filtering criteria.</dd><dt><a href="/api/benchmark"><code>GET /api/benchmark</code></a></dt><dd>Read the stored Qloo-versus-LLM vocabulary comparison. Returns <code>404</code> if no benchmark has been stored. It does not measure design quality.</dd><dt><a href="/health"><code>GET /health</code></a></dt><dd>Check server availability and whether provider bindings are configured. Configuration does not guarantee the external provider is reachable.</dd><dt><a href="/openapi.json"><code>GET /openapi.json</code></a></dt><dd>Download the machine-readable endpoint specification.</dd></dl></section>
<p><a href="/">Return to the app</a></p></main></body></html>`;
}

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
      if (p === "/docs") return new Response(docs(url.origin), { headers: { "content-type": "text/html; charset=utf-8" } });
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
        await mcpServer(makeService(env, undefined, req.signal)).connect(transport);
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
          const svc = makeService(env, undefined, req.signal);
          if (p === "/api/vibe") {
            const parsed = parseVibeBody(body);
            if (!parsed) return err(422, "invalid_input", 'Body must be JSON like {"audience": "fans of Slowdive, Aesop and A24"} (audience max 300 chars, or 1-5 seeds)');
            return json(await svc.generate(parsed));
          }
          const parsed = parseVibeBody(body);
          if (!parsed || !Array.isArray(body.candidates) || !body.candidates.length || body.candidates.length > 12 || body.candidates.some((c: unknown) => typeof c !== "string" || c.trim().length < 2 || c.length > 60)) return err(422, "invalid_input", 'Provide an audience and 1-12 reference names, each between 2 and 60 characters.');
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
