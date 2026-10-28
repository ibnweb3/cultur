import json
import os
import sqlite3
import threading
import time

_lock = threading.Lock()


class DB:
    """SQLite: TTL provider cache + saved dossiers. Ephemeral on free hosts."""

    def __init__(self, path: str):
        if path != ":memory:":
            os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        self.conn = sqlite3.connect(path, check_same_thread=False)
        self.conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS cache(k TEXT PRIMARY KEY, v TEXT, fetched REAL, ttl REAL);
            CREATE TABLE IF NOT EXISTS dossiers(id TEXT PRIMARY KEY, body TEXT, expires REAL);
            """
        )

    def cache_get(self, k: str):
        with _lock:
            row = self.conn.execute("SELECT v, fetched, ttl FROM cache WHERE k=?", (k,)).fetchone()
        if not row or time.time() > row[1] + row[2]:
            return None
        return json.loads(row[0]), row[1]

    def cache_put(self, k: str, v, ttl: float):
        with _lock:
            self.conn.execute("REPLACE INTO cache VALUES(?,?,?,?)", (k, json.dumps(v), time.time(), ttl))
            self.conn.commit()

    def cache_del(self, k: str):
        with _lock:
            self.conn.execute("DELETE FROM cache WHERE k=?", (k,))
            self.conn.commit()

    def save_dossier(self, id_: str, body: dict, expires: float):
        with _lock:
            self.conn.execute("REPLACE INTO dossiers VALUES(?,?,?)", (id_, json.dumps(body), expires))
            self.conn.commit()

    def get_dossier(self, id_: str):
        with _lock:
            row = self.conn.execute("SELECT body, expires FROM dossiers WHERE id=?", (id_,)).fetchone()
        if not row or time.time() > row[1]:
            return None
        return json.loads(row[0])
