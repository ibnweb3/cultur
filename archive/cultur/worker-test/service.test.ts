import { describe, expect, it } from "vitest";
import { InvalidInput, classify } from "../src/service";
import { FakeQloo, MemStore, makeSvc } from "./helpers";

describe("classify", () => {
  it("routes inputs and rejects bad ones", () => {
    expect(classify("@Foo_1")[0]).toBe("twitter_handle");
    expect(classify("https://x.com/foo")[0]).toBe("twitter_handle");
    expect(classify("vitalik.eth")[0]).toBe("ens");
    expect(classify("0x" + "a".repeat(40))[0]).toBe("contract");
    expect(classify("Wonderland")[0]).toBe("name");
    for (const bad of ["", "   ", "0x123", "<script>", "x".repeat(201), "@bad handle!"]) expect(() => classify(bad)).toThrow(InvalidInput);
  });
});

describe("dossier generation", () => {
  it("makes fresh, relevant Qloo calls and resolves an exact match", async () => {
    const f = new FakeQloo(); const { svc } = makeSvc(f);
    const d = await svc.generate({ input: "Foo Creator" });
    expect(d.live_qloo.performed).toBe(true);
    expect(d.live_qloo.fresh_successful_calls).toBeGreaterThanOrEqual(1);
    expect(f.calls.some((c) => c.includes("/search") && c.includes("Foo"))).toBe(true);
    expect(["complete", "partial"]).toContain(d.status);
    expect(d.resolved_identity.qloo_entity_id).toBe("ANCHOR");
    expect(Object.keys(d.fingerprint.entities).length).toBeGreaterThan(0);
  });
  it("repeat requests still go live (cache bypassed for grounding)", async () => {
    const f = new FakeQloo(); const { svc } = makeSvc(f);
    await svc.generate({ input: "Foo Creator" });
    const n = f.calls.length;
    const d2 = await svc.generate({ input: "Foo Creator" });
    expect(f.calls.length).toBeGreaterThan(n);
    expect(d2.live_qloo.fresh_successful_calls).toBeGreaterThanOrEqual(1);
  });
  it("keeps evidence references intact", async () => {
    const { svc } = makeSvc(new FakeQloo());
    const d = await svc.generate({ input: "Foo Creator" });
    const ids = new Set(d.evidence.map((e: { id: string }) => e.id));
    expect(ids.size).toBe(d.evidence.length);
    for (const r of d.plain_english_report) for (const e of r.evidence) expect(ids.has(e)).toBe(true);
    for (const s of Object.values(d.scores) as { evidence: string[] }[]) for (const e of s.evidence) expect(ids.has(e)).toBe(true);
    expect(d.plain_english_report.some((r: { evidence: string[] }) => r.evidence.length)).toBe(true);
  });
  it("preserves ambiguity instead of forcing a match", async () => {
    const f = new FakeQloo(); f.search = [{ entity_id: "A", name: "Foo", types: ["urn:entity:brand"] }, { entity_id: "B", name: "Foo", types: ["urn:entity:person"] }];
    const d = await makeSvc(f).svc.generate({ input: "Foo" });
    expect(d.resolved_identity).toBeNull();
    expect(d.ambiguity).toHaveLength(2);
    expect(d.status).toBe("insufficient_evidence");
    expect(d.scores.trust_score.value).toBeNull();
  });
  it("never substitutes a similarly named celebrity", async () => {
    const f = new FakeQloo(); f.search = [{ entity_id: "C", name: "Famous Celebrity", types: ["urn:entity:person"] }];
    expect((await makeSvc(f).svc.generate({ input: "Fam0us" })).resolved_identity).toBeNull();
  });
  it("a name match alone does not resolve a handle", async () => {
    const f = new FakeQloo(); f.search = [{ entity_id: "C", name: "foo", types: ["urn:entity:person"] }];
    const d = await makeSvc(f).svc.generate({ input: "@foo" });
    expect(d.resolved_identity).toBeNull();
    expect(d.ambiguity.length).toBeGreaterThan(0);
  });
  it("resolves a handle when the entity lists that handle, anchoring all listings", async () => {
    const f = new FakeQloo();
    const e = (id: string, ty: string) => ({ entity_id: id, name: "Foo Creator", types: [ty], properties: { external: { twitter: { id: "foocreator" } } } });
    f.entities = [e("P1", "urn:entity:person"), e("A1", "urn:entity:artist")];
    const d = await makeSvc(f).svc.generate({ input: "@FooCreator" });
    expect(d.resolved_identity.qloo_entity_id).toBe("P1");
    expect(d.fingerprint.anchors).toEqual(["P1", "A1"]);
  });
  it("rejects a handle owned by another entity", async () => {
    const f = new FakeQloo();
    f.entities = [{ entity_id: "X", name: "Other", types: ["urn:entity:person"], properties: { external: { twitter: { id: "someoneelse" } } } }, { entity_id: "Y", name: "Another", types: ["urn:entity:person"] }];
    expect((await makeSvc(f).svc.generate({ input: "@foocreator" })).resolved_identity).toBeNull();
  });
  for (const mode of ["429", "timeout", "malformed", "500"] as const) {
    it(`Qloo ${mode} prevents a complete fresh verdict`, async () => {
      const f = new FakeQloo(); f.fail = mode;
      const d = await makeSvc(f).svc.generate({ input: "Foo Creator" });
      expect(d.status).toBe("insufficient_evidence");
      expect(d.live_qloo.performed).toBe(false);
      expect(d.fingerprint).toEqual({});
      expect(d.scores.trust_score.value).toBeNull();
      expect(JSON.stringify(d)).not.toContain("stack");
    });
  }
  it("cached data cannot stand in for live grounding", async () => {
    const f = new FakeQloo(); const { svc } = makeSvc(f);
    await svc.generate({ input: "Foo Creator" });
    f.fail = "500";
    const d = await svc.generate({ input: "Foo Creator" });
    expect(d.status).toBe("insufficient_evidence");
    expect(d.fingerprint).toEqual({});
  });
  it("without a key there is no verdict", async () => {
    const d = await makeSvc(new FakeQloo(), { key: undefined }).svc.generate({ input: "Foo Creator" });
    expect(d.status).toBe("insufficient_evidence");
    expect(d.caveats.some((c: string) => c.includes("QLOO_API_KEY"))).toBe(true);
  });
  it("GET returns the original dossier unchanged", async () => {
    const { svc } = makeSvc(new FakeQloo());
    const d = await svc.generate({ input: "Foo Creator" });
    expect(await svc.get(d.id)).toEqual(d);
    expect(await svc.get("missing")).toBeNull();
  });
  it("contract inputs report limits and still run a relevant Qloo lookup", async () => {
    const f = new FakeQloo(); f.search = [];
    const { svc } = makeSvc(f, { rpc: (b) => ({ eth_getCode: "0x6001", eth_getBalance: "0xde0b6b3a7640000" } as Record<string, string>)[b.method] ?? "0x" });
    const d = await svc.generate({ input: "0x" + "b".repeat(40) });
    expect(d.wallet_findings.some((w: { kind: string }) => w.kind === "code")).toBe(true);
    expect(d.caveats.some((c: string) => c.toLowerCase().includes("creation"))).toBe(true);
    expect(d.live_qloo.attempted_calls).toBeGreaterThanOrEqual(1);
    expect(d.status).toBe("insufficient_evidence");
  });
  it("marks caller hints as caller_supplied", async () => {
    const d = await makeSvc(new FakeQloo()).svc.generate({ input: "Foo Creator", qloo_entity_ids: [{ entity_id: "HINT1", attribution: "tester" }] });
    expect(d.evidence.some((e: { origin: string }) => e.origin === "caller_supplied")).toBe(true);
  });
  it("zero Qloo footprint is a coverage warning, not a penalty", async () => {
    const f = new FakeQloo(); f.noInsights = true;
    const d = await makeSvc(f).svc.generate({ input: "Foo Creator" });
    expect(d.caveats.some((c: string) => c.includes("Zero Qloo footprint"))).toBe(true);
    const v = d.scores.trust_score.value;
    expect(v === null || v >= 50).toBe(true);
  });
  it("excludes a registry case that shares the subject's Qloo entity", async () => {
    const f = new FakeQloo(); const store = new MemStore();
    await store.put("regfp:cryptozoo-logan-paul", JSON.stringify({ anchors: ["ANCHOR"], entities: { artist: [{ id: "artist0", name: "x", rank: 0, popularity: 0.1, tags: [] }] }, tags: [] }));
    const d = await makeSvc(f, { store }).svc.generate({ input: "Foo Creator" });
    expect(d.rebrand_matches).toEqual([]);
    expect(d.caveats.some((c: string) => c.includes("self-match"))).toBe(true);
  });
  it("returns a partial result when the upstream budget is hit", async () => {
    const f = new FakeQloo();
    const slow = f.handler; f.handler = async (i) => { await new Promise((r) => setTimeout(r, 200)); return slow(i); };
    const d = await makeSvc(f, { budgetMs: 50 }).svc.generate({ input: "Foo Creator" });
    expect(d.caveats.some((c: string) => c.includes("budget"))).toBe(true);
    expect(d.status).not.toBe("complete");
  });
});

describe("identity rules", () => {
  it("does not anchor on an exact name hit that is a place", async () => {
    const f = new FakeQloo(); f.search = [{ entity_id: "PL", name: "Foo Creator", types: ["urn:entity:place"] }];
    const d = await makeSvc(f).svc.generate({ input: "Foo Creator" });
    expect(d.resolved_identity).toBeNull();
    expect(d.ambiguity[0].note).toContain("not a person");
  });
  it("does not link an ENS name to a Qloo entity from the label alone", async () => {
    const f = new FakeQloo(); f.search = [{ entity_id: "P", name: "foo", types: ["urn:entity:person"] }];
    const d = await makeSvc(f).svc.generate({ input: "foo.eth" });
    expect(d.resolved_identity).toBeNull();
    expect(d.ambiguity[0].note).toContain("not linked");
  });
  it("links an ENS name via its self-asserted com.twitter record and the Qloo handle lookup", async () => {
    const f = new FakeQloo();
    f.entities = [{ entity_id: "P1", name: "Foo Creator", types: ["urn:entity:person"], properties: { external: { twitter: { id: "foocreator" } } } }];
    const pad = (h: string) => "0x" + h.padStart(64, "0");
    const str = "foocreator";
    const abi = "0x" + (32).toString(16).padStart(64, "0") + str.length.toString(16).padStart(64, "0") + Buffer.from(str).toString("hex").padEnd(64, "0");
    const rpc = (b: { method: string; params: { data?: string }[] }) => {
      if (b.method !== "eth_call") return "0x";
      const data = b.params[0].data as string;
      if (data.startsWith("0x0178b8bf")) return pad("1".repeat(40));
      if (data.startsWith("0x3b3b57de")) return pad("2".repeat(40));
      if (data.startsWith("0x59d1d43c")) return abi;
      return "0x";
    };
    const d = await makeSvc(f, { rpc }).svc.generate({ input: "foo.eth" });
    expect(d.resolved_identity.qloo_entity_id).toBe("P1");
    expect(d.resolved_identity.method).toContain("external.twitter.ids");
    expect(d.evidence.some((e: { fact: string }) => e.fact.includes("self-asserted"))).toBe(true);
  });
});
