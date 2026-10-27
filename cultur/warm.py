"""Warm registry fingerprints from Qloo at runtime (cached in SQLite, never committed).
For each curated case, a name is used as an anchor only when Qloo search returns exactly one
exact-name match. Cases without Qloo coverage are recorded as such, not filled in."""
import asyncio
import sys

from . import fingerprint as fpmod
from . import registry
from .qloo import ent_id, entities_of, etype
from .service import Service

TTL = 30 * 86400


async def warm_case(svc: Service, case: dict) -> dict:
    anchors, tried = [], []
    svc.db.cache_del(f"regfp:{case['id']}")  # drop stale fingerprints before re-resolving
    for name in case.get("qloo_anchor_names", []):
        r = await svc.q.search(name, take=5)
        tried.append({"name": name, "ok": r.ok})
        if not r.ok:
            continue
        ex = [e for e in entities_of(r.data) if registry.norm(e.get("name") or "") == registry.norm(name)
              and etype(e) in ("urn:entity:person", "urn:entity:brand")]
        if len(ex) == 1 and ent_id(ex[0]) not in anchors:
            anchors.append(ent_id(ex[0]))
    if not anchors:
        svc.db.cache_put(f"regcov:{case['id']}", {"status": "no_qloo_match", "tried": tried}, TTL)
        return {"id": case["id"], "anchors": 0}
    fp = await fpmod.build(svc.q, anchors[:4])
    fp["anchors"] = anchors[:4]
    if fp["entities"] or fp["tags"]:
        svc.db.cache_put(f"regfp:{case['id']}", fp, TTL)
    svc.db.cache_put(f"regcov:{case['id']}", {"status": "covered" if (fp["entities"] or fp["tags"]) else "empty", "tried": tried}, TTL)
    return {"id": case["id"], "anchors": len(anchors), "entities": sum(len(v) for v in fp["entities"].values()), "tags": len(fp["tags"])}


async def warm_all(svc: Service, sem: int = 2):
    s = asyncio.Semaphore(sem)

    async def one(c):
        async with s:
            try:
                return await warm_case(svc, c)
            except Exception as e:  # keep warming other cases
                return {"id": c["id"], "error": type(e).__name__}

    return await asyncio.gather(*[one(c) for c in registry.load()])


if __name__ == "__main__":
    svc = Service()
    if not svc.q.configured:
        sys.exit("QLOO_API_KEY not set")
    for row in asyncio.run(warm_all(svc)):
        print(row)
