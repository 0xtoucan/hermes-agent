"""A live conversation is re-briefed on its first tool result under a changed terminal backend."""
from types import SimpleNamespace

from agent import prompt_builder
from agent.terminal_backend_briefing import TerminalBackendBriefing


def _env(backend_name):
    return SimpleNamespace(backend_name=backend_name)


def test_no_note_until_the_prompt_backend_is_known_or_while_it_matches(monkeypatch):
    monkeypatch.setattr("tools.terminal_tool_lifecycle.get_active_env", lambda task_id: _env("mxc"))
    briefing = TerminalBackendBriefing()
    assert briefing.check_tool_call("t") is None, "no prompt built yet: nothing to compare against"
    briefing.record_prompt_backend("mxc")
    assert briefing.check_tool_call("t") is None
    monkeypatch.setattr("tools.terminal_tool_lifecycle.get_active_env", lambda task_id: None)
    assert briefing.check_tool_call("t") is None, "no environment yet (no command has run)"


def test_sandbox_turned_on_mid_conversation_is_announced_once_with_the_sandbox_notes(monkeypatch):
    monkeypatch.setattr("tools.terminal_tool_lifecycle.get_active_env", lambda task_id: _env("mxc"))
    briefing = TerminalBackendBriefing()
    briefing.record_prompt_backend("local")
    note = briefing.check_tool_call("t")
    assert note and "[Environment changed]" in note and "turned on" in note
    assert "busybox" in note and "[Sandbox]" in note, "the sandbox shell and denial notes travel with the switch"
    assert briefing.check_tool_call("t") is None, "announced once, not on every result"


def test_sandbox_turned_off_mid_conversation_is_announced_and_a_second_flip_is_announced_again(monkeypatch):
    monkeypatch.setattr("tools.terminal_tool_lifecycle.get_active_env", lambda task_id: _env("local"))
    briefing = TerminalBackendBriefing()
    briefing.record_prompt_backend("mxc")
    note = briefing.check_tool_call("t")
    assert note and "turned off" in note and "no sandbox policy" in note
    monkeypatch.setattr("tools.terminal_tool_lifecycle.get_active_env", lambda task_id: _env("mxc"))
    assert "turned on" in (briefing.check_tool_call("t") or "")


def test_switch_note_between_other_backends_names_both():
    note = prompt_builder.terminal_backend_switch_note("local", "docker")
    assert "`docker`" in note and "`local`" in note
