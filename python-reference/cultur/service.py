"""Single dossier-generation service used by both REST and MCP.

Bounded, evidence-dependent workflow:
resolve input -> inspect evidence -> choose Qloo/onchain tools -> compare candidates ->
assess sufficiency -> cited findings. Every step lands in tool_trace.
"""
import asyncio
import re
import time
import uuid
from datetime import datetime, timedelta, timezone
from typing import Optional

from . import fingerprint as fpmod
from . import registry, scoring
from .config import Settings
from .db import DB
from .onchain import ADDR_RE, TX_RE, Chain
from .qloo import QlooClient, ent_id, entities_of, etype
from .schemas import SCHEMA_VERSION, SCORING_VERSION, Dossier, DossierRequest, Evidence, Score


class InvalidInput(ValueError):
    pass


def now_iso(ts: Optional[float] = None) -> str:
    return datetime.fromtimestamp(ts or time.time(), tz=timezone.utc).isoformat(timespec="seconds")


def classify(raw: str) -> tuple[str, str]:
    s = raw.strip()
    if not s or len(s) > 200 or re.search(r"[\x00-\x1f<>]", s):
        raise InvalidInput("input must be a non-empty handle, ENS name, contract address or name (max 200 chars)")
    if s.lower().startswith("0x"):
        if ADDR_RE.match(s):
            return "contract", s.lower()
        raise InvalidInput("0x input is not a valid 40-hex-character Ethereum address")
    m = re.match(r"^(?:https?://)?(?:www\.)?(?:twitter|x)\.com/@?([A-Za-z0-9_]{1,15})/?(?:\?.*)?$", s, re.I)
    if m:
        return "twitter_handle", m.group(1)
    if s.startswith("@"):
        if re.match(r"^@[A-Za-z0-9_]{1,15}$", s):
            return "twitter_handle", s[1:]
        raise InvalidInput("invalid Twitter/X handle")
    if re.match(r"^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.eth$", s, re.I):
        return "ens", s.lower()
    return "name", s


class Book:
    """Evidence ledger: ids are stable per dossier; report claims must cite them."""

    def __init__(self):
        self.items: list[Evidence] = []

    def add(self, source, ref, subject, fact, freshness="n/a", origin="observed", ts=None) -> str:
        eid = f"e{len(self.items) + 1}"
        self.items.append(Evidence(id=eid, source=source, ref=ref, subject=str(subject), fact=fact,
                                   retrieved_at=now_iso(ts), freshness=freshness, origin=origin))
        return eid


class Service:
    def __init__(self, settings: Optional[Settings] = None, db: Optional[DB] = None,
                 qloo: Optional[QlooClient] = None, chain: Optional[Chain] = None):
        self.s = settings or Settings()
        self.db = db or DB(self.s.db_path)
        self.q = qloo or QlooClient(self.s, self.db)
        self.chain = chain or Chain(self.s)

    # ---- public ---------------------------------------------------------
    def get(self, id_: str) -> Optional[dict]:
        return self.db.get_dossier(id_)

    async def generate(self, req: DossierRequest) -> dict:
        t0 = time.time()
        itype, norm_in = classify(req.input)
        ctx = {"trace": [], "book": Book(), "findings": [], "caveats": [], "qcalls": [],
               "provider": {}, "wallet": [], "wallet_items": [], "anchors": [], "identity": None,
               "ambiguity": [], "fp": None, "matches": [], "reg_self": None, "deadline_hit": False,
               "name_basis": None, "identity_conf": None, "coverage": {}}
        try:
            await asyncio.wait_for(self._pipeline(req, itype, norm_in, ctx), timeout=self.s.upstream_budget_s)
        except asyncio.TimeoutError:
            ctx["deadline_hit"] = True
            ctx["caveats"].append(f"Upstream work budget of {self.s.upstream_budget_s:.0f}s reached; unfinished steps were cancelled and the result is partial.")
        d = self._assemble(req, itype, ctx, t0)
        self.db.save_dossier(d["id"], d, time.time() + self.s.dossier_ttl_days * 86400)
        return d

    # ---- helpers --------------------------------------------------------
    def _trace(self, ctx, step, tool, detail, ok, t):
        ctx["trace"].append({"step": len(ctx["trace"]) + 1, "action": step, "tool": tool, "detail": detail,
                             "ok": ok, "ms": int((time.time() - t) * 1000)})

    def _note_q(self, ctx, what, r):
        ctx["qcalls"].append({"what": what, "ok": r.ok, "freshness": r.freshness, "error": r.error, "ref": r.ref,
                              "status": r.status, "ts": r.fetched_at})
        ctx["provider"]["qloo"] = {"configured": self.q.configured, "last_error": r.error if not r.ok else ctx["provider"].get("qloo", {}).get("last_error")}

    async def _qloo_resolve(self, ctx, query: str, itype: str, norm_in: str):
        """Fresh, request-specific Qloo lookup. Returns accepted entity or None; ambiguity preserved."""
        t = time.time()
        if itype == "twitter_handle":
            r = await self.q.entity_by_twitter(norm_in, fresh=True)
            self._note_q(ctx, "entities by external.twitter.ids", r)
            ents = entities_of(r.data) if r.ok else []
            self._trace(ctx, "resolve handle", "qloo.entities", f"external.twitter.ids={norm_in}", r.ok, t)
            owned = [e for e in ents if str(((e.get("properties") or {}).get("external") or {}).get("twitter", {}).get("id", "")).lower() == norm_in.lower()]
            if owned and len({registry.norm(e.get("name") or "") for e in owned}) == 1:
                # several Qloo entities (e.g. person + artist) may list the same handle; all are the same named subject
                first = self._accept(ctx, owned[0], r, "Qloo lookup by external.twitter.ids (handle listed on the entity)")
                for extra in owned[1:4]:
                    if ent_id(extra) not in ctx["anchors"]:
                        ctx["anchors"].append(ent_id(extra))
                        ctx["identity"]["also_listed_as"] = ctx["identity"].get("also_listed_as", []) + [{"qloo_entity_id": ent_id(extra), "type": etype(extra)}]
                return first
            if len(ents) == 1:
                return self._accept(ctx, ents[0], r, "Qloo lookup by external.twitter.ids")
            if len(ents) > 1:
                ctx["ambiguity"] = [{"id": ent_id(e), "name": e.get("name")} for e in ents[:5]]
                return None
            # fall back to name search as CANDIDATES only
        t = time.time()
        r = await self.q.search(norm_in if itype != "contract" else query, take=5, fresh=True)
        self._note_q(ctx, "search", r)
        self._trace(ctx, "search candidates", "qloo.search", f"query={norm_in}", r.ok, t)
        if not r.ok:
            return None
        ents = entities_of(r.data)
        exact = [e for e in ents if registry.norm(e.get("name") or "") == registry.norm(norm_in)]
        if len(exact) == 1 and itype in ("name", "ens", "twitter_handle"):
            if itype == "twitter_handle":
                # a name match alone does not prove this handle belongs to that entity
                ctx["ambiguity"] = [{"id": ent_id(exact[0]), "name": exact[0].get("name"), "note": "name match only; handle ownership not verified"}]
                return None
            return self._accept(ctx, exact[0], r, "exact name match in Qloo search")
        ctx["ambiguity"] = [{"id": ent_id(e), "name": e.get("name"), "type": etype(e)} for e in ents[:5]]
        if ents:
            ctx["caveats"].append("Qloo returned candidates but none is an unambiguous exact match; none was assumed.")
        return None

    def _accept(self, ctx, e, r, how):
        eid = ctx["book"].add("qloo", r.ref, ent_id(e), f"Qloo entity '{e.get('name')}' ({etype(e) or 'type n/a'}) resolved via {how}",
                              r.freshness, "observed", r.fetched_at)
        ctx["identity"] = {"qloo_entity_id": ent_id(e), "name": e.get("name"), "type": etype(e), "method": how, "evidence": [eid]}
        ctx["anchors"].append(ent_id(e))
        ctx["identity_conf"] = 60.0
        return e

    # ---- pipeline -------------------------------------------------------
    async def _pipeline(self, req, itype, norm_in, ctx):
        book: Book = ctx["book"]
        t = time.time()
        reg = registry.find_by_name(norm_in) if itype != "contract" else registry.find_by_wallet(norm_in)
        if reg:
            ctx["reg_self"] = reg[0]
            e = book.add("curated-registry", f"registry/cases.json#{reg[0]['id']}", reg[0]["id"],
                         f"Input matches curated case '{reg[0]['id']}'; sources: {', '.join(reg[0]['sources'][:2])}", "n/a", "curated")
            ctx.setdefault("reg_ev", []).append(e)
        self._trace(ctx, "check registry", "registry", f"matches={len(reg)}", True, t)

        qname = norm_in
        # onchain branch
        address = None
        if itype == "ens":
            t = time.time()
            r = await self.chain.resolve_ens(norm_in)
            self._trace(ctx, "resolve ENS", "eth.ens", norm_in, r.ok, t)
            ctx["provider"]["eth_rpc"] = {"ok": r.ok, "error": r.error}
            if r.ok:
                address = r.value
                ev = book.add("ethereum-mainnet", f"ENS registry resolver(addr) for {norm_in}", address,
                              f"{norm_in} forward-resolves to {address}", "fresh", "observed")
                ctx["wallet"].append({"kind": "ens_forward", "address": address, "evidence": [ev], "note": "Forward record only; says nothing about cultural interests."})
                ctx["wallet_items"].append({"kind": "ens_forward_resolved", "verified": True})
                qname = norm_in[:-4]
            else:
                ctx["caveats"].append(f"ENS resolution failed: {r.error}")
        elif itype == "contract":
            address = norm_in
        if address:
            await self._wallet_checks(req, address, itype == "contract", ctx)

        # hints
        if req.qloo_entity_ids:
            for h in req.qloo_entity_ids[:5]:
                ev = book.add("caller", "request.qloo_entity_ids", h.entity_id,
                              f"Caller asserts Qloo entity {h.entity_id} as seed (attribution: {h.attribution}); unverified", "n/a", "caller_supplied")
                ctx["anchors"].append(h.entity_id)
                ctx.setdefault("hint_ev", []).append(ev)

        # live grounding: always at least one request-specific Qloo lookup
        if self.q.configured:
            if itype == "contract":
                text = ctx["reg_self"]["names"][0] if ctx["reg_self"] else norm_in
                lt = "name" if ctx["reg_self"] else "contract"
            else:
                text, lt = qname, itype
            await self._qloo_resolve(ctx, text, lt, text)
            if itype == "contract" and not ctx["reg_self"] and not ctx["anchors"]:
                ctx["caveats"].append("A bare contract address carries no cultural anchor, and Qloo returned no usable entity for it. Provide a sourced project name or Qloo entity IDs.")
        else:
            ctx["caveats"].append("QLOO_API_KEY is not configured: no fresh Qloo grounding is possible, so no cultural analysis or trust verdict is issued.")
            self._trace(ctx, "ground in Qloo", "qloo", "skipped: no credentials", False, time.time())

        live_ok = any(c["ok"] and c["freshness"] == "fresh" for c in ctx["qcalls"])
        if not ctx["anchors"] or not live_ok:
            return

        # fingerprint
        t = time.time()
        fp = await fpmod.build(self.q, list(dict.fromkeys(ctx["anchors"])))
        for c in fp["calls"]:
            ctx["qcalls"].append({**c, "status": None})
        ctx["fp"] = fp
        n_ok = sum(1 for c in fp["calls"] if c["ok"])
        self._trace(ctx, "fingerprint", "qloo.insights", f"{n_ok}/{len(fp['calls'])} calls ok", n_ok > 0, t)
        for cat, items in fp["entities"].items():
            ctx.setdefault("fp_ev", []).append(book.add("qloo", f"GET /v2/insights filter.type=urn:entity:{cat}", cat,
                f"{len(items)} {cat} associations returned (top: {', '.join(str(i['name']) for i in items[:3])})", "fresh", "observed"))
        if fp["tags"]:
            ctx.setdefault("fp_ev", []).append(book.add("qloo", "GET /v2/insights filter.type=urn:tag", "tags",
                f"{len(fp['tags'])} tag associations (top: {', '.join(str(i['name']) for i in fp['tags'][:3])})", "fresh", "observed"))
        if fp["audience"]:
            ctx.setdefault("aud_ev", []).append(book.add("qloo", "GET /v2/insights filter.type=urn:demographics", "audience",
                f"{len(fp['audience'])} audience/demographic signals returned (aggregated; not a statement about individuals)", "fresh", "observed"))

        # compare against warmed registry fingerprints
        await self._compare(ctx)

    async def _wallet_checks(self, req, address, is_contract, ctx):
        book = ctx["book"]
        t = time.time()
        r = await self.chain.code_size(address)
        ctx["provider"]["eth_rpc"] = {"ok": r.ok, "error": r.error}
        self._trace(ctx, "inspect address", "eth.getCode", address, r.ok, t)
        if r.ok:
            size = int(r.value)
            ev = book.add("ethereum-mainnet", f"eth_getCode({address})", address,
                          f"{address} has {size} bytes of code ({'contract' if size else 'externally owned account'})", "fresh")
            ctx["wallet"].append({"kind": "code", "address": address, "bytes": size, "evidence": [ev]})
            if is_contract and size == 0:
                ctx["caveats"].append("Address has no bytecode on Ethereum mainnet; it is not a contract there.")
            if size:
                o = await self.chain.owner(address)
                if o.ok:
                    ev2 = book.add("ethereum-mainnet", f"eth_call({address}, owner())", o.value, f"owner() returns {o.value}", "fresh")
                    ctx["wallet"].append({"kind": "owner", "address": o.value, "evidence": [ev2], "note": "Current owner is not necessarily the creator."})
                    reg = registry.find_by_wallet(o.value)
                    if reg:
                        ctx["wallet_items"].append({"kind": "owner_matches_registry", "verified": True})
                else:
                    ctx["wallet"].append({"kind": "owner", "address": None, "evidence": [], "note": o.error})
        b = await self.chain.balance_eth(address)
        if b.ok:
            ev = book.add("ethereum-mainnet", f"eth_getBalance({address})", address, f"Native balance {b.value} ETH. Token holdings were not enumerated.", "fresh")
            ctx["wallet"].append({"kind": "native_balance", "value_eth": b.value, "evidence": [ev], "note": "Scope: native ETH only. Standard RPC cannot enumerate all tokens or prior contracts."})
        if is_contract:
            if req.creation_tx_hash:
                if not TX_RE.match(req.creation_tx_hash):
                    ctx["caveats"].append("creation_tx_hash is not a valid 32-byte hash and was ignored.")
                else:
                    ok, sender, note = await self.chain.tx_creation_matches(req.creation_tx_hash, address)
                    ev = book.add("ethereum-mainnet", f"eth_getTransactionReceipt({req.creation_tx_hash})", req.creation_tx_hash,
                                  f"{note}; transaction sender {sender}", "fresh", "observed" if ok else "caller_supplied")
                    ctx["wallet"].append({"kind": "creation_tx", "verified": ok, "tx": req.creation_tx_hash, "sender": sender, "evidence": [ev],
                                          "note": "Sender is not automatically the attributed creator (factories, deployers and owners can differ)."})
                    if ok:
                        ctx["wallet_items"].append({"kind": "creation_tx_verified", "verified": True})
            else:
                ctx["caveats"].append("Contract creation history unavailable: standard RPC cannot look up creators, and no indexer record or creation_tx_hash was supplied.")

    async def _compare(self, ctx):
        book: Book = ctx["book"]
        fp = ctx["fp"]
        ents, tags = fpmod.weight_map(fp, scoring.popularity_weight)
        if not ents and not tags:
            return
        t = time.time()
        warmed = []
        for case in registry.load():
            if ctx["reg_self"] and case["id"] == ctx["reg_self"]["id"]:
                continue
            hit = self.db.cache_get(f"regfp:{case['id']}")
            if hit and set(hit[0].get("anchors", [])) & set(ctx["anchors"]):
                ctx["caveats"].append(f"Subject shares a Qloo entity with curated case '{case['id']}'; that case was excluded from comparison as a self-match.")
                continue
            if hit:
                warmed.append((case, hit[0]))
        ctx["coverage"]["registry_fingerprints_available"] = f"{len(warmed)}/{len(registry.load())}"
        scored = []
        for case, rfp in warmed:
            re_, rt = fpmod.weight_map(rfp, scoring.popularity_weight)
            se = scoring.weighted_jaccard(ents, re_)
            st = scoring.weighted_jaccard(tags, rt)
            shared_e = sorted(set(ents) & set(re_))
            shared_t = sorted(set(tags) & set(rt))
            sim = round(0.7 * se + 0.3 * st, 4)
            scored.append((sim, case, se, st, shared_e, shared_t, rfp))
        scored.sort(key=lambda x: -x[0])
        self._trace(ctx, "compare to registry", "local.weighted_jaccard", f"{len(warmed)} warmed records", True, t)
        top = scored[: self.s.max_compare_candidates]
        names = {}
        for fpx in [fp] + [x[6] for x in top]:
            for items in fpx.get("entities", {}).values():
                for e in items:
                    names[e["id"]] = e.get("name")
        qc = 0
        for sim, case, se, st, shared_e, shared_t, rfp in top:
            band = scoring.similarity_band(sim, len(shared_e) + len(shared_t))
            m = {"registry_id": case["id"], "names": case["names"], "similarity": sim,
                 "method": "weighted Jaccard (0.7 entity + 0.3 tag); weights = 1/(1+rank) discounted by popularity when 0..1",
                 "entity_overlap": round(se, 4), "tag_overlap": round(st, 4), "band": band,
                 "shared_entities": [{"id": i, "name": names.get(i)} for i in shared_e[:10]], "shared_tags": shared_t[:10],
                 "continuity": {"status": case["continuity_status"], "note": case.get("continuity_note", ""), "sources": case["sources"]},
                 "adverse_history_status": case["adverse_status"], "qloo_compare": None,
                 "limitations": ["Similarity of taste is an observation, not evidence of common identity."]}
            if band != "none" and qc < self.s.max_qloo_compare_calls and ctx["anchors"] and rfp.get("anchors"):
                qc += 1
                r = await self.q.compare(ctx["anchors"], rfp["anchors"])
                self._note_q(ctx, "analysis/compare", r)
                m["qloo_compare"] = {"ok": r.ok, "freshness": r.freshness, "error": r.error,
                                     "raw_top_level_keys": sorted(r.data.keys()) if r.ok and isinstance(r.data, dict) else None,
                                     "note": "Raw Qloo comparison value preserved; its scale is not interpreted by Cultur."}
                res = r.data.get("results") if r.ok and isinstance(r.data, dict) else None
                if isinstance(res, dict) and isinstance(res.get("tags"), list):
                    sc = [t["query"]["score"] for t in res["tags"] if isinstance(t, dict) and isinstance(t.get("query"), dict) and isinstance(t["query"].get("score"), (int, float))]
                    m["qloo_compare"]["shared_tags_scored"] = len(sc)
                    m["qloo_compare"]["top_shared_tags"] = [{"name": t.get("name"), "score": t["query"].get("score")} for t in res["tags"][:5] if isinstance(t, dict) and isinstance(t.get("query"), dict)]
                    m["qloo_compare"]["note"] = "Qloo compare returns shared tags with per-tag scores (raw values preserved)."
            if band != "none":
                m["evidence"] = [book.add("local-comparison", "weighted Jaccard over Qloo fingerprints", case["id"],
                    f"Overlap with curated case '{case['id']}': band {band}, {len(shared_e)} shared entities, {len(shared_t)} shared tags", "cached" if True else "fresh", "inferred")]
                ctx["matches"].append(m)

    # ---- assembly -------------------------------------------------------
    def _assemble(self, req, itype, ctx, t0) -> dict:
        book: Book = ctx["book"]
        fp = ctx["fp"]
        fresh_ok = [c for c in ctx["qcalls"] if c["ok"] and c["freshness"] == "fresh"]
        live = {"performed": bool(fresh_ok), "fresh_successful_calls": len(fresh_ok), "attempted_calls": len(ctx["qcalls"]),
                "calls": [{"what": c["what"], "ok": c["ok"], "freshness": c["freshness"], "error": c["error"], "ref": c["ref"]} for c in ctx["qcalls"]][:20],
                "note": "Grounding requires at least one fresh request-specific Qloo query; an empty result from a relevant lookup counts as a coverage gap, not a failure."}
        grounded = bool(fresh_ok) and bool(ctx["anchors"])

        ent_n = sum(len(v) for v in fp["entities"].values()) if fp else 0
        tag_n = len(fp["tags"]) if fp else 0
        cats = len(fp["entities"]) if fp else 0
        depth = scoring.cultural_depth(cats, ent_n, tag_n, grounded and fp is not None)
        auth = scoring.community_authenticity(bool(fp and fp["audience"]), False)
        best = None
        for m in ctx["matches"]:
            order = {"none": 0, "low": 1, "moderate": 2, "high": 3}
            if best is None or order[m["band"]] > order[best["band"]]:
                best = m
        continuity = bool(best and best["continuity"]["status"] == "established")
        wallet = scoring.wallet_corroboration(ctx["wallet_items"])
        compared = grounded and fp is not None and ctx["coverage"].get("registry_fingerprints_available", "0/").split("/")[0] != "0"
        rebrand = scoring.rebrand_risk(best["band"] if best else None, continuity,
                                       best["adverse_history_status"] if best else None, compared, len(registry.load()))
        self_hist = ctx["reg_self"]["adverse_status"] if ctx["reg_self"] else None
        trust = scoring.trust_score(ctx["identity_conf"] if grounded else None, wallet, rebrand, self_hist, grounded)
        scores = {"rebrand_risk": rebrand, "cultural_depth": depth, "community_authenticity": auth,
                  "wallet_corroboration": wallet, "trust_score": trust}
        for k, sc in scores.items():
            sc.evidence = sorted(set(sc.evidence) | self._score_ev(k, ctx))

        # report (deterministic templates, each cites evidence)
        rep = []
        def say(text, ev):
            ev = [e for e in ev if e]
            rep.append({"text": text, "evidence": ev})
        if ctx["identity"]:
            i = ctx["identity"]
            say(f"Qloo resolved the input to '{i['name']}' ({i['method']}). This is an entity match, not proof of who controls an account or wallet.", i["evidence"])
        elif ctx["reg_self"]:
            say(f"The input matches curated case '{ctx['reg_self']['id']}'. Case facts are listed in the evidence with sources.", ctx.get("reg_ev", []))
        if fp and ent_n:
            say(f"Qloo returns {ent_n} cross-domain associations across {cats} categories and {tag_n} tags for this anchor. They describe audience-level cultural affinity, not private preferences.", ctx.get("fp_ev", []))
        if fp and fp["audience"]:
            say("Qloo also returned aggregated audience context. It does not show whether followers are real.", ctx.get("aud_ev", []))
        for m in ctx["matches"]:
            if m["band"] == "none":
                continue
            c = m["continuity"]["status"]
            txt = (f"Cultural overlap with curated case '{m['registry_id']}' is in the '{m['band']}' band. ")
            txt += ("Independently reported identity continuity exists for that case, which makes this a lead worth investigating." if c == "established"
                    else "No independent identity continuity is recorded, so this is only a similarity observation.")
            say(txt, m["evidence"])
        for w in ctx["wallet"]:
            if w["kind"] == "creation_tx":
                say(("The supplied creation transaction creates this contract directly." if w["verified"] else "The supplied transaction does not show direct creation of this contract.") + " The sender is not automatically the creator.", w["evidence"])
            elif w["kind"] == "ens_forward":
                say(f"The ENS name forward-resolves to {w['address']}.", w["evidence"])
        if not rep:
            say("No supported finding could be produced from the available evidence; see coverage and caveats.", [])

        caveats = list(ctx["caveats"])
        if not grounded:
            caveats.append("No fresh Qloo grounding for this input: no fingerprint, rebrand lead or trust verdict was produced.")
        if grounded and fp is not None and ent_n == 0 and tag_n == 0:
            caveats.append("Zero Qloo footprint found for the anchor. This is a coverage warning that needs follow-up; it does not lower trust or imply suspicious conduct.")
        if grounded and ctx["coverage"].get("registry_fingerprints_available", "0/").startswith("0/"):
            caveats.append("No registry fingerprints are warmed in this instance's cache, so no rebrand comparison was run (run the warm-up job).")
        caveats.append("Momentum is limited to Qloo's raw audience_growth measurements on associated entities; /v2/trending returned no data and is not interpreted.")

        if not grounded:
            status = "insufficient_evidence"
        elif ctx["deadline_hit"] or fp is None or not ent_n or any(not c["ok"] for c in (fp["calls"] if fp else [])):
            status = "partial"
        else:
            status = "complete"
        if ctx["reg_self"] and ctx["identity"]:
            ver = "verified"
        elif ctx["identity"] or ctx["wallet_items"]:
            ver = "partially_verified"
        elif ctx["anchors"]:
            ver = "taste_only"
        else:
            ver = "unverified"

        # evidence-reference integrity
        valid = {e.id for e in book.items}
        for r_ in rep:
            r_["evidence"] = [e for e in r_["evidence"] if e in valid]

        created = time.time()
        d = Dossier(
            id=uuid.uuid4().hex[:16], created_at=now_iso(created), expires_at=now_iso(created + self.s.dossier_ttl_days * 86400),
            input=req.input, input_type=itype, status=status, resolved_identity=ctx["identity"], ambiguity=ctx["ambiguity"],
            verification=ver, scores=scores,
            fingerprint=({"anchors": ctx["anchors"], "entities": fp["entities"], "tags": fp["tags"], "audience": fp["audience"],
                          "momentum": fp.get("momentum") or None, "provenance": "Qloo, fresh"} if (fp and grounded) else {}),
            rebrand_matches=ctx["matches"], wallet_findings=ctx["wallet"], plain_english_report=rep,
            evidence=book.items, coverage={**ctx["coverage"], "qloo_categories_with_results": cats,
                                           "registry_size": len(registry.load()), "chain": "ethereum-mainnet only"},
            caveats=caveats, provider_status={**ctx["provider"], "qloo_configured": self.q.configured},
            live_qloo=live, tool_trace=ctx["trace"], duration_ms=int((time.time() - t0) * 1000),
        )
        return d.model_dump(mode="json")

    def _score_ev(self, key, ctx) -> set:
        if key == "cultural_depth":
            return set(ctx.get("fp_ev", []))
        if key == "community_authenticity":
            return set(ctx.get("aud_ev", []))
        if key == "wallet_corroboration":
            return {e for w in ctx["wallet"] for e in w.get("evidence", [])}
        if key == "rebrand_risk":
            return {e for m in ctx["matches"] for e in m.get("evidence", [])}
        if key == "trust_score":
            return set(ctx["identity"]["evidence"]) if ctx["identity"] else set()
        return set()
