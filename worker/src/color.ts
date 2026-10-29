// Pure colour maths: OKLCH -> sRGB, WCAG 2.x contrast, and the accessibility gate that adjusts a palette until it passes.
// This is OUR code. Qloo has no colour data; nothing here claims otherwise.

export interface Oklch { l: number; c: number; h: number }
export interface Adjustment { token: string; from: string; to: string; reason: string }

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const rad = (d: number) => (d * Math.PI) / 180;

function linearFromOklch({ l, c, h }: Oklch): [number, number, number] {
  const a = c * Math.cos(rad(h)), b = c * Math.sin(rad(h));
  const l_ = l + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = l - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = l - 0.0894841775 * a - 1.291485548 * b;
  const L = l_ ** 3, M = m_ ** 3, S = s_ ** 3;
  return [
    4.0767416621 * L - 3.3077115913 * M + 0.2309699292 * S,
    -1.2684380046 * L + 2.6097574011 * M - 0.3413193965 * S,
    -0.0041960863 * L - 0.7034186147 * M + 1.707614701 * S,
  ];
}
const gamma = (v: number) => (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.max(v, 0) ** (1 / 2.4) - 0.055);
const inGamut = (rgb: number[]) => rgb.every((v) => v >= -0.0005 && v <= 1.0005);

/** Reduce chroma until the colour is representable in sRGB. */
export function toSrgb(o: Oklch): { r: number; g: number; b: number; c: number } {
  let c = Math.max(0, o.c);
  let lin = linearFromOklch({ ...o, c });
  for (let i = 0; i < 40 && !inGamut(lin); i++) { c *= 0.92; lin = linearFromOklch({ ...o, c }); }
  const [r, g, b] = lin.map((v) => clamp01(gamma(clamp01(v)))) as [number, number, number];
  return { r, g, b, c };
}
export function toHex(o: Oklch): string {
  const { r, g, b } = toSrgb(o);
  return "#" + [r, g, b].map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("");
}
export const toOklchCss = (o: Oklch) => `oklch(${o.l.toFixed(3)} ${toSrgb(o).c.toFixed(3)} ${Math.round(o.h)})`;

export function luminance(hex: string): number {
  const ch = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * ch[0]! + 0.7152 * ch[1]! + 0.0722 * ch[2]!;
}
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}
const r2 = (n: number) => Math.round(n * 100) / 100;

export interface PaletteInput { mode: "light" | "dark"; hue: number; chroma: number }
export interface Palette {
  hex: Record<"bg" | "surface" | "border" | "text" | "muted" | "accent" | "accentText", string>;
  oklch: Record<"bg" | "surface" | "border" | "text" | "muted" | "accent" | "accentText", Oklch>;
  contrast: { pair: string; ratio: number; need: number; pass: boolean; level: string }[];
  adjustments: Adjustment[];
  gate: "pass" | "adjusted";
}

/** Check text and accent on both page and card surfaces, plus text on the accent. */
export function buildPalette(inp: PaletteInput): Palette {
  const dark = inp.mode === "dark";
  const h = inp.hue, c = Math.min(0.2, Math.max(0, inp.chroma));
  const o: Palette["oklch"] = {
    bg: { l: dark ? 0.16 : 0.985, c: c * 0.15, h },
    surface: { l: dark ? 0.21 : 0.965, c: c * 0.2, h },
    border: { l: dark ? 0.31 : 0.9, c: c * 0.25, h },
    text: { l: dark ? 0.96 : 0.22, c: c * 0.25, h },
    muted: { l: dark ? 0.73 : 0.46, c: c * 0.35, h },
    accent: { l: dark ? 0.72 : 0.55, c, h },
    accentText: { l: 0.99, c: 0, h },
  };
  const adjustments: Adjustment[] = [];
  const hex = () => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, toHex(v)])) as Palette["hex"];
  const dir = dark ? 1 : -1; // direction that increases contrast against bg for foreground colours
  const onSurfaces = (hex: string) => Math.min(contrast(hex, toHex(o.bg)), contrast(hex, toHex(o.surface)));

  const lift = (key: "text" | "muted", need: number) => {
    const start = o[key].l;
    for (let i = 0; i < 80 && onSurfaces(toHex(o[key])) < need; i++) o[key] = { ...o[key], l: clamp01(o[key].l + dir * 0.01) };
    if (o[key].l !== start) adjustments.push({ token: key, from: start.toFixed(2), to: o[key].l.toFixed(2), reason: `lightness moved to reach ${need}:1 against background and surface` });
  };
  lift("text", 4.5); lift("muted", 4.5);

  // accent must be >=3:1 against bg (UI component) and carry readable text (>=4.5:1)
  const a0 = o.accent.l;
  const textOn = (acc: string) => (contrast("#ffffff", acc) >= contrast("#0b0b0b", acc) ? "#ffffff" : "#0b0b0b");
  let found = false;
  for (let step = 0; step <= 60 && !found; step++) {
    for (const sgn of step === 0 ? [0] : [1, -1]) {
      const cand = { ...o.accent, l: Math.min(0.95, Math.max(0.2, a0 + sgn * step * 0.01)) };
      const ax = toHex(cand), tx = textOn(ax);
      if (onSurfaces(ax) >= 3 && contrast(tx, ax) >= 4.5) {
        o.accent = cand; o.accentText = tx === "#ffffff" ? { l: 1, c: 0, h } : { l: 0.15, c: 0, h }; found = true; break;
      }
    }
  }
  if (!found) o.accentText = { l: 1, c: 0, h };
  if (o.accent.l !== a0) adjustments.push({ token: "accent", from: a0.toFixed(2), to: o.accent.l.toFixed(2), reason: "lightness moved so accent is >=3:1 on background and surface and its label is >=4.5:1" });

  const H = hex();
  const rows = [
    { pair: "text on background", a: H.text, b: H.bg, need: 4.5 },
    { pair: "muted text on background", a: H.muted, b: H.bg, need: 4.5 },
    { pair: "text on surface", a: H.text, b: H.surface, need: 4.5 },
    { pair: "muted text on surface", a: H.muted, b: H.surface, need: 4.5 },
    { pair: "accent on background (UI component)", a: H.accent, b: H.bg, need: 3 },
    { pair: "accent on surface (UI component)", a: H.accent, b: H.surface, need: 3 },
    { pair: "button label on accent", a: H.accentText, b: H.accent, need: 4.5 },
  ].map((r) => {
    const actual = contrast(r.a, r.b);
    return { pair: r.pair, ratio: r2(actual), need: r.need, pass: actual >= r.need, level: actual >= 7 ? "AAA" : actual >= r.need ? "AA" : "fail" };
  });
  return { hex: H, oklch: o, contrast: rows, adjustments, gate: adjustments.length ? "adjusted" : "pass" };
}
