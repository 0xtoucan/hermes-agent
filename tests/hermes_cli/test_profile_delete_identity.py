"""Deleting a profile purges its durable identity from the root state.db (#112727).

The delete-side twin of the rename rekey: ``agent:<name>:*`` routing keys, ``gateway_heartbeats``
and ``delivery_obligations`` rows naming a deleted profile otherwise keep it resolvable by the
gateway's routing index for the life of the store.
"""
from __future__ import annotations

import sqlite3
import time
from pathlib import Path
from unittest.mock import patch

import pytest

from hermes_cli.profiles import create_profile, delete_profile


@pytest.fixture()
def profile_env(tmp_path, monkeypatch):
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    default_home = tmp_path / ".hermes"
    default_home.mkdir(exist_ok=True)
    monkeypatch.setenv("HERMES_HOME", str(default_home))
    return default_home


def _seed_identity(root_db: Path, profile: str, chat: str) -> None:
    from hermes_state import SessionDB
    db = SessionDB(root_db)
    db.save_gateway_routing_entry(f"agent:{profile}:telegram:dm:{chat}", '{"session_id": "s"}')
    now = time.time()
    db._write_sql(
        "INSERT INTO gateway_heartbeats(backend_id,pid,started_at,last_heartbeat,profile,host) VALUES (?,?,?,?,?,?)",
        (f"be-{profile}", 1, now, now, profile, "host"))
    db.close()
    conn = sqlite3.connect(root_db)
    from gateway.delivery_ledger import _initialize_schema
    _initialize_schema(conn)
    conn.execute(
        "INSERT INTO delivery_obligations(obligation_id,session_key,platform,chat_id,content,state,"
        "created_at,updated_at,adapter_profile) VALUES (?,?,?,?,?,?,?,?,?)",
        (f"o-{profile}", f"agent:{profile}:telegram:dm:{chat}", "telegram", chat, "hi", "pending", now, now, profile))
    conn.commit()
    conn.close()


def _identity(root_db: Path) -> dict:
    conn = sqlite3.connect(root_db)
    out = {
        "routing": sorted(r[0] for r in conn.execute("SELECT session_key FROM gateway_routing")),
        "heartbeats": sorted(r[0] for r in conn.execute("SELECT profile FROM gateway_heartbeats")),
        "delivery": sorted(r[0] for r in conn.execute("SELECT adapter_profile FROM delivery_obligations")),
    }
    conn.close()
    return out


def test_delete_purges_profile_identity_and_leaves_other_profiles_alone(profile_env):
    root_db = profile_env / "state.db"
    with patch("hermes_cli.profiles._live_default_multiplexer", return_value=False):
        create_profile("foo", no_alias=True, no_skills=True)
        create_profile("bar", no_alias=True, no_skills=True)
    _seed_identity(root_db, "foo", "1")
    _seed_identity(root_db, "bar", "2")
    from hermes_state import SessionDB
    db = SessionDB(root_db)
    db.save_gateway_routing_entry("telegram:dm:3", '{"session_id": "d"}')  # default-profile row
    db.close()

    with patch("hermes_cli.profiles._live_default_multiplexer", return_value=False), \
            patch("hermes_cli.profiles._notify_multiplexer"):
        delete_profile("foo", yes=True)

    assert _identity(root_db) == {
        "routing": ["agent:bar:telegram:dm:2", "telegram:dm:3"],
        "heartbeats": ["bar"],
        "delivery": ["bar"],
    }
