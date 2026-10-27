"""Ethereum mainnet facts via standard JSON-RPC. No chain scans; limits reported."""
import re
from dataclasses import dataclass
from typing import Optional

import httpx

from .config import Settings
from .keccak import keccak256

ENS_REGISTRY = "0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e"
ADDR_RE = re.compile(r"^0x[0-9a-fA-F]{40}$")
TX_RE = re.compile(r"^0x[0-9a-fA-F]{64}$")
ZERO = "0x" + "0" * 40


def namehash(name: str) -> bytes:
    node = b"\x00" * 32
    if name:
        for label in reversed(name.lower().split(".")):
            node = keccak256(node + keccak256(label.encode()))
    return node


@dataclass
class Rpc:
    ok: bool
    value: Optional[str] = None
    error: Optional[str] = None


class Chain:
    def __init__(self, s: Settings, http: Optional[httpx.AsyncClient] = None):
        self.s = s
        self.http = http or httpx.AsyncClient(timeout=s.provider_timeout_s)

    async def rpc(self, method: str, params: list):
        try:
            r = await self.http.post(self.s.eth_rpc_url, json={"jsonrpc": "2.0", "id": 1, "method": method, "params": params})
            j = r.json()
        except (httpx.HTTPError, ValueError) as e:
            return Rpc(False, error=f"rpc {method}: {type(e).__name__}")
        if "error" in j:
            return Rpc(False, error=f"rpc {method}: {str(j['error'].get('message', 'error'))[:80]}")
        return Rpc(True, j.get("result"))

    async def call(self, to: str, data: str) -> Rpc:
        return await self.rpc("eth_call", [{"to": to, "data": data}, "latest"])

    async def resolve_ens(self, name: str) -> Rpc:
        node = namehash(name).hex()
        res = await self.call(ENS_REGISTRY, "0x0178b8bf" + node)  # resolver(bytes32)
        if not res.ok or not res.value or len(res.value) < 66:
            return Rpc(False, error=res.error or "no resolver")
        resolver = "0x" + res.value[-40:]
        if resolver == ZERO:
            return Rpc(False, error="no resolver set")
        res = await self.call(resolver, "0x3b3b57de" + node)  # addr(bytes32)
        if not res.ok or not res.value or len(res.value) < 66:
            return Rpc(False, error=res.error or "no address record")
        addr = "0x" + res.value[-40:]
        return Rpc(True, None if addr == ZERO else addr) if addr != ZERO else Rpc(False, error="name resolves to zero address")

    async def code_size(self, addr: str) -> Rpc:
        r = await self.rpc("eth_getCode", [addr, "latest"])
        if r.ok:
            r.value = str(max(0, (len(r.value or "0x") - 2) // 2))
        return r

    async def owner(self, addr: str) -> Rpc:
        r = await self.call(addr, "0x8da5cb5b")
        if r.ok and r.value and len(r.value) >= 66:
            return Rpc(True, "0x" + r.value[-40:])
        return Rpc(False, error=r.error or "owner() absent or reverted")

    async def balance_eth(self, addr: str) -> Rpc:
        r = await self.rpc("eth_getBalance", [addr, "latest"])
        if r.ok:
            r.value = f"{int(r.value, 16) / 1e18:.6f}"
        return r

    async def tx_receipt(self, tx: str):
        return await self.rpc("eth_getTransactionReceipt", [tx])

    async def tx_creation_matches(self, tx: str, contract: str):
        """Verify a supplied creation tx actually created `contract`. Returns (ok, sender, note)."""
        rc = await self.rpc("eth_getTransactionReceipt", [tx])
        if not rc.ok or not rc.value:
            return False, None, rc.error or "receipt not found"
        v = rc.value
        if (v.get("contractAddress") or "").lower() == contract.lower():
            return True, v.get("from"), "direct creation (receipt.contractAddress matches)"
        return False, v.get("from"), "receipt does not show direct creation of this contract (factory creations are not auto-attributed)"
