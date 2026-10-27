"""Qloo client. Auth: X-Api-Key. Routes per docs.qloo.com (GET /search, /entities,
/v2/insights, /v2/analysis/compare, /v2/audiences, trending). Parsing is defensive:
unverified response shapes yield empty results plus a parse note, never invented data."""
import asyncio
import hashlib
import json
import random
import time
from dataclasses import dataclass, field
from typing import Any, Optional

import httpx

from .config import Settings
from .db import DB


@dataclass
class QlooResult:
    ok: bool
    data: Any = None
    freshness: str = "fresh"  # fresh | cached
    status: Optional[int] = None
    error: Optional[str] = None  # no secrets
    ref: str = ""  # redacted reproducible query
    fetched_at: float = field(default_factory=time.time)


def entities_of(data: Any) -> list[dict]:
    """results.entities (insights) or results list (search/compare) -> list of dicts."""
    if not isinstance(data, dict):
        return []
    res = data.get("results")
    if isinstance(res, dict):
        res = res.get("entities")
    return [e for e in res if isinstance(e, dict)] if isinstance(res, list) else []


def tags_of(data: Any) -> list[dict]:
    if not isinstance(data, dict):
        return []
    res = data.get("results")
    if isinstance(res, dict):
        res = res.get("tags") or res.get("entities")
    return [t for t in res if isinstance(t, dict)] if isinstance(res, list) else []


def ent_id(e: dict) -> Optional[str]:
    return e.get("entity_id") or e.get("id")


class QlooClient:
    def __init__(self, settings: Settings, db: DB, http: Optional[httpx.AsyncClient] = None):
        self.s, self.db = settings, db
        self.http = http or httpx.AsyncClient(timeout=settings.provider_timeout_s)
        self.calls_fresh = 0
        self.calls_total = 0

    @property
    def configured(self) -> bool:
        return bool(self.s.qloo_api_key)

    def _key(self, path: str, params: dict) -> str:
        norm = json.dumps(params, sort_keys=True, default=str)
        raw = f"qloo|{self.s.qloo_base_url}|{path}|{norm}|v{self.s.cache_version}|{self.s.credential_namespace}"
        return hashlib.sha256(raw.encode()).hexdigest()

    async def get(self, path: str, params: dict, *, fresh: bool = False) -> QlooResult:
        """fresh=True bypasses the cache read (live grounding) but still stores the response."""
        ref = f"GET {path}?" + "&".join(f"{k}={v}" for k, v in sorted(params.items()))
        if not self.configured:
            return QlooResult(False, error="QLOO_API_KEY not configured", ref=ref)
        key = self._key(path, params)
        if not fresh:
            hit = self.db.cache_get(key)
            if hit:
                return QlooResult(True, hit[0], "cached", 200, ref=ref, fetched_at=hit[1])
        last_err, status = "unknown", None
        for attempt in range(self.s.max_retries + 1):
            self.calls_total += 1
            try:
                r = await self.http.get(
                    self.s.qloo_base_url + path, params=params, headers={"X-Api-Key": self.s.qloo_api_key}
                )
                status = r.status_code
                if status == 429 or status >= 500:
                    last_err = f"HTTP {status}"
                    if attempt < self.s.max_retries:
                        try:
                            wait = min(float(r.headers.get("Retry-After", "")), 5.0)
                        except ValueError:
                            wait = 0.4 * (2**attempt)
                        await asyncio.sleep(wait + random.uniform(0, 0.25))
                        continue
                    break
                if status == 404:
                    # documented "No results": a legitimate empty answer
                    self.calls_fresh += 1
                    return QlooResult(True, {"results": []}, "fresh", 404, ref=ref)
                if status >= 400:
                    return QlooResult(False, status=status, error=f"HTTP {status}", ref=ref)
                try:
                    data = r.json()
                except ValueError:
                    return QlooResult(False, status=status, error="malformed JSON from provider", ref=ref)
                if not isinstance(data, (dict, list)):
                    return QlooResult(False, status=status, error="unexpected response type", ref=ref)
                self.calls_fresh += 1
                self.db.cache_put(key, data, self.s.cache_ttl_s)
                return QlooResult(True, data, "fresh", status, ref=ref)
            except httpx.TimeoutException:
                last_err = "timeout"
            except httpx.HTTPError as e:
                last_err = f"transport error: {type(e).__name__}"
            if attempt < self.s.max_retries:
                await asyncio.sleep(0.3 * (2**attempt) + random.uniform(0, 0.2))
        return QlooResult(False, status=status, error=last_err, ref=ref)

    # --- endpoint wrappers -------------------------------------------------
    async def search(self, query: str, types: Optional[str] = None, take: int = 5, fresh=False):
        p = {"query": query, "take": take}
        if types:
            p["types"] = types
        return await self.get("/search", p, fresh=fresh)

    async def entity_by_twitter(self, handle: str, fresh=False):
        # Whether /entities accepts external.twitter.ids is an open contract item; failure is reported.
        return await self.get("/entities", {"external.twitter.ids": handle}, fresh=fresh)

    async def insights(self, entity_ids: list[str], type_: str, take: int = 10, fresh=False, **extra):
        p = {"filter.type": type_, "signal.interests.entities": ",".join(entity_ids), "take": take, **extra}
        return await self.get("/v2/insights", p, fresh=fresh)

    async def compare(self, a_ids: list[str], b_ids: list[str], fresh=False):
        p = {"a.signal.interests.entities": ",".join(a_ids), "b.signal.interests.entities": ",".join(b_ids)}
        return await self.get("/v2/analysis/compare", p, fresh=fresh)
