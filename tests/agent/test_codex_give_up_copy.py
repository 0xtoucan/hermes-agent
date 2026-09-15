"""The Codex hidden-reasoning give-up must read as a plain sentence with next steps on every
surface, while the gateway keeps suppressing it (peer-agent loops, #51628). Regression for
the raw ``Codex response remained incomplete after 3 continuation attempts`` reply (#61128).
"""
from __future__ import annotations

from types import SimpleNamespace

from agent.turn_truncation import continue_codex_incomplete
from gateway.run import _is_gateway_hidden_reasoning_incomplete_turn, _normalize_empty_agent_response


def _exhausted_agent():
    return SimpleNamespace(
        model="gpt-5-codex", log_prefix="", _codex_incomplete_retries=3,
        _build_assistant_message=lambda m, fr: {"role": "assistant", "content": ""},
        _emit_wait_notice=lambda *_: None, _persist_session=lambda *_: None, _session_messages=None,
    )


def test_codex_give_up_is_plain_language_for_users_and_still_silent_on_gateway():
    agent = _exhausted_agent()
    agent._codex_incomplete_retries = 3  # this call is the 4th attempt → give up
    result = continue_codex_incomplete(
        agent, SimpleNamespace(content=None, reasoning=None), "incomplete",
        messages=[{"role": "user", "content": "hi"}], conversation_history=[], api_call_count=4,
    )
    assert result is not None and result["partial"] and not result.get("completed")
    text = result["final_response"]
    assert "remained incomplete" not in text
    assert "/retry" in text and "/reasoning low" in text and "gpt-5-codex" in text
    assert result["failure_reason"] == "empty_response"
    # Gateway: suppressed rather than delivered, exactly as before the copy change
    # (run_turn.py blanks the response on this predicate before normalizing).
    assert _is_gateway_hidden_reasoning_incomplete_turn(result)
    assert _normalize_empty_agent_response(result, "") == ""
