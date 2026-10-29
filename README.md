# QlooVibe

**Audience-grounded design directions for coding agents.** Describe your project or let your agent read its Markdown brief. QlooVibe finds audience references, asks Qloo for related design vocabulary, and returns up to three supported visual directions with font pairs, palettes, CSS and evidence. Choose a direction, then let your coding agent apply its brief. A critic tool scores the artists, brands and films your agent plans to reference against the same audience.

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

**Qloo supplies no colours, fonts or CSS.** The tag-to-token step is our mapping: every rule is a labelled hypothesis, not validated in user studies, and the table is public (`GET /api/rules`). The service returns no tokens when Qloo decor data is unavailable or none of the design choices has enough mapped evidence. In a supported brief, choices with too little evidence use explicitly labelled defaults; body type stays sans for readability. Qloo responses may come from the labelled private cache. No LLM writes the tokens or the preview.

The web app accepts a project description or audience references. Its direction picker previews the generated colors, typography and spacing, with working copy and download controls. Review the resolved audience assumptions and evidence warnings before choosing a direction. Alternatives are different rule-based readings of the same Qloo vocabulary; they are not separate Qloo recommendations. Limited evidence can produce fewer than three options.

## Use it

From the project root, install the Worker dependencies and start the current source with `npm --prefix worker ci` and `npm run dev`. The complete local app runs at `http://localhost:8787`; the public URL reflects its last deployment.

```bash
curl -s -X POST http://localhost:8787/api/vibe \
  -H 'content-type: application/json' \
  -d '{"project": "A music discovery app for young listeners in Lagos, with local events and artist profiles.", "seeds": ["Burna Boy", "Nike"]}'

curl -s -X POST https://qloovibe.ibnweb3lab.workers.dev/api/vibe \
  -H 'content-type: application/json' -d '{"audience": "fans of Slowdive, Aesop, A24"}'

curl -s -X POST https://qloovibe.ibnweb3lab.workers.dev/api/check \
  -H 'content-type: application/json' \
  -d '{"audience": "Slowdive, Aesop", "candidates": ["Bon Iver", "Metallica"]}'
```

```bash
claude mcp add --transport http qloovibe https://qloovibe.ibnweb3lab.workers.dev/mcp
```

MCP tools: `design_brief({project})` accepts a description; `design_brief({project_markdown, source_name})` accepts Markdown text already read by your coding agent. Explicit `audience` or `seeds` can be supplied alongside project context. The hosted server cannot open local filesystem paths. `check_audience_fit` scores references and `get_rule_table` returns the mapping. Status codes: 200 (including `partial` and `insufficient_evidence`), 422 invalid input, 404 expired brief, 429 rate limit.

For scoped file access through a local MCP process:

```bash
npm run --silent mcp -- --project-root "/absolute/path/to/your-project"
```

The bridge exposes `list_project_markdown`, `read_project_markdown` and `design_project`. It defaults to the local Worker at `http://localhost:8787`. Reading a document stays local; generating directions submits its text to the configured service. Remote project submission is disabled unless you explicitly select a service URL and launch with `--allow-remote-projects`. See [MCP setup and the project-to-design workflow](docs/MCP.md) for agent-console configuration and file limits.

Responses include a `directions` array. Present its names, font pairs, palettes and rationale, then ask which direction the user wants. Use the chosen item's `agent_brief`, `tokens.css_qv` or `tokens.css_shadcn`. Selection needs no new provider request. Top-level `tokens` and `agent_brief` are compatibility aliases for the initial direction; they do not track a different choice made by your agent.

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

- Decor, ambience and style tags describe physical spaces and music styles; applying them to interfaces is an analogy. Named font pairs and alternative design directions are QlooVibe recommendations, not font data returned by Qloo.
- Project-only requests use Workers AI to propose audience references, then Qloo verifies entity matches. This identifies known entities; it does not establish that the inferred audience assumptions are correct. Supplying your own audience names keeps that choice explicit.
- Qloo coverage varies: some seeds resolve to the closest entity (flagged), and some tags have no rule yet (listed in the output).
- Critic verdicts compare a candidate's Qloo affinity with the median of Qloo's top 10 for the same audience and type (strong ≤ .05, ok ≤ .10, weak ≤ .18, else off-audience). Thresholds are a heuristic and Qloo affinities are compressed: read rank and gap.
- Measured cold requests took about 4 to 8 seconds (about 10 Qloo calls); Qloo requests have a 25-second overall deadline. Repeated seed sets are served from a private cache for 6 hours and are labelled `cached` in the trace.
- Contrast checks cover text and accent on both page and card surfaces, plus text on the accent. A completed interface still needs its own accessibility review.
- Free-tier Workers: the rate limiter is per isolate (best effort).
- Design tokens repeat for the same resolved audience names, Qloo data and rule version. Model-inferred audience names can vary between runs; Qloo data can change over time.

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

Open `http://localhost:8787`. Wrangler serves both the frontend and API; a static file server serving `worker/public` cannot create briefs, check references or serve API docs. KV data stays in the local `.wrangler` development state. The default `npm run dev` permits the remote Workers AI binding for project-only audience inference and the optional benchmark. It requires Cloudflare authentication and can consume Workers AI usage. Inference sends selected project text to Cloudflare; audience names are sent to Qloo. [Cloudflare's local development guide](https://developers.cloudflare.com/workers/local-development/) explains why Workers AI runs remotely even when the app runs locally.

Use `npm run dev:offline` to disable remote bindings, including Workers AI. Supply explicit audience names alongside project text in this mode. It can still call Qloo over the network when a Qloo key is configured, so it is not a guarantee of fully offline operation. `npm run dev:ai` is an alias for the default AI-enabled command.

Run the checks with `npm --prefix worker test`, `npm --prefix worker run typecheck` and `npm run test:mcp`. To deploy to your own Cloudflare account:

```bash
cd worker
npx wrangler kv namespace create KV           # replace the KV id in wrangler.jsonc with your namespace id
npx wrangler secret put QLOO_API_KEY          # your Qloo key; never committed
npx wrangler secret put ADMIN_TOKEN           # only needed for the benchmark script
npx wrangler deploy
```

`QLOO_BASE_URL` (hackathon keys only work on `https://hackathon.api.qloo.com`) and `RATE_LIMIT_PER_MIN` live in `worker/wrangler.jsonc`; see `.env.example`.

## Privacy

No accounts, no tracking. Submitted audience and reference names are sent to Qloo. Project descriptions or selected Markdown text go to your configured QlooVibe service; when audience inference is needed, the text is processed through Workers AI. Saved briefs include a short project excerpt and expire after 7 days. The local bridge reads only permitted project documents, does not edit them, and requires a launcher opt-in before sending project text to a remote service. The rate limiter keeps IPs in memory only; the Qloo key is a Worker secret and is never logged or returned. Qloo data is not redistributed in this repository.

## Repository layout

- `worker/` the deployed app (TypeScript, Cloudflare Workers, KV, Workers AI for audience inference and the optional benchmark, official MCP SDK)
  - `src/rules.ts` the published rule table and tag filter terms · `src/color.ts` OKLCH maths and the contrast gate · `src/compile.ts` the token compiler · `src/vibe.ts` the service and critic · `src/index.ts` routes and MCP
- `scripts/benchmark.mjs` the batch comparison
- `scripts/qloovibe-mcp.mjs` scoped local file access and the stdio MCP bridge
- `docs/` MCP setup, claims ledger and submission text
- `archive/cultur/` an earlier project (crypto due diligence), kept for history with separate opt-in local run instructions; QlooVibe does not build or deploy it

## License

MIT, see `LICENSE`.
