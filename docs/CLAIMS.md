# Claims ledger

Every sentence in the README, the Devpost text and the demo must fit this ledger. If a claim is not in "Allowed", it does not ship.

## Allowed (each is backed by a test, a live call or a measured run)

- Qloo supplies ranked decor, ambience and style tags for an audience, touchstone brands/artists/films with per-seed explainability, and affinity scores for candidates we name.
- Audiences differ strongly on these tags (top-10 decor tag overlap between five test audiences: Jaccard 0.00 to 0.05).
- Repeated identical queries return identical output (3 of 3 calls, and benchmark re-query Jaccard 1.00).
- Without fresh Qloo grounding the service returns no vocabulary and no tokens (unit tests: failing tags, missing key, failing search).
- Every token carries a receipt: source, contributing Qloo tags with affinity, rule id.
- Palette values are derived by our code from rule-chosen hue, chroma and mode and pass WCAG AA for the four gated pairs (unit-tested over 64 palette combinations).
- The rule table is ours, public at `/api/rules`, versioned, and every rule is a hypothesis.
- Benchmark numbers exactly as stored by `scripts/benchmark.mjs` (n=12, one model, one temperature, closed vocabulary pooled from Qloo output).

## Not allowed

- "Qloo generates colours / hex codes / CSS / design systems." It does not.
- "Colours come from brand affinities / images." Tested: no audience signal (p = 0.22 to 0.70).
- "Per-tag explainability weights from Qloo." Qloo returns explainability for entity results only.
- "100% deterministic" without "for the same query and Qloo data version".
- "250M+ entities", "audited consumer preferences", "millions of profiles": unverified, not ours to claim.
- "Better design", "higher conversion", "users prefer": never measured.
- "Sub-100 ms", "real-time": measured latency is 4 to 8 s cold, under 1 s cached.
- "Calacanis (or any judge) will love...": a guess about people.
- Any example output not copied from a live run.

## Known weaknesses to state when asked

- Space and music tags applied to interfaces is an analogy.
- The token mapping is unvalidated; the benchmark shows specificity and repeatability, not design quality.
- Some kept tags have no rule yet (listed in the output); some seeds resolve to the closest entity (flagged).
