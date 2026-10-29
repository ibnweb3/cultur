// The published rule table: how Qloo design tags become design tokens.
// Qloo supplies ranked tags with affinities. It does NOT supply CSS. Everything in this file is OUR mapping,
// every rule is a labelled hypothesis (not validated against user studies), and the table is served at GET /api/rules.

export const RULE_TABLE_VERSION = "qv-rules-1.0";

export type Dim = "radius" | "density" | "mode" | "chroma" | "hue" | "font" | "motion" | "elevation";
export interface Effect { dim: Dim; value: number | string; w?: number }
export interface Rule { id: string; label: string; tags: string[]; effects: Effect[] }

export const DEFAULTS: Record<Dim, number | string> = {
  radius: 8, density: 1, mode: "light", chroma: 0.03, hue: 250, font: "sans", motion: 180, elevation: 1,
};

// Units: radius px; density multiplier of a 4px spacing unit; chroma = OKLCH chroma (0 grey .. ~.2 vivid);
// hue = OKLCH degrees; motion = ms; elevation 0 flat .. 3 floating.
export const RULES: Rule[] = [
  { id: "R01", label: "Minimal / understated", tags: ["minimalist", "minimal", "simple", "clean", "understated", "zen", "spare", "sleek"],
    effects: [{ dim: "radius", value: 2 }, { dim: "density", value: 1.2 }, { dim: "chroma", value: 0.02 }, { dim: "elevation", value: 0 }, { dim: "font", value: "sans" }] },
  { id: "R02", label: "Industrial / brutalist", tags: ["industrial", "brutalist", "utilitarian", "raw", "concrete", "warehouse"],
    effects: [{ dim: "radius", value: 0 }, { dim: "elevation", value: 0 }, { dim: "font", value: "mono", w: 0.6 }, { dim: "font", value: "sans", w: 0.4 }, { dim: "mode", value: "dark", w: 0.5 }, { dim: "chroma", value: 0.02 }] },
  { id: "R03", label: "Modernist / geometric", tags: ["mid century", "bauhaus", "modern", "contemporary", "geometric", "scandinavian"],
    effects: [{ dim: "radius", value: 4 }, { dim: "font", value: "sans" }, { dim: "density", value: 1.05 }] },
  { id: "R04", label: "Cozy / warm", tags: ["cozy", "homey", "warm", "intimate", "charming", "rustic", "rustic chic", "earth tones", "warm earth tones", "lived in"],
    effects: [{ dim: "radius", value: 12 }, { dim: "density", value: 0.95 }, { dim: "hue", value: 55 }, { dim: "chroma", value: 0.07 }, { dim: "font", value: "serif", w: 0.3 }] },
  { id: "R05", label: "Dark / moody", tags: ["dark wood", "moody", "dim", "dimly lit", "dark", "speakeasy", "noir", "lounge"],
    effects: [{ dim: "mode", value: "dark" }] },
  { id: "R06", label: "Airy / bright", tags: ["airy", "bright", "light", "open", "spacious", "sunlit"],
    effects: [{ dim: "mode", value: "light" }, { dim: "density", value: 1.2 }] },
  { id: "R07", label: "Coastal", tags: ["coastal", "beachy", "nautical", "seaside", "tropical", "oceanic"],
    effects: [{ dim: "hue", value: 215 }, { dim: "chroma", value: 0.08 }, { dim: "mode", value: "light" }, { dim: "radius", value: 8 }] },
  { id: "R08", label: "Vintage / retro", tags: ["vintage", "retro", "vintage chic", "old school", "old world", "time capsule", "nostalgic", "antique", "art nouveau", "traditional", "classic", "retro modern", "retro infused"],
    effects: [{ dim: "font", value: "serif" }, { dim: "hue", value: 45 }, { dim: "chroma", value: 0.06 }, { dim: "radius", value: 4 }, { dim: "elevation", value: 1 }] },
  { id: "R09", label: "Elegant / upscale", tags: ["elegant", "luxurious", "luxury", "upscale", "posh", "classy", "sophisticated", "refined", "polished", "chic", "ornate", "art deco", "opulent", "stylish", "glamorous", "lavish"],
    effects: [{ dim: "font", value: "serif", w: 0.6 }, { dim: "radius", value: 4 }, { dim: "chroma", value: 0.04 }, { dim: "density", value: 1.1 }, { dim: "elevation", value: 1 }] },
  { id: "R10", label: "Vibrant / playful", tags: ["vibrant", "colorful", "playful", "whimsical", "quirky", "eclectic", "maximalist", "youthful", "themed", "fun", "energetic", "lively", "jovial", "fuzzy", "cheerful"],
    effects: [{ dim: "chroma", value: 0.16 }, { dim: "radius", value: 16 }, { dim: "motion", value: 140 }, { dim: "elevation", value: 2 }] },
  { id: "R11", label: "Neon / futuristic / club", tags: ["neon", "futuristic", "club ready", "bass driven", "in your face", "punk infused", "genre bending", "electric", "trippy", "rowdy", "rousing", "anarchic"],
    effects: [{ dim: "mode", value: "dark" }, { dim: "chroma", value: 0.18 }, { dim: "hue", value: 300 }, { dim: "motion", value: 120 }, { dim: "radius", value: 2 }, { dim: "font", value: "mono", w: 0.4 }, { dim: "font", value: "sans", w: 0.6 }] },
  { id: "R12", label: "Western / Americana", tags: ["western", "country", "americana", "ranch", "old west", "southern"],
    effects: [{ dim: "hue", value: 50 }, { dim: "chroma", value: 0.08 }, { dim: "font", value: "serif", w: 0.5 }, { dim: "radius", value: 6 }] },
  { id: "R13", label: "Urban / edgy", tags: ["urban", "street", "hipster", "artsy", "artistic", "edgy", "graffiti", "gritty"],
    effects: [{ dim: "mode", value: "dark", w: 0.5 }, { dim: "radius", value: 2 }, { dim: "chroma", value: 0.1 }, { dim: "font", value: "sans" }] },
  { id: "R14", label: "Calm / flowing", tags: ["flowing", "conscious", "serene", "calm", "peaceful", "soft", "gentle", "mellow", "whispery", "confessional", "soul baring", "emotive", "introspective"],
    effects: [{ dim: "motion", value: 260 }, { dim: "chroma", value: 0.03 }, { dim: "elevation", value: 1 }] },
  { id: "R15", label: "Casual / authentic", tags: ["casual", "unpretentious", "authentic", "relaxed", "laid back", "friendly", "feel good", "inviting", "honest", "community focused", "welcoming"],
    effects: [{ dim: "radius", value: 8 }, { dim: "density", value: 1 }] },
  { id: "R16", label: "Monochrome", tags: ["monochromatic", "monochrome", "black and white", "greyscale"],
    effects: [{ dim: "chroma", value: 0.005 }] },
  { id: "R17", label: "Pastel / dreamy", tags: ["pastel", "dreamy", "candy", "sweet"],
    effects: [{ dim: "chroma", value: 0.05 }, { dim: "mode", value: "light" }, { dim: "radius", value: 14 }, { dim: "hue", value: 340 }] },
  { id: "R18", label: "Muted", tags: ["muted", "muted tones", "subdued", "neutral"],
    effects: [{ dim: "chroma", value: 0.025 }] },
  { id: "R19", label: "Botanical / natural", tags: ["botanical", "organic", "natural", "nature", "garden", "plants", "green", "earthy", "scenic", "nature focused"],
    effects: [{ dim: "hue", value: 145 }, { dim: "chroma", value: 0.08 }] },
  { id: "R20", label: "Alternative / indie", tags: ["indie", "alternative", "lo fi", "underground", "diy", "grunge"],
    effects: [{ dim: "radius", value: 4 }, { dim: "chroma", value: 0.05 }, { dim: "mode", value: "dark", w: 0.4 }, { dim: "density", value: 1.05 }] },
  { id: "R21", label: "Rugged / outdoor", tags: ["rugged", "outdoorsy", "adventurous", "wild", "sun soaked", "weathered"],
    effects: [{ dim: "radius", value: 4 }, { dim: "hue", value: 60 }, { dim: "chroma", value: 0.07 }, { dim: "font", value: "sans" }] },
];

export const norm = (s: string): string =>
  s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

const RULE_INDEX = new Map<string, Rule>();
for (const r of RULES) for (const t of r.tags) RULE_INDEX.set(norm(t), r);

/** Exact full-tag match (factor 1) or single-word match (factor 0.6). */
export function matchRule(tag: string): { rule: Rule; match: "exact" | "word"; factor: number } | null {
  const n = norm(tag);
  const full = RULE_INDEX.get(n);
  if (full) return { rule: full, match: "exact", factor: 1 };
  for (const w of n.split(" ")) {
    if (w.length < 4) continue;
    const r = RULE_INDEX.get(w);
    if (r) return { rule: r, match: "word", factor: 0.6 };
  }
  return null;
}

// Tags that describe origin, cuisine, venue type or non-visual attributes of a space, not a visual style.
const ORIGIN = /\b(french|italian|japanese|spanish|mexican|chinese|korean|indian|thai|greek|german|british|english|irish|scottish|parisian|mediterranean|alpine|colonial|caribbean|latin|asian|european|american|swiss|moroccan|turkish|russian|brazilian)\b/;
const VENUE = /\b(bistro|cafe|bar|pub|tavern|hotel|restaurant|diner|brewery|bakery|inn|hostel|resort|steakhouse|pizzeria|campus|university|museum)\b/;
const NONVISUAL = /\b(family friendly|kid friendly|pet friendly|convenient|functional|safe|iconic|cultural|inspiring|reliable|accessible|affordable|popular|touristy)\b/;

export function nonVisualReason(tag: string): string | null {
  const n = norm(tag);
  if (!n) return "empty";
  if (ORIGIN.test(n)) return "origin or cuisine term, not a visual style";
  if (VENUE.test(n)) return "venue type, not a visual style";
  if (NONVISUAL.test(n)) return "non-visual attribute";
  return null;
}
