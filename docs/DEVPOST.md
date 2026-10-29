# Devpost text (draft, synced to docs/CLAIMS.md)

**Title:** QlooVibe: audience-grounded design direction for coding agents

**Tagline:** Coding agents guess at taste. QlooVibe asks Qloo, then shows a receipt for every design token.

## What it does

Vibecoding tools such as Claude Code, Cursor and v0 fall back to generic themes because they guess what an audience likes. QlooVibe is an MCP server and REST API that asks Qloo what a specific audience loves ("fans of Slowdive, Aesop and A24") and returns design direction an agent can apply:

- ranked decor, ambience and style vocabulary for the audience, with every dropped tag and the reason it was dropped;
- touchstone brands, artists and films with per-seed explainability;
- microcopy tone words, verbatim from Qloo;
- design tokens (CSS variables for a shadcn-style component set), with a receipt for each: which Qloo tags drove it, their affinity, and which rule mapped it;
- a WCAG AA contrast gate on the palette;
- a critic tool that scores the artists, brands or films an agent plans to name in copy against the same audience and flags off-audience picks.

## How Qloo is used

`/search` resolves seeds; `/v2/insights` with `filter.type=urn:tag` returns ranked decor, ambience and style tags; entity insights with explainability return touchstones; `filter.entities` scores candidate references. Without fresh Qloo grounding the service returns no vocabulary and no tokens: no defaults, no model guess.

## What we are honest about

Qloo supplies no colours or CSS. The mapping from tags to tokens is our published rule table (`/api/rules`), made of labelled hypotheses. We tested extracting colour from Qloo's images and venue photos; it did not separate audiences (p between 0.22 and 0.70), so we removed it. Space and music tags applied to interfaces is an analogy.

## Measured

12 audiences, Qloo's top-8 decor words against Llama 3.3 70B shown the same pooled word list (3 runs): Qloo's sets are more audience-specific (between-audience Jaccard 0.06 vs 0.15), use more distinct words (61 vs 39) and repeat exactly (1.00 vs 0.78). The LLM agreed with Qloo's top 8 only 19% of the time. We make no claim that either produces a better design.

## Built with

Cloudflare Workers and KV (free plan), the official MCP SDK, Workers AI (benchmark only), TypeScript, 33 tests. No LLM writes the tokens or the preview. Public repo, MIT licence.

## Try it

https://qloovibe.ibnweb3lab.workers.dev (no login). `claude mcp add --transport http qloovibe https://qloovibe.ibnweb3lab.workers.dev/mcp`
