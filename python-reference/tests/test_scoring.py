from cultur import scoring as s
from cultur.schemas import Score


def test_weighted_jaccard_basic_and_empty():
    assert s.weighted_jaccard({}, {}) == 0.0
    assert s.weighted_jaccard({"a": 1}, {"a": 1}) == 1.0
    assert s.weighted_jaccard({"a": 1}, {"b": 1}) == 0.0


def test_deterministic():
    assert s.rebrand_risk("high", True, "established", True, 12) == s.rebrand_risk("high", True, "established", True, 12)


def test_band_boundaries():
    assert s.similarity_band(0.50, 5) == "high"
    assert s.similarity_band(0.4999, 5) == "moderate"
    assert s.similarity_band(0.25, 5) == "moderate"
    assert s.similarity_band(0.10, 5) == "low"
    assert s.similarity_band(0.0999, 5) == "none"


def test_few_shared_items_cannot_support_strong_band():
    assert s.similarity_band(0.9, 2) == "low"


def test_popular_shared_taste_is_discounted():
    assert s.popularity_weight(0.99) < s.popularity_weight(0.01)
    assert s.popularity_weight(5000) == 1.0  # unverified scale ignored


def test_unrelated_identities_sharing_popular_tastes_stay_low():
    # two unrelated subjects share only mainstream items: discounted weights keep similarity under the moderate cut
    a = {f"e{i}": s.popularity_weight(0.97) / (1 + i) for i in range(3)}
    a.update({f"a{i}": 1 / (1 + i) for i in range(10)})
    b = {f"e{i}": s.popularity_weight(0.97) / (1 + i) for i in range(3)}
    b.update({f"b{i}": 1 / (1 + i) for i in range(10)})
    sim = s.weighted_jaccard(a, b)
    assert s.similarity_band(sim, 3) in ("none", "low")


def test_risk_direction_similarity_only_stays_a_lead():
    lead = s.rebrand_risk("high", False, "established", True, 12)
    full = s.rebrand_risk("high", True, "established", True, 12)
    assert lead.value < full.value < 101
    assert lead.value < 50
    assert full.band == "high"


def test_rebrand_alone_not_misconduct():
    assert s.rebrand_risk("high", True, None, True, 12).value < 50


def test_no_comparison_is_insufficient_not_zero():
    r = s.rebrand_risk(None, False, None, False, 12)
    assert r.value is None and r.status == "insufficient_evidence"


def test_no_lead_is_not_clearance():
    r = s.rebrand_risk("none", False, None, True, 12)
    assert r.band == "no_lead" and any("not clearance" in l for l in r.limitations)


def test_authenticity_never_issued():
    assert s.community_authenticity(True, True).value is None


def test_depth_missing_data_insufficient():
    d = s.cultural_depth(0, 0, 0, True)
    assert d.value is None and d.status == "insufficient_evidence"


def test_wallet_balances_alone_are_not_identity_proof():
    assert s.wallet_corroboration([{"kind": "balance", "verified": True}]).value is None


def test_trust_null_below_min_evidence_and_unavailable_without_qloo():
    none = Score()
    assert s.trust_score(None, none, none, None, True).value is None
    assert s.trust_score(60.0, none, none, None, False).status == "unavailable"


def test_trust_missing_is_neither_zero_nor_reassuring():
    w = s.wallet_corroboration([{"kind": "registry_wallet_match", "verified": True}])
    t = s.trust_score(60.0, w, Score(), None, True)
    assert t.value is not None and 0 < t.value < 100


def test_established_history_lowers_trust():
    w = s.wallet_corroboration([{"kind": "registry_wallet_match", "verified": True}])
    assert s.trust_score(60.0, w, Score(), "established", True).value < s.trust_score(60.0, w, Score(), "alleged", True).value
