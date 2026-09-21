"""How the agent turn that is running can hand a sign-in link to the user.

Set once per tool batch from the agent that owns it, read by the connector dispatch path
(``model_tools`` -> ``dispatch`` -> ``gateway/bridge`` -> ``gateway/merge``), which never sees
the agent. Not the session platform: the desktop, the Ink TUI and the classic CLI all draw a
card, and the same session runs side agents that draw none.
"""

from __future__ import annotations

from contextlib import contextmanager
from contextvars import ContextVar
from typing import Any, Iterator

__all__ = [
    "CARD",
    "LINK",
    "SIDE",
    "SIDE_AGENT_TOOL_DROPS",
    "agent_connection_surface",
    "connection_surface",
    "scoped_connection_surface",
    "side_agent_tool_drops",
]

# A connection card renders for this turn: the model is told a card exists and never sees the link.
CARD = "card"
# A side agent (subagent, background turn): no card, and no link either — only the main agent connects.
SIDE = "side"
# A headless run (-q, cron, ACP, api_server, messaging): the model relays the link to the user.
LINK = "link"

_SURFACE: ContextVar[str] = ContextVar("hermes_connection_surface", default=LINK)


def connection_surface() -> str:
    return _SURFACE.get()


def agent_connection_surface(agent: Any) -> str:
    """The surface of the agent that owns the batch. A card is exactly a connection callback:
    every client that draws one attaches it. ``side_agent`` is declared at the call sites that
    build subagents and background turns, never inferred from the platform."""
    if getattr(agent, "connection_callback", None) is not None:
        return CARD
    return SIDE if getattr(agent, "side_agent", False) else LINK


# Only the main agent starts an authorization: it is the one with a user in front of it.
SIDE_AGENT_TOOL_DROPS = frozenset({"manage_connections"})


def side_agent_tool_drops(agent: Any) -> frozenset:
    """Tool names this agent must never hold; empty for a main agent. Every path that derives
    ``agent.tools`` applies it, because a rebuild re-reads the registry and would hand the tool
    back to a side agent between turns."""
    return SIDE_AGENT_TOOL_DROPS if getattr(agent, "side_agent", False) else frozenset()


@contextmanager
def scoped_connection_surface(surface: str) -> Iterator[None]:
    token = _SURFACE.set(surface)
    try:
        yield
    finally:
        _SURFACE.reset(token)
