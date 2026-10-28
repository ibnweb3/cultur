import pytest
from fastapi.testclient import TestClient

import cultur.app as appmod
from cultur.config import Settings
from cultur.schemas import Dossier
from conftest import FakeQloo, make_service


@pytest.fixture(scope="module")
def _client():
    st = Settings(qloo_api_key="test-key", qloo_base_url="https://qloo.test", eth_rpc_url="https://rpc.test", db_path=":memory:", max_retries=1)
    appmod.svc = make_service(st, FakeQloo())
    with TestClient(appmod.app) as c:  # MCP session manager can only start once per process
        yield c


@pytest.fixture
def client(_client):
    appmod._hits.clear()
    appmod.svc.s.rate_limit_per_min = 100
    return _client


def test_health_and_docs(client):
    assert client.get("/health").json()["status"] == "ok"
    assert client.get("/openapi.json").status_code == 200


def test_post_get_roundtrip_and_errors(client):
    r = client.post("/api/dossier", json={"input": "Foo Creator"})
    assert r.status_code == 200
    d = r.json()
    g = client.get(f"/api/dossier/{d['id']}")
    assert g.status_code == 200 and g.json() == d
    assert client.get("/api/dossier/nope").status_code == 404
    assert client.post("/api/dossier", json={}).status_code == 422
    assert client.post("/api/dossier", json={"input": "0x12"}).status_code == 422
    assert "Traceback" not in client.post("/api/dossier", json={"input": ""}).text


def test_rate_limit_429(client):
    appmod.svc.s.rate_limit_per_min = 2
    codes = [client.post("/api/dossier", json={"input": "Foo Creator"}).status_code for _ in range(3)]
    assert codes == [200, 200, 429]


async def test_rest_and_mcp_share_schema(settings):
    appmod.svc = make_service(settings, FakeQloo())
    mcp_d = await appmod.generate_dossier("Foo Creator")
    Dossier.model_validate(mcp_d)
    assert set(appmod.svc.get(mcp_d["id"])) == set(mcp_d)
    tools = await appmod.mcp.list_tools()
    assert any(t.name == "generate_dossier" for t in tools)


def test_mcp_endpoint_mounted(client):
    r = client.post("/mcp", headers={"accept": "application/json, text/event-stream", "content-type": "application/json"},
                    json={"jsonrpc": "2.0", "id": 1, "method": "initialize",
                          "params": {"protocolVersion": "2025-03-26", "capabilities": {}, "clientInfo": {"name": "t", "version": "0"}}})
    assert r.status_code == 200, r.text
