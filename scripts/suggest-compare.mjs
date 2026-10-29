// Compares audience-name suggestions from two local dev servers that differ only in SUGGEST_MODEL.
// Usage: node scripts/suggest-compare.mjs http://localhost:8792 http://localhost:8793
import { readFileSync } from "node:fs";
const [a, b] = process.argv.slice(2);
const html = readFileSync("worker/public/index.html", "utf8");
const chips = [...html.matchAll(/text: "([^"]{40,})" \}/g)].map((m) => m[1]).slice(0, 4);
const PROJECTS = [
  "A site for a student podcast series in Lagos Nigeria",
  "A booking site for an independent yoga studio in Lisbon for people who like indie folk and slow living",
  "A landing page for a retro arcade bar in Osaka aimed at twenty-somethings who love city pop and anime",
  "A fan hub for a metal band's touring crew in Berlin",
  "A neighbourhood bakery site in Mexico City for families who love telenovelas and street food",
  "A study-habit tracker app for university students in Seoul who follow K-pop and webtoons",
  ...chips,
];
const ask = async (base, project) => {
  for (let i = 0; i < 3; i++) {
    try { const r = await fetch(base + "/api/vibe", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ project }) }); const j = JSON.parse(await r.text()); if (j.audience) return j; } catch {}
  }
  return null;
};
const tot = { A: 0, B: 0 }, ok = { A: 0, B: 0 };
for (const p of PROJECTS) {
  const [x, y] = [await ask(a, p), await ask(b, p)];
  const row = (j) => j ? { status: j.status, kept: j.seeds?.length ?? 0, names: (j.seeds || []).map((s) => s.name) } : { status: "error", kept: 0, names: [] };
  const rx = row(x), ry = row(y);
  tot.A += rx.kept; tot.B += ry.kept; ok.A += rx.status === "complete" || rx.status === "partial" ? 1 : 0; ok.B += ry.status === "complete" || ry.status === "partial" ? 1 : 0;
  console.log(p.slice(0, 50)); console.log("  A:", rx.status, rx.kept, rx.names.join(" | ")); console.log("  B:", ry.status, ry.kept, ry.names.join(" | "));
}
console.log(JSON.stringify({ projects: PROJECTS.length, A_supported: ok.A, B_supported: ok.B, A_kept_total: tot.A, B_kept_total: tot.B }));
console.log("DONE");
