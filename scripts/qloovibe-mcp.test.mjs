import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { DEFAULT_URL, MAX_DOCUMENT_BYTES, designProject, listProjectMarkdown, parseArguments, readProjectMarkdown, serviceUrl } from "./qloovibe-mcp.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const brief = "# Project\nBuild an accessible music discovery app for young listeners in Lagos.\n";

async function fixture(t) {
  const base = await mkdtemp(path.join(here, ".mcp-test-"));
  assert.ok(path.isAbsolute(base) && base.startsWith(path.join(here, ".mcp-test-")));
  t.after(async () => { await rm(base, { recursive: true, force: true }); });
  const root = path.join(base, "project"), outside = path.join(base, "outside");
  await mkdir(path.join(root, "docs"), { recursive: true });
  await mkdir(outside);
  await writeFile(path.join(root, "docs/design.md"), brief);
  return { root, outside };
}

async function api(t, responder) {
  const server = createServer(responder);
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  return `http://127.0.0.1:${server.address().port}`;
}

test("reads the complete selected UTF-8 document with only its relative filename", async (t) => {
  const { root } = await fixture(t);
  assert.deepEqual(await readProjectMarkdown(root, "docs/design.md"), { path: "docs/design.md", content: brief });
  await writeFile(path.join(root, "docs/design-tokens.txt"), "🙂".repeat(4000));
  assert.equal((await readProjectMarkdown(root, "docs/design-tokens.txt")).content.length, 8000);
});

test("rejects absolute, drive-relative, traversal and alternate-stream paths", async (t) => {
  const { root } = await fixture(t);
  for (const filename of [path.join(root, "docs/design.md"), "/etc/project.md", "C:\\project\\design.md", "C:design.md", "../outside/design.md", "docs/../docs/design.md", "docs\\..\\design.md", "docs/design.md:private", "docs/design.md\0"]) {
    await assert.rejects(readProjectMarkdown(root, filename), undefined, filename);
  }
});

test("rejects protected directories and conventional secret filenames", async (t) => {
  const { root } = await fixture(t);
  for (const filename of [".env", ".env.md", ".git/config.md", ".codex/notes.md", ".aws/profile.txt", "node_modules/design.md", "data/design.md", "secrets.md", "docs/api-key-notes.txt", "credentials.markdown", "id_rsa.txt", "README.json"]) {
    await assert.rejects(readProjectMarkdown(root, filename), undefined, filename);
  }
});

test("rejects directories, malformed UTF-8, binary data and both size limits", async (t) => {
  const { root } = await fixture(t);
  await mkdir(path.join(root, "folder.md"));
  await assert.rejects(readProjectMarkdown(root, "folder.md"), /regular/);
  await writeFile(path.join(root, "large.md"), "a".repeat(8001));
  await assert.rejects(readProjectMarkdown(root, "large.md"), /8000 characters/);
  await writeFile(path.join(root, "huge.md"), Buffer.alloc(MAX_DOCUMENT_BYTES + 1));
  await assert.rejects(readProjectMarkdown(root, "huge.md"), /32768 bytes/);
  await writeFile(path.join(root, "invalid.md"), Buffer.from([0xff, 0xfe]));
  await assert.rejects(readProjectMarkdown(root, "invalid.md"), /UTF-8/);
  await writeFile(path.join(root, "binary.txt"), "text\0hidden");
  await assert.rejects(readProjectMarkdown(root, "binary.txt"), /plain text/);
});

test("rejects an outside directory link and an alias into a protected directory", async (t) => {
  const { root, outside } = await fixture(t);
  await writeFile(path.join(outside, "design.md"), "Private outside data");
  await mkdir(path.join(root, "secrets"));
  await writeFile(path.join(root, "secrets/design.md"), "Private inside data");
  const kind = process.platform === "win32" ? "junction" : "dir";
  await symlink(outside, path.join(root, "outside-alias"), kind);
  await symlink(path.join(root, "secrets"), path.join(root, "innocent-alias"), kind);
  await assert.rejects(readProjectMarkdown(root, "outside-alias/design.md"), /inside/);
  await assert.rejects(readProjectMarkdown(root, "innocent-alias/design.md"), /protected/);
  const listing = await listProjectMarkdown(root);
  assert.deepEqual(listing.files, ["docs/design.md"]);
});

test("lists documents without reading generated or protected trees", async (t) => {
  const { root } = await fixture(t);
  for (const directory of ["node_modules", ".git", "data", "build"]) {
    await mkdir(path.join(root, directory));
    await writeFile(path.join(root, directory, "design.md"), brief);
  }
  await writeFile(path.join(root, "secrets.md"), brief);
  await writeFile(path.join(root, "README.markdown"), brief);
  assert.deepEqual((await listProjectMarkdown(root)).files, ["README.markdown", "docs/design.md"]);
});

test("caps discovery at 100 files and four directory levels", async (t) => {
  const { root } = await fixture(t);
  for (let i = 0; i < 105; i++) await writeFile(path.join(root, `brief-${i}.md`), brief);
  const listing = await listProjectMarkdown(root);
  assert.equal(listing.files.length, 100);
  assert.equal(listing.truncated, true);
  const { root: deepRoot } = await fixture(t);
  await mkdir(path.join(deepRoot, "one/two/three/four/five"), { recursive: true });
  await writeFile(path.join(deepRoot, "one/two/three/four/five/brief.md"), brief);
  const deep = await listProjectMarkdown(deepRoot);
  assert.equal(deep.files.includes("one/two/three/four/five/brief.md"), false);
  assert.equal(deep.truncated, true);
});

test("launcher defaults to local service and requires an explicit remote opt-in", async () => {
  assert.deepEqual(parseArguments([], {}, "/selected/project"), { root: "/selected/project", url: DEFAULT_URL, allowRemoteProjects: false, help: false });
  const configured = parseArguments(["--project-root", "/chosen", "--url", "https://example.com", "--allow-remote-projects"], {}, "/default");
  assert.equal(configured.root, "/chosen");
  assert.equal(configured.allowRemoteProjects, true);
  await assert.rejects(designProject("unread-project", { markdown_path: "design.md" }, "https://example.com"), /Remote project submission is disabled/);
  assert.throws(() => parseArguments(["--project-root"], {}), /needs a value/);
  assert.throws(() => serviceUrl("http://example.com"), /HTTPS/);
  assert.throws(() => serviceUrl("https://user:password@example.com"), /credentials/);
  assert.throws(() => serviceUrl("https://example.com?private=value"), /query/);
});

test("submits selected Markdown text to the local API, preserves options and leaves files unchanged", async (t) => {
  const { root } = await fixture(t);
  const result = { status: "complete", selected_direction_id: "calm", directions: [{ id: "calm", agent_brief: "Use calm tokens" }, { id: "bold", agent_brief: "Use bold tokens" }] };
  let received;
  const url = await api(t, async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    received = { path: request.url, body: JSON.parse(Buffer.concat(chunks).toString()) };
    response.setHeader("content-type", "application/json"); response.end(JSON.stringify(result));
  });
  const output = await designProject(root, { markdown_path: "docs/design.md", seeds: ["Burna Boy", "Nike"], fresh: true }, url);
  assert.deepEqual(received, { path: "/api/vibe", body: { project: brief, source_name: "design.md", seeds: ["Burna Boy", "Nike"], fresh: true } });
  assert.equal(JSON.stringify(received).includes(root), false);
  assert.deepEqual(output, result);
  assert.equal(await readFile(path.join(root, "docs/design.md"), "utf8"), brief);
  await assert.rejects(designProject(root, { markdown_path: "docs/design.md", project_description: brief }, url), /exactly one/);
});

test("preserves service errors and never follows an API redirect", async (t) => {
  let requests = 0;
  const url = await api(t, (_request, response) => {
    requests++;
    response.writeHead(429, { "content-type": "application/json", "retry-after": "60" });
    response.end(JSON.stringify({ error: { message: "Rate limit" } }));
  });
  await assert.rejects(designProject("unused", { project_description: brief }, url), /HTTP 429: Rate limit.*Wait/);
  assert.equal(requests, 1);
  const redirect = await api(t, (_request, response) => { response.writeHead(302, { location: url }); response.end(); });
  await assert.rejects(designProject("unused", { project_description: brief }, redirect));
  assert.equal(requests, 1);
});

test("stdio MCP client discovers tools and reads a scoped file through the launched process", async (t) => {
  const { root } = await fixture(t);
  let submitted;
  const directions = { status: "complete", directions: [{ id: "quiet", agent_brief: "Quiet direction" }, { id: "expressive", agent_brief: "Expressive direction" }], selected_direction_id: "quiet" };
  const url = await api(t, async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    submitted = JSON.parse(Buffer.concat(chunks).toString());
    response.setHeader("content-type", "application/json"); response.end(JSON.stringify(directions));
  });
  const require = createRequire(new URL("../worker/package.json", import.meta.url));
  const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(here, "qloovibe-mcp.mjs"), "--project-root", root, "--url", url], stderr: "pipe" });
  const client = new Client({ name: "qloovibe-test", version: "1.0.0" });
  t.after(async () => { await client.close(); });
  await client.connect(transport);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name).sort(), ["design_project", "list_project_markdown", "read_project_markdown"]);
  const read = await client.callTool({ name: "read_project_markdown", arguments: { path: "docs/design.md" } });
  assert.deepEqual(JSON.parse(read.content[0].text), { path: "docs/design.md", content: brief });
  const denied = await client.callTool({ name: "read_project_markdown", arguments: { path: "../outside/brief.md" } });
  assert.equal(denied.isError, true);
  assert.equal(denied.content[0].text.includes(root), false);
  const designed = await client.callTool({ name: "design_project", arguments: { markdown_path: "docs/design.md" } });
  assert.deepEqual(submitted, { project: brief, source_name: "design.md" });
  assert.deepEqual(JSON.parse(designed.content[0].text), directions);
  assert.equal(await readFile(path.join(root, "docs/design.md"), "utf8"), brief);
});
