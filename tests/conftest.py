"""SYNTHETIC test fixtures. Not real Qloo data; never shown in the product."""
import httpx
import pytest

from cultur.config import Settings
from cultur.db import DB
from cultur.onchain import Chain
from cultur.qloo import QlooClient
from cultur.service import Service


def fake_entities(prefix, n=5):
    return [{"entity_id": f"{prefix}{i}", "name": f"{prefix} item {i}", "type": "urn:entity:artist", "popularity": 0.1,
             "tags": [{"id": f"tag:{prefix}{i % 2}", "name": f"t{i % 2}"}]} for i in range(n)]


class FakeQloo:
    def __init__(self, search=None, fail=None):
        self.calls = []
        self.search_result = search if search is not None else [{"entity_id": "ANCHOR", "name": "Foo Creator", "type": "urn:entity:person"}]
        self.fail = fail  # None | "429" | "timeout" | "malformed" | "500"

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.calls.append(str(request.url))
        if self.fail == "timeout":
            raise httpx.ReadTimeout("t")
        if self.fail == "429":
            return httpx.Response(429, headers={"Retry-After": "0"}, json={"message": "slow"})
        if self.fail == "500":
            return httpx.Response(500, json={})
        if self.fail == "malformed":
            return httpx.Response(200, content=b"<html>nope</html>")
        p = request.url.path
        q = dict(request.url.params)
        if p == "/search":
            return httpx.Response(200, json={"results": self.search_result})
        if p == "/entities":
            return httpx.Response(404, json={"message": "No results"})
        if p == "/v2/insights":
            t = q.get("filter.type")
            if t == "urn:tag":
                return httpx.Response(200, json={"results": {"tags": [{"tag_id": "tag:a", "name": "A"}, {"tag_id": "tag:b", "name": "B"}]}})
            if t == "urn:demographics":
                return httpx.Response(200, json={"results": {"demographics": [{"id": "d1", "name": "Age 25-34"}]}})
            return httpx.Response(200, json={"results": {"entities": fake_entities(t.split(":")[-1])}})
        if p == "/v2/analysis/compare":
            return httpx.Response(200, json={"success": True, "results": []})
        return httpx.Response(404)


@pytest.fixture
def settings():
    return Settings(qloo_api_key="test-key", qloo_base_url="https://qloo.test", eth_rpc_url="https://rpc.test",
                    db_path=":memory:", max_retries=1)


def make_service(settings, fake: FakeQloo, rpc=None):
    db = DB(":memory:")
    q = QlooClient(settings, db, httpx.AsyncClient(transport=httpx.MockTransport(fake)))
    rpc = rpc or (lambda r: httpx.Response(200, json={"jsonrpc": "2.0", "id": 1, "result": "0x"}))
    chain = Chain(settings, httpx.AsyncClient(transport=httpx.MockTransport(rpc)))
    return Service(settings, db, q, chain)


@pytest.fixture
def fake():
    return FakeQloo()


@pytest.fixture
def svc(settings, fake):
    return make_service(settings, fake)
