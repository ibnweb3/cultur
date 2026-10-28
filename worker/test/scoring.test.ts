import { describe, expect, it } from "vitest";
import * as s from "../src/scoring";
import { namehash } from "../src/chain";

const none = { value: null, band: "n/a", status: "insufficient_evidence" as const, evidence: [], limitations: [] };

describe("scoring", () => {
  it("weighted jaccard basics", () => {
    expect(s.weightedJaccard({}, {})).toBe(0);
    expect(s.weightedJaccard({ a: 1 }, { a: 1 })).toBe(1);
    expect(s.weightedJaccard({ a: 1 }, { b: 1 })).toBe(0);
  });
  it("is deterministic", () => {
    expect(s.rebrandRisk("high", true, "established", true, 12)).toEqual(s.rebrandRisk("high", true, "established", true, 12));
  });
  it("band boundaries", () => {
    expect(s.similarityBand(0.5, 5)).toBe("high");
    expect(s.similarityBand(0.4999, 5)).toBe("moderate");
    expect(s.similarityBand(0.25, 5)).toBe("moderate");
    expect(s.similarityBand(0.1, 5)).toBe("low");
    expect(s.similarityBand(0.0999, 5)).toBe("none");
    expect(s.similarityBand(0.9, 2)).toBe("low");
  });
  it("discounts popular shared tastes; unrelated identities stay low", () => {
    expect(s.popularityWeight(0.99)).toBeLessThan(s.popularityWeight(0.01));
    expect(s.popularityWeight(5000)).toBe(1);
    const a: Record<string, number> = {}, b: Record<string, number> = {};
    for (let i = 0; i < 3; i++) a["e" + i] = b["e" + i] = s.popularityWeight(0.97) / (1 + i);
    for (let i = 0; i < 10; i++) { a["a" + i] = 1 / (1 + i); b["b" + i] = 1 / (1 + i); }
    expect(["none", "low"]).toContain(s.similarityBand(s.weightedJaccard(a, b), 3));
  });
  it("risk direction: similarity alone is a lead; continuity+history raises it; rebrand alone is not misconduct", () => {
    const lead = s.rebrandRisk("high", false, "established", true, 12);
    const full = s.rebrandRisk("high", true, "established", true, 12);
    expect(lead.value as number).toBeLessThan(full.value as number);
    expect(lead.value as number).toBeLessThan(50);
    expect(full.band).toBe("high");
    expect(s.rebrandRisk("high", true, null, true, 12).value as number).toBeLessThan(50);
  });
  it("missing data is insufficient, never zero or clearance", () => {
    const r = s.rebrandRisk(null, false, null, false, 12);
    expect(r.value).toBeNull();
    expect(r.status).toBe("insufficient_evidence");
    expect(s.rebrandRisk("none", false, null, true, 12).band).toBe("no_lead");
    expect(s.culturalDepth(0, 0, 0, true).value).toBeNull();
    expect(s.communityAuthenticity(true, true).value).toBeNull();
    expect(s.walletCorroboration([{ kind: "balance", verified: true }]).value).toBeNull();
  });
  it("trust: null below minimum evidence, unavailable without Qloo, history lowers it", () => {
    expect(s.trustScore(null, none, none, null, true).value).toBeNull();
    expect(s.trustScore(60, none, none, null, false).status).toBe("unavailable");
    const w = s.walletCorroboration([{ kind: "registry_wallet_match", verified: true }]);
    const t = s.trustScore(60, w, none, null, true);
    expect(t.value as number).toBeGreaterThan(0);
    expect(t.value as number).toBeLessThan(100);
    expect(s.trustScore(60, w, none, "established", true).value as number).toBeLessThan(s.trustScore(60, w, none, "alleged", true).value as number);
  });
});

describe("ENS namehash", () => {
  it("matches the EIP-137 vector for eth", () => {
    const h = [...namehash("eth")].map((x) => x.toString(16).padStart(2, "0")).join("");
    expect(h).toBe("93cdeb708b7545dc668eb9280176169d1c33cfd8ed6f04690a0bcc88a93fc4ae");
  });
});

import { Chain } from "../src/chain";
describe("RPC failover", () => {
  it("tries the next endpoint on rate limits and errors, but not on reverts", async () => {
    const seen: string[] = [];
    const mk = (msgs: Record<string, string | null>) => (async (u: string) => {
      seen.push(u);
      const m = msgs[u];
      return new Response(JSON.stringify(m ? { jsonrpc: "2.0", id: 1, error: { message: m } } : { jsonrpc: "2.0", id: 1, result: "0x01" }));
    }) as unknown as typeof fetch;
    const a = new Chain({ rpcUrl: "https://a,https://b", fetchFn: mk({ "https://a": "Rate limit exceeded", "https://b": null }) });
    expect((await a.rpc("eth_getCode", [])).ok).toBe(true);
    expect(seen).toEqual(["https://a", "https://b"]);
    seen.length = 0;
    const r = new Chain({ rpcUrl: "https://a,https://b", fetchFn: mk({ "https://a": "execution reverted", "https://b": null }) });
    expect((await r.rpc("eth_call", [])).ok).toBe(false);
    expect(seen).toEqual(["https://a"]);
  });
});
