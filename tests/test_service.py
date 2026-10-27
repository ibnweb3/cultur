import json

import httpx
import pytest

from cultur.schemas import DossierRequest
from cultur.service import InvalidInput, classify
from conftest import FakeQloo, make_service


def test_classify():
    assert classify("@Foo_1")[0] == "twitter_handle"
    assert classify("https://x.com/foo")[0] == "twitter_handle"
    assert classify("vitalik.eth")[0] == "ens"
    assert classify("0x" + "a" * 40)[0] == "contract"
    assert classify("Wonderland")[0] == "name"
    for bad in ["", "   ", "0x123", "<script>", "x" * 201, "@bad handle!"]:
        with pytest.raises(InvalidInput):
            classify(bad)


async def test_valid_request_makes_fresh_relevant_qloo_calls(svc, fake):
    d = await svc.generate(DossierRequest(input="Foo Creator"))
    assert d["live_qloo"]["performed"] and d["live_qloo"]["fresh_successful_calls"] >= 1
    assert any("/search" in c and "Foo" in c for c in fake.calls)
    assert d["status"] in ("complete", "partial")
    assert d["resolved_identity"]["qloo_entity_id"] == "ANCHOR"
    assert d["fingerprint"]["entities"]


async def test_repeat_request_still_goes_live(svc, fake):
    await svc.generate(DossierRequest(input="Foo Creator"))
    n = len(fake.calls)
    d2 = await svc.generate(DossierRequest(input="Foo Creator"))
    assert len(fake.calls) > n  # cache bypassed for the grounding step
    assert d2["live_qloo"]["fresh_successful_calls"] >= 1


async def test_evidence_reference_integrity(svc):
    d = await svc.generate(DossierRequest(input="Foo Creator"))
    ids = {e["id"] for e in d["evidence"]}
    assert len(ids) == len(d["evidence"])
    for r in d["plain_english_report"]:
        assert set(r["evidence"]) <= ids
    for sc in d["scores"].values():
        assert set(sc["evidence"]) <= ids
    assert any(r["evidence"] for r in d["plain_english_report"])


async def test_ambiguous_resolution_is_preserved_not_forced(settings):
    f = FakeQloo(search=[{"entity_id": "A", "name": "Foo", "type": "urn:entity:brand"},
                         {"entity_id": "B", "name": "Foo", "type": "urn:entity:person"}])
    d = await make_service(settings, f).generate(DossierRequest(input="Foo"))
    assert d["resolved_identity"] is None
    assert len(d["ambiguity"]) == 2
    assert d["status"] == "insufficient_evidence"
    assert d["scores"]["trust_score"]["value"] is None


async def test_similar_name_celebrity_not_substituted(settings):
    f = FakeQloo(search=[{"entity_id": "C", "name": "Famous Celebrity", "type": "urn:entity:person"}])
    d = await make_service(settings, f).generate(DossierRequest(input="Fam0us"))
    assert d["resolved_identity"] is None


async def test_handle_name_match_alone_does_not_resolve(settings):
    f = FakeQloo(search=[{"entity_id": "C", "name": "foo", "type": "urn:entity:person"}])
    d = await make_service(settings, f).generate(DossierRequest(input="@foo"))
    assert d["resolved_identity"] is None and d["ambiguity"]


@pytest.mark.parametrize("mode", ["429", "timeout", "malformed", "500"])
async def test_qloo_failure_prevents_complete_verdict(settings, mode):
    d = await make_service(settings, FakeQloo(fail=mode)).generate(DossierRequest(input="Foo Creator"))
    assert d["status"] == "insufficient_evidence"
    assert d["live_qloo"]["performed"] is False
    assert d["fingerprint"] == {}
    assert d["scores"]["trust_score"]["value"] is None
    assert "Traceback" not in str(d)


async def test_cached_data_cannot_substitute_for_live_grounding(settings):
    f = FakeQloo()
    s = make_service(settings, f)
    await s.generate(DossierRequest(input="Foo Creator"))
    f.fail = "500"
    d = await s.generate(DossierRequest(input="Foo Creator"))
    assert d["status"] == "insufficient_evidence" and d["fingerprint"] == {}


async def test_no_key_means_no_verdict(settings):
    settings.qloo_api_key = ""
    d = await make_service(settings, FakeQloo()).generate(DossierRequest(input="Foo Creator"))
    assert d["status"] == "insufficient_evidence"
    assert any("QLOO_API_KEY" in c for c in d["caveats"])


async def test_historical_get_returns_original(svc):
    d = await svc.generate(DossierRequest(input="Foo Creator"))
    again = svc.get(d["id"])
    assert again == d and again["created_at"] == d["created_at"]
    assert svc.get("missing") is None


async def test_contract_inputs_report_limits_and_never_scan(settings):
    def rpc(r: httpx.Request):
        m = json.loads(r.content)["method"]
        res = {"eth_getCode": "0x6001", "eth_getBalance": hex(10**18), "eth_call": "0x"}.get(m, "0x")
        return httpx.Response(200, json={"jsonrpc": "2.0", "id": 1, "result": res})
    d = await make_service(settings, FakeQloo(search=[]), rpc=rpc).generate(DossierRequest(input="0x" + "b" * 40))
    assert any(w["kind"] == "code" for w in d["wallet_findings"])
    assert any("creation" in c.lower() for c in d["caveats"])
    assert d["live_qloo"]["attempted_calls"] >= 1
    assert d["status"] == "insufficient_evidence"


async def test_hints_are_marked_caller_supplied(svc):
    d = await svc.generate(DossierRequest(input="Foo Creator", qloo_entity_ids=[{"entity_id": "HINT1", "attribution": "tester"}]))
    assert any(e["origin"] == "caller_supplied" for e in d["evidence"])


async def test_zero_qloo_footprint_is_coverage_warning_not_penalty(settings):
    class Empty(FakeQloo):
        def __call__(self, request):
            if request.url.path == "/v2/insights":
                return httpx.Response(404, json={"message": "No results"})
            return super().__call__(request)
    d = await make_service(settings, Empty()).generate(DossierRequest(input="Foo Creator"))
    assert any("Zero Qloo footprint" in c for c in d["caveats"])
    v = d["scores"]["trust_score"]["value"]
    assert v is None or v >= 50
