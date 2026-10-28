// Pure, deterministic scoring. Direction: rebrand_risk higher = more concern; the others higher = more supported.
// Missing evidence is never zero and never reassuring: missing components are dropped; below the minimum weight the score is null.
import type { Score } from "./types";

export const CONFIG = {
  similarityBands: { high: 0.5, moderate: 0.25, low: 0.1 },
  minSharedForModerate: 3,
  trustWeights: { identity_confidence: 0.2, wallet_corroboration: 0.25, rebrand_risk_inverted: 0.25, sourced_history: 0.3 } as Record<string, number>,
  trustMinWeight: 0.45,
  supportedCategories: 4,
};

const score = (p: Partial<Score>): Score => ({ value: null, band: "n/a", status: "insufficient_evidence", evidence: [], limitations: [], ...p });

export function weightedJaccard(a: Record<string, number>, b: Record<string, number>): number {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  if (!keys.size) return 0;
  let num = 0, den = 0;
  for (const k of keys) {
    const x = a[k] ?? 0, y = b[k] ?? 0;
    num += Math.min(x, y);
    den += Math.max(x, y);
  }
  return den ? num / den : 0;
}

export function similarityBand(value: number, nShared: number, cfg = CONFIG): string {
  const b = cfg.similarityBands;
  let band = value >= b.high ? "high" : value >= b.moderate ? "moderate" : value >= b.low ? "low" : "none";
  // a handful of shared items cannot support a stronger band
  if ((band === "high" || band === "moderate") && nShared < cfg.minSharedForModerate) band = "low";
  return band;
}

/** Discount very popular items; only applied when the value is plausibly a 0..1 fraction. */
export function popularityWeight(pop: unknown): number {
  return typeof pop === "number" && pop >= 0 && pop <= 1 ? Math.max(0.1, 1 - pop) : 1;
}

const bandOf = (v: number, cuts: [number, string][], dflt: string) => cuts.find(([c]) => v >= c)?.[1] ?? dflt;
const round1 = (n: number) => Math.round(n * 10) / 10;

export function culturalDepth(categories: number, nEntities: number, nTags: number, qlooOk: boolean): Score {
  if (!qlooOk || (nEntities === 0 && nTags === 0))
    return score({ limitations: ["No Qloo cultural data for this subject; sparse coverage is not evidence of anything."] });
  const cat = Math.min(categories / CONFIG.supportedCategories, 1);
  const ent = Math.min(nEntities / 30, 1);
  const tag = Math.min(nTags / 15, 1);
  const v = round1(100 * (0.5 * cat + 0.3 * ent + 0.2 * tag));
  return score({
    value: v, band: bandOf(v, [[66, "broad"], [33, "moderate"]], "narrow"), status: "available",
    limitations: ["Descriptive breadth of Qloo associations only; not a quality or trust measure, and niche creators naturally score lower."],
  });
}

export function communityAuthenticity(hasAudience: boolean, hasMomentum: boolean): Score {
  const avail = [hasAudience && "audience", hasMomentum && "momentum"].filter(Boolean) as string[];
  return score({
    band: avail.length ? "descriptive_only" : "n/a",
    limitations: [
      "Audience demographics and trend momentum describe cultural context; they cannot establish real followers or detect bots, so no authenticity value is issued.",
      ...(avail.length ? [`Signals observed: ${avail.join(", ")}.`] : []),
    ],
  });
}

export function rebrandRisk(bestBand: string | null, continuitySourced: boolean, adverse: string | null, comparisonRan: boolean, registrySize: number): Score {
  if (!comparisonRan) return score({ limitations: ["No Qloo fingerprint to compare."] });
  const lim = ["A rebrand is not misconduct. Taste similarity alone never establishes common identity."];
  // low-band overlap is within noise: not a lead
  if (bestBand == null || bestBand === "none" || bestBand === "low")
    return score({ value: 0, band: "no_lead", status: "available", limitations: [...lim, `No lead among ${registrySize} curated cases; this is not clearance (registry is small).`] });
  let v = { moderate: 15, high: 30 }[bestBand as "moderate" | "high"];
  if (continuitySourced) {
    v += 15;
    if (adverse === "established") v += 40;
    else if (adverse === "alleged" || adverse === "disputed") v += 15;
  } else if (adverse) {
    lim.push("Adverse history of the matched record is not applied because identity continuity is not independently sourced.");
  }
  v = Math.min(v, 100);
  return score({ value: v, band: v >= 50 ? "high" : v >= 20 ? "elevated" : "lead_only", status: "available", limitations: lim });
}

export function walletCorroboration(items: { kind: string; verified: boolean }[]): Score {
  const W: Record<string, number> = { creation_tx_verified: 40, registry_wallet_match: 40, ens_forward_resolved: 10, owner_matches_registry: 30 };
  if (!items.length) return score({ limitations: ["No wallet facts available for this input."] });
  const got = items.filter((i) => i.verified).reduce((s, i) => s + (W[i.kind] ?? 0), 0);
  if (got === 0)
    return score({ limitations: ["Wallet data present but no explicit sourced relationship; balances, shared factories or token holdings are not identity proof."] });
  const v = Math.min(got, 100);
  return score({ value: v, band: v >= 60 ? "strong" : "partial", status: "available", limitations: ["Corroborates only the listed relationships; not a safety guarantee."] });
}

export function trustScore(identityConfidence: number | null, wallet: Score, rebrand: Score, selfHistory: string | null, grounded: boolean): Score {
  const lim = ["Documented heuristic, not a calibrated probability of fraud. Missing evidence is excluded, not treated as reassuring."];
  if (!grounded) return score({ status: "unavailable", limitations: ["Fresh Qloo grounding unavailable; no verdict issued."] });
  const comps: Record<string, number> = {};
  if (identityConfidence != null) comps.identity_confidence = identityConfidence;
  if (wallet.status === "available" && wallet.value != null) comps.wallet_corroboration = wallet.value;
  if (rebrand.status === "available" && rebrand.value != null && rebrand.band !== "no_lead") comps.rebrand_risk_inverted = 100 - rebrand.value;
  if (selfHistory === "established") comps.sourced_history = 0;
  else if (selfHistory === "alleged" || selfHistory === "disputed") comps.sourced_history = 50;
  const w = CONFIG.trustWeights;
  const tot = Object.keys(comps).reduce((s, k) => s + w[k], 0);
  if (tot < CONFIG.trustMinWeight) return score({ limitations: [...lim, `Evidence weight ${tot.toFixed(2)} below minimum ${CONFIG.trustMinWeight}.`] });
  const v = round1(Object.keys(comps).reduce((s, k) => s + w[k] * comps[k], 0) / tot);
  return score({
    value: v, band: v >= 75 ? "stronger_support" : v >= 50 ? "mixed" : "weak_support", status: "available",
    limitations: [...lim, `Components used: ${Object.keys(comps).sort().join(", ")}; weights renormalized over available.`],
  });
}
