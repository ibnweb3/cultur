# Cultur

**New name. Familiar cultural footprint.**

Cultur uses Qloo's cross-domain taste graph to surface possible connections between crypto creators and prior projects, with cited evidence and onchain corroboration. It is an API first (REST + MCP); the web page is one thin client over the same service.

> Americans reported $7.2 billion in cryptocurrency investment-fraud losses in 2025, according to the FBI's IC3 ([2025 Internet Crime Report](https://www.ic3.gov/AnnualReport/Reports/2025_IC3Report.pdf), p. 11). That is a U.S. figure and is not attributable to creator rebrands.

Cultur is due-diligence support for fans and creators. It never calls anyone a fraudster: taste similarity is an observation, a possible identity connection is a lead, and only independently sourced facts count as continuity or adverse history.

## What it does

`POST /api/dossier {"input": "<handle|ens|contract|name>"}` returns, in about 30 seconds, an auditable dossier: scores (each with evidence ids and limitations), a Qloo cross-domain fingerprint, possible rebrand leads against a curated registry of 12 researched cases, wallet facts, a plain-English report where every claim cites evidence, explicit coverage gaps, and a compact tool trace.

**Qloo is the only cultural data source.** Entity resolution, tags, cross-domain affinities, audience context and fingerprints all come from Qloo. Without fresh Qloo grounding Cultur issues no fingerprint, no rebrand lead and no trust verdict (it still returns onchain facts and the gaps). Every valid request makes at least one fresh, request-specific Qloo query; cached responses never stand in for it.

## Quick start

```bash
python -m venv .venv && . .venv/bin/activate      # Windows: .venv\Scripts\activate
pip install -r requirements-dev.txt
cp .env.example .env                                # then set QLOO_API_KEY (server-side only); the hackathon host is hackathon.api.qloo.com
python -m pytest -q
uvicorn cultur.app:app --port 8000
```

```bash
curl -s -X POST localhost:8000/api/dossier -H 'content-type: application/json' -d '{"input": "Wonderland"}'
curl -s localhost:8000/api/dossier/<id>             # the original dossier, unchanged
curl -s localhost:8000/health
```

Optional hints (API only, treated as unverified assertions): `qloo_entity_ids: [{"entity_id": "...", "attribution": "who says so"}]`, `creation_tx_hash`. OpenAPI docs at `/docs`.

Status codes: 200 (including partial / insufficient-evidence dossiers), 422 invalid input, 404 missing or expired dossier, 429 rate limit.

Registry fingerprints are produced at runtime from Qloo and cached in SQLite (never committed). Warm them with `python -m cultur.warm` (the server also does this in the background at start-up when a key is set).

## MCP

Streamable HTTP endpoint: `https://<host>/mcp`, tool `generate_dossier(input, qloo_entity_ids?, creation_tx_hash?)`. It calls the same service and returns the same schema as REST.

```bash
claude mcp add --transport http cultur https://<host>/mcp
```

## Method

Workflow (bounded, evidence-dependent, recorded in `tool_trace`): resolve input, check the curated registry, run onchain checks where applicable, fresh Qloo lookup, fingerprint (`/v2/insights` for artist / brand / person / place, tags via `filter.type=urn:tag`, audience via `filter.type=urn:demographics`), compare with warmed registry fingerprints, then score. Upstream budget is 25 s; unfinished work is cancelled and the dossier is marked partial.

- **Resolution.** A Qloo result is accepted only when it is an unambiguous exact match (or a handle returned by Qloo's `external.twitter.ids` lookup). Name similarity never resolves a handle. Ambiguity is returned, not forced.
- **Similarity.** Weighted Jaccard over Qloo entities and tags: 0.7 entity + 0.3 tag. Weights are rank-based (`1/(1+rank)`), because Qloo's affinity scale is not assumed; very popular items are discounted when popularity is a 0..1 fraction. Bands: high >= 0.50, moderate >= 0.25, low >= 0.10 (configurable in `cultur/scoring.py`); fewer than 3 shared items caps the band at low.
- **Scores** (`scoring_version cultur-score-1.0`, pure functions): `rebrand_risk` (higher = more concern; similarity alone stays a lead, stronger values need independently sourced continuity plus adverse history), `cultural_depth` (descriptive breadth), `community_authenticity` (always null: audience and trend signals cannot show real followers), `wallet_corroboration` (only explicit sourced relationships), `trust_score` (weighted heuristic: sourced history 0.30, wallet 0.25, rebrand risk inverted 0.25, identity confidence 0.20; missing components are dropped and weights renormalised; null below total weight 0.45; a "no lead" result is excluded rather than counted as reassuring). Not a calibrated fraud probability. Zero Qloo footprint is a coverage warning, never a penalty.
- **Evidence.** Each record has id, source, reproducible reference, subject, fact, timestamp, fresh/cached flag, and an origin of observed / curated / caller_supplied / inferred.

## Privacy

No accounts. No Twitter/X scraping and no X API. Analysis uses submitted public identifiers, cited public records, public onchain facts, and Qloo's aggregated cultural intelligence. Public handles and wallet addresses can still be personal data. Dossiers are stored for 7 days then expire; the rate limiter keeps IPs in memory only; secrets stay server-side and are never logged or returned.

## Limitations (read these)

- Ethereum mainnet only. Standard RPC cannot find a contract's creator or enumerate holdings; creation info needs a supplied `creation_tx_hash` or a sourced registry record. Sender, factory, owner and creator are kept distinct. No chain scans.
- The registry holds 12 cases built from public reporting (DOJ/SEC releases, CoinDesk, The Block and others); its wallet lists are empty because no primary-sourced wallet was verified. A failed project is not a fraudulent one; each record carries a claim status (established / alleged / disputed / unresolved). Absence of a match is not clearance.
- Qloo coverage varies by entity. In the live warm-up (2026-10-27) 6 of the 12 registry cases had a Qloo person anchor with a fingerprint (Do Kwon, Kim Kardashian, Richard Heart, Sam Bankman-Fried, Javier Milei, Logan Paul); the rest have no usable Qloo entity and are not compared. Only named people/brands are used as anchors, never generic project names. `/v2/trending` exists but returned no data for the probed query; momentum is limited to Qloo's raw `audience_growth` measurements.
- Free-tier hosting cold-starts (about a minute on Render) and has an ephemeral disk: SQLite caches and saved dossiers can vanish on restart.
- Qloo audience associations describe aggregated audiences, not any person's private preferences.

## Deploy ($0)

`render.yaml` targets Render's free web service (spins down after 15 minutes idle; 750 free hours/month; see render.com/docs/free). Set `QLOO_API_KEY`, `QLOO_BASE_URL`, `ETH_RPC_URL` in the dashboard. A `Dockerfile` is included for other free hosts.

## License

MIT, see `LICENSE`. Qloo data is not redistributed in this repository.
