"""A yielded foreground ``terminal`` result makes ``process_manage`` directly callable.

``process_manage`` is deferred behind the tool_search bridge by default. After a foreground
command yields to the background the model needs it on the very next step, and discovering it
through ``tool_describe`` + ``tool_call`` cost two model turns per yield in a live eval. The
promotion rides the existing tail-append contract for late-landing tools, so the prefix bytes
already in the request stay in place.
"""
import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from agent.tool_executor import execute_tool_calls_sequential
from run_agent import AIAgent


def _tool(name):
    return {"type": "function", "function": {"name": name, "description": "t", "parameters": {"type": "object", "properties": {}}}}


def _fake_get_tool_definitions(*_a, skip_tool_search_assembly=False, **_kw):
    # The assembled view the agent is built from defers process_manage; the raw view has it.
    return [_tool("terminal"), _tool("process_manage")] if skip_tool_search_assembly else [_tool("terminal"), _tool("tool_call")]


def _make_agent(tmp_path: Path) -> AIAgent:
    with (
        patch("model_tools.get_tool_definitions", side_effect=_fake_get_tool_definitions),
        patch("model_tools.check_toolset_requirements", return_value={}),
        patch("agent.process_bootstrap.OpenAI"),
        patch("run_agent._hermes_home", tmp_path),
        patch("agent.model_metadata.fetch_model_metadata", return_value={}),
    ):
        agent = AIAgent(api_key="test-key", base_url="https://openrouter.ai/api/v1", quiet_mode=True,
                        skip_context_files=True, skip_memory=True)
    agent._flush_messages_to_session_db = MagicMock(return_value=True)
    agent._append_guardrail_observation = MagicMock(side_effect=lambda _n, _a, result, **_k: result)
    agent._record_file_mutation_result = MagicMock()
    agent._subdirectory_hints.check_tool_call = MagicMock(return_value="")
    agent._tool_result_content_for_active_model = MagicMock(side_effect=lambda _n, result: result)
    return agent


def _terminal_call(result: dict):
    call = SimpleNamespace(id="t1", type="function", function=SimpleNamespace(name="terminal", arguments='{"command": "make"}'))
    return SimpleNamespace(tool_calls=[call]), json.dumps(result)


def test_yielded_terminal_result_promotes_process_manage_into_next_turn_tools(tmp_path):
    agent = _make_agent(tmp_path)
    before = [t["function"]["name"] for t in agent.tools]
    assert "process_manage" not in before
    assistant, yielded = _terminal_call({"output": "started", "exit_code": None, "status": "yielded_to_background",
                                         "session_id": "abc123", "notify_on_complete": True, "note": "..."})
    with (patch("model_tools.handle_function_call", return_value=yielded),
          patch("model_tools.get_tool_definitions", side_effect=_fake_get_tool_definitions)):
        execute_tool_calls_sequential(agent, assistant, [], "task")

    after = [t["function"]["name"] for t in agent.tools]
    assert after == before + ["process_manage"], after  # tail append: cached prefix bytes untouched
    assert "process_manage" in agent.valid_tool_names


def test_finished_terminal_result_leaves_the_tool_list_alone(tmp_path):
    agent = _make_agent(tmp_path)
    before = list(agent.tools)
    assistant, done = _terminal_call({"output": "yielded_to_background mentioned in output", "exit_code": 0})
    with (patch("model_tools.handle_function_call", return_value=done),
          patch("model_tools.get_tool_definitions", side_effect=_fake_get_tool_definitions)):
        execute_tool_calls_sequential(agent, assistant, [], "task")
    assert agent.tools == before
