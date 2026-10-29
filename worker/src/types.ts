export interface Env {
  KV: KVNamespace;
  ASSETS: Fetcher;
  AI?: Ai;
  QLOO_API_KEY?: string;
  QLOO_BASE_URL?: string;
  ADMIN_TOKEN?: string;
  RATE_LIMIT_PER_MIN?: string;
}

export interface Store {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, ttlSeconds: number): Promise<void>;
  delete(key: string): Promise<void>;
}

export type Family = "decor" | "ambience" | "style";
export const FAMILIES: Family[] = ["decor", "ambience", "style"];

export const SCHEMA_VERSION = "1.0";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Json = any;

export interface TraceStep {
  step: string;
  call: string; // redacted, reproducible Qloo query (no credentials)
  freshness: "fresh" | "cached";
  status: "ok" | "error";
  ms: number;
  note?: string;
}
