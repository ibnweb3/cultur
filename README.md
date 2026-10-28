# Cultur

**New name. Familiar cultural footprint.**

Live demo: https://cultur.ibnweb3lab.workers.dev (no login) · API docs: `/docs` · MCP: `/mcp`

Cultur uses Qloo's cross-domain taste graph to surface possible connections between crypto creators and prior projects, with cited evidence and onchain corroboration. It is an API first (REST + MCP); the web page is one thin client over the same service.

> Americans reported $7.2 billion in cryptocurrency investment-fraud losses in 2025, according to the FBI's IC3 ([2025 Internet Crime Report](https://www.ic3.gov/AnnualReport/Reports/2025_IC3Report.pdf), p. 11). That is a U.S. figure and is not attributable to creator rebrands.

Cultur is due-diligence support for fans and creators. It never calls anyone a fraudster: taste similarity is an observation, a possible identity connection is a lead, and only independently sourced facts count as continuity or adverse history.

## What it does

`POST /api/dossier {"input": "<handle|ens|contract|name>"}` returns, in a few seconds, an auditable dossier: scores (each with evidence ids and limitations), a Qloo cross-domain fingerprint, possible rebrand leads against a curated registry of 12 researched cases, wallet facts, a plain-English report where every claim cites evidence, explicit coverage gaps, and a compact tool trace.

**Qloo is the only cultural data source.** Entity resolution, tags, cross-domain affinities, audience context and fingerprints all come from Qloo (`/search`, `/entities`, `/v2/insights`, `/v2/analysis/compare`). Without fresh Qloo grounding Cultur issues no fingerprint, no rebrand lead and no trust verdict (it still returns onchain facts and the gaps). Every valid request makes at least one fresh, request-specific Qloo query; cached responses never stand in for it.

## Use it

```bash
curl -s -X POST https://cultur.ibnweb3lab.workers.dev/api/dossier \
  -H 'content-type: application/json' -d '{"input": "@elonmusk"}'

curl -s https://cultur.ibnweb3lab.workers.dev/api/dossier/<id>   # the original dossier, unchanged
```

Optional API-only hints (treated as unverified assertions): `qloo_entity_ids: [{"entity_id": "...", "attribution": "who says so"}]`, `creation_tx_hash` (verified against the receipt).

Status codes: 200 (including partial / insufficient-evidence dossiers), 422 invalid input, 404 missing or expired dossier, 429 rate limit.

### MCP

Streamable HTTP endpoint `https://cultur.ibnweb3lab.workers.dev/mcp`, tool `generate_dossier(input, qloo_entity_ids?, creation_tx_hash?)`. It calls the same service and returns the same schema as REST.

```bash
claude mcp add --transport http cultur https://cultur.ibnweb3lab.workers.dev/mcp
```

## Run it yourself

```bash
cd worker
npm install
npm test                                   # 38 tests (synthetic fixtures, clearly labelled)
npx wrangler kv namespace create CULTUR_KV # put the id in wrangler.jsonc
npx wrangler secret put QLOO_API_KEY       # your Qloo key; never committed
npx wrangler deploy
```

Config (`worker/wrangler.jsonc`): `QLOO_BASE_URL` (hackathon keys only work on `https://hackathon.api.qloo.com`), `ETH_RPC_URL` (comma-separated list of free endpoints, tried in order), `RATE_LIMIT_PER_MIN`. See `.env.example`.

## Method

Workflow (bounded, evidence-dependent, recorded in `tool_trace`): resolve input, check the curated registry, run onchain checks where applicable, fresh Qloo lookup, fingerprint (`/v2/insights` for artist / brand / person / place, tags via `filter.type=urn:tag`, audience via `filter.type=urn:demographics`), compare with warmed registry fingerprints, then score. The upstream budget is 25 s; unfinished work is aborted and the dossier is marked partial.

- **Resolution.** A Qloo result is accepted only when it is an unambiguous exact match on a person, artist or brand, or when Qloo's `external.twitter.ids` lookup returns an entity that lists that handle. An ENS name is linked only through its self-asserted `com.twitter` text record (shown as evidence, never as verification); a label that merely resembles a Qloo name is not evidence. Ambiguity is returned, not forced.
- **Similarity.** Weighted Jaccard over Qloo entities and tags: 0.7 entity + 0.3 tag. Weights are rank-based (`1/(1+rank)`) and discounted for very popular items (Qloo popularity is a 0..1 fraction). Bands: high >= 0.50, moderate >= 0.25, low >= 0.10; fewer than 3 shared items caps the band at low, and a low band is not treated as a lead.
- **Scores** (`scoring_version cultur-score-1.0`, pure functions in `worker/src/scoring.ts`): `rebrand_risk` (higher = more concern; similarity alone stays a lead, stronger values need independently sourced continuity plus adverse history), `cultural_depth` (descriptive breadth), `community_authenticity` (always null: audience and trend signals cannot show real followers), `wallet_corroboration` (only explicit sourced relationships), `trust_score` (weighted heuristic: sourced history 0.30, wallet 0.25, rebrand risk inverted 0.25, identity confidence 0.20; missing components are dropped and weights renormalised; null below total weight 0.45). It measures how much sourced evidence supports integrity, not a calibrated fraud probability; a low value can mean little evidence. Zero Qloo footprint is a coverage warning, never a penalty.
- **Evidence.** Each record has id, source, reproducible reference, subject, fact, timestamp, fresh/cached flag, and an origin of observed / curated / caller_supplied / inferred.
- **Registry.** `registry/cases.json` holds 12 hand-researched cases (DOJ/SEC releases, CoinDesk, The Block and others) with claim statuses (established / alleged / disputed / unresolved). Fingerprints are produced at runtime from Qloo for named people only (`qloo_anchor_names`) and kept in the Worker's private KV; no Qloo data is committed.

## Privacy

No accounts. No Twitter/X scraping and no X API. Analysis uses submitted public identifiers, cited public records, public onchain facts, and Qloo's aggregated cultural intelligence. Public handles and wallet addresses can still be personal data. Dossiers are kept for 7 days then expire; the rate limiter keeps IPs in memory only; the Qloo key is a Worker secret and is never logged or returned.

## Limitations (read these)

- Ethereum mainnet only. Standard RPC cannot find a contract's creator or enumerate holdings; creation info needs a supplied `creation_tx_hash`. Sender, factory, owner and creator are kept distinct. No chain scans. Free public RPCs rate-limit, so lookups fail over across several.
- In the live warm-up, 6 of the 12 registry cases had a Qloo person anchor with a fingerprint (Do Kwon, Kim Kardashian, Richard Heart, Sam Bankman-Fried, Javier Milei, Logan Paul); the rest have no usable Qloo entity and are not compared. In testing no input produced a meaningful rebrand overlap, and none is forced. Absence of a match is not clearance.
- The registry lists no sourced wallets, so wallet corroboration only reflects ENS and creation-transaction checks.
- `/v2/trending` returned no data for the probed query; momentum is limited to Qloo's raw `audience_growth` values.
- Free-tier Workers: the rate limiter is per-isolate (best effort), KV is eventually consistent, and a dossier fetched from another region immediately after creation may briefly 404.
- Qloo audience associations describe aggregated audiences, not any person's private preferences.

## Repository layout

- `worker/` the deployed app (TypeScript, Cloudflare Workers, KV, official MCP SDK). 
- `registry/` curated case records (shared).
- `python-reference/` the first FastAPI implementation of the same service. It is kept for reference and is not deployed; it was replaced because no free no-card host for it was available.

## License

MIT, see `LICENSE`. Qloo data is not redistributed in this repository.
