// Runs the with/without-brief build test against a running worker (default local dev with remote AI).
// Usage: ADMIN_TOKEN=... node scripts/audit-bench.mjs [baseUrl] [outFile]
import { writeFileSync, mkdirSync } from "node:fs";
const base = process.argv[2] || "http://localhost:8791";
const out = process.argv[3] || "data/audit-benchmark.json";
const token = process.env.ADMIN_TOKEN;
if (!token) { console.error("Set ADMIN_TOKEN"); process.exit(1); }
const PROJECTS = [
  "A site for a student podcast series in Lagos Nigeria",
  "A booking site for an independent yoga studio in Lisbon for people who like indie folk and slow living",
  "A landing page for a retro arcade bar in Osaka aimed at twenty-somethings who love city pop and anime",
  "A storefront for handmade ceramics sold to fans of Japanese minimalism and quiet coffee shops",
  "A fan hub for a metal band's touring crew in Berlin",
  "A neighbourhood bakery site in Mexico City for families who love telenovelas and street food",
  "A study-habit tracker app for university students in Seoul who follow K-pop and webtoons",
  "A portfolio for a documentary photographer in Nairobi who loves jazz and long-form journalism",
];
const rows = [];
for (const project of PROJECTS) {
  const t0 = Date.now();
  let j = {};
  for (let attempt = 0; attempt < 3 && !j.baseline; attempt++) {
    try {
      const r = await fetch(base + "/api/admin/build-bench", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + token }, body: JSON.stringify({ project }) });
      j = JSON.parse(await r.text());
    } catch (e) { j = { error: String(e.message).slice(0, 80) }; }
  }
  if (!j.baseline) { console.log("skip", project.slice(0, 40), JSON.stringify(j).slice(0, 120)); continue; }
  rows.push(j);
  const f = (a) => `${a.audit.status} [${a.audit.finding_ids.join(",") || "-"}]`;
  console.log(((Date.now() - t0) / 1000).toFixed(0) + "s", project.slice(0, 38).padEnd(38), "| base:", f(j.baseline), "| brief:", f(j.briefed), "| fixed:", f(j.repaired));
}
const markers = (arm) => arm.audit.finding_ids.includes("generic_markers") || arm.audit.finding_ids.includes("default_fonts");
const summary = {
  version: "qv-audit-bench-1", model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", temperature: 0, projects: rows.length,
  baseline: { pass: rows.filter((r) => r.baseline.audit.status === "pass").length, template_markers: rows.filter((r) => markers(r.baseline)).length, off_palette_colors: rows.reduce((n, r) => n + r.baseline.audit.metrics.off_palette_colors, 0), color_literals: rows.reduce((n, r) => n + r.baseline.audit.metrics.color_literals, 0) },
  briefed: { pass: rows.filter((r) => r.briefed.audit.status === "pass").length, template_markers: rows.filter((r) => markers(r.briefed)).length, off_palette_colors: rows.reduce((n, r) => n + r.briefed.audit.metrics.off_palette_colors, 0), color_literals: rows.reduce((n, r) => n + r.briefed.audit.metrics.color_literals, 0) },
  repaired: { pass: rows.filter((r) => r.repaired.audit.status === "pass").length, template_markers: rows.filter((r) => markers(r.repaired)).length, off_palette_colors: rows.reduce((n, r) => n + r.repaired.audit.metrics.off_palette_colors, 0), pages_needing_fix: rows.filter((r) => r.repaired.rounds > 0).length },
  note: "Palette and font checks compare against the QlooVibe direction, so the baseline cannot match them by design. The template-marker rows are independent of the direction. Neither measures design quality.",
};
mkdirSync("data", { recursive: true });
writeFileSync(out, JSON.stringify({ summary, rows: rows.map(({ project, direction, baseline, briefed, repaired }) => ({ project, direction, baseline: { ...baseline, code: undefined }, briefed: { ...briefed, code: undefined }, repaired: { ...repaired, code: undefined } })) }, null, 1));
writeFileSync(out.replace(/\.json$/, "-code.json"), JSON.stringify(rows.map((r) => ({ project: r.project, baseline: r.baseline.code, briefed: r.briefed.code, repaired: r.repaired.code })), null, 1));
console.log(JSON.stringify(summary, null, 1));
