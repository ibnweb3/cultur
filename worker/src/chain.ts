// Ethereum mainnet facts via standard JSON-RPC. No chain scans; limits are reported by the service.
import { keccak_256 } from "@noble/hashes/sha3.js";

export const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
export const TX_RE = /^0x[0-9a-fA-F]{64}$/;
const ENS_REGISTRY = "0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e";
const ZERO = "0x" + "0".repeat(40);

const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const utf8 = (s: string) => new TextEncoder().encode(s);
const cat = (a: Uint8Array, b: Uint8Array) => { const o = new Uint8Array(a.length + b.length); o.set(a); o.set(b, a.length); return o; };

export function namehash(name: string): Uint8Array {
  let node: Uint8Array = new Uint8Array(32);
  if (name) for (const label of name.toLowerCase().split(".").reverse()) node = keccak_256(cat(node, keccak_256(utf8(label))));
  return node;
}

export interface Rpc { ok: boolean; value?: string; error?: string }
export interface ChainOpts { rpcUrl: string; fetchFn?: typeof fetch; signal?: AbortSignal; timeoutMs?: number }

export class Chain {
  constructor(private o: ChainOpts) {}

  /** rpcUrl may be a comma-separated list of free endpoints; the next one is tried on rate limits or transport errors. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async rpc(method: string, params: any[]): Promise<Rpc & { raw?: any }> {
    const urls = this.o.rpcUrl.split(",").map((u) => u.trim()).filter(Boolean);
    let lastErr = `rpc ${method}: no endpoint`;
    for (const url of urls) {
      try {
        const t = AbortSignal.timeout(this.o.timeoutMs ?? 6000);
        const r = await (this.o.fetchFn ?? fetch)(url, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
          signal: this.o.signal ? AbortSignal.any([this.o.signal, t]) : t,
        });
        const j = (await r.json()) as { result?: unknown; error?: { message?: string; code?: number } };
        if (j.error) {
          lastErr = `rpc ${method}: ${String(j.error.message ?? "error").slice(0, 80)}`;
          if (!/revert|execution/i.test(lastErr)) continue; // endpoint trouble: try the next one
          return { ok: false, error: lastErr }; // a genuine EVM revert is not retried
        }
        return { ok: true, value: typeof j.result === "string" ? j.result : undefined, raw: j.result };
      } catch (e) {
        if (this.o.signal?.aborted) return { ok: false, error: `rpc ${method}: cancelled` };
        lastErr = `rpc ${method}: ${(e as Error).name}`;
      }
    }
    return { ok: false, error: lastErr };
  }
  call(to: string, data: string) { return this.rpc("eth_call", [{ to, data }, "latest"]); }

  private async ensResolver(node: string): Promise<Rpc> {
    const r = await this.call(ENS_REGISTRY, "0x0178b8bf" + node); // resolver(bytes32)
    if (!r.ok || !r.value || r.value.length < 66) return { ok: false, error: r.error ?? "no resolver" };
    const resolver = "0x" + r.value.slice(-40);
    return resolver === ZERO ? { ok: false, error: "no resolver set" } : { ok: true, value: resolver };
  }

  async resolveEns(name: string): Promise<Rpc> {
    const node = hex(namehash(name));
    const rs = await this.ensResolver(node);
    if (!rs.ok) return rs;
    const a = await this.call(rs.value as string, "0x3b3b57de" + node); // addr(bytes32)
    if (!a.ok || !a.value || a.value.length < 66) return { ok: false, error: a.error ?? "no address record" };
    const addr = "0x" + a.value.slice(-40);
    return addr === ZERO ? { ok: false, error: "name resolves to zero address" } : { ok: true, value: addr };
  }

  /** ENS text record (e.g. "com.twitter"). Self-asserted by the name's owner: supporting metadata only. */
  async ensText(name: string, key: string): Promise<Rpc> {
    const node = hex(namehash(name));
    const rs = await this.ensResolver(node);
    if (!rs.ok) return rs;
    const kb = utf8(key);
    const pad = (n: number) => n.toString(16).padStart(64, "0");
    const data = "0x59d1d43c" + node + pad(64) + pad(kb.length) + hex(kb).padEnd(Math.ceil(kb.length / 32) * 64, "0"); // text(bytes32,string)
    const r = await this.call(rs.value as string, data);
    if (!r.ok || !r.value || r.value.length < 2 + 128) return { ok: false, error: r.error ?? "no text record" };
    const body = r.value.slice(2);
    const len = parseInt(body.slice(64, 128), 16);
    if (!len || len > 100) return { ok: false, error: "empty text record" };
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) bytes[i] = parseInt(body.slice(128 + i * 2, 130 + i * 2), 16);
    return { ok: true, value: new TextDecoder().decode(bytes) };
  }

  async codeSize(addr: string): Promise<Rpc> {
    const r = await this.rpc("eth_getCode", [addr, "latest"]);
    return r.ok ? { ok: true, value: String(Math.max(0, ((r.value ?? "0x").length - 2) >> 1)) } : r;
  }
  async owner(addr: string): Promise<Rpc> {
    const r = await this.call(addr, "0x8da5cb5b");
    return r.ok && r.value && r.value.length >= 66 ? { ok: true, value: "0x" + r.value.slice(-40) } : { ok: false, error: r.error ?? "owner() absent or reverted" };
  }
  async balanceEth(addr: string): Promise<Rpc> {
    const r = await this.rpc("eth_getBalance", [addr, "latest"]);
    if (!r.ok) return r;
    if (!r.value || !/^0x[0-9a-fA-F]+$/.test(r.value)) return { ok: false, error: "rpc eth_getBalance: malformed result" };
    return { ok: true, value: (Number(BigInt(r.value)) / 1e18).toFixed(6) };
  }
  /** Verify a supplied creation tx actually created `contract`. */
  async creationMatches(tx: string, contract: string): Promise<{ ok: boolean; sender?: string; note: string }> {
    const r = await this.rpc("eth_getTransactionReceipt", [tx]);
    if (!r.ok || !r.raw) return { ok: false, note: r.error ?? "receipt not found" };
    if (String(r.raw.contractAddress ?? "").toLowerCase() === contract.toLowerCase())
      return { ok: true, sender: r.raw.from, note: "direct creation (receipt.contractAddress matches)" };
    return { ok: false, sender: r.raw.from, note: "receipt does not show direct creation of this contract (factory creations are not auto-attributed)" };
  }
}
