// Batch benchmark: Qloo decor vocabulary vs an LLM asked to pick from the SAME word list.
// Usage: ADMIN_TOKEN=... [QLOOVIBE_URL=...] node scripts/benchmark.mjs
// Results are stored in the Worker's private KV (GET /api/benchmark); they contain Qloo-derived tags, so they are not committed.
import { readFileSync, existsSync } from "node:fs";

const BASE = process.env.QLOOVIBE_URL || "https://qloovibe.ibnweb3lab.workers.dev";
let TOKEN = process.env.ADMIN_TOKEN;
if (!TOKEN && existsSync(new URL("../.env", import.meta.url))) {
  const m = readFileSync(new URL("../.env", import.meta.url), "utf8").match(/^ADMIN_TOKEN=(.+)$/m);
  if (m) TOKEN = m[1].trim().replace(/^"|"$/g, "");
}
if (!TOKEN) throw new Error("ADMIN_TOKEN is required");
const H = { "content-type": "application/json", "user-agent": "qloovibe-benchmark/1.0" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const K = 8, RUNS = 3, TEMP = 0.7;

const AUDIENCES = [
  "Slowdive, Aesop, A24", "Phoebe Bridgers, Aesop", "Travis Scott, Supreme", "Luke Combs, Yeti", "BLACKPINK, Glossier", "Norah Jones, Louis Vuitton",
  "Kendrick Lamar, Nike", "Taylor Swift, Sephora", "Johnny Cash, Harley-Davidson", "Daft Punk, Apple", "Bad Bunny, Zara", "Fleetwood Mac, Anthropologie",
];

async function post(path, body, headers = {}, tries = 4) {
  for (let i = 0; i < tries; i++) {
    const r = await fetch(BASE + path, { method: "POST", headers: { ...H, ...headers }, body: JSON.stringify(body) });
    if (r.status === 429) { await sleep(15000); continue; }
    if (!r.ok) throw new Error(`${path} -> HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return r.json();
  }
  throw new Error(`${path} kept returning 429`);
}
const jac = (a, b) => { const A = new Set(a), B = new Set(b); const i = [...A].filter((x) => B.has(x)).length; return i / (A.size + B.size - i || 1); };
const mean = (xs) => xs.reduce((s, x) => s + x, 0) / (xs.length || 1);
const pairs = (xs) => xs.flatMap((a, i) => xs.slice(i + 1).map((b) => [a, b]));
const f2 = (n) => (n == null ? "–" : n.toFixed(2));

// rule matcher mirroring src/rules.ts (exact tag, else a single word of >=4 chars)
const rules = await (await fetch(BASE + "/api/rules")).json();
const norm = (s) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
const idx = new Set(rules.rules.flatMap((r) => r.tags.map(norm)));
const mapped = (t) => idx.has(norm(t)) || norm(t).split(" ").some((w) => w.length >= 4 && idx.has(w));

console.log(`Running ${AUDIENCES.length} audiences against ${BASE}`);
const data = [];
for (const a of AUDIENCES) {
  const v = await post("/api/vibe", { audience: a });
  if (!v.vocabulary) { console.log("  skipped (no vocabulary):", a, v.caveats); continue; }
  const decor = v.vocabulary.filters.find((f) => f.family === "decor");
  const hidden = new Set(decor.dropped.filter((d) => !d.reason.startsWith("below top")).map((d) => d.tag));
  const visual = decor.raw.map((r) => r.tag).filter((t) => !hidden.has(t));
  data.push({ audience: a, seeds: v.seeds.map((s) => s.name), qloo: decor.kept.map((k) => k.tag), visual });
  console.log("  qloo:", a, "->", data.at(-1).qloo.join(", "));
  await sleep(2500);
}
const vocab = [...new Set(data.flatMap((d) => d.visual))];
console.log(`Vocabulary: ${vocab.length} visual decor tags pooled from Qloo output`);

for (const d of data) {
  const r = await post("/api/admin/llm-pick", { seeds: d.seeds, vocabulary: vocab, k: K, runs: RUNS, temperature: TEMP }, { authorization: `Bearer ${TOKEN}` });
  if (!r.runs) throw new Error("llm-pick failed: " + JSON.stringify(r));
  d.model = r.model; d.llmRuns = r.runs; d.llm = r.runs[0];
  console.log("  llm:", d.audience, "->", d.llm.join(", "));
}

// repeatability of Qloo itself: re-query 3 audiences with fresh=true and compare kept sets
const rep = [];
for (const d of data.slice(0, 3)) {
  const v = await post("/api/vibe", { audience: d.audience, fresh: true });
  rep.push(jac(v.vocabulary.filters.find((f) => f.family === "decor").kept.map((k) => k.tag), d.qloo));
  await sleep(2500);
}

const usable = data.filter((d) => d.llmRuns.every((r) => r.length >= 3));
const overlap = (d) => mean(d.llmRuns.map((r) => r.filter((w) => d.qloo.includes(w)).length / K));
const between = (get) => mean(pairs(data.map(get)).map(([a, b]) => jac(a, b)));
const distinct = (get) => new Set(data.flatMap(get)).size;
const top = (get) => { const c = {}; for (const w of data.flatMap(get)) c[w] = (c[w] || 0) + 1; const [w, n] = Object.entries(c).sort((a, b) => b[1] - a[1])[0]; return `${w} (${n} of ${data.length} audiences)`; };
const share = (get) => mean(data.map((d) => get(d).filter(mapped).length / (get(d).length || 1)));

const summary = [
  { label: "Agreement: share of the LLM's 8 picks that are also in Qloo's top 8 for that audience (mean of 3 runs)", qloo: "–", llm: f2(mean(data.map(overlap))) },
  { label: "Between-audience similarity of the word sets, Jaccard (lower = more audience-specific)", qloo: f2(between((d) => d.qloo)), llm: f2(between((d) => d.llm)) },
  { label: "Distinct words used across all audiences", qloo: String(distinct((d) => d.qloo)), llm: String(distinct((d) => d.llm)) },
  { label: "Most repeated word across audiences", qloo: top((d) => d.qloo), llm: top((d) => d.llm) },
  { label: "Repeatability on re-run, Jaccard (1.00 = identical)", qloo: f2(mean(rep)), llm: f2(mean(data.map((d) => mean(pairs(d.llmRuns).map(([a, b]) => jac(a, b)))))) },
  { label: "Share of picked words that map to a rule in the table", qloo: f2(share((d) => d.qloo)), llm: f2(share((d) => d.llm)) },
  { label: "Audit trail per word", qloo: "affinity, rank, filter decision, rule", llm: "none (a bare list)" },
];
const payload = {
  generated_at: new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC", n_audiences: data.length, model: data[0].model, vocab_size: vocab.length,
  method: `Each audience gets 8 decor words from two sources. Qloo arm: the top 8 of Qloo's ranked decor tags after the published filter. LLM arm: the model is shown the same pooled word list (${vocab.length} words) and asked for the 8 that fit the audience; ${RUNS} runs at temperature ${TEMP}.`,
  summary,
  rows: data.map((d) => ({ audience: d.audience, qloo: d.qloo, llm: d.llm, overlap: overlap(d) })),
  notes: [
    "The word list is pooled from Qloo's own output, so the LLM arm borrows Qloo's vocabulary: this is the easiest setting for the LLM.",
    "Agreement is not correctness. A high overlap means a capable LLM mostly reproduces Qloo's picks, so Qloo's contribution there is evidence and repeatability, not different answers.",
    "No claim is made that either arm produces a better design. The comparison measures specificity, repeatability and traceability only.",
    `One model, ${data.length} audiences, one temperature. Treat the numbers as indicative.`,
  ],
};
console.log("\n" + summary.map((s) => `${s.label}\n    qloo: ${s.qloo} | llm: ${s.llm}`).join("\n"));
const put = await fetch(BASE + "/api/benchmark", { method: "PUT", headers: { ...H, authorization: `Bearer ${TOKEN}` }, body: JSON.stringify(payload) });
console.log("\nstored:", put.status, usable.length === data.length ? "" : `(note: ${data.length - usable.length} audience(s) had a short LLM run)`);
