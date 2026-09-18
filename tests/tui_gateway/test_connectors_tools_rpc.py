"""Connectors tool-list RPC behavior through the JSON-RPC dispatch rail."""

from __future__ import annotations

import time

from tools.connectors.gateway.errors import GatewayAuthError
from tools.connectors.portal.tools_cache import ToolsRead
from tools.connectors.portal.wire import ConnectorToolsListing


_DESCRIPTION = "D" * 200


def _listing():
    return ConnectorToolsListing.model_validate(
        {
            "connector": "mail-service",
            "toolkitVersion": "2026.1",
            "etag": '"v1"',
            "tools": [
                {
                    "slug": "MAIL_SERVICE_SEND",
                    "name": "Send message",
                    "description": _DESCRIPTION,
                    "facet": "write",
                    "hints": ["createHint"],
                    "categories": ["messaging"],
                    "noAuth": False,
                    "deprecated": False,
                }
            ],
        }
    )


class _ReplyTransport:
    def __init__(self):
        self.frames = []

    def write(self, obj):
        self.frames.append(obj)
        return True

    def close(self):
        pass


def _reply(transport, *, slug="mail-service"):
    from tui_gateway import server

    server.dispatch(
        {
            "jsonrpc": "2.0",
            "id": 7,
            "method": "connectors.tools",
            "params": {"slug": slug},
        },
        transport,
    )
    deadline = time.time() + 2
    while time.time() < deadline:
        if transport.frames:
            return transport.frames[-1]
        time.sleep(0.01)
    raise AssertionError("connectors.tools did not reply")

def test_connector_tools_rpc_returns_the_typed_result(monkeypatch):
    monkeypatch.setattr("tools.connectors.connectors_available", lambda: True)
    monkeypatch.setattr("tools.connectors.portal.client.PortalConnectorClient.require_authentication", lambda self: None)
    listing = _listing()
    result = ToolsRead(
        connector="mail-service",
        toolkit_version="2026.1",
        etag='"v1"',
        fetched_at=123.0,
        source="network",
        stale=False,
        tools=listing.tools,
    )
    monkeypatch.setattr("tools.connectors.portal.tools_cache.read_tools", lambda *args, **kwargs: result)

    transport = _ReplyTransport()
    reply = _reply(transport)

    from tui_gateway import server

    assert "connectors.tools" in server._LONG_HANDLERS
    assert reply["result"] == {
        "connector": "mail-service",
        "toolkit_version": "2026.1",
        "etag": '"v1"',
        "fetched_at": 123.0,
        "source": "network",
        "stale": False,
        "tools": [
            {
                "slug": "MAIL_SERVICE_SEND",
                "name": "Send message",
                "description": _DESCRIPTION,
                "facet": "write",
                "hints": ["createHint"],
                "categories": ["messaging"],
                "deprecated": False,
            }
        ],
    }


def test_connector_tools_rpc_turns_unexpected_failures_into_typed_errors(monkeypatch):
    monkeypatch.setattr("tools.connectors.connectors_available", lambda: True)
    monkeypatch.setattr("tools.connectors.portal.client.PortalConnectorClient.require_authentication", lambda self: None)

    def read_tools(*args, **kwargs):
        raise OSError("cache write detail")

    monkeypatch.setattr("tools.connectors.portal.tools_cache.read_tools", read_tools)

    reply = _reply(_ReplyTransport())

    assert reply["error"] == {
        "code": 5034,
        "message": "Connector tools are unavailable.",
        "data": {"reason": "TOOLS_UNAVAILABLE"},
    }


def test_connector_tools_rpc_hides_auth_error_details(monkeypatch):
    monkeypatch.setattr("tools.connectors.connectors_available", lambda: True)
    monkeypatch.setattr("tools.connectors.portal.client.PortalConnectorClient.require_authentication", lambda self: None)
    calls = []

    def read_tools(*args, **kwargs):
        calls.append((args, kwargs))
        raise GatewayAuthError("upstream detail")

    monkeypatch.setattr("tools.connectors.portal.tools_cache.read_tools", read_tools)

    reply = _reply(_ReplyTransport())

    assert calls
    assert reply["error"] == {
        "code": 4032,
        "message": "Sign in to use connectors.",
        "data": {"reason": "NEEDS_NOUS_AUTH"},
    }
