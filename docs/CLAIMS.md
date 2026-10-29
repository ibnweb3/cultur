# Claims ledger

Every sentence in the README, the Devpost text and the demo must fit this ledger. If a claim is not in "Allowed", it does not ship.

## Allowed (each is backed by a test, a live call or a measured run)

- A project description or Markdown document can supply the context. A language model proposes audience references; Qloo resolves the names, and only exact matches are retained for inferred audiences. Resolving an entity does not validate the inferred audience's preferences.
- Supported results include up to three distinct design directions, each with a named font pair, contrast-checked palette, CSS, implementation brief and evidence. Alternatives interpret subsets of the same returned Qloo tags; they are not independent Qloo findings. Sparse evidence yields fewer options.
- Named font choices, style lenses and palette values are QlooVibe recommendations derived through our code. Qloo does not supply font names or certify these design choices.
- The web app accepts project text and local Markdown/text files, and switches previews and exports to the selected direction. Files are read on selection and submitted only when the user creates directions.
- The local stdio MCP bridge reads selected Markdown files within the configured project folder. The hosted MCP server accepts text from its client and cannot read local filesystem paths. Both workflows present directions for the user to choose.

- Qloo supplies ranked decor, ambience and style tags for an audience, touchstone brands/artists/films with per-seed explainability, and affinity scores for candidates we name.
- Audiences differ strongly on these tags (top-10 decor tag overlap between five test audiences: Jaccard 0.00 to 0.05).
- Repeated queries with the same explicit audience names returned identical vocabulary and tokens (3 of 3 calls, and benchmark re-query Jaccard 1.00). Project-to-audience model inference can vary between runs.
- Without available Qloo decor data, or when no design choice has enough mapped evidence, the service returns no tokens (unit tests cover unavailable data and unmapped or filtered tags). Cached Qloo responses are labelled; supported briefs label individual defaults explicitly.
- Every exported token carries a receipt: source, mapping or fixed-value note, and contributing Qloo tags with affinity and rule id where applicable.
- Palette values are derived by our code from rule-chosen hue, chroma and mode and pass WCAG AA for the seven gated pairs (unit-tested over 64 palette combinations): text and accent on page and card surfaces, plus text on the accent. This is not an accessibility certification for a finished interface.
- Per-seed decor shares come from separate Qloo queries and are unavailable if any seed's score is missing; missing evidence is not treated as zero support.
- The rule table is ours, public at `/api/rules`, versioned, and every rule is a hypothesis.
- When given a project description or design.md (`project`), a language model proposes audience names only; each name is checked against Qloo and only exact matches are kept. All design vocabulary still comes from Qloo, and the response says `audience.source: "model_suggested"` and lists the proposed names. If the model or Qloo is unavailable for project-only inference, no tokens are produced.
- Benchmark numbers exactly as stored by `scripts/benchmark.mjs` (n=12, one model, one temperature, closed vocabulary pooled from Qloo output).
- `audit_ui` / `POST /api/audit` run deterministic code checks (no model, no Qloo call) of generated code against the chosen direction's palette and fonts, plus a published list of starter-template markers. The result is pass or needs_changes with findings; it measures adherence to the direction, not design quality.
- Build test `docs/audit-benchmark.json` (`scripts/audit-bench.mjs`): 7 projects, one model (Llama 3.3 70B, temperature 0), one run. Pages written from project text only passed the audit 0 of 7 times; pages written with the brief passed 5 of 7; after one audit-and-fix round 7 of 7 passed. The baseline cannot match the direction's palette or fonts by design, so the first comparison shows the brief is followed, not that it is better. One project (a Mexico City bakery) returned no direction and is not in the 7.
- Model-suggested audience names are stored for 30 days per project text, so the same text returns the same names.

## Not allowed

- "No AI is involved" or "Qloo is the only intelligence": a language model picks the starting names when the user supplies a description instead of names. Say so.
- "Qloo generates colours / hex codes / CSS / design systems." It does not.
- "Colours come from brand affinities / images." Tested: no audience signal (p = 0.22 to 0.70).
- "Per-tag explainability weights from Qloo." Qloo returns explainability for entity results only.
- "No defaults" for every token. Individual unsupported choices are labelled defaults; named body fonts are labelled QlooVibe readability recommendations. Entirely unsupported briefs produce no tokens.
- "100% deterministic" without specifying the same resolved audience names, Qloo data and rule version; model-based project inference may vary.
- "250M+ entities", "audited consumer preferences", "millions of profiles": unverified, not ours to claim.
- "Better design", "higher conversion", "users prefer": never measured.
- "Sub-100 ms", "real-time": measured latency is 4 to 8 s cold, under 1 s cached.
- "Calacanis (or any judge) will love...": a guess about people.
- "The brief removes generic AI design": in the build test the brief did not reduce template markers by itself (briefed pages 2 of 7 had them, baseline pages 0 of 7 in the final run, 1 to 3 of 7 in earlier runs); only the audit-and-fix round cleared them.
- "AI slop score", "design quality score": the audit measures adherence and marker lists we publish, nothing else.
- Any example output not copied from a live run.

## Known weaknesses to state when asked

- The build test is small (7 projects, one model, one run) and the baseline's marker count varied between runs of the same test (3, 1, 1, then 0 of 7). A false positive (pink gradients flagged as blue-violet) was found by inspection and fixed after the first runs; the stored numbers are from the final run. It shows the loop works, not how much it helps in general.
- The audit does not see layout, imagery or whether copy is good; it checks colours, fonts and listed markers.

- With a project description, the choice of starting names is the model's, so it reflects the model's idea of the audience (for example Lagos students); Qloo verifies the names exist and supplies the taste data, but does not judge the choice. Users can pass their own seeds.
- Space and music tags applied to interfaces is an analogy.
- The token mapping is unvalidated; the benchmark shows specificity and repeatability, not design quality.
- Some kept tags have no rule yet (listed in the output); some seeds resolve to the closest entity (flagged).
