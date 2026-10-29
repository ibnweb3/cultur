export type ScoreStatus = "available" | "insufficient_evidence" | "unavailable";
export type Origin = "observed" | "curated" | "caller_supplied" | "inferred";

export interface Score {
  value: number | null;
  band: string;
  status: ScoreStatus;
  evidence: string[];
  limitations: string[];
}

export interface Evidence {
  id: string;
  source: string;
  ref: string;
  subject: string;
  fact: string;
  retrieved_at: string;
  freshness: "fresh" | "cached" | "n/a";
  origin: Origin;
}

export interface Env extends ArchiveBindings {
  QLOO_API_KEY?: string;
}

export interface DossierRequest {
  input: string;
  qloo_entity_ids?: { entity_id: string; attribution: string }[];
  creation_tx_hash?: string;
}

export interface Store {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, ttlSeconds: number): Promise<void>;
  delete(key: string): Promise<void>;
}

export const SCHEMA_VERSION = "1.0";
export const SCORING_VERSION = "cultur-score-1.0";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Dossier = Record<string, any>;
