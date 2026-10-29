// Execute the real page script against a small DOM stand-in. All responses are synthetic;
// these are flow regressions, not a substitute for browser layout/accessibility testing.
import { describe, expect, it, vi } from "vitest";
import { makeSvc } from "./helpers";
import { parseSeeds } from "../src/vibe";

// The Worker intentionally has no Node typings. Vitest supplies these built-in modules.
const runtimeModules = ["node:fs", "node:vm"];
const { readFileSync } = await import(runtimeModules[0]!);
const { runInNewContext } = await import(runtimeModules[1]!);
const page: string = readFileSync(new URL("../public/index.html", (import.meta as { url: string }).url), "utf8");
const script = page.match(/<script>([\s\S]*?)<\/script>/)?.[1];
if (!script) throw new Error("The page's executable script was not found");

type Handler = (event: { preventDefault(): void; key?: string }) => unknown;
class Element {
  nodeType = 1;
  children: Element[] = [];
  parentElement: Element | null = null;
  attributes = new Map<string, string>();
  listeners = new Map<string, Handler[]>();
  value = "";
  hidden = false;
  disabled = false;
  open = false;
  className = "";
  tabIndex = 0;
  selected = false;
  files: { name: string; size: number; text(): Promise<string> }[] = [];
  private text = "";
  style = { cssText: "", values: new Map<string, string>(), setProperty(name: string, value: string) { this.values.set(name, value); } };
  constructor(readonly tagName: string, private document: TestDocument) {}
  get textContent(): string { return this.text + this.children.map((child) => child.textContent).join(""); }
  set textContent(value: string) { this.text = String(value); this.children = []; }
  setAttribute(name: string, value: string) {
    this.attributes.set(name, String(value));
    if (name === "hidden") this.hidden = true;
    if (name === "open") this.open = true;
    if (name === "class") this.className = value;
  }
  getAttribute(name: string) { return name === "class" ? this.className || null : this.attributes.get(name) ?? null; }
  append(...nodes: unknown[]) {
    for (const value of nodes) {
      const node = value instanceof Element ? value : this.document.createTextNode(String(value));
      node.parentElement = this; this.children.push(node);
    }
  }
  replaceChildren(...nodes: (Element | string)[]) { this.children = []; this.text = ""; this.append(...nodes); }
  addEventListener(type: string, handler: Handler) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), handler]); }
  async dispatch(type: string, key?: string) {
    if (type === "click" && this.disabled) return;
    await Promise.all((this.listeners.get(type) ?? []).map((handler) => handler({ preventDefault() {}, key })));
  }
  click() {
    if (this.tagName === "a" && this.getAttribute("download")) this.document.downloads.push({ href: this.getAttribute("href")!, filename: this.getAttribute("download")! });
    return this.dispatch("click");
  }
  focus() { this.document.activeElement = this; }
  scrollIntoView() {}
  select() { this.selected = true; }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter((node) => node !== this); }
  querySelector(selector: string) { return this.querySelectorAll(selector)[0] ?? null; }
  querySelectorAll(selector: string): Element[] {
    const pieces = selector.split(/\s+/);
    let roots: Element[] = [this];
    for (const piece of pieces) {
      roots = roots.flatMap((root) => {
        const found: Element[] = [];
        const walk = (node: Element) => { for (const child of node.children) { if (matches(child, piece)) found.push(child); walk(child); } };
        walk(root); return found;
      });
    }
    return roots;
  }
}
function matches(element: Element, selector: string) {
  if (selector.startsWith("#")) return element.getAttribute("id") === selector.slice(1);
  const attribute = selector.match(/^\[([\w-]+)=([^\]]+)\]$/);
  if (attribute) return element.getAttribute(attribute[1]!) === attribute[2]!.replace(/^['"]|['"]$/g, "");
  if (/^[a-z]+$/i.test(selector)) return element.tagName === selector.toLowerCase();
  throw new Error(`DOM stand-in does not implement selector ${selector}`);
}
class TestDocument {
  body = new Element("body", this);
  activeElement: Element | null = null;
  downloads: { href: string; filename: string }[] = [];
  createElement(tag: string) { return new Element(tag, this); }
  createTextNode(value: string) { const node = new Element("#text", this); node.nodeType = 3; node.textContent = value; return node; }
  querySelector(selector: string) { return this.body.querySelector(selector); }
  querySelectorAll(selector: string) { return this.body.querySelectorAll(selector); }
  constructor() {
    // Only static elements addressed by the script need loading. Generated trees use
    // actual parent/child relationships, including forms and downloadable controls.
    const body = page.slice(page.indexOf("<body>"), page.indexOf("<script>"));
    for (const match of body.matchAll(/<([a-z][\w-]*)\b([^>]*)>/gi)) {
      if (!/\bid="/.test(match[2]!)) continue;
      const node = this.createElement(match[1]!);
      for (const attr of match[2]!.matchAll(/([\w-]+)(?:="([^"]*)")?/g)) node.setAttribute(attr[1]!, attr[2] ?? "");
      this.body.append(node);
    }
  }
}
type RequestOptions = { method?: string; body?: string; signal?: AbortSignal };
type Responder = (url: string, options: RequestOptions) => Promise<Response> | Response;
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function harness(responder: Responder = () => response({}), settings: { origin?: string; health?: Responder } = {}) {
  const document = new TestDocument(), clipboard = vi.fn(async (_text: string) => {});
  const pendingTimers = new Map<number, { callback: () => void; delay: number }>(); let nextTimer = 0;
  const timer = (callback: () => void, delay = 0) => { pendingTimers.set(++nextTimer, { callback, delay }); return nextTimer; };
  const blobs = new Map<string, Blob>();
  const objectURLs = {
    createObjectURL: vi.fn((blob: Blob) => { const url = `blob:synthetic-test-${blobs.size}`; blobs.set(url, blob); return url; }),
    revokeObjectURL: vi.fn((_url: string) => {}),
  };
  const fetch = vi.fn(async (url: string, options: RequestOptions = {}) => {
    if (url === "/health") return settings.health ? settings.health(url, options) : response({ qloo_configured: true, ai_configured: true });
    if (url === "/api/rules") return response({ version: "qv-rules-test" });
    return responder(url, options);
  });
  const app = runInNewContext(script + "\n;({ run, loadBench, parseNames, setInputMode, readProjectFile, selectDirection, state });", {
    document, fetch, navigator: { clipboard: { writeText: clipboard } }, location: new URL(settings.origin ?? "https://qloovibe.test"),
    AbortController, Error, TypeError, Blob, URL: objectURLs, performance,
    setTimeout: timer, setInterval: timer, clearTimeout: (id: number) => pendingTimers.delete(id), clearInterval: (id: number) => pendingTimers.delete(id),
  });
  const el = (id: string) => { const node = document.querySelector("#" + id); if (!node) throw new Error(`Missing #${id}`); return node; };
  const posts = () => fetch.mock.calls.filter(([, options]) => options?.method === "POST");
  return { app, el, fetch, posts, document, clipboard, pendingTimers, blobs, objectURLs };
}

async function fixture() {
  const { svc } = makeSvc();
  return svc.generate({ audience: "Slowdive, Aesop", seeds: ["Slowdive", "Aesop"] });
}
const button = (root: Element, label: string) => {
  const found = root.querySelectorAll("button").find((node) => node.textContent === label);
  if (!found) throw new Error(`Missing button '${label}'`); return found;
};

describe("consumer page flows (real inline script, synthetic responses)", () => {
  it("explains how to start the Worker when a local static server returns HTML for the API", async () => {
    const html = (status: number) => new Response("<!doctype html><title>Error response</title><p>File not found</p>", { status, headers: { "content-type": "text/html; charset=utf-8" } });
    const ui = harness(() => html(501), { origin: "http://localhost:8799", health: () => html(404) });
    await vi.waitFor(() => expect(ui.el("health").textContent).toBe("Worker server required"));
    expect(ui.el("status").textContent).toContain("npm run dev");
    expect(ui.el("status").textContent).toContain("http://localhost:8787");
    await ui.app.run("Slowdive", "audience");
    expect(ui.el("status").textContent).toContain("static files without the API");
    expect(ui.el("out").hidden).toBe(true);
    expect(ui.el("go").disabled).toBe(false);
    expect(ui.el("aud").disabled).toBe(false);
  });

  it("keeps production HTML failures generic instead of suggesting a local development command", async () => {
    const ui = harness(() => new Response("<!doctype html><title>Unavailable</title>", { status: 404, headers: { "content-type": "text/html" } }));
    await ui.app.run("Slowdive", "audience");
    expect(ui.el("status").textContent).toContain("unreadable response");
    expect(ui.el("status").textContent).not.toContain("npm run dev");
    expect(ui.el("out").hidden).toBe(true);
  });

  it("starts with project context, and both kinds of example only fill their input", async () => {
    const ui = harness();
    expect(ui.posts()).toHaveLength(0);
    expect(ui.el("out").hidden).toBe(true);
    expect(ui.app.state.mode).toBe("project");
    expect(ui.el("project").value).toBe("");
    expect(ui.el("project-fields").hidden).toBe(false);
    expect(ui.el("audience-fields").hidden).toBe(true);
    await button(ui.el("chips"), "Independent bookshop").click();
    expect(ui.el("project").value).toContain("independent bookshop");
    expect(ui.document.activeElement).toBe(ui.el("project"));
    expect(ui.posts()).toHaveLength(0);
    await ui.el("mode-audience").click();
    await button(ui.el("chips"), "Slowdive, Aesop, A24").click();
    expect(ui.el("aud").value).toBe("Slowdive, Aesop, A24");
    expect(ui.document.activeElement).toBe(ui.el("aud"));
    expect(ui.posts()).toHaveLength(0);
  });

  it("submits project text explicitly without guessing whether prose contains audience names", async () => {
    const ui = harness(() => response({ status: "insufficient_evidence", caveats: ["No supported audience was found."] }));
    const project = "Minimal bookshop website";
    ui.el("project").value = project;
    await ui.el("ask").dispatch("submit");
    expect(JSON.parse(ui.posts()[0]![1]!.body!)).toEqual({ project });
    expect(ui.el("out").hidden).toBe(true);
    expect(ui.el("project").disabled).toBe(false);
    expect(ui.el("aud").disabled).toBe(true);
  });

  it("reads a Markdown file for review and submits its full text with source context only on request", async () => {
    const ui = harness(() => response({ status: "insufficient_evidence", caveats: ["Synthetic fixture has no evidence."] }));
    const text = "# Bookshop\n\nA welcoming store for curious readers, with local events and considered recommendations.";
    ui.el("project-file").files = [{ name: "design.md", size: text.length, text: async () => text }];
    await ui.el("project-file").dispatch("change");
    expect(ui.el("project").value).toBe(text);
    expect(ui.el("file-context").textContent).toContain("design.md");
    expect(ui.el("clear-file").hidden).toBe(false);
    expect(ui.posts()).toHaveLength(0);
    await ui.el("ask").dispatch("submit");
    expect(JSON.parse(ui.posts()[0]![1]!.body!)).toEqual({ project: text, source_name: "design.md" });
    await ui.el("clear-file").click();
    expect(ui.el("project").value).toBe(text);
    expect(ui.app.state.sourceName).toBeNull();
  });

  it("rejects oversized or unreadable files without truncating or replacing the reviewed text", async () => {
    const ui = harness();
    ui.el("project").value = "A previously reviewed project description.";
    const huge = "A".repeat(8001);
    await ui.app.readProjectFile({ name: "large.md", size: huge.length, text: async () => huge });
    expect(ui.el("status").textContent).toContain("no text has been truncated");
    expect(ui.el("project").value).toBe("A previously reviewed project description.");
    await ui.app.readProjectFile({ name: "design.md", size: 50, text: async () => { throw new Error("Unable to read file"); } });
    expect(ui.el("status").textContent).toContain("Unable to read file");
    expect(ui.el("go").disabled).toBe(false);
    expect(ui.el("project-file").disabled).toBe(false);
    await ui.app.run("Too short");
    expect(ui.el("status").textContent).toContain("20–8,000 characters");
    expect(ui.posts()).toHaveLength(0);
  });

  it("rejects binary or incorrectly encoded files while keeping reviewed project text", async () => {
    const ui = harness();
    const reviewed = "An independent bookshop website with local events.";
    ui.el("project").value = reviewed;
    for (const text of ["Binary project content\u0000must not be submitted", "Invalidly decoded project \ufffd content"]) {
      await ui.app.readProjectFile({ name: "project.txt", size: text.length, text: async () => text });
      expect(ui.el("status").textContent).toContain("UTF-8 text");
      expect(ui.el("project").value).toBe(reviewed);
      expect(ui.el("go").disabled).toBe(false);
      expect(ui.posts()).toHaveLength(0);
    }
  });

  it("explains missing AI configuration and keeps direct audience mode usable", async () => {
    const ui = harness(() => response({ status: "insufficient_evidence", caveats: [] }), { health: () => response({ qloo_configured: true, ai_configured: false }) });
    await vi.waitFor(() => expect(ui.el("configuration-warning").textContent).toContain("Use audience references"));
    expect(ui.el("configuration-warning").hidden).toBe(false);
    expect(ui.el("go").disabled).toBe(true);
    await ui.app.run("A useful website for an independent bookshop.");
    expect(ui.posts()).toHaveLength(0);
    await ui.el("mode-audience").click();
    expect(ui.el("configuration-warning").hidden).toBe(true);
    expect(ui.el("go").disabled).toBe(false);
    ui.el("aud").value = "Slowdive, Aesop";
    await ui.el("ask").dispatch("submit");
    expect(JSON.parse(ui.posts()[0]![1]!.body!).seeds).toEqual(["Slowdive", "Aesop"]);
  });

  it("renders an actual generated brief, supports tabs and copies the actual CSS", async () => {
    const vibe = { ...await fixture(), caveats: [] }, ui = harness(() => response(vibe));
    await ui.app.run("Slowdive, Aesop", "audience");
    expect(ui.el("out").hidden, ui.el("status").textContent).toBe(false);
    expect(ui.el("result-head").textContent).toContain("Slowdive");
    expect(ui.el("result-head").textContent).not.toContain("null");
    expect(ui.el("p-preview").textContent).toContain(vibe.tokens.palette.hex.accent);
    expect(ui.el("p-tokens").textContent).toContain(vibe.agent_brief);
    expect(ui.el("p-vocab").textContent).toContain("Minimalist");
    expect(ui.el("go").disabled).toBe(false);
    expect(JSON.parse(ui.posts()[0]![1]!.body!)).toEqual({ audience: "Slowdive, Aesop", seeds: ["Slowdive", "Aesop"] });
    await ui.el("t-tokens").click();
    expect(ui.el("p-preview").hidden).toBe(true);
    expect(ui.el("p-tokens").hidden).toBe(false);
    await button(ui.el("p-tokens"), "Copy CSS").click();
    expect(ui.clipboard).toHaveBeenCalledWith(vibe.tokens.css_qv);
  });

  it("switches actual preview values and every export to the selected evidence-backed direction", async () => {
    const vibe = await fixture(), ui = harness(() => response(vibe));
    expect(vibe.directions.length).toBeGreaterThan(1);
    await ui.app.run("Slowdive, Aesop", "audience");
    const selected = vibe.directions[1];
    const choose = ui.el("direction-picker").querySelectorAll("button").find((node) => node.getAttribute("data-direction-id") === selected.id)!;
    await choose.click();
    expect(choose.getAttribute("aria-pressed")).toBe("true");
    expect(ui.app.state.selectedDirection).toBe(selected.id);
    expect(ui.el("p-preview").textContent).toContain(selected.fonts.display.name);
    expect(ui.el("p-preview").textContent).toContain(selected.tokens.palette.hex.accent);
    const specimen = ui.el("p-preview").querySelector("[class=specimen]")!;
    expect(specimen.style.values.get("--qv-font-display")).toBe(selected.fonts.display.stack);
    expect(ui.el("selected-direction-status").textContent).toContain(selected.name + " selected");
    await button(ui.el("p-tokens"), "Copy CSS").click();
    expect(ui.clipboard).toHaveBeenLastCalledWith(selected.tokens.css_qv);
    await button(ui.el("p-tokens"), "Copy design brief").click();
    expect(ui.clipboard).toHaveBeenLastCalledWith(selected.agent_brief);
    await button(ui.el("p-preview"), "Copy design brief").click();
    expect(ui.clipboard).toHaveBeenLastCalledWith(selected.agent_brief);
    await button(ui.el("p-tokens"), "Download CSS").click();
    await button(ui.el("p-tokens"), "Download brief (.md)").click();
    expect(await ui.blobs.get(ui.document.downloads[0]!.href)!.text()).toBe(selected.tokens.css_qv);
    expect(await ui.blobs.get(ui.document.downloads[1]!.href)!.text()).toBe(selected.agent_brief);
    expect(vibe.tokens.css_qv).toBe(vibe.directions[0].tokens.css_qv);
    expect(ui.el("p-vocab").textContent).toContain("Minimalist");
  });

  it("clears a previous result before a failing request and releases every control", async () => {
    const vibe = await fixture(); let attempt = 0;
    const ui = harness(() => ++attempt === 1 ? response(vibe) : response({ error: { message: "Provider down" } }, 503));
    await ui.app.run("Slowdive, Aesop", "audience");
    const next = ui.app.run("Metallica", "audience");
    // No previous audience content or imitation result is shown while waiting.
    for (const id of ["result-head", "p-preview", "p-tokens", "p-vocab", "p-critic", "p-audit"]) expect(ui.el(id).textContent).toBe("");
    expect(ui.el("t-audit").disabled).toBe(true);
    expect(ui.app.state.vibe).toBeNull();
    await next;
    expect(ui.el("out").hidden).toBe(true);
    expect(ui.el("status").textContent).toContain("try again");
    expect(ui.el("go").disabled).toBe(false);
    expect(ui.el("aud").disabled).toBe(false);
    expect(ui.el("cancel").hidden).toBe(true);
    expect(ui.el("chips").querySelectorAll("button").every((node) => !node.disabled)).toBe(true);
  });

  it("keeps a usable brief when replacement input fails validation", async () => {
    const vibe = await fixture(), ui = harness(() => response(vibe));
    await ui.app.run("Slowdive, Aesop", "audience");
    const preview = ui.el("p-preview").textContent;
    await ui.app.run("Slowdive,,Aesop", "audience");
    expect(ui.posts()).toHaveLength(1);
    expect(ui.el("out").hidden).toBe(false);
    expect(ui.el("p-preview").textContent).toBe(preview);
    expect(ui.app.state.vibe).not.toBeNull();
    expect(ui.document.activeElement).toBe(ui.el("aud"));
    await ui.app.run("Too short", "project");
    expect(ui.posts()).toHaveLength(1);
    expect(ui.el("out").hidden).toBe(false);
    expect(ui.el("p-preview").textContent).toBe(preview);
    expect(ui.document.activeElement).toBe(ui.el("project"));
  });

  it("blocks generation while known unavailable and leaves the inputs usable", async () => {
    const ui = harness(() => response({}), { health: () => response({ qloo_configured: false, ai_configured: true }) });
    await vi.waitFor(() => expect(ui.el("configuration-warning").hidden).toBe(false));
    expect(ui.el("go").disabled).toBe(true);
    expect(ui.el("project").disabled).toBe(false);
    await ui.app.run("An independent bookshop for curious local readers.");
    expect(ui.posts()).toHaveLength(0);
    expect(ui.el("status").textContent).toContain("temporarily unavailable");
    expect(ui.el("cancel").hidden).toBe(true);
  });

  it("retains reviewed audit code and cancels the previous direction's audit on selection", async () => {
    const vibe = await fixture(); let auditSignal: AbortSignal | undefined;
    const ui = harness((url, options) => {
      if (url === "/api/vibe") return response(vibe);
      auditSignal = options.signal;
      return new Promise((_resolve, reject) => options.signal!.addEventListener("abort", () => {
        const error = new Error("Aborted"); error.name = "AbortError"; reject(error);
      }));
    });
    await ui.app.run("Slowdive, Aesop", "audience");
    const code = "body { background: #ffffff; color: #111111; }";
    ui.el("audit-code").value = code;
    const pending = ui.el("p-audit").querySelector("form")!.dispatch("submit");
    expect(auditSignal?.aborted).toBe(false);
    const next = vibe.directions[1];
    await ui.el("direction-picker").querySelectorAll("button").find((node) => node.getAttribute("data-direction-id") === next.id)!.click();
    await pending;
    expect(auditSignal?.aborted).toBe(true);
    expect(ui.app.state.audit).toBeNull();
    expect(ui.el("audit-code").value).toBe(code);
    expect(ui.el("audit-code").disabled).toBe(false);
    expect(ui.el("p-audit").textContent).toContain(next.name);
    expect(ui.el("audit-res").textContent).toBe("");
  });

  it("cancels a running audit, prevents duplicate submission and keeps the reviewed code", async () => {
    const vibe = await fixture();
    const ui = harness((url, options) => url === "/api/vibe" ? response(vibe) : new Promise((_resolve, reject) => options.signal!.addEventListener("abort", () => {
      const error = new Error("Aborted"); error.name = "AbortError"; reject(error);
    })));
    await ui.app.run("Slowdive, Aesop", "audience");
    ui.el("audit-code").value = "body { background: #ffffff; color: #111111; }";
    const form = ui.el("p-audit").querySelector("form")!;
    const pending = form.dispatch("submit");
    await form.dispatch("submit");
    expect(ui.posts().filter(([url]) => url === "/api/audit")).toHaveLength(1);
    await button(ui.el("p-audit"), "Cancel audit").click(); await pending;
    expect(ui.el("p-audit").textContent).toContain("canceled");
    expect(ui.el("audit-code").value).toContain("background: #ffffff");
    expect(ui.el("audit-code").disabled).toBe(false);
    expect(button(ui.el("p-audit"), "Audit my build").disabled).toBe(false);
  });

  it("does not certify unexamined audit checks as following the direction", async () => {
    const vibe = await fixture();
    const ui = harness((url) => url === "/api/vibe" ? response(vibe) : response({ status: "pass", summary: "No failures found in this snippet.", checks: [{ result: "not_applicable", label: "No font declarations in this snippet" }], findings: [], limits: "Checks only the submitted code." }));
    await ui.app.run("Slowdive, Aesop", "audience");
    ui.el("audit-code").value = "<main><p>An independent bookshop.</p></main>";
    await ui.el("p-audit").querySelector("form")!.dispatch("submit");
    expect(ui.el("audit-res").textContent).toContain("No failures found");
    expect(ui.el("audit-res").textContent).toContain("Not checked");
    expect(ui.el("audit-res").textContent).not.toContain("Follows this direction");
  });

  it("cancels an outstanding request and returns the form to an editable state", async () => {
    const ui = harness((_url, options) => new Promise((_resolve, reject) => {
      options.signal!.addEventListener("abort", () => { const error = new Error("Aborted"); error.name = "AbortError"; reject(error); });
    }));
    const pending = ui.app.run("Slowdive", "audience");
    expect(ui.el("go").disabled).toBe(true);
    expect(ui.el("cancel").hidden).toBe(false);
    await ui.el("cancel").click(); await pending;
    expect(ui.el("status").textContent).toContain("canceled");
    expect(ui.el("aud").disabled).toBe(false);
    expect(ui.el("go").disabled).toBe(false);
    expect(ui.app.state.request).toBeNull();
  });

  it("times out an unresponsive request and releases the form for another attempt", async () => {
    const ui = harness((_url, options) => new Promise((_resolve, reject) => {
      options.signal!.addEventListener("abort", () => { const error = new Error("Aborted"); error.name = "AbortError"; reject(error); });
    }));
    const pending = ui.app.run("Slowdive", "audience");
    const timeout = [...ui.pendingTimers.values()].filter((timer) => timer.delay === 60000).at(-1);
    expect(timeout).toBeDefined(); timeout!.callback(); await pending;
    expect(ui.el("status").textContent).toContain("taking too long");
    expect(ui.el("out").hidden).toBe(true);
    expect(ui.el("aud").disabled).toBe(false);
    expect(ui.el("go").disabled).toBe(false);
    expect(ui.el("cancel").hidden).toBe(true);
    expect(ui.app.state.request).toBeNull();
  });

  it("offers selectable original text when clipboard access is denied", async () => {
    const vibe = await fixture(), ui = harness(() => response(vibe));
    await ui.app.run("Slowdive, Aesop", "audience");
    ui.clipboard.mockRejectedValueOnce(new Error("Clipboard permission denied"));
    const copy = button(ui.el("p-tokens"), "Copy design brief");
    await copy.click();
    const fallback = ui.el("p-tokens").querySelector("textarea")!;
    expect(fallback.textContent).toBe(vibe.agent_brief);
    expect(fallback.getAttribute("readonly")).not.toBeNull();
    expect(fallback.selected).toBe(true);
    expect(ui.document.activeElement).toBe(fallback);
    expect(ui.el("p-tokens").textContent).toContain("Select and copy the text below");
    expect(copy.disabled).toBe(false);
  });

  it("downloads the generated CSS and brief as real file payloads", async () => {
    const vibe = await fixture(), ui = harness(() => response(vibe));
    await ui.app.run("Slowdive, Aesop", "audience");
    await button(ui.el("p-tokens"), "Download CSS").click();
    await button(ui.el("p-tokens"), "Download brief (.md)").click();
    const [css, brief] = ui.document.downloads;
    expect(css!.filename).toBe("qloovibe.css");
    expect(brief!.filename).toBe("qloovibe-brief.md");
    expect(await ui.blobs.get(css!.href)!.text()).toBe(vibe.tokens.css_qv);
    expect(ui.blobs.get(css!.href)!.type).toBe("text/css;charset=utf-8");
    expect(await ui.blobs.get(brief!.href)!.text()).toBe(vibe.agent_brief);
    expect(ui.blobs.get(brief!.href)!.type).toBe("text/markdown;charset=utf-8");
    for (const task of ui.pendingTimers.values()) if (task.delay === 1000) task.callback();
    expect(ui.objectURLs.revokeObjectURL).toHaveBeenCalledWith(css!.href);
    expect(ui.objectURLs.revokeObjectURL).toHaveBeenCalledWith(brief!.href);
  });

  it("explains missing reference scores and keeps the check form usable", async () => {
    const vibe = await fixture();
    const ui = harness((url) => url === "/api/vibe" ? response(vibe) : response({ status: "insufficient_evidence", results: [], caveats: ["Qloo could not match this name."] }));
    await ui.app.run("Slowdive, Aesop", "audience");
    ui.el("cands").value = "Unknown Reference";
    await ui.el("p-critic").querySelector("form")!.dispatch("submit");
    expect(ui.el("critres").textContent).toContain("No references could be scored");
    expect(ui.el("critres").textContent).toContain("Try an exact");
    expect(ui.el("critres").textContent).toContain("could not match");
    expect(ui.el("cands").disabled).toBe(false);
    expect(button(ui.el("p-critic"), "Check references").disabled).toBe(false);
  });

  it("lets people cancel an outstanding reference check and edit their references", async () => {
    const vibe = await fixture();
    const ui = harness((url, options) => url === "/api/vibe" ? response(vibe) : new Promise((_resolve, reject) => options.signal!.addEventListener("abort", () => {
      const error = new Error("Aborted"); error.name = "AbortError"; reject(error);
    })));
    await ui.app.run("Slowdive, Aesop", "audience");
    ui.el("cands").value = "Bon Iver";
    const pending = ui.el("p-critic").querySelector("form")!.dispatch("submit");
    await button(ui.el("p-critic"), "Cancel check").click(); await pending;
    expect(ui.el("p-critic").textContent).toContain("canceled");
    expect(ui.el("cands").value).toBe("Bon Iver");
    expect(ui.el("cands").disabled).toBe(false);
    expect(ui.app.state.critic).toBeNull();
  });

  it("preserves names containing commas when editing the proposed audience", async () => {
    const base = await fixture();
    const vibe = { ...base, audience: { ...base.audience, source: "model_suggested" }, seeds: base.seeds.map((seed: { query: string }, i: number) => i ? seed : { ...seed, query: "Earth, Wind & Fire" }) };
    const ui = harness(() => response(vibe));
    await ui.app.run("An independent record shop with local listening events.");
    await button(ui.el("result-head"), "Not right? Edit these names").click();
    expect(ui.app.state.mode).toBe("audience");
    expect([...ui.app.parseNames(ui.el("aud").value, 5, true)]).toEqual(vibe.seeds.map((seed: { query: string }) => seed.query));
    expect(ui.document.activeElement).toBe(ui.el("aud"));
  });

  it("rejects excess reference names instead of silently truncating them", async () => {
    const vibe = await fixture(), ui = harness(() => response(vibe));
    await ui.app.run("Slowdive", "audience");
    ui.el("cands").value = Array.from({ length: 13 }, (_, i) => `Reference ${i}`).join(", ");
    await ui.el("p-critic").querySelector("form")!.dispatch("submit");
    expect(ui.posts().filter(([url]) => url === "/api/check")).toHaveLength(0);
    expect(ui.el("p-critic").textContent).toContain("Enter 1–12 names");
    expect(ui.document.activeElement).toBe(ui.el("cands"));
  });

  it("preserves conjunctions and quoted commas in real audience and candidate names", async () => {
    const ui = harness(() => response({ status: "insufficient_evidence", caveats: ["Synthetic fixture has no audience data."] }));
    const input = 'Salt & Stone, Pride and Prejudice, "Earth, Wind & Fire", SALT & STONE';
    expect([...ui.app.parseNames(input, 5)]).toEqual(["Salt & Stone", "Pride and Prejudice", "Earth, Wind & Fire"]);
    expect([...ui.app.parseNames('fans of Slowdive, “Earth, Wind & Fire”, Pride and Prejudice', 5, true)]).toEqual(["Slowdive", "Earth, Wind & Fire", "Pride and Prejudice"]);
    await ui.app.run(input, "audience");
    expect(JSON.parse(ui.posts()[0]![1]!.body!).seeds).toEqual(["Salt & Stone", "Pride and Prejudice", "Earth, Wind & Fire"]);
    expect(() => ui.app.parseNames('"Earth, Wind & Fire', 5)).toThrow(/Close the quote/);
    expect(ui.el("out").hidden).toBe(true);
  });

  it("parses audience punctuation and quoted names consistently with the API", () => {
    const ui = harness();
    for (const input of [
      'fans of Slowdive, “Earth, Wind & Fire”, Salt & Stone',
      "people who love Florence + the Machine;Pride and Prejudice\r\nA24",
      "audience: ‘Earth, Wind & Fire’ (artist), D'Angelo",
      '"Say ""Hello""", Aesop',
    ]) expect([...ui.app.parseNames(input, 5, true)]).toEqual(parseSeeds(input));
    for (const input of ['Slowdive,,A24', '"Slowdive" and A24', '“Slowdive, A24', 'Slowdive,']) {
      expect(() => ui.app.parseNames(input, 5, true)).toThrow();
      expect(() => parseSeeds(input)).toThrow();
    }
    expect([...ui.app.parseNames("Fans of Film", 12)]).toEqual(["Fans of Film"]);
  });

  it("distinguishes an absent comparison from a server error and retries either", async () => {
    const benchmark = { generated_at: "2026-10-29", n_audiences: 2, model: "Synthetic test model", vocab_size: 10, summary: [{ label: "Repeatability", qloo: 1, llm: 0.8 }] };
    let attempt = 0;
    const ui = harness(() => ++attempt === 1 ? response({ error: {} }, 500) : attempt === 2 ? response({ error: {} }, 404) : response(benchmark));
    await ui.app.loadBench();
    expect(ui.el("bench-content").textContent).toContain("service is having trouble");
    expect(ui.el("bench-content").textContent).not.toContain("No recorded comparison");
    await button(ui.el("bench-content"), "Try loading again").click();
    expect(ui.el("bench-content").textContent).toContain("No recorded comparison is available yet");
    await button(ui.el("bench-content"), "Try loading again").click();
    expect(ui.el("bench-content").textContent).toContain("Repeatability");
    expect(ui.el("bench-content").textContent).toContain("does not measure");
    expect(ui.el("bench-content").textContent).not.toContain("null");
    expect(ui.el("bench-content").getAttribute("aria-busy")).toBe("false");
  });
});
