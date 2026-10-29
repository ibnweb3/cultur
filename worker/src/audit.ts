// Deterministic audit of generated UI code against a QlooVibe direction. Pure code: no model, no Qloo call.
// It measures adherence to the chosen direction plus a published list of generic-default markers.
// It does not judge whether a design is good or whether an audience will like it.

export const AUDIT_VERSION = "qv-audit-1.0";
export const MAX_CODE = 200_000;
export const MAX_REFERENCE = 40_000;

export interface AuditFinding {
  id: string;
  severity: "fail" | "warn";
  message: string;
  examples: string[];
  fix: string;
}
export interface AuditResult {
  audit_version: string;
  status: "pass" | "needs_changes";
  summary: string;
  reference: { palette: string[]; fonts: string[] };
  metrics: { color_literals: number; off_palette_colors: number; token_color_share: number | null; font_families_used: string[]; distinct_radii: number };
  findings: AuditFinding[];
  checks: { id: string; label: string; result: "pass" | "fail" | "warn" | "not_applicable" }[];
  limits: string;
}

type Rgb = [number, number, number];

/** Fonts that mark an unmodified starter template. Published so the check is inspectable. */
export const DEFAULT_FONTS = ["inter", "roboto", "open sans", "poppins", "montserrat", "space grotesk", "dm sans", "lato", "nunito"];
/** Phrases that read as unedited generic copy. */
export const GENERIC_COPY = ["lorem ipsum", "unlock the power", "revolutionize", "supercharge your", "seamless experience", "cutting-edge", "elevate your", "welcome to our", "your one-stop", "john doe", "acme inc"];
const TAILWIND_DEFAULT_COLOR = /\b(?:bg|text|border|from|to|via|ring|fill|stroke)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-(?:50|100|200|300|400|500|600|700|800|900|950)\b/g;
const PURPLE_GRADIENT_CLASS = /\b(?:from|via|to)-(?:purple|violet|indigo|fuchsia)-\d{2,3}\b/;

const HEX = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})\b/g;
const RGBFN = /rgba?\(\s*(\d{1,3})\s*[, ]\s*(\d{1,3})\s*[, ]\s*(\d{1,3})(?:\s*[,/]\s*[\d.]+%?)?\s*\)/gi;

function hexToRgb(h: string): Rgb | null {
  let x = h.replace("#", "");
  if (x.length === 3 || x.length === 4) x = x.split("").map((c) => c + c).join("");
  if (x.length === 8) x = x.slice(0, 6);
  if (x.length !== 6) return null;
  const n = parseInt(x, 16);
  return Number.isNaN(n) ? null : [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const dist = (a: Rgb, b: Rgb) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const norm = (rgb: Rgb) => "#" + rgb.map((v) => v.toString(16).padStart(2, "0")).join("");
const isNeutralEdge = (c: Rgb) => c.every((v) => v <= 6) || c.every((v) => v >= 249);

function colorsIn(text: string): Rgb[] {
  const out: Rgb[] = [];
  for (const m of text.matchAll(HEX)) { const c = hexToRgb(m[0]); if (c) out.push(c); }
  for (const m of text.matchAll(RGBFN)) { const c: Rgb = [Number(m[1]), Number(m[2]), Number(m[3])]; if (c.every((v) => v <= 255)) out.push(c); }
  return out;
}

const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/<!--[\s\S]*?-->/g, " ");
const firstFamily = (decl: string) => decl.split(",")[0]!.replace(/["']/g, "").trim();

function fontsDeclared(text: string, varOnly: boolean): string[] {
  const out = new Set<string>();
  const re = varOnly ? /--[\w-]*font[\w-]*\s*:\s*([^;}\n]+)/gi : /font-family\s*:\s*([^;}\n]+)/gi;
  for (const m of text.matchAll(re)) {
    const decl = m[1]!.trim();
    if (/^var\(/i.test(decl) || /^(?:inherit|initial|unset)$/i.test(decl)) continue;
    const f = firstFamily(decl);
    if (f) out.add(f.toLowerCase());
  }
  return [...out];
}

/** Pull the expected palette and fonts out of a QlooVibe brief, css_qv or css_shadcn export. */
export function parseReference(reference: string): { palette: Rgb[]; fonts: string[] } {
  const text = stripComments(reference);
  const palette: Rgb[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(/--[\w-]+\s*:\s*([^;}\n]+)/g)) {
    for (const c of colorsIn(m[1]!)) { const k = norm(c); if (!seen.has(k)) { seen.add(k); palette.push(c); } }
  }
  return { palette, fonts: fontsDeclared(text, true) };
}

const GENERIC_FAMILIES = new Set(["sans-serif", "serif", "monospace", "system-ui", "ui-sans-serif", "ui-serif", "ui-monospace", "cursive", "fantasy", "inherit"]);

export function auditUi(code: string, reference: string): AuditResult {
  const src = stripComments(code);
  const ref = parseReference(reference);
  const findings: AuditFinding[] = [];
  const checks: AuditResult["checks"] = [];
  const hasPalette = ref.palette.length > 0, hasFonts = ref.fonts.length > 0;

  // 1. Colour literals outside the direction's palette.
  const literals = colorsIn(src).filter((c) => !isNeutralEdge(c));
  const off = literals.filter((c) => !ref.palette.some((p) => dist(p, c) <= 14));
  const offUnique = [...new Set(off.map(norm))];
  if (hasPalette) {
    const bad = offUnique.length > 0 && off.length / Math.max(1, literals.length) > 0.15;
    checks.push({ id: "palette", label: "Colours come from the direction's palette", result: bad ? "fail" : offUnique.length ? "warn" : "pass" });
    if (offUnique.length) findings.push({
      id: "off_palette_colors", severity: bad ? "fail" : "warn",
      message: `${off.length} of ${literals.length} colour literals are not in the direction's palette (${offUnique.length} distinct).`,
      examples: offUnique.slice(0, 6),
      fix: "Replace these with the matching palette variable (for example var(--qv-accent)) or derive tints from it.",
    });
  } else checks.push({ id: "palette", label: "Colours come from the direction's palette", result: "not_applicable" });

  // 2. Fonts.
  const used = fontsDeclared(src, false);
  const styled = used.filter((f) => !GENERIC_FAMILIES.has(f));
  const wrongFonts = hasFonts ? styled.filter((f) => !ref.fonts.includes(f)) : [];
  const defaultFonts = styled.filter((f) => DEFAULT_FONTS.includes(f) && !ref.fonts.includes(f));
  const tailwindFont = /\bfont-(?:sans|serif|mono)\b/.test(src) && !used.length;
  if (hasFonts) {
    checks.push({ id: "fonts", label: "Fonts match the direction's pair", result: wrongFonts.length ? "fail" : "pass" });
    if (wrongFonts.length) findings.push({
      id: "wrong_fonts", severity: "fail",
      message: `Fonts used that are not in the direction (${ref.fonts.join(", ")}): ${wrongFonts.join(", ")}.`,
      examples: wrongFonts.slice(0, 6),
      fix: "Use the direction's display font for headings and its body font for text; load them as the brief explains.",
    });
  } else checks.push({ id: "fonts", label: "Fonts match the direction's pair", result: "not_applicable" });
  if (defaultFonts.length) findings.push({
    id: "default_fonts", severity: "warn",
    message: `Common starter-template fonts are in use: ${defaultFonts.join(", ")}.`,
    examples: defaultFonts, fix: "Swap for the direction's named fonts.",
  });
  void tailwindFont;

  // 3. Raw colour literals versus token usage.
  const varColorUses = (src.match(/var\(\s*--(?:qv-(?:bg|surface|border|text|muted|accent|accent-text)|background|foreground|card|primary|secondary|muted|accent|border|ring|popover)[\w-]*\s*\)/g) || []).length;
  const totalColorUse = varColorUses + literals.length;
  const share = totalColorUse ? Math.round((varColorUses / totalColorUse) * 100) : null;
  if (hasPalette && share !== null && totalColorUse >= 8) {
    const low = share < 50;
    checks.push({ id: "tokens", label: "Colours use the direction's variables", result: low ? "warn" : "pass" });
    if (low) findings.push({
      id: "low_token_use", severity: "warn",
      message: `Only ${share}% of colour uses reference the direction's variables.`,
      examples: [], fix: "Define the variables once in :root and reference them everywhere, so the direction can be changed in one place.",
    });
  } else checks.push({ id: "tokens", label: "Colours use the direction's variables", result: "not_applicable" });

  // 4. Generic-default markers.
  const markers: string[] = [];
  const twDefaults = [...new Set(src.match(TAILWIND_DEFAULT_COLOR) || [])];
  if (twDefaults.length && hasPalette) markers.push(`Tailwind default palette classes: ${twDefaults.slice(0, 5).join(", ")}`);
  if (PURPLE_GRADIENT_CLASS.test(src)) markers.push("purple/indigo gradient classes");
  for (const m of src.matchAll(/gradient\([^)]*\)/gi)) {
    const cs = colorsIn(m[0]);
    if (cs.some(([r, g, b]) => b > 150 && r > 80 && g < 120 && b > g + 60 && b > r + 20)) { markers.push("blue-violet CSS gradient"); break; }
  }
  const lower = src.toLowerCase();
  const copy = GENERIC_COPY.filter((p) => lower.includes(p));
  if (copy.length) markers.push(`generic copy: "${copy.slice(0, 4).join('", "')}"`);
  checks.push({ id: "generic_markers", label: "No generic starter-template markers", result: markers.length ? "fail" : "pass" });
  if (markers.length) findings.push({
    id: "generic_markers", severity: "fail",
    message: `Generic template markers found (${markers.length}).`,
    examples: markers.slice(0, 6),
    fix: "Replace with audience-specific copy and the direction's colours; use the touchstones and tone words from the brief.",
  });

  // 5. Radius consistency.
  const radii = new Set<string>();
  for (const m of src.matchAll(/border-radius\s*:\s*([^;}\n]+)/gi)) {
    const v = m[1]!.trim().toLowerCase();
    if (!/var\(|inherit|^0(?:px)?$/.test(v) && !/^50%$|^9999px$|^999px$/.test(v)) radii.add(v);
  }
  if (radii.size > 4) {
    checks.push({ id: "radius", label: "Corner radii are consistent", result: "warn" });
    findings.push({ id: "radius_scatter", severity: "warn", message: `${radii.size} different border-radius values are in use.`, examples: [...radii].slice(0, 6), fix: "Use var(--qv-radius) for components and at most one larger value for containers." });
  } else checks.push({ id: "radius", label: "Corner radii are consistent", result: "pass" });

  const fails = findings.filter((f) => f.severity === "fail").length;
  return {
    audit_version: AUDIT_VERSION,
    status: fails ? "needs_changes" : "pass",
    summary: fails
      ? `${fails} check${fails === 1 ? "" : "s"} failed and ${findings.length - fails} warning${findings.length - fails === 1 ? "" : "s"}. Fix the failures, then audit again.`
      : findings.length ? `No failures, ${findings.length} warning${findings.length === 1 ? "" : "s"}.` : "No failures or warnings.",
    reference: { palette: ref.palette.map(norm), fonts: ref.fonts },
    metrics: { color_literals: literals.length, off_palette_colors: off.length, token_color_share: share, font_families_used: used, distinct_radii: radii.size },
    findings, checks,
    limits: "Measures adherence to the chosen direction and a published list of generic-default markers. It does not judge design quality, layout, or whether an audience will like the result.",
  };
}

export const auditGuide = () => ({
  version: AUDIT_VERSION,
  status: "QlooVibe code checks, not Qloo output and not a quality score",
  default_font_markers: DEFAULT_FONTS,
  generic_copy_markers: GENERIC_COPY,
  checks: ["palette", "fonts", "tokens", "generic_markers", "radius"],
});
