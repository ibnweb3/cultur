# QlooVibe

**Audience-grounded design direction for coding agents.** Tell it who you are building for; it asks Qloo what that audience loves, filters the design vocabulary Qloo returns, compiles design tokens through a published rule table, enforces WCAG AA contrast, and prints a receipt for every token. A critic tool then scores the artists, brands and films your agent plans to reference against the same audience.

- Live: https://qloovibe.ibnweb3lab.workers.dev (no login) · API docs: `/docs` · rule table: `/api/rules` · MCP: `/mcp`
- API first: the web page is one thin client over the same REST and MCP service.

## What Qloo does, and what we do

| Qloo (data) | Our code (deterministic, open) |
|---|---|
| Resolves your seeds (`/search`) | Picks the entity: brands and artists before other types on a name clash, type hints like `Slowdive (artist)` |
| Ranks decor, ambience and style tags for the audience (`/v2/insights`, `filter.type=urn:tag`) | Filters non-visual tags (origin, venue type, generic attributes), keeps the top 8 per family, shows every drop with its reason |
| Returns touchstone brands, artists and films with per-seed explainability | Maps kept tags to tokens with the published rule table `qv-rules-1.0` |
| Scores your candidate references against the audience (`filter.entities`) | Derives per-seed shares for decor tags from separate per-seed queries (Qloo gives no per-tag explainability) |
| | Builds the palette from rule-chosen hue, chroma and mode, then forces WCAG AA contrast |

**Qloo supplies no colours, fonts or CSS.** The tag-to-token step is our mapping: every rule is a labelled hypothesis, not validated in user studies, and the table is public (`GET /api/rules`). The service returns no tokens when Qloo decor data is unavailable or none of the design choices has enough mapped evidence. In a supported brief, choices with too little evidence use explicitly labelled defaults; body type stays system sans for readability. Qloo responses may come from the labelled private cache. No LLM writes the tokens or the preview.

The web app starts with your audience input. Its preview shows the generated colors, typography and spacing, with working copy and download controls. It includes no sample product navigation, sign-up form or invented product metrics. Review the matched audience names and any evidence warnings before using the brief.

## Use it

```bash
curl -s -X POST https://qloovibe.ibnweb3lab.workers.dev/api/vibe \
  -H 'content-type: application/json' -d '{"audience": "fans of Slowdive, Aesop, A24"}'

curl -s -X POST https://qloovibe.ibnweb3lab.workers.dev/api/check \
  -H 'content-type: application/json' \
  -d '{"audience": "Slowdive, Aesop", "candidates": ["Bon Iver", "Metallica"]}'
```

```bash
claude mcp add --transport http qloovibe https://qloovibe.ibnweb3lab.workers.dev/mcp
```

MCP tools: `design_brief(audience)` returns a markdown brief (CSS variables for a shadcn-style component set, touchstones, tone words) plus the full receipts; `check_audience_fit(audience, candidates)` scores references; `get_rule_table()` returns the mapping. Status codes: 200 (including `partial` and `insufficient_evidence`), 422 invalid input, 404 expired brief, 429 rate limit.

Separate audience names with commas, semicolons or newlines. Names containing `and`, `&` or `+` stay intact, such as `Pride and Prejudice` and `Salt & Stone`. Put names containing commas in straight or curly double quotes: `Slowdive, “Earth, Wind & Fire”`. API clients can supply `seeds: ["Slowdive", "Earth, Wind & Fire"]` to preserve each name exactly.

## Measured, not claimed

A batch comparison (script: `scripts/benchmark.mjs`; stored results are served at `GET /api/benchmark` and shown in the page's measured-comparison section) pits Qloo's top-8 decor words per audience against an LLM (Llama 3.3 70B on Workers AI) that is shown the same pooled word list. 12 audiences, 3 runs at temperature 0.7, run 2026-10-29:

| Metric | Qloo | LLM, same word list |
|---|---|---|
| Between-audience similarity of the word sets (Jaccard, lower is more audience-specific) | 0.06 | 0.15 |
| Distinct words used across the 12 audiences | 61 | 39 |
| Repeatability on re-run (Jaccard, 1.00 is identical) | 1.00 | 0.78 |
| Share of picked words that map to a rule | 0.86 | 0.89 |
| Agreement: LLM picks that are also in Qloo's top 8 | – | 0.19 |

Read it carefully: the word list is pooled from Qloo's output, which is the easiest setting for the LLM; both arms lean on "Vintage" (6 and 7 of 12 audiences); the LLM maps to rules slightly more often than Qloo; and nothing here shows either arm produces a better design. It measures specificity, repeatability and traceability only. One model, 12 audiences, one temperature.

## Things we tested and removed

- **Colours from Qloo images.** Extracting palettes from images of an audience's lookalike artists, brands, films and venues did not separate audiences (between/within colour distance ratio 0.99 to 1.01, permutation p between 0.22 and 0.70). No colour is taken from images.
- **A cross-seed intersection filter for noisy tags** kept 0 of 10 tags for one audience and 1 of 10 for another, so the published filter is a top-N cutoff plus a visual-tag screen instead.
- **Per-tag Qloo explainability** is not returned for tag queries, so attribution is derived from separate per-seed queries and labelled as such. Shares are unavailable when any seed's score is missing; missing evidence is not treated as zero support.

## Limitations

- Decor, ambience and style tags describe physical spaces and music styles; applying them to interfaces is an analogy.
- Qloo coverage varies: some seeds resolve to the closest entity (flagged), and some tags have no rule yet (listed in the output).
- Critic verdicts compare a candidate's Qloo affinity with the median of Qloo's top 10 for the same audience and type (strong ≤ .05, ok ≤ .10, weak ≤ .18, else off-audience). Thresholds are a heuristic and Qloo affinities are compressed: read rank and gap.
- Measured cold requests took about 4 to 8 seconds (about 10 Qloo calls); Qloo requests have a 25-second overall deadline. Repeated seed sets are served from a private cache for 6 hours and are labelled `cached` in the trace.
- Contrast checks cover text and accent on both page and card surfaces, plus text on the accent. A completed interface still needs its own accessibility review.
- Free-tier Workers: the rate limiter is per isolate (best effort).
- Repeatable for the same query and Qloo data version; Qloo data can change over time.

## Run it yourself

For local development, run these commands from the project root:

```bash
npm --prefix worker ci
cp .env.example worker/.dev.vars
```

Add your Qloo key as `QLOO_API_KEY` in `worker/.dev.vars` (PowerShell users can use `Copy-Item .env.example worker/.dev.vars`). This file is ignored by Git. Then start the complete app:

```bash
npm run dev
```

Open `http://localhost:8787`. Wrangler serves both the frontend and API; a static file server serving `worker/public` cannot create briefs, check references or serve API docs. KV data stays in the local `.wrangler` development state. Sample audience requests still call Qloo; Workers AI is used only when explicitly running the benchmark and can call the remote AI service.

Run the checks with `npm --prefix worker test` and `npm --prefix worker run typecheck`. To deploy to your own Cloudflare account:

```bash
cd worker
npx wrangler kv namespace create KV           # replace the KV id in wrangler.jsonc with your namespace id
npx wrangler secret put QLOO_API_KEY          # your Qloo key; never committed
npx wrangler secret put ADMIN_TOKEN           # only needed for the benchmark script
npx wrangler deploy
```

`QLOO_BASE_URL` (hackathon keys only work on `https://hackathon.api.qloo.com`) and `RATE_LIMIT_PER_MIN` live in `worker/wrangler.jsonc`; see `.env.example`.

## Privacy

No accounts, no tracking. Submitted audience and reference names are sent to Qloo. Briefs are kept for 7 days and then expire; the rate limiter keeps IPs in memory only; the Qloo key is a Worker secret and is never logged or returned. Qloo data is not redistributed in this repository.

## Repository layout

- `worker/` the deployed app (TypeScript, Cloudflare Workers, KV, Workers AI for the benchmark only, official MCP SDK)
  - `src/rules.ts` the published rule table and tag filter terms · `src/color.ts` OKLCH maths and the contrast gate · `src/compile.ts` the token compiler · `src/vibe.ts` the service and critic · `src/index.ts` routes and MCP
- `scripts/benchmark.mjs` the batch comparison
- `docs/` claims ledger and submission text
- `archive/cultur/` an earlier project (crypto due diligence), kept for history, not built or deployed

## License

MIT, see `LICENSE`.
