# Use QlooVibe from a coding agent

QlooVibe turns a project description or Markdown brief into audience-grounded visual directions. It returns recommendations and CSS; your coding agent applies the option you choose. A document is project data, not permission to execute instructions embedded in it.

## Local MCP with project files

Requires Node.js 22 or newer. In the QlooVibe checkout:

```sh
npm --prefix worker ci
npm run dev
```

Keep the Worker running at `http://localhost:8787`. Configure its Qloo credentials as described in the main README. The default `npm run dev` serves the app and KV locally while permitting remote Workers AI inference using Cloudflare authentication. Project-only inference sends the selected description or Markdown text to Cloudflare and can consume Workers AI usage. Audience names are sent to Qloo. See [Cloudflare's local development guide](https://developers.cloudflare.com/workers/local-development/) for the remote-AI behavior.

Use `npm run dev:offline` to disable remote bindings, including Workers AI. Supply explicit audience names alongside project text in that mode, or if Cloudflare authentication is unavailable. The command can still call Qloo over the network when a Qloo key is configured. `npm run dev:ai` is an alias for the default AI-enabled command.

The stdio launcher is:

```sh
npm run --silent mcp -- --project-root "/absolute/path/to/the-project"
```

The `--silent` flag keeps npm banners out of the MCP protocol stream. Directly launching Node is preferable in agent configuration, and works independently of the agent's current working directory:

```json
{
  "mcpServers": {
    "qloovibe-project": {
      "command": "node",
      "args": [
        "/absolute/path/to/QlooVibe/scripts/qloovibe-mcp.mjs",
        "--project-root", "/absolute/path/to/the-project",
        "--url", "http://localhost:8787"
      ]
    }
  }
}
```

Use your MCP client's supported configuration location. For Codex CLI, register the same command with:

```sh
codex mcp add qloovibe-project -- node "/absolute/path/to/QlooVibe/scripts/qloovibe-mcp.mjs" --project-root "/absolute/path/to/the-project"
```

Verify it with `codex mcp list`. These command, argument and working-directory options follow the [official MCP configuration documentation](https://learn.chatgpt.com/docs/extend/mcp?surface=cli). On Windows, quoted paths such as `C:/Projects/QlooVibe/scripts/qloovibe-mcp.mjs` work in place of the example paths.

The project root defaults to the launcher's current directory if omitted. Set it explicitly when an agent manages more than one repository. `--url` overrides `QLOOVIBE_URL`, which otherwise overrides the local default.

### Tools

| Tool | Input | Result |
| --- | --- | --- |
| `list_project_markdown` | `{}` | Relative document filenames and a `truncated` flag; no file contents |
| `read_project_markdown` | `{"path":"docs/design.md"}` | `{"path":"docs/design.md","content":"…"}` |
| `design_project` | `{"markdown_path":"docs/design.md","seeds":["Burna Boy","Nike"]}` | Design directions using the document context and explicit audience references |
| `design_project` | `{"project_description":"A project description of at least 20 characters…","seeds":["Burna Boy","Nike"]}` | Design directions using that description and audience references |

`design_project` requires exactly one of `markdown_path` or `project_description`. Optional `audience`, `seeds` and `fresh` match the REST audience fields. Explicit audience references guide grounding while the project description remains available as context. Omit audience references to infer them with Workers AI when you have chosen to share the description for remote processing; this is supported by the default AI-enabled development command.

Reading a file stays local. `design_project` submits its text to the configured QlooVibe service as `project`; for a document it also supplies only the basename as `source_name`. It sends no absolute filesystem paths and never writes project files.

### File boundaries

Reads accept `.md`, `.markdown` and `.txt` files inside the selected root. Absolute paths, drive-relative paths, traversal, hidden paths, conventional secret filenames and symlink escapes are rejected. Dependency, generated, data and capture directories are excluded. A document must be UTF-8 plain text, at most 8000 characters and 32,768 bytes; oversized files are rejected rather than silently truncated.

Discovery scans at most 2000 directory entries, four directory levels and 100 files. It skips directory links and excluded paths. A truncated list is not a complete inventory; a known permitted document can still be read by relative path.

### Choosing a remote service

Project submission to a non-local URL is disabled by default, even if `QLOOVIBE_URL` names a remote host. After deciding that a brief may be shared with the selected service, explicitly enable remote submission in the launcher:

```sh
node scripts/qloovibe-mcp.mjs --project-root "/absolute/path/to/the-project" --url "https://qloovibe.ibnweb3lab.workers.dev" --allow-remote-projects
```

This enables submission only when `design_project` is called; starting the server and listing or reading documents do not upload them. The public service receives the selected text and may process it with Workers AI to infer audience references. Audience names are sent to Qloo. Saved briefs contain a short project excerpt and expire after seven days. Do not select documents containing confidential information you have not chosen to share. Filename checks cannot detect secrets embedded in an otherwise ordinary brief.

HTTPS is required for remote URLs. Plain HTTP is accepted only for `localhost`, `127.0.0.1` and `::1`. Redirects are not followed.

## Remote MCP when the host already reads files

Connect the coding agent to the QlooVibe Worker's Streamable HTTP endpoint, `/mcp`. For the current source use `http://localhost:8787/mcp`; a deployed host exposes the same path. The published service runs its last deployed version.

The host agent reads the user-selected project document using its own file tools, then passes the actual content:

```json
{
  "project_markdown": "# Music discovery app\nBuild for young listeners in Lagos, with artist profiles and local events…",
  "source_name": "design.md"
}
```

Call `design_brief` with that object. For a description use `{"project":"…"}` instead. A path such as `C:/Projects/app/design.md` is not Markdown content, and the hosted service cannot open it. Choose which text to share with a remote host before making the call.

The remote server also exposes a `design_project` prompt and the `qloovibe://workflow/project-design` resource describing the workflow. Its tools include `design_brief`, `check_audience_fit` and `get_rule_table`.

## Choose and apply a direction

1. Read the relevant project brief or accept the user's description.
2. Generate directions and explain the resolved audience, assumptions, defaults and missing evidence.
3. Present each returned direction's `name`, `fonts`, `tokens.palette`, `rationale` and `project_fit`. There can be fewer than three supported directions.
4. Ask the user which option to use. Keep the returned result and locate that item in `directions` by `id`; selection needs no new provider call.
5. Use that item's `agent_brief`, `tokens.css_qv` or `tokens.css_shadcn` when implementation is requested. Follow its font-loading guidance and preserve the project's functional and accessibility requirements.

`selected_direction_id` initially identifies the first direction. Top-level `tokens` and `agent_brief` preserve compatibility with older clients and also refer to that initial direction. They do not change when your agent records a different user choice; use the chosen array item.

Qloo supplies audience relationships and design descriptors. QlooVibe's published rules and direction lenses supply the token interpretations and named font recommendations. The returned alternatives are design suggestions, not evidence that one design will perform better. `insufficient_evidence` means there is no supported brief to implement.

## Verify the bridge

```sh
npm run test:mcp
node scripts/qloovibe-mcp.mjs --help
```

The tests exercise real temporary files, traversal and secret-path rejection, directory-link escapes, size limits, bounded discovery, a local HTTP API, and an MCP client connected to the launched stdio process. They do not submit documents to an external service.
