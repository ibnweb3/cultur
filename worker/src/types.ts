export interface Env extends Pick<CloudflareBindings, "KV" | "ASSETS">,
  Partial<Pick<CloudflareBindings, "AI" | "QLOO_BASE_URL" | "RATE_LIMIT_PER_MIN">> {
  QLOO_API_KEY?: string;
  ADMIN_TOKEN?: string;
  /** Optional smaller model for the project-to-names step; defaults to the benchmark model. */
  SUGGEST_MODEL?: string;
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
