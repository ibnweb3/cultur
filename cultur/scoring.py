"""Pure, deterministic scoring. No I/O. Versioned via schemas.SCORING_VERSION.

Direction: rebrand_risk higher = more concern. cultural_depth, wallet_corroboration,
trust_score higher = more supported. Missing evidence is never zero and never reassuring:
missing components are dropped from the composite, and below MIN_WEIGHT the score is null.
"""
from typing import Optional

from .schemas import Score

CONFIG = {
    "similarity_bands": {"high": 0.50, "moderate": 0.25, "low": 0.10},  # weighted Jaccard lower bounds
    "min_shared_for_moderate": 3,
    "trust_weights": {
        "identity_confidence": 0.20,
        "wallet_corroboration": 0.25,
        "rebrand_risk_inverted": 0.25,
        "sourced_history": 0.30,
    },
    "trust_min_weight": 0.45,
    "supported_categories": 4,  # artist, brand, person, place
}


def weighted_jaccard(a: dict[str, float], b: dict[str, float]) -> float:
    keys = set(a) | set(b)
    if not keys:
        return 0.0
    num = sum(min(a.get(k, 0.0), b.get(k, 0.0)) for k in keys)
    den = sum(max(a.get(k, 0.0), b.get(k, 0.0)) for k in keys)
    return num / den if den else 0.0


def similarity_band(value: float, n_shared: int, cfg=CONFIG) -> str:
    b = cfg["similarity_bands"]
    band = "high" if value >= b["high"] else "moderate" if value >= b["moderate"] else "low" if value >= b["low"] else "none"
    # a handful of shared items cannot support a stronger band
    if band in ("high", "moderate") and n_shared < cfg["min_shared_for_moderate"]:
        band = "low"
    return band


def popularity_weight(pop) -> float:
    """Discount very popular items (shared mainstream taste says little). Only applied when the
    value is plausibly a 0..1 fraction; unverified scales are ignored."""
    if isinstance(pop, (int, float)) and 0 <= pop <= 1:
        return max(0.1, 1.0 - float(pop))
    return 1.0


def _band(v: float, cuts: list[tuple[float, str]], default: str) -> str:
    for c, name in cuts:
        if v >= c:
            return name
    return default


def cultural_depth(categories_with_results: int, n_entities: int, n_tags: int, qloo_ok: bool) -> Score:
    if not qloo_ok or (n_entities == 0 and n_tags == 0):
        return Score(status="insufficient_evidence", limitations=["No Qloo cultural data for this subject; sparse coverage is not evidence of anything."])
    cat = min(categories_with_results / CONFIG["supported_categories"], 1.0)
    ent = min(n_entities / 30, 1.0)
    tag = min(n_tags / 15, 1.0)
    v = round(100 * (0.5 * cat + 0.3 * ent + 0.2 * tag), 1)
    return Score(value=v, band=_band(v, [(66, "broad"), (33, "moderate")], "narrow"), status="available",
                 limitations=["Descriptive breadth of Qloo associations only; not a quality or trust measure, and niche creators naturally score lower."])


def community_authenticity(has_audience: bool, has_momentum: bool) -> Score:
    lim = ["Audience demographics and trend momentum describe cultural context; they cannot establish real followers or detect bots, so no authenticity value is issued."]
    avail = [n for n, h in (("audience", has_audience), ("momentum", has_momentum)) if h]
    return Score(value=None, band="descriptive_only" if avail else "n/a",
                 status="insufficient_evidence", limitations=lim + ([f"Signals observed: {', '.join(avail)}."] if avail else []))


def rebrand_risk(best_band: Optional[str], continuity_sourced: bool, adverse_status: Optional[str],
                 comparison_ran: bool, registry_size: int) -> Score:
    if not comparison_ran:
        return Score(status="insufficient_evidence", limitations=["No Qloo fingerprint to compare."])
    lim = ["A rebrand is not misconduct. Taste similarity alone never establishes common identity."]
    if best_band in (None, "none"):
        return Score(value=0.0, band="no_lead", status="available",
                     limitations=lim + [f"No lead among {registry_size} curated cases; this is not clearance (registry is small)."])
    base = {"low": 5, "moderate": 15, "high": 30}[best_band]
    v = base
    if continuity_sourced:
        v += 15
        if adverse_status == "established":
            v += 40
        elif adverse_status in ("alleged", "disputed"):
            v += 15
    elif adverse_status:
        lim.append("Adverse history of the matched record is not applied because identity continuity is not independently sourced.")
    v = min(v, 100)
    band = "high" if v >= 50 else "elevated" if v >= 20 else "lead_only"
    return Score(value=float(v), band=band, status="available", limitations=lim)


def wallet_corroboration(items: list[dict]) -> Score:
    """items: {kind, verified: bool}. Only explicit sourced relationships count."""
    W = {"creation_tx_verified": 40, "registry_wallet_match": 40, "ens_forward_resolved": 10, "owner_matches_registry": 30}
    if not items:
        return Score(status="insufficient_evidence", limitations=["No wallet facts available for this input."])
    got = sum(W.get(i["kind"], 0) for i in items if i.get("verified"))
    if got == 0:
        return Score(status="insufficient_evidence", limitations=["Wallet data present but no explicit sourced relationship; balances, shared factories or token holdings are not identity proof."])
    v = float(min(got, 100))
    return Score(value=v, band="strong" if v >= 60 else "partial", status="available",
                 limitations=["Corroborates only the listed relationships; not a safety guarantee."])


def trust_score(identity_confidence: Optional[float], wallet: Score, rebrand: Score,
                self_history: Optional[str], qloo_grounded: bool) -> Score:
    lim = ["Documented heuristic, not a calibrated probability of fraud. Missing evidence is excluded, not treated as reassuring."]
    if not qloo_grounded:
        return Score(status="unavailable", limitations=["Fresh Qloo grounding unavailable; no verdict issued."] )
    comps: dict[str, float] = {}
    if identity_confidence is not None:
        comps["identity_confidence"] = identity_confidence
    if wallet.status == "available" and wallet.value is not None:
        comps["wallet_corroboration"] = wallet.value
    if rebrand.status == "available" and rebrand.value is not None and rebrand.band != "no_lead":
        comps["rebrand_risk_inverted"] = 100 - rebrand.value
    if self_history == "established":
        comps["sourced_history"] = 0.0
    elif self_history in ("alleged", "disputed"):
        comps["sourced_history"] = 50.0
    w = CONFIG["trust_weights"]
    tot = sum(w[k] for k in comps)
    if tot < CONFIG["trust_min_weight"]:
        return Score(status="insufficient_evidence", limitations=lim + [f"Evidence weight {tot:.2f} below minimum {CONFIG['trust_min_weight']}."])
    v = round(sum(w[k] * comps[k] for k in comps) / tot, 1)
    band = "stronger_support" if v >= 75 else "mixed" if v >= 50 else "weak_support"
    return Score(value=v, band=band, status="available",
                 limitations=lim + [f"Components used: {', '.join(sorted(comps))}; weights renormalized over available."])
