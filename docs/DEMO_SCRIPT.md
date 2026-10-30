# QlooVibe demo script (about 2:30)

Record against https://qloovibe.ibnweb3lab.workers.dev. Use the `elevenlabs-demo-video` skill: one uncut voice-over take, Playwright recording, no captions.

Before recording:
- Workers AI resets at 00:00 UTC. Record after that, or use only the example chips (cached) and typed names (no AI needed).
- Run each example once beforehand so the result is cached and loads instantly on camera.

| Time | On screen | Voice-over |
|---|---|---|
| 0:00 | Hero: "Good design starts with your TASTE." | Every AI coding agent builds the same page. Purple gradient, Inter, "Unlock the power of". The problem is not the template. The agent has no taste, and nobody gave it any. |
| 0:15 | Click the "Independent bookshop" chip. Results load. | QlooVibe gives it some. I describe a project. It finds who the project is for, then asks Qloo, the cultural taste data API, what those people actually like. |
| 0:30 | Scroll the audience names, then the Qloo evidence. | These are real Qloo matches, not guesses. Names that Qloo cannot match exactly are labelled as partial, and nothing is invented. |
| 0:45 | Direction 1: palette, font pair, contrast check. | From that taste, a fixed rule table produces a palette, a named font pair and design tokens. Every colour pair passes a WCAG contrast check before it is shown. Up to three directions, each from a different angle. |
| 1:05 | Click the agent brief / CSS tab. Click Copy. | Each direction comes as ready CSS and an agent brief: tokens, rules, and a list of things the agent must not do. Paste it into any coding agent. |
| 1:20 | Switch to Audit tab. Paste a generic page (indigo gradient, Inter, "Unlock the power of"). Run. | Now the part I care about most. Handing over a brief does not mean the agent followed it. So QlooVibe audits the code. It checks the palette, the fonts, default Tailwind colours, the blue-violet gradient, template copy and scattered corner radii. |
| 1:45 | Findings list with fail items. Then paste the fixed page. "No failures found". | The failures come back as a fix list. The agent repairs the page, and the audit passes. The audit measures adherence to the direction. It does not claim to judge good design. |
| 2:00 | Show docs/audit-benchmark.json or the README table briefly. | I measured it on a small sample, one model. With no brief, 0 of 7 pages passed. With the brief, 5 of 7. After one audit-and-fix round, 7 of 7. The brief alone did not remove filler copy. The audit did. |
| 2:15 | Terminal or MCP client calling `audit_ui`; show `/docs`. | It is API first. REST and MCP, no login. An agent can call QlooVibe itself, build, audit, fix, repeat. |
| 2:30 | Hero again. | QlooVibe. Give your agent taste, then check that it used it. |

## Notes
- Do not say Qloo endorses the project, and do not say the audit measures design quality.
- Do not show the Workers AI error. If it appears, wait for the 00:00 UTC reset and re-record.
- Numbers (0/7, 5/7, 7/7) come from docs/audit-benchmark.json. If you rerun the benchmark, update them in the voice-over.
