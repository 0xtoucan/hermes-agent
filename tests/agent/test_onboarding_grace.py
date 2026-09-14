"""Setup grace is finite per identity, then the guide spends the ordinary allowance."""
import base64
import copy
import importlib
import json
import shutil
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import pytest


@pytest.fixture
def guide_env(tmp_path, monkeypatch):
    from hermes_cli import auth, auth_nous, profiles
    from hermes_constants import reset_hermes_home_override, set_hermes_home_override
    from tui_gateway import server

    home = tmp_path / "hermes"
    home.mkdir()
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setenv("HERMES_SHARED_AUTH_DIR", str(tmp_path / "shared-auth"))
    monkeypatch.setenv("HERMES_GUEST_ONBOARDING", "1")
    payload = base64.urlsafe_b64encode(json.dumps({
        "sub": "fixture", "client_id": "nas-anonymous", "account_tier": "anonymous",
        "scope": "inference:invoke tool:invoke", "exp": 32503680000,
    }).encode()).decode().rstrip("=")
    guest = {"auth_method": "anonymous", "anon_token": "anon_guide_fixture",
             "access_token": f"e30.{payload}.fixture", "expires_at": "2999-01-01T00:00:00+00:00",
             "inference_base_url": "https://welcome-api.nousresearch.com/v1"}
    auth._save_active_provider_state("nous", guest)
    auth_nous._write_shared_nous_state(guest)

    def rpc(method, **params):
        return server.handle_request({"id": method, "method": method, "params": params})

    assert "result" in rpc("profiles.ensure_onboarding", soul="Guide")
    guide = profiles.get_profile_dir("hermes-setup")
    monkeypatch.setenv("HERMES_HOME", str(guide))
    auth._save_active_provider_state("nous", guest)
    monkeypatch.setattr("agent.turn_api_call._should_stream", lambda _agent: False)
    monkeypatch.setattr("agent.title_generator.maybe_auto_title", lambda *a, **kw: None)
    agents = []

    def make_agent():
        from run_agent import AIAgent
        agent = AIAgent(api_key="fixture", provider="nous", model="nous/welcome",
                        base_url=guest["inference_base_url"], quiet_mode=True,
                        skip_context_files=True, skip_memory=True, enabled_toolsets=[])
        agent._cached_system_prompt = "Stable guide prefix"
        agent.compression_enabled = False
        agent.save_trajectories = False
        agents.append(agent)
        return agent

    receipt = tmp_path / "receipt.txt"
    receipt.write_text("real guide tool result", encoding="utf-8")

    def run(agent, *, tool=False, history=None):
        from tools.file_tools import READ_FILE_SCHEMA
        calls = [SimpleNamespace(id="read", type="function", function=SimpleNamespace(
            name="read_file", arguments=json.dumps({"path": str(receipt)})))]
        def response(content, tool_calls=None):
            return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(
                content=content, tool_calls=tool_calls), finish_reason="tool_calls" if tool_calls else "stop")], usage=None)
        agent.valid_tool_names = {"read_file"}
        agent.tools = [{"type": "function", "function": READ_FILE_SCHEMA}]
        api = Mock(side_effect=([response("", calls)] if tool else []) + [response("Finished.")])
        agent._interruptible_api_call = api
        result = agent.run_conversation("Continue", conversation_history=history)
        return result, api

    yield SimpleNamespace(home=home, guide=guide, guest=guest, rpc=rpc, server=server,
                          make_agent=make_agent, run=run, agents=agents,
                          set_home=set_hermes_home_override, reset_home=reset_hermes_home_override)
    for agent in agents:
        agent.close()


def test_text_only_grace_expires_atomically_without_a_separate_gate(guide_env):
    from agent.free_tier import admit_turn, finish_turn
    from hermes_cli import free_tier_usage as usage
    from tools.delegate_tool import _build_child_agent

    env = guide_env
    agent = env.make_agent()
    agent.base_url = "http://localhost:11434/v1"
    agent._primary_runtime = None
    assert env.run(agent, tool=True)[0]["completed"]
    assert not usage._usage_path().exists()  # own inference consumes neither allowance
    agent.base_url = env.guest["inference_base_url"]
    for _ in range(19):
        result, api = env.run(agent)
        assert result["completed"] and api.call_count == 1
    assert usage.status()["tool_calls_used"] == 0
    before = usage._usage_path().read_bytes() if usage._usage_path().exists() else None
    for _ in range(3):
        assert env.rpc("free_tier.status")["result"]["continuation_required"] is False
    assert (usage._usage_path().read_bytes() if usage._usage_path().exists() else None) == before

    # Two logical turns compete for the final reservation; only one can get grace.
    contenders = [env.make_agent(), env.make_agent()]
    start, admitted = threading.Barrier(2), threading.Barrier(2)
    def compete(owner):
        start.wait(timeout=10)
        with admit_turn(owner) as blocked:
            assert blocked is None
            admitted.wait(timeout=10)
            turn = owner._free_tier_turn
            child = None
            if turn.guide:
                child = _build_child_agent(0, "Finish guide work", None, [], None, 4, 1, owner)
                env.agents.append(child)
                assert child._free_tier_parent_turn is turn
            finished = finish_turn(owner, {"completed": True, "final_response": "Done."})
            assert finished["free_tier"]["onboarding_complete"] is True
            assert not finished.get("continuation_required")
            return turn.guide, child
    with ThreadPoolExecutor(max_workers=2) as pool:
        outcomes = list(pool.map(compete, contenders))
    assert sorted(grace for grace, _ in outcomes) == [False, True]
    child = next(child for _, child in outcomes if child is not None)
    child.compression_enabled = False
    child.save_trajectories = False
    result, _ = env.run(child, tool=True)
    assert result["completed"] and usage.status()["tool_calls_used"] == 0
    assert child._free_tier_parent_turn is None

    # Exhaustion starts normal counting, not a separate text-turn login wall.
    result, _ = env.run(agent, tool=True)
    assert result["completed"] and usage.status()["tool_calls_used"] == 1
    assert not result.get("continuation_required")
    assert result["free_tier"]["onboarding_complete"] is True

    # Reload and reprovision the profile cannot renew the identity's grace.
    importlib.reload(usage)
    shutil.rmtree(env.guide)
    assert "result" in env.rpc("profiles.ensure_onboarding", soul="Guide again")
    assert "result" in env.rpc("free_tier.provision")
    restarted = env.make_agent()
    result, _ = env.run(restarted, tool=True)
    assert result["completed"] and usage.status()["tool_calls_used"] == 2
    assert restarted._cached_system_prompt == "Stable guide prefix"
    assert "anon_guide_fixture" not in usage._usage_path().read_text()
    assert usage._usage_path().stat().st_mode & 0o077 == 0


def test_setup_completion_starts_shared_counting_in_the_same_guide_chat(guide_env, monkeypatch):
    from agent.free_tier import admit_turn, record_tool_completion, refusal
    from hermes_cli import auth, auth_nous, free_tier_usage as usage
    from tools.memory_tool import load_on_disk_store

    env = guide_env
    agent = env.make_agent()
    session = {"agent": agent, "profile_home": str(env.guide), "history": [], "running": False}
    monkeypatch.setitem(env.server._sessions, "guide", session)
    result, _ = env.run(agent, tool=True)
    assert result["completed"] and usage.status()["tool_calls_used"] == 0
    with admit_turn(agent) as blocked:
        assert blocked is None and agent._free_tier_turn.guide
        assert "error" in env.rpc("free_tier.finish_onboarding", session_id="missing")
        assert usage.onboarding_available(usage.current_identity())
        with monkeypatch.context() as m:
            m.setattr(auth, "_write_private_file_atomic", Mock(side_effect=OSError("fixture write failure")))
            assert "error" in env.rpc("free_tier.finish_onboarding", session_id="guide")
        assert usage.onboarding_available(usage.current_identity())
        response = env.rpc("free_tier.finish_onboarding", session_id="guide")
        assert response.get("result", {}).get("finished") is True
        record_tool_completion(agent)  # already-admitted work retains its reservation
    assert usage.status()["tool_calls_used"] == 0

    for _ in range(usage.TOOL_CALL_CAP):
        result, _ = env.run(agent, tool=True)
        assert result["completed"]
    assert result["continuation_required"] and result["free_tier_notice"] == usage.LIMIT_NOTICE
    assert result["messages"][-1]["content"] == "Finished."
    before = copy.deepcopy(result["messages"])
    blocked, api = env.run(agent, history=result["messages"])
    assert blocked["refusal_reason"] == usage.LIMIT_REASON and not blocked["completed"]
    assert blocked["messages"] == before and api.call_count == 0

    # Both live and agentless (mirrored or cold) gateway probes see the same gate.
    session = {"agent": agent, "profile_home": str(env.guide), "history": before, "running": False}
    monkeypatch.setattr(env.server, "_sess_nowait", lambda *a: (session, None))
    monkeypatch.setattr(env.server, "_make_agent", Mock(side_effect=AssertionError("read-only probe")))
    monkeypatch.setattr(env.server, "_apply_pending_model_switch", lambda *a: None)
    monkeypatch.setattr(env.server, "_sync_agent_model_with_config", lambda *a: None)
    stored = usage._usage_path().read_bytes()
    for mode in ("live", "mirror", "cold"):
        if mode != "live":
            session["agent"] = None
            session["_metadata_mirror"] = ({"runtime": {"base_url": agent.base_url}} if mode == "mirror" else {})
            session["model_override"] = {"provider": "nous", "model": "nous/welcome"}
        status = env.rpc("free_tier.status", session_id="guide")["result"]
        assert status["continuation_required"] and status["tool_calls_used"] == usage.TOOL_CALL_CAP
        assert status["onboarding_complete"] is True
        assert env.rpc("prompt.submit", session_id="guide", text="Not appended")["error"]["data"]["reason"] == usage.LIMIT_REASON
    assert usage._usage_path().read_bytes() == stored
    assert env.rpc("free_tier.finish_onboarding", finished=False)["result"]["finished"] is True
    assert usage.status()["tool_calls_used"] == usage.TOOL_CALL_CAP
    assert "result" in env.rpc("profiles.ensure_onboarding")
    assert refusal(agent) is not None
    token = env.set_home(str(env.home))
    try:
        assert refusal(agent) is not None  # default/first-build never gets guide grace
    finally:
        env.reset_home(token)
    agent.base_url = "http://localhost:11434/v1"
    agent._primary_runtime = None
    assert env.run(agent)[0]["completed"]
    assert usage.status()["tool_calls_used"] == usage.TOOL_CALL_CAP
    agent.base_url = env.guest["inference_base_url"]
    auth_nous._write_shared_nous_state({"access_token": "signed-in-fixture", "refresh_token": "fixture"})
    assert refusal(agent) is None

    # A fresh identity exercises the real remember RPC fallback, without layout RPC.
    guest = {**env.guest, "anon_token": "anon_handoff_fixture"}
    auth._save_active_provider_state("nous", guest)
    auth_nous._write_shared_nous_state(guest)
    assert "error" in env.rpc("profiles.remember_onboarding", answers={"name": []})
    with admit_turn(agent) as blocked:
        assert blocked is None and agent._free_tier_turn.guide
        remembered = env.rpc("profiles.remember_onboarding", answers={"name": "Fixture", "layout": "Focus"})
        assert remembered["result"]["saved"] is True
    token = env.set_home(str(env.home))
    try:
        assert any("User prefers to be called: Fixture" in entry for entry in load_on_disk_store().user_entries)
    finally:
        env.reset_home(token)
    importlib.reload(usage)
    assert "result" in env.rpc("profiles.ensure_onboarding")
    result, _ = env.run(agent, tool=True)
    assert result["completed"] and usage.status()["tool_calls_used"] == 1

    # Leaving setup for a real default-profile turn is another irreversible exit.
    guest = {**env.guest, "anon_token": "anon_default_exit_fixture"}
    auth._save_active_provider_state("nous", guest)
    auth_nous._write_shared_nous_state(guest)
    identity = usage.current_identity()
    token = env.set_home(str(env.home))
    try:
        auth._save_active_provider_state("nous", guest)
        assert refusal(agent) is None  # probes must not finish onboarding
        assert usage.onboarding_available(identity)
        result, _ = env.run(agent, tool=True)
        assert result["completed"] and usage.status()["tool_calls_used"] == 1
    finally:
        env.reset_home(token)
    assert not usage.onboarding_available(identity)
    result, _ = env.run(agent, tool=True)
    assert result["completed"] and usage.status()["tool_calls_used"] == 2
