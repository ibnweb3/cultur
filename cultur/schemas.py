from typing import Any, Literal, Optional

from pydantic import BaseModel, Field

SCHEMA_VERSION = "1.0"
SCORING_VERSION = "cultur-score-1.0"

Status = Literal["available", "insufficient_evidence", "unavailable"]
Origin = Literal["observed", "curated", "caller_supplied", "inferred"]


class QlooHint(BaseModel):
    entity_id: str
    attribution: str = Field(min_length=1, description="Who asserts this seed and why")


class DossierRequest(BaseModel):
    input: str = Field(min_length=1, max_length=200)
    qloo_entity_ids: Optional[list[QlooHint]] = None
    creation_tx_hash: Optional[str] = None


class Evidence(BaseModel):
    id: str
    source: str
    ref: str  # URL or redacted reproducible query
    subject: str  # entity/tag/address/tx identifier
    fact: str
    retrieved_at: str
    freshness: Literal["fresh", "cached", "n/a"]
    origin: Origin


class Score(BaseModel):
    value: Optional[float] = None
    band: str = "n/a"
    status: Status = "insufficient_evidence"
    evidence: list[str] = []
    limitations: list[str] = []


class Dossier(BaseModel):
    schema_version: str = SCHEMA_VERSION
    scoring_version: str = SCORING_VERSION
    id: str
    created_at: str
    expires_at: str
    input: str
    input_type: str
    status: Literal["complete", "partial", "insufficient_evidence"]
    resolved_identity: Optional[dict[str, Any]] = None
    ambiguity: list[dict[str, Any]] = []
    verification: Literal["verified", "partially_verified", "taste_only", "unverified"]
    scores: dict[str, Score]
    fingerprint: dict[str, Any] = {}
    rebrand_matches: list[dict[str, Any]] = []
    wallet_findings: list[dict[str, Any]] = []
    plain_english_report: list[dict[str, Any]] = []  # {text, evidence:[ids]}
    evidence: list[Evidence] = []
    coverage: dict[str, Any] = {}
    caveats: list[str] = []
    provider_status: dict[str, Any] = {}
    live_qloo: dict[str, Any] = {}
    tool_trace: list[dict[str, Any]] = []
    duration_ms: int = 0
