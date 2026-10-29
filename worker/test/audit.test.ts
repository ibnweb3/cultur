import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { auditUi, parseReference } from "../src/audit";
import { MemStore } from "./helpers";

const REF = `:root {
  --qv-bg: #fff9f5;
  --qv-surface: #fcf1eb;
  --qv-border: #e8dbd3;
  --qv-text: #211813;
  --qv-muted: #63554b;
  --qv-accent: #926649;
  --qv-accent-text: #ffffff;
  --qv-radius: 8px;
  --qv-font-display: Georgia, "Times New Roman", serif;
  --qv-font-body: "Figtree", "Segoe UI", Arial, sans-serif;
}`;

const GOOD = `body { background: var(--qv-bg); color: var(--qv-text); font-family: "Figtree", sans-serif; }
h1, h2 { font-family: Georgia, serif; color: var(--qv-text); }
.card { background: var(--qv-surface); border: 1px solid var(--qv-border); border-radius: var(--qv-radius); }
.btn { background: var(--qv-accent); color: var(--qv-accent-text); border-radius: var(--qv-radius); }
.tag { color: var(--qv-muted); background: #fcf1eb; }
<h1>Campus Voices, from Yaba to Surulere</h1>`;

const SLOP = `body { font-family: Inter, sans-serif; background: #f8fafc; color: #1e293b; }
.hero { background: linear-gradient(135deg, #6366f1, #a855f7); }
.btn { background: #6366f1; border-radius: 6px; } .a { border-radius: 9px; } .b { border-radius: 14px; } .c { border-radius: 20px; } .d { border-radius: 3px; }
<div class="bg-indigo-600 text-white"><h1>Unlock the power of your podcast</h1><p>Lorem ipsum</p></div>`;

describe("audit_ui", () => {
  it("reads the palette and fonts from a brief", () => {
    const r = parseReference(REF);
    expect(r.palette).toHaveLength(7);
    expect(r.fonts).toEqual(["georgia", "figtree"]);
  });
  it("passes code that follows the direction", () => {
    const a = auditUi(GOOD, REF);
    expect(a.status).toBe("pass");
    expect(a.findings.filter((f) => f.severity === "fail")).toEqual([]);
    expect(a.limits).toContain("does not judge design quality");
  });
  it.each(["aaaaaaaaaaaaaaaaaaaa", "<div>Meet the neighbourhood artists</div>"])("cannot certify a direction from unstyled input: %s", (code) => {
    const result = auditUi(code, REF);
    expect(result.status).toBe("needs_changes");
    expect(result.findings.some((finding) => finding.id === "unverifiable_direction")).toBe(true);
    expect(result.checks.find((check) => check.id === "palette")?.result).toBe("not_applicable");
    expect(result.checks.find((check) => check.id === "fonts")?.result).toBe("not_applicable");
  });
  it("flags off-palette colours, wrong fonts, template markers and scattered radii", () => {
    const a = auditUi(SLOP, REF);
    expect(a.status).toBe("needs_changes");
    const ids = a.findings.map((f) => f.id);
    expect(ids).toEqual(expect.arrayContaining(["off_palette_colors", "wrong_fonts", "default_fonts", "generic_markers", "radius_scatter"]));
    expect(a.findings.find((f) => f.id === "wrong_fonts")!.examples).toContain("inter");
    expect(a.metrics.off_palette_colors).toBeGreaterThan(3);
  });
  it("treats a colour close to a palette colour as the same and ignores pure black and white", () => {
    const a = auditUi("a{color:#211914;background:#fff;border-color:#000}", REF);
    expect(a.metrics.off_palette_colors).toBe(0);
  });
  it("does not fail palette or fonts when the reference has none", () => {
    const a = auditUi("body { color: #123456; font-family: Inter }", "Use warm colours and a friendly tone for the page.");
    expect(a.checks.find((c) => c.id === "palette")!.result).toBe("not_applicable");
    expect(a.checks.find((c) => c.id === "fonts")!.result).toBe("not_applicable");
  });
  it("flags a blue-violet gradient but not a pink or green one", () => {
    expect(auditUi(".a{background:linear-gradient(135deg,#6366f1,#a855f7)}", REF).findings.map((f) => f.id)).toContain("generic_markers");
    expect(auditUi(".a{background:linear-gradient(to bottom,#ff69b4,#ffe6f2)}", REF).findings.map((f) => f.id)).not.toContain("generic_markers");
    expect(auditUi(".a{background:linear-gradient(to bottom,#c9e4ca,#f7f7f7)}", REF).findings.map((f) => f.id)).not.toContain("generic_markers");
  });
  it("ignores colours inside comments", () => {
    expect(auditUi("/* #ff00ff */ a { color: var(--qv-text) }", REF).metrics.color_literals).toBe(0);
  });
});

describe("audit api", () => {
  const e = () => {
    const store = new MemStore();
    return { KV: { get: (k: string) => store.get(k), put: (k: string, v: string) => store.put(k, v), delete: (k: string) => store.delete(k) }, ASSETS: { fetch: async () => new Response("ui") }, QLOO_API_KEY: "k", RATE_LIMIT_PER_MIN: "100" } as never;
  };
  const post = (body: unknown) => worker.fetch(new Request("https://qv.test/api/audit", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), e());
  it("audits over REST without any Qloo call", async () => {
    const res = await post({ code: SLOP, reference: REF });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe("needs_changes");
  });
  it("rejects missing or oversized input", async () => {
    expect((await post({ code: "x" })).status).toBe(422);
    expect((await post({ code: "a".repeat(200_001), reference: REF })).status).toBe(422);
    expect((await post({ code: SLOP, reference: 5 })).status).toBe(422);
  });
  it("is callable as an MCP tool", async () => {
    const res = await worker.fetch(new Request("https://qv.test/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "cf-connecting-ip": "audit-mcp" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "audit_ui", arguments: { code: GOOD, reference: REF } } }) }), e());
    const j = (await res.json()) as { result: { content: { text: string }[] } };
    expect(JSON.parse(j.result.content[0]!.text).status).toBe("pass");
  });
});
