# Devpost text (draft, synced to docs/CLAIMS.md)

**Title:** QlooVibe: a design partner for vibe coders

**Tagline:** Describe your project. Explore Qloo-grounded styles. Build with the direction you choose.

## What it does

QlooVibe helps a vibe coder choose a visual direction for what they are building. Describe an app, paste a README or design specification, or connect it to your coding agent through MCP. It returns supported style options with named font pairs, color palettes, spacing, corner radii, motion, CSS and an implementation brief for each option.

The web app lets you compare and select directions. Its preview, copy controls and downloads use the selected option. A local MCP connection can read Markdown inside your chosen project folder; the hosted MCP endpoint accepts the text read by your coding agent. The MCP workflow asks the agent to show the options and apply the user's choice while respecting the project's framework and functionality.

## How Qloo is used

When a project has no explicit audience references and remote inference is enabled, a language model proposes plausible artists, brands, films, shows or books. These starting references are assumptions, disclosed in the result. Qloo resolves them; only exact matches are retained for inferred audiences. An entity match confirms its identity, not that the project's audience likes it. The default local development command enables remote Workers AI with local KV; an explicit offline alternative disables remote bindings and requires audience references.

Qloo then supplies ranked decor, ambience and style descriptors, cultural touchstones and affinity scores. QlooVibe filters the descriptors and maps them through its published rule table. The options are distinct interpretations of the same Qloo evidence, with their contributing tags and rules shown. Alternatives require no extra Qloo queries. When evidence supports fewer options, the app returns fewer; unsupported briefs contain no tokens.

## What the design recommendations mean

Qloo supplies no font names, colors or CSS. QlooVibe recommends named font pairs and translates descriptors into tokens. Every option includes its rationale, receipts, explicit defaults and checked contrast pairs. These mappings are design hypotheses; the seven contrast checks do not certify a finished interface's accessibility or prove that an audience will prefer a design.

The reference checker separately scores named artists, brands or films against the resolved audience, using Qloo affinity and a disclosed heuristic baseline. It is useful before naming cultural references in copy or imagery.

## Measured

The stored vocabulary benchmark compares Qloo's top-eight decor words with Llama 3.3 70B choosing from the same pooled vocabulary: 12 audiences, three runs. Qloo's sets were more audience-specific (between-audience Jaccard 0.06 vs 0.15), used more distinct words (61 vs 39) and repeated identically (1.00 vs 0.78). These measurements concern vocabulary specificity and repeatability, not the quality of the new style choices or project inference.

## Built with

Cloudflare Workers, KV, Workers AI for project-reference inference and the benchmark, the official MCP SDK, TypeScript and automated tests. No language model writes the design tokens. Font assets and their license are provided for use with the exports. Enabling remote inference sends selected project text to Workers AI; proposed audience names and reference queries are sent to Qloo. Local file reads are confined to the configured project folder. Remote project submission from the local bridge requires explicit configuration.

## Try it

The development version includes the project-first chooser and local MCP connection. See README.md and docs/MCP.md for setup and data-processing choices. The public endpoint is https://qloovibe.ibnweb3lab.workers.dev; local changes must be deployed before they are available there.
