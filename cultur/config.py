import os
from pathlib import Path
from dataclasses import dataclass, field


def _load_dotenv():
    f = Path(__file__).resolve().parent.parent / ".env"
    if f.exists():
        for line in f.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


_load_dotenv()


def _env(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


@dataclass
class Settings:
    qloo_api_key: str = field(default_factory=lambda: _env("QLOO_API_KEY"))
    qloo_base_url: str = field(default_factory=lambda: _env("QLOO_BASE_URL", "https://hackathon.api.qloo.com").rstrip("/"))
    eth_rpc_url: str = field(default_factory=lambda: _env("ETH_RPC_URL", "https://ethereum-rpc.publicnode.com"))
    indexer_api_key: str = field(default_factory=lambda: _env("INDEXER_API_KEY"))
    db_path: str = field(default_factory=lambda: _env("DB_PATH", "data/cultur.db"))
    rate_limit_per_min: int = field(default_factory=lambda: int(_env("RATE_LIMIT_PER_MIN", "10")))
    # request budgets
    upstream_budget_s: float = 25.0
    provider_timeout_s: float = 8.0
    max_retries: int = 2
    max_compare_candidates: int = 4
    max_qloo_compare_calls: int = 3
    dossier_ttl_days: int = 7
    cache_ttl_s: int = 6 * 3600
    cache_version: str = "1"

    @property
    def credential_namespace(self) -> str:
        # never store the key itself; namespace only
        import hashlib
        return hashlib.sha256(self.qloo_api_key.encode()).hexdigest()[:8] if self.qloo_api_key else "nokey"
