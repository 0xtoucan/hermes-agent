"""The ``purge-profile-identity`` control verb drops a deleted profile's routing from the live
store's memory AND its durable index, and leaves other profiles' keys alone (#112727)."""
from __future__ import annotations

import time
from types import SimpleNamespace


def _make_store(tmp_path):
    from gateway.config import GatewayConfig
    from gateway.session import SessionStore
    sessions_dir = tmp_path / "sessions"
    sessions_dir.mkdir(exist_ok=True)
    store = SessionStore(
        sessions_dir,
        GatewayConfig(sessions_dir=sessions_dir, write_sessions_json=False, multiplex_profiles=True),
    )
    store._ensure_loaded()
    return store


def _entry(session_key, chat_id, profile):
    from gateway.session import Platform, SessionEntry, SessionSource
    from gateway.session_lifecycle import _now
    now = _now()
    return SessionEntry(
        session_key=session_key, session_id=f"sid-{chat_id}",
        platform=Platform.TELEGRAM, chat_type="dm", created_at=now, updated_at=now,
        origin=SessionSource(platform=Platform.TELEGRAM, chat_id=chat_id, profile=profile),
    )


def test_purge_verb_drops_deleted_profile_from_memory_and_disk(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    from gateway.run_profile_reconcile import purge_profile_identity_verb
    store = _make_store(tmp_path)
    with store._lock:
        store._entries["agent:foo:telegram:dm:1"] = _entry("agent:foo:telegram:dm:1", "1", "foo")
        store._entries["agent:bar:telegram:dm:2"] = _entry("agent:bar:telegram:dm:2", "2", "bar")
        store._entries["telegram:dm:3"] = _entry("telegram:dm:3", "3", None)
        store._save()
    db = store._routing_db
    now = time.time()
    for profile in ("foo", "bar"):
        db._write_sql(
            "INSERT INTO gateway_heartbeats(backend_id,pid,started_at,last_heartbeat,profile,host) VALUES (?,?,?,?,?,?)",
            (f"be-{profile}", 1, now, now, profile, "host"))

    answer = purge_profile_identity_verb(SimpleNamespace(session_store=store))({"name": "foo"})

    assert answer["ok"] is True and answer["dropped"] == 1
    survivors = ["agent:bar:telegram:dm:2", "telegram:dm:3"]
    assert sorted(store._entries) == survivors
    assert sorted(db.load_gateway_routing_entries(scope=store._routing_scope())) == survivors
    assert [r["profile"] for r in db._read_all("SELECT profile FROM gateway_heartbeats")] == ["bar"]
