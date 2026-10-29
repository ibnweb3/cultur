import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { Chain } from "./chain";
import { QlooClient } from "./qloo";
import { InvalidInput, Service, warmSome } from "./service";
import type { DossierRequest, Env, Store } from "./types";

const DEFAULT_RPC = "https://ethereum-rpc.publicnode.com,https://1rpc.io/eth,https://eth.llamarpc.com,https://cloudflare-eth.com";

const kvStore = (kv: KVNamespace): Store => ({
  get: (k) => kv.get(k),
  put: (k, v, ttl) => kv.put(k, v, { expirationTtl: Math.max(60, Math.floor(ttl)) }),
  delete: (k) => kv.delete(k),
});

export function makeService(env: Env, store: Store = kvStore(env.KV)): Service {
  return new Service({
    store,
    mk: (signal) => ({
      q: new QlooClient({ apiKey: env.QLOO_API_KEY, baseUrl: (env.QLOO_BASE_URL ?? "https://hackathon.api.qloo.com").replace(/\/$/, ""), store, signal }),
      chain: new Chain({ rpcUrl: env.ETH_RPC_URL ?? DEFAULT_RPC, signal }),
    }),
  });
}

const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type, mcp-session-id, mcp-protocol-version, accept", "access-control-allow-methods": "GET, POST, OPTIONS" };
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", ...CORS, ...headers } });
const err = (status: number, code: string, message: string, headers: Record<string, string> = {}) => json({ error: { code, message } }, status, headers);

let lastWarm = 0;
const qlooFor = (env: Env, store: Store) => new QlooClient({ apiKey: env.QLOO_API_KEY, baseUrl: (env.QLOO_BASE_URL ?? "https://hackathon.api.qloo.com").replace(/\/$/, ""), store });
const warmNow = (env: Env) => { const store = kvStore(env.KV); return warmSome(store, qlooFor(env, store), 3).catch(() => []); };

// Best-effort per-isolate limiter (free plan has no shared counter); documented in the README.
const hits = new Map<string, number[]>();
export function limited(ip: string, perMin: number, now = Date.now()): boolean {
  const q = (hits.get(ip) ?? []).filter((t) => now - t < 60000);
  if (q.length >= perMin) { hits.set(ip, q); return true; }
  q.push(now);
  hits.set(ip, q);
  if (hits.size > 5000) hits.clear();
  return false;
}

function parseBody(b: unknown): DossierRequest | null {
  if (!b || typeof b !== "object") return null;
  const o = b as Record<string, unknown>;
  if (typeof o.input !== "string" || !o.input.trim() || o.input.length > 200) return null;
  const r: DossierRequest = { input: o.input };
  if (o.creation_tx_hash != null) { if (typeof o.creation_tx_hash !== "string") return null; r.creation_tx_hash = o.creation_tx_hash; }
  if (o.qloo_entity_ids != null) {
    if (!Array.isArray(o.qloo_entity_ids)) return null;
    for (const h of o.qloo_entity_ids) if (!h || typeof h.entity_id !== "string" || typeof h.attribution !== "string" || !h.attribution) return null;
    r.qloo_entity_ids = o.qloo_entity_ids;
  }
  return r;
}

function mcpServer(svc: Service): McpServer {
  const s = new McpServer({ name: "cultur", version: "1.0.0" });
  s.registerTool("generate_dossier", {
    description: "Generate an auditable Cultur dossier (cultural fingerprint, cited findings, coverage gaps) for a crypto project or creator, grounded in Qloo. Same service and schema as POST /api/dossier.",
    inputSchema: {
      input: z.string().min(1).max(200).describe("Twitter/X handle, ENS name, Ethereum contract address, or project/creator name"),
      qloo_entity_ids: z.array(z.object({ entity_id: z.string(), attribution: z.string().min(1) })).optional().describe("Optional Qloo seed IDs; treated as unverified assertions"),
      creation_tx_hash: z.string().optional().describe("Optional contract creation transaction hash, verified against the receipt"),
    },
  }, async (args) => {
    try {
      const d = await svc.generate(args as DossierRequest);
      return { content: [{ type: "text" as const, text: JSON.stringify(d) }] };
    } catch (e) {
      if (e instanceof InvalidInput) return { content: [{ type: "text" as const, text: JSON.stringify({ error: { code: "invalid_input", message: e.message } }) }], isError: true };
      return { content: [{ type: "text" as const, text: JSON.stringify({ error: { code: "internal_error", message: "Unexpected server error" } }) }], isError: true };
    }
  });
  return s;
}

const OPENAPI = {
  openapi: "3.1.0",
  info: { title: "Cultur", version: "1.0", description: "Cultural-fingerprint due diligence for crypto projects and creators, grounded in Qloo. MCP (Streamable HTTP) is served at /mcp." },
  paths: {
    "/api/dossier": { post: { summary: "Generate a dossier", requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["input"], properties: {
      input: { type: "string", maxLength: 200, example: "@elonmusk" },
      qloo_entity_ids: { type: "array", items: { type: "object", required: ["entity_id", "attribution"], properties: { entity_id: { type: "string" }, attribution: { type: "string" } } } },
      creation_tx_hash: { type: "string" } } } } } },
      responses: { "200": { description: "Dossier (complete, partial or insufficient_evidence)" }, "422": { description: "Invalid input" }, "429": { description: "Rate limited" } } } },
    "/api/dossier/{id}": { get: { summary: "Retrieve the original dossier (no re-analysis)", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { "200": { description: "Dossier" }, "404": { description: "Missing or expired" } } } },
    "/health": { get: { summary: "Health", responses: { "200": { description: "ok" } } } },
  },
};

const DOCS = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Cultur API</title>
<link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5.17.14/swagger-ui.css"></head><body><div id="ui"></div>
<script src="https://unpkg.com/swagger-ui-dist@5.17.14/swagger-ui-bundle.js"></script><script>SwaggerUIBundle({url:"/openapi.json",dom_id:"#ui"})</script></body></html>`;

export default {
  async fetch(req: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const p = url.pathname;
    try {
      if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
      if (p === "/health") return json({ status: "ok", qloo_configured: !!env.QLOO_API_KEY, version: "1.0" });
      if (p === "/openapi.json") return json(OPENAPI);
      if (p === "/docs") return new Response(DOCS, { headers: { "content-type": "text/html; charset=utf-8" } });
      if (p === "/mcp") {
        const svc = makeService(env);
        const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        await mcpServer(svc).connect(transport);
        const res = await transport.handleRequest(req);
        const h = new Headers(res.headers);
        for (const [k, v] of Object.entries(CORS)) h.set(k, v);
        return new Response(res.body, { status: res.status, headers: h });
      }
      if (p === "/api/dossier" && req.method === "POST") {
        const ip = req.headers.get("cf-connecting-ip") ?? "unknown";
        if (limited(ip, parseInt(env.RATE_LIMIT_PER_MIN ?? "10", 10))) return err(429, "rate_limited", "Too many requests; retry in a minute.", { "retry-after": "60" });
        let body: unknown;
        try { body = await req.json(); } catch { return err(422, "invalid_input", "Request body must be JSON like {\"input\": \"<handle|ens|contract|name>\"}"); }
        const parsed = parseBody(body);
        if (!parsed) return err(422, "invalid_input", "Request body must be JSON like {\"input\": \"<handle|ens|contract|name>\"} (max 200 chars)");
        // keep the registry warm even if the cron trigger is late: a few cases per request, throttled per isolate
        if (ctx && env.QLOO_API_KEY && Date.now() - lastWarm > 20000) { lastWarm = Date.now(); ctx.waitUntil(warmNow(env)); }
        try { return json(await makeService(env).generate(parsed)); }
        catch (e) { if (e instanceof InvalidInput) return err(422, "invalid_input", e.message); throw e; }
      }
      const m = p.match(/^\/api\/dossier\/([A-Za-z0-9]{1,64})$/);
      if (m && req.method === "GET") {
        const d = await makeService(env).get(m[1]);
        return d ? json(d) : err(404, "not_found", "Dossier not found or expired");
      }
      if (p.startsWith("/api/")) return err(404, "not_found", "Unknown route");
      return env.ASSETS.fetch(req);
    } catch {
      return err(500, "internal_error", "Unexpected server error");
    }
  },

  // Registry fingerprints are produced at runtime from Qloo and kept in KV; a few cases per tick (50-subrequest limit).
  async scheduled(_e: ScheduledController, env: Env, ctx: ExecutionContext) {
    if (!env.QLOO_API_KEY) return;
    ctx.waitUntil(warmNow(env));
  },
};
