// Execute the real page script against a small DOM stand-in. All responses are synthetic;
// these are flow regressions, not a substitute for browser layout/accessibility testing.
import { describe, expect, it, vi } from "vitest";
import { makeSvc } from "./helpers";

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
  getAttribute(name: string) { return this.attributes.get(name) ?? null; }
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

function harness(responder: Responder = () => response({})) {
  const document = new TestDocument(), clipboard = vi.fn(async (_text: string) => {});
  const pendingTimers = new Map<number, { callback: () => void; delay: number }>(); let nextTimer = 0;
  const timer = (callback: () => void, delay = 0) => { pendingTimers.set(++nextTimer, { callback, delay }); return nextTimer; };
  const blobs = new Map<string, Blob>();
  const objectURLs = {
    createObjectURL: vi.fn((blob: Blob) => { const url = `blob:synthetic-test-${blobs.size}`; blobs.set(url, blob); return url; }),
    revokeObjectURL: vi.fn((_url: string) => {}),
  };
  const fetch = vi.fn(async (url: string, options: RequestOptions = {}) => {
    if (url === "/health") return response({ qloo_configured: true });
    if (url === "/api/rules") return response({ version: "qv-rules-test" });
    return responder(url, options);
  });
  const app = runInNewContext(script + "\n;({ run, loadBench, parseNames, state });", {
    document, fetch, navigator: { clipboard: { writeText: clipboard } }, location: { origin: "https://qloovibe.test" },
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
  it("opens without generating an audience and example buttons only fill the input", async () => {
    const ui = harness();
    expect(ui.posts()).toHaveLength(0);
    expect(ui.el("out").hidden).toBe(true);
    expect(ui.el("aud").value).toBe("");
    await button(ui.el("chips"), "Slowdive, Aesop, A24").click();
    expect(ui.el("aud").value).toBe("Slowdive, Aesop, A24");
    expect(ui.document.activeElement).toBe(ui.el("aud"));
    expect(ui.posts()).toHaveLength(0);
  });

  it("renders an actual generated brief, supports tabs and copies the actual CSS", async () => {
    const vibe = { ...await fixture(), caveats: [] }, ui = harness(() => response(vibe));
    await ui.app.run("Slowdive, Aesop");
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

  it("clears a previous result before a failing request and releases every control", async () => {
    const vibe = await fixture(); let attempt = 0;
    const ui = harness(() => ++attempt === 1 ? response(vibe) : response({ error: { message: "Provider down" } }, 503));
    await ui.app.run("Slowdive, Aesop");
    const next = ui.app.run("Metallica");
    // while loading, only a text-free skeleton is visible: nothing from the previous audience can be read in any tab
    for (const id of ["result-head", "p-preview", "p-tokens", "p-vocab", "p-critic"]) expect(ui.el(id).textContent).toBe("");
    expect(ui.app.state.vibe).toBeNull();
    await next;
    expect(ui.el("out").hidden).toBe(true);
    expect(ui.el("status").textContent).toContain("try again");
    expect(ui.el("go").disabled).toBe(false);
    expect(ui.el("aud").disabled).toBe(false);
    expect(ui.el("cancel").hidden).toBe(true);
    expect(ui.el("chips").querySelectorAll("button").every((node) => !node.disabled)).toBe(true);
  });

  it("cancels an outstanding request and returns the form to an editable state", async () => {
    const ui = harness((_url, options) => new Promise((_resolve, reject) => {
      options.signal!.addEventListener("abort", () => { const error = new Error("Aborted"); error.name = "AbortError"; reject(error); });
    }));
    const pending = ui.app.run("Slowdive");
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
    const pending = ui.app.run("Slowdive");
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
    await ui.app.run("Slowdive, Aesop");
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
    await ui.app.run("Slowdive, Aesop");
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
    await ui.app.run("Slowdive, Aesop");
    ui.el("cands").value = "Unknown Reference";
    await ui.el("p-critic").querySelector("form")!.dispatch("submit");
    expect(ui.el("critres").textContent).toContain("No references could be scored");
    expect(ui.el("critres").textContent).toContain("Try an exact");
    expect(ui.el("critres").textContent).toContain("could not match");
    expect(ui.el("cands").disabled).toBe(false);
    expect(button(ui.el("p-critic"), "Check references").disabled).toBe(false);
  });

  it("rejects excess reference names instead of silently truncating them", async () => {
    const vibe = await fixture(), ui = harness(() => response(vibe));
    await ui.app.run("Slowdive");
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
    await ui.app.run(input);
    expect(JSON.parse(ui.posts()[0]![1]!.body!).seeds).toEqual(["Salt & Stone", "Pride and Prejudice", "Earth, Wind & Fire"]);
    expect(() => ui.app.parseNames('"Earth, Wind & Fire', 5)).toThrow(/Close the double quote/);
    expect(ui.el("out").hidden).toBe(true);
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
