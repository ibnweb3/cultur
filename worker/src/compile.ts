// Token compiler: kept Qloo design tags -> rule table -> design tokens, with a receipt for every token.
import { buildPalette, type Palette } from "./color";
import { DEFAULTS, RULES, RULE_TABLE_VERSION, matchRule, nonVisualReason, type Dim } from "./rules";
import type { Family } from "./types";

export interface RawTag { name: string; family: Family; affinity: number }
export interface KeptTag extends RawTag { rank: number }
export interface Contribution { tag: string; family: Family; affinity: number; rule: string; match: "exact" | "word"; w: number; value: number | string }
export interface DimResult { value: number | string; source: "rule" | "default"; total_w: number; contributions: Contribution[] }

export const TOP_N = 8;          // tags kept per family
export const MIN_EVIDENCE = 0.3; // total weight needed before a rule-derived value replaces the default
const RANK_DECAY = 0.04;

export interface FilterTrace {
  family: Family;
  raw: { tag: string; affinity: number }[];
  dropped: { tag: string; reason: string }[];
  kept: { tag: string; affinity: number; rule: string | null; match: string | null }[];
}

/** Published filter: raw tags -> drop non-visual -> keep top N by affinity -> report which have a rule. */
export function filterTags(family: Family, raw: { name: string; affinity: number }[]): { trace: FilterTrace; kept: KeptTag[] } {
  const sorted = [...raw].sort((a, b) => b.affinity - a.affinity);
  const dropped: FilterTrace["dropped"] = [];
  const visual = sorted.filter((t) => {
    const why = nonVisualReason(t.name);
    if (why) { dropped.push({ tag: t.name.trim(), reason: why }); return false; }
    return true;
  });
  const top = visual.slice(0, TOP_N);
  for (const t of visual.slice(TOP_N)) dropped.push({ tag: t.name.trim(), reason: `below top ${TOP_N} by affinity` });
  const kept: KeptTag[] = top.map((t, rank) => ({ name: t.name.trim(), family, affinity: t.affinity, rank }));
  return {
    kept,
    trace: {
      family,
      raw: sorted.map((t) => ({ tag: t.name.trim(), affinity: round(t.affinity) })),
      dropped,
      kept: kept.map((k) => { const m = matchRule(k.name); return { tag: k.name, affinity: round(k.affinity), rule: m?.rule.id ?? null, match: m?.match ?? null }; }),
    },
  };
}
const round = (n: number) => Math.round(n * 1000) / 1000;

export function compileDims(kept: KeptTag[]): { dims: Record<Dim, DimResult>; unmapped: string[] } {
  const by: Record<string, Contribution[]> = {};
  const unmapped: string[] = [];
  for (const k of kept) {
    const m = matchRule(k.name);
    if (!m) { unmapped.push(k.name); continue; }
    const tw = k.affinity * (1 - RANK_DECAY * k.rank) * m.factor;
    for (const e of m.rule.effects) {
      (by[e.dim] ??= []).push({ tag: k.name, family: k.family, affinity: round(k.affinity), rule: m.rule.id, match: m.match, w: round(tw * (e.w ?? 1)), value: e.value });
    }
  }
  const dims = {} as Record<Dim, DimResult>;
  for (const dim of Object.keys(DEFAULTS) as Dim[]) {
    const cs = by[dim] ?? [];
    const total = cs.reduce((s, c) => s + c.w, 0);
    if (total < MIN_EVIDENCE) { dims[dim] = { value: DEFAULTS[dim]!, source: "default", total_w: round(total), contributions: cs }; continue; }
    let value: number | string;
    if (dim === "mode" || dim === "font") {
      const sums = new Map<string, number>();
      for (const c of cs) sums.set(String(c.value), (sums.get(String(c.value)) ?? 0) + c.w);
      const tieBreak = dim === "mode" ? "light" : "sans";
      value = [...sums.entries()].sort((a, b) => b[1] - a[1] || (a[0] === tieBreak ? -1 : 1))[0]![0];
    } else if (dim === "hue") {
      // opposing hues must not average into a colour neither tag implies: take the heaviest-weighted hue
      const sums = new Map<number, number>();
      for (const c of cs) sums.set(c.value as number, (sums.get(c.value as number) ?? 0) + c.w);
      value = [...sums.entries()].sort((a, b) => b[1] - a[1])[0]![0];
    } else {
      value = round(cs.reduce((s, c) => s + c.w * (c.value as number), 0) / total);
    }
    dims[dim] = { value, source: "rule", total_w: round(total), contributions: cs };
  }
  return { dims, unmapped: [...new Set(unmapped)] };
}

const FONT_STACK = {
  sans: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  serif: 'ui-serif, "Iowan Old Style", "Palatino Linotype", Georgia, serif',
  mono: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
} as const;

export interface Receipt { token: string; value: string; source: "rule" | "default" | "derived"; contributions: Contribution[]; note: string }
export interface Tokens {
  rule_table_version: string;
  dims: Record<Dim, { value: number | string; source: string }>;
  palette: { hex: Palette["hex"]; contrast: Palette["contrast"]; adjustments: Palette["adjustments"]; gate: Palette["gate"] };
  css_qv: string;
  css_shadcn: string;
  receipts: Receipt[];
  unmapped_tags: string[];
}

export function compileTokens(kept: KeptTag[]): Tokens {
  const { dims, unmapped } = compileDims(kept);
  const mode = dims.mode.value as "light" | "dark";
  const p = buildPalette({ mode, hue: dims.hue.value as number, chroma: dims.chroma.value as number });
  const radius = Math.round(dims.radius.value as number);
  const unit = Math.round((dims.density.value as number) * 4 * 100) / 100;
  const font = dims.font.value as keyof typeof FONT_STACK;
  const dur = Math.round(dims.motion.value as number);
  const elev = Math.min(3, Math.max(0, Math.round(dims.elevation.value as number)));
  const ease = dur <= 160 ? "cubic-bezier(0.2, 0, 0, 1)" : "cubic-bezier(0.4, 0, 0.2, 1)";
  const t = p.hex.text; const rgb = [1, 3, 5].map((i) => parseInt(t.slice(i, i + 2), 16)).join(" ");
  const shadow = ["none", `0 1px 2px rgb(${rgb} / 0.08)`, `0 4px 14px rgb(${rgb} / 0.12)`, `0 12px 32px rgb(${rgb} / 0.18)`][elev]!;

  const css_qv = `:root {
  --qv-bg: ${p.hex.bg};
  --qv-surface: ${p.hex.surface};
  --qv-border: ${p.hex.border};
  --qv-text: ${p.hex.text};
  --qv-muted: ${p.hex.muted};
  --qv-accent: ${p.hex.accent};
  --qv-accent-text: ${p.hex.accentText};
  --qv-radius: ${radius}px;
  --qv-unit: ${unit}px;
  --qv-font-display: ${FONT_STACK[font]};
  --qv-font-body: ${FONT_STACK.sans};
  --qv-dur: ${dur}ms;
  --qv-ease: ${ease};
  --qv-shadow: ${shadow};
}`;
  // Keep both exports identical to the exact sRGB colours checked by the contrast gate.
  // These are complete CSS colours for modern shadcn/ui theme variables.
  const css_shadcn = `:root {
  --background: ${p.hex.bg};
  --foreground: ${p.hex.text};
  --card: ${p.hex.surface};
  --card-foreground: ${p.hex.text};
  --popover: ${p.hex.surface};
  --popover-foreground: ${p.hex.text};
  --primary: ${p.hex.accent};
  --primary-foreground: ${p.hex.accentText};
  --secondary: ${p.hex.surface};
  --secondary-foreground: ${p.hex.text};
  --muted: ${p.hex.surface};
  --muted-foreground: ${p.hex.muted};
  --accent: ${p.hex.surface};
  --accent-foreground: ${p.hex.text};
  --border: ${p.hex.border};
  --input: ${p.hex.border};
  --ring: ${p.hex.accent};
  --radius: ${(radius / 16).toFixed(3)}rem;
}`;

  const dr = (d: Dim) => dims[d];
  const receipts: Receipt[] = [
    { token: "--qv-radius / --radius", value: `${radius}px`, source: dr("radius").source, contributions: dr("radius").contributions, note: "weighted mean of rule values; shadcn radius is converted to rem at a 16px root size" },
    { token: "--qv-unit", value: `${unit}px`, source: dr("density").source, contributions: dr("density").contributions, note: "4px base x density multiplier" },
    { token: "--qv-font-display", value: font, source: dr("font").source, contributions: dr("font").contributions, note: "heaviest-weighted font family; body text stays sans for readability" },
    { token: "--qv-dur / --qv-ease", value: `${dur}ms`, source: dr("motion").source, contributions: dr("motion").contributions, note: "<=160ms uses the snappy curve" },
    { token: "--qv-shadow", value: `elevation ${elev}`, source: dr("elevation").source, contributions: dr("elevation").contributions, note: "0 flat .. 3 floating" },
    { token: "colour mode", value: mode, source: dr("mode").source, contributions: dr("mode").contributions, note: "weighted vote; ties go to light" },
    { token: "palette hue", value: `${dr("hue").value} deg`, source: dr("hue").source, contributions: dr("hue").contributions, note: "heaviest-weighted hue among the matched rules (opposing hues are not averaged)" },
    { token: "palette chroma", value: String(dr("chroma").value), source: dr("chroma").source, contributions: dr("chroma").contributions, note: "weighted mean (OKLCH chroma)" },
    ...p.adjustments.map((a): Receipt => ({ token: `contrast gate: ${a.token}`, value: `L ${a.from} -> ${a.to}`, source: "derived", contributions: [], note: a.reason })),
  ];
  for (const receipt of receipts) {
    if (receipt.source === "default") receipt.note = `Published default: too little mapped evidence to reach weight ${MIN_EVIDENCE}. ${receipt.note}`;
  }
  const paletteInputs = (["mode", "hue", "chroma"] as Dim[]);
  const paletteContributions = paletteInputs.flatMap((dim) => dr(dim).contributions);
  const paletteDefaults = paletteInputs.filter((dim) => dr(dim).source === "default");
  const paletteNote = `Derived from mode, hue and chroma, gamut-mapped to sRGB and contrast-checked.${paletteDefaults.length ? ` Published defaults used for ${paletteDefaults.join(", ")}.` : ""} Qloo does not supply colours.`;
  const aliases: Record<keyof Palette["hex"], string> = {
    bg: "--qv-bg / --background",
    surface: "--qv-surface / --card / --popover / --secondary / --muted / --accent",
    border: "--qv-border / --border / --input",
    text: "--qv-text / --foreground / --card-foreground / --popover-foreground / --secondary-foreground / --accent-foreground",
    muted: "--qv-muted / --muted-foreground",
    accent: "--qv-accent / --primary / --ring",
    accentText: "--qv-accent-text / --primary-foreground",
  };
  for (const key of Object.keys(aliases) as (keyof Palette["hex"])[]) {
    receipts.push({ token: aliases[key], value: p.hex[key], source: "derived", contributions: paletteContributions, note: paletteNote });
  }
  receipts.push({ token: "--qv-font-body", value: "sans", source: "default", contributions: [], note: "Fixed system sans-serif stack for readable body text; not inferred from the audience." });
  return {
    rule_table_version: RULE_TABLE_VERSION,
    dims: Object.fromEntries((Object.keys(dims) as Dim[]).map((d) => [d, { value: dims[d].value, source: dims[d].source }])) as Tokens["dims"],
    palette: { hex: p.hex, contrast: p.contrast, adjustments: p.adjustments, gate: p.gate },
    css_qv, css_shadcn, receipts, unmapped_tags: unmapped,
  };
}

export const ruleTable = () => ({ version: RULE_TABLE_VERSION, defaults: DEFAULTS, rules: RULES, status: "hypotheses: our mapping from Qloo tags to tokens, not validated in user studies, not produced by Qloo" });
