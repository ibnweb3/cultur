import asyncio
import logging
import contextlib
import time
from collections import defaultdict, deque
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from mcp.server.mcpserver import MCPServer
from mcp.server.transport_security import TransportSecuritySettings

from .schemas import Dossier, DossierRequest
from .service import InvalidInput, Service
from .warm import warm_all

logging.getLogger("httpx").setLevel(logging.WARNING)  # keep provider URLs out of logs
STATIC = Path(__file__).resolve().parent.parent / "static"
svc = Service()
_hits: dict[str, deque] = defaultdict(deque)

mcp = MCPServer("cultur", instructions="Cultur: cultural-fingerprint due diligence on crypto projects/creators, grounded in Qloo. Call generate_dossier with a handle, ENS name, Ethereum contract or project name.")


@mcp.tool()
async def generate_dossier(input: str, qloo_entity_ids: list[dict] | None = None, creation_tx_hash: str | None = None) -> dict:
    """Generate an auditable Cultur dossier. Same service and schema as POST /api/dossier.
    qloo_entity_ids: optional [{"entity_id": "...", "attribution": "..."}] (treated as unverified assertions)."""
    try:
        req = DossierRequest(input=input, qloo_entity_ids=qloo_entity_ids, creation_tx_hash=creation_tx_hash)
        return await svc.generate(req)
    except InvalidInput as e:
        return {"error": {"code": "invalid_input", "message": str(e)}}
    except ValueError as e:
        return {"error": {"code": "invalid_input", "message": "invalid request"}}


mcp_app = mcp.streamable_http_app(stateless_http=True, json_response=True,
                                  transport_security=TransportSecuritySettings(enable_dns_rebinding_protection=False))


@contextlib.asynccontextmanager
async def lifespan(app: FastAPI):
    task = asyncio.create_task(warm_all(svc)) if svc.q.configured else None
    async with mcp.session_manager.run():
        yield
    if task:
        task.cancel()


app = FastAPI(title="Cultur", version="1.0", lifespan=lifespan,
              description="Cultural-fingerprint due diligence for crypto projects and creators, grounded in Qloo.")


def err(code: int, kind: str, msg: str, **hdr):
    return JSONResponse({"error": {"code": kind, "message": msg}}, status_code=code, headers=hdr)


@app.exception_handler(Exception)
async def _unhandled(request: Request, exc: Exception):
    return err(500, "internal_error", "Unexpected server error")


@app.exception_handler(422)
async def _validation(request: Request, exc):
    return err(422, "invalid_input", "Request body must be JSON like {\"input\": \"<handle|ens|contract|name>\"} (max 200 chars)")


def _limited(ip: str) -> bool:
    q, now = _hits[ip], time.time()
    while q and now - q[0] > 60:
        q.popleft()
    if len(q) >= svc.s.rate_limit_per_min:
        return True
    q.append(now)
    return False


@app.post("/api/dossier", response_model=Dossier, responses={422: {}, 429: {}})
async def post_dossier(body: DossierRequest, request: Request):
    ip = request.headers.get("x-forwarded-for", request.client.host if request.client else "?").split(",")[0].strip()
    if _limited(ip):
        return err(429, "rate_limited", "Too many requests; retry in a minute.", **{"Retry-After": "60"})
    try:
        return await svc.generate(body)
    except InvalidInput as e:
        return err(422, "invalid_input", str(e))


@app.get("/api/dossier/{id}", response_model=Dossier, responses={404: {}})
async def get_dossier(id: str):
    d = svc.get(id)
    if not d:
        return err(404, "not_found", "Dossier not found or expired")
    return d


@app.get("/health")
async def health():
    return {"status": "ok", "qloo_configured": svc.q.configured, "version": "1.0"}


@app.get("/")
async def index():
    return FileResponse(STATIC / "index.html")


app.mount("/static", StaticFiles(directory=STATIC), name="static")
app.mount("/", mcp_app)  # serves /mcp (Streamable HTTP); registered last so API routes win
