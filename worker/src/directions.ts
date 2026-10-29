// Alternative readings of the same Qloo vocabulary. The lenses and named font
// recommendations are QlooVibe design choices, never additional Qloo findings.
import { compileDims, compileTokens, type KeptTag, type Tokens } from "./compile";
import { matchRule, RULES, RULE_TABLE_VERSION, type Dim } from "./rules";
import type { Family } from "./types";

export interface ProjectContext {
  summary: string;
  input_excerpt: string;
  source_name?: string;
  basis: "user_supplied";
}

interface NamedFont {
  name: string;
  family: "sans" | "serif" | "mono";
  stack: string;
  source: "bundled" | "system";
}

export interface FontPair {
  display: NamedFont;
  body: NamedFont;
  source: "qloovibe_recommendation";
  note: string;
  stylesheet_url: null;
  loading_guidance: string;
  font_face_css: string;
  assets: { name: string; path: string; license: string }[];
}

export interface DirectionDraft {
  id: string;
  name: string;
  summary: string;
  description: string;
  rationale: string[];
  project_fit: string[];
  provenance: {
    source: "qloovibe_rule_interpretation";
    method: "all_kept_tags" | "focus_subset";
    rule_table_version: string;
    focus_rules: string[];
    tags: { tag: string; family: Family; affinity: number; rule: string }[];
    note: string;
  };
  fonts: FontPair;
  tokens: Tokens;
}

export interface StyleDirection extends DirectionDraft { agent_brief: string }

interface Lens {
  id: string;
  name: string;
  rules: string[];
  use: string;
}

const LENSES: Lens[] = [
  { id: "structured", name: "Clean structure", rules: ["R01", "R02", "R03", "R16", "R18"], use: "Keep navigation and repeated components restrained; give the project's main task a clear hierarchy." },
  { id: "editorial", name: "Warm editorial", rules: ["R04", "R08", "R09", "R12", "R15"], use: "Give the project introduction a strong typographic voice, with plain body text for instructions and longer reading." },
  { id: "expressive", name: "Expressive edge", rules: ["R05", "R10", "R11", "R13", "R17", "R20"], use: "Concentrate visual emphasis on the project's key message and primary action; keep supporting tasks quieter." },
  { id: "open", name: "Open calm", rules: ["R06", "R07", "R14", "R19", "R21"], use: "Use a steady reading rhythm and clear grouping for the project's content; respect reduced-motion preferences." },
];

const FIGTREE: NamedFont = { name: "Figtree", family: "sans", stack: '"Figtree", "Segoe UI", Arial, sans-serif', source: "bundled" };
const ARIAL: NamedFont = { name: "Arial", family: "sans", stack: 'Arial, "Helvetica Neue", sans-serif', source: "system" };
const GEORGIA: NamedFont = { name: "Georgia", family: "serif", stack: 'Georgia, "Times New Roman", serif', source: "system" };
const CONSOLAS: NamedFont = { name: "Consolas", family: "mono", stack: 'Consolas, "Liberation Mono", "Courier New", monospace', source: "system" };
const FONT_FACE = '@font-face { font-family: "Figtree"; src: url("/fonts/figtree-latin.woff2") format("woff2"); font-style: normal; font-weight: 300 900; font-display: swap; }';
const SEPARATION_THRESHOLDS: Partial<Record<Dim, number>> = { radius: 2, density: 0.075, chroma: 0.015, hue: 30, motion: 30, elevation: 1 };

/** Published alongside the rule table so the interpretation step is inspectable. */
export const directionGuide = () => ({
  version: "qv-directions-1.0",
  status: "QlooVibe design hypotheses, not Qloo output or validated audience preferences",
  max_directions: 3,
  default: { id: "balanced", name: "Audience blend", method: "Compile every kept tag with the published rule table." },
  lenses: LENSES.map((lens) => ({ id: lens.id, name: lens.name, rules: [...lens.rules], application: lens.use })),
  rule_focus_fallback: "Each observed rule can also supply a focused candidate when several distinct signals belong to the same broad lens.",
  selection: "Keep the all-tag blend first. Select up to two focus subsets with the most visibly different rule-supported dimensions from every selected option; break ties by summed original affinity, then published lens order. Preserve original affinities and ranks. Build no extra options if evidence cannot separate them.",
  minimum_numeric_difference: { ...SEPARATION_THRESHOLDS },
  categorical_difference: ["mode", "font"],
  fonts: {
    source: "QlooVibe named-font recommendations; Qloo supplies no font names or font validation.",
    catalog: [FIGTREE, ARIAL, GEORGIA, CONSOLAS].map((font) => ({ ...font })),
    pairs: { sans: ["Figtree", "Arial"], structured_sans: ["Arial", "Figtree"], serif: ["Georgia", "Figtree"], mono: ["Consolas", "Figtree"] },
    font_face_css: FONT_FACE,
    bundled_assets: [{ path: "/fonts/figtree-latin.woff2", license: "/fonts/Figtree-OFL.txt" }],
    note: "Copy the bundled font and license into the destination project. System fonts use the listed fallbacks when unavailable; no remote font service is required.",
  },
});

function fontPair(tokens: Tokens, lens: string): FontPair {
  const family = tokens.dims.font.value;
  const display = family === "serif" ? GEORGIA : family === "mono" ? CONSOLAS : lens === "structured" ? ARIAL : FIGTREE;
  const body = display.name === "Figtree" ? ARIAL : FIGTREE;
  return {
    display: { ...display }, body: { ...body }, source: "qloovibe_recommendation", stylesheet_url: null,
    note: `QlooVibe recommends ${display.name} with ${body.name} from the ${tokens.dims.font.source === "rule" ? "rule-selected" : "published default"} ${family} display family. Qloo supplies no font names or font validation.`,
    loading_guidance: "Figtree is bundled with QlooVibe. Copy /fonts/figtree-latin.woff2 and /fonts/Figtree-OFL.txt into your project's public/fonts directory, then include font_face_css before the token CSS. Georgia, Arial and Consolas use installed system fonts with the supplied fallbacks; availability varies by device. No remote font service is required.",
    font_face_css: FONT_FACE,
    assets: [{ name: "Figtree", path: "/fonts/figtree-latin.woff2", license: "/fonts/Figtree-OFL.txt" }],
  };
}

function namedFonts(tokens: Tokens, fonts: FontPair): Tokens {
  return {
    ...tokens,
    css_qv: fonts.font_face_css + "\n\n" + tokens.css_qv.replace(/(--qv-font-display:\s*)[^;]+;/, `$1${fonts.display.stack};`).replace(/(--qv-font-body:\s*)[^;]+;/, `$1${fonts.body.stack};`),
    css_shadcn: fonts.font_face_css + "\n\n" + tokens.css_shadcn.replace(/\n}$/, `\n  --font-sans: ${fonts.body.stack};\n  --font-display: ${fonts.display.stack};\n}`),
    receipts: tokens.receipts.map((receipt) => receipt.token === "--qv-font-display" ? {
      ...receipt, token: "--qv-font-display / --font-display", value: fonts.display.stack, source: "derived",
      note: `${fonts.note} The contributing rules select a family, not this named font.`,
    } : receipt.token === "--qv-font-body" ? {
      ...receipt, token: "--qv-font-body / --font-sans", value: fonts.body.stack, source: "derived", note: `QlooVibe readability recommendation: ${fonts.body.name} with the supplied fallback stack; not inferred from Qloo audience data.`,
    } : receipt),
  };
}

// Count changes a reader can see, rather than rounding noise or a switch to a
// published default. Only a candidate's rule-supported dimensions qualify.
function distance(a: Pick<Tokens, "dims">, b: Pick<Tokens, "dims">): number {
  let score = 0;
  for (const dim of Object.keys(a.dims) as Dim[]) {
    if (a.dims[dim].source !== "rule") continue;
    const av = a.dims[dim].value, bv = b.dims[dim].value;
    if (typeof av === "string" || typeof bv === "string") { if (av !== bv) score++; continue; }
    const delta = dim === "hue" ? Math.min(Math.abs(av - bv), 360 - Math.abs(av - bv)) : dim === "elevation" ? Math.abs(Math.round(av) - Math.round(bv)) : Math.abs(av - bv);
    if (delta >= (SEPARATION_THRESHOLDS[dim] ?? Infinity)) score++;
  }
  return score;
}

const hasEvidence = (tokens: Pick<Tokens, "dims">) => Object.values(tokens.dims).some((dim) => dim.source === "rule");
const rounded = (value: number) => Math.round(value * 1000) / 1000;

/** Up to three genuinely different directions; sparse evidence never becomes invented options. */
export function buildDirections(kept: KeptTag[], context?: ProjectContext): DirectionDraft[] {
  // Score candidate dimensions first; build palettes only for the selected routes.
  const baseline = { dims: compileDims(kept).dims };
  if (!hasEvidence(baseline)) return [];
  const baselineLens: Lens = { id: "balanced", name: "Audience blend", rules: [], use: "Start with this balanced interpretation across the project's primary screens, then check each component in its actual context." };
  const selected = [{ lens: baselineLens, tags: kept, tokens: baseline }];
  // Group lenses usually provide coherent alternatives. Individual observed rules
  // also remain available when several distinct signals share one broad group.
  const lenses: Lens[] = [...LENSES, ...RULES.map((rule) => ({ id: `focus-${rule.id.toLowerCase()}`, name: rule.label.split(" / ").join(" · "), rules: [rule.id], use: `Use the ${rule.label.toLowerCase()} reading for the project's visual treatment while keeping its task flow and content requirements intact.` }))];
  let candidates = lenses.flatMap((lens) => {
    const tags = kept.filter((tag) => { const match = matchRule(tag.name); return match && lens.rules.includes(match.rule.id); });
    if (!tags.length) return [];
    const tokens = { dims: compileDims(tags).dims };
    return hasEvidence(tokens) && distance(tokens, baseline) > 0 ? [{ lens, tags, tokens }] : [];
  });
  while (selected.length < 3 && candidates.length) {
    const ranked = candidates.map((candidate, index) => ({ candidate, index, separation: Math.min(...selected.map((item) => distance(candidate.tokens, item.tokens))), support: candidate.tags.reduce((sum, tag) => sum + tag.affinity, 0) }))
      .filter((item) => item.separation > 0)
      .sort((a, b) => b.separation - a.separation || b.support - a.support || a.index - b.index);
    if (!ranked.length) break;
    const next = ranked[0]!.candidate;
    selected.push(next);
    candidates = candidates.filter((candidate) => candidate !== next);
  }
  return selected.map(({ lens, tags }) => {
    const tokens = compileTokens(tags);
    const evidence = tags.flatMap((tag) => { const match = matchRule(tag.name); return match ? [{ tag: tag.name, family: tag.family, affinity: rounded(tag.affinity), rule: match.rule.id }] : []; });
    const rules = [...new Set(evidence.map((tag) => tag.rule))];
    const words = [...new Set(evidence.map((tag) => tag.tag))].slice(0, 4);
    const fonts = fontPair(tokens, lens.id);
    const summary = `${tokens.dims.mode.value} surfaces, ${fonts.display.name} headings and ${Math.round(tokens.dims.radius.value as number)}px corners.`;
    return {
      id: lens.id, name: lens.name, summary, description: `${summary} ${lens.id === "balanced" ? "Balances" : "Focuses on"} ${words.join(", ")} from the returned Qloo vocabulary.`,
      rationale: [lens.id === "balanced" ? "Compiles all kept Qloo tags with the published rule table." : `Compiles a focus subset of the same returned tags using ${rules.join(", ")}; affinities and original ranks are unchanged.`, `Evidence: ${words.join(", ")}.`, fonts.note],
      project_fit: context ? [`Project context supplied${context.source_name ? ` in ${context.source_name}` : ""}: ${context.summary}`, lens.use] : [lens.use, "No project context was supplied; this is an audience-grounded design interpretation, not a validated project recommendation."],
      provenance: { source: "qloovibe_rule_interpretation", method: lens.id === "balanced" ? "all_kept_tags" : "focus_subset", rule_table_version: RULE_TABLE_VERSION, focus_rules: rules, tags: evidence,
        note: "Qloo supplies the shared audience tags and affinities. QlooVibe selects the lenses, maps tokens through its rule table and recommends named fonts. Alternatives use no extra Qloo queries and are not separate audience findings." },
      fonts, tokens: namedFonts(tokens, fonts),
    };
  });
}
