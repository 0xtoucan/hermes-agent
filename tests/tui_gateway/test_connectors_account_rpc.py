"""Account-level connector RPC behavior through the JSON-RPC dispatch rail."""

from __future__ import annotations

import time


class _ReplyTransport:
    def __init__(self):
        self.frames = []

    def write(self, obj):
        self.frames.append(obj)
        return True

    def close(self):
        pass


def _reply(transport, method, params):
    from tui_gateway import server

    server.dispatch({"jsonrpc": "2.0", "id": 7, "method": method, "params": params}, transport)
    deadline = time.time() + 2
    while time.time() < deadline:
        if transport.frames:
            return transport.frames[-1]
        time.sleep(0.01)
    raise AssertionError(f"{method} did not reply")


def test_policy_set_surfaces_conflict_and_preserves_the_seen_revision(monkeypatch):
    from tools.connectors.gateway.errors import ToolGatewayError
    from tools.connectors.portal.wire import ConnectorPolicyResponse

    class Client:
        sent = None

        def require_authentication(self):
            return None

        def policy(self):
            return ConnectorPolicyResponse.model_validate({"layers": []})

        def set_policy(self, body):
            type(self).sent = body
            raise ToolGatewayError("hidden", status=409)

    monkeypatch.setattr("tools.connectors.connectors_available", lambda: True)
    monkeypatch.setattr("tools.connectors.portal.client.PortalConnectorClient", Client)

    reply = _reply(_ReplyTransport(), "connectors.policy.set", {
        "change": {"type": "tools", "connector": "linear", "disabled_tools": ["create"]},
        "expected_revision": "shown-revision",
    })

    assert Client.sent == {
        "scope": "member",
        "disabledConnectors": [],
        "tools": {"linear": ["create"]},
        "expectedRevision": "shown-revision",
    }
    assert reply["error"] == {
        "code": 4090,
        "message": "Connector policy changed. Refresh and try again.",
        "data": {"reason": "POLICY_CONFLICT"},
    }


def test_account_remove_maps_not_found_and_returns_the_removed_account(monkeypatch):
    from tools.connectors.gateway.errors import GatewayUnavailable

    class Client:
        outcome = None

        def delete_account(self, connection_id):
            outcome = type(self).outcome
            if isinstance(outcome, Exception):
                raise outcome
            return outcome

    monkeypatch.setattr("tools.connectors.connectors_available", lambda: True)
    monkeypatch.setattr("tools.connectors.gateway.client.ConnectorClient", Client)

    Client.outcome = GatewayUnavailable("hidden", code="connection_not_found", status=404)
    missing = _reply(_ReplyTransport(), "connectors.accounts.remove", {"connection_id": "ca_missing"})
    Client.outcome = {"connectionId": "ca_1", "status": "removed"}
    removed = _reply(_ReplyTransport(), "connectors.accounts.remove", {"connection_id": "ca_1"})

    assert missing["error"] == {
        "code": 4041,
        "message": "Connector account not found.",
        "data": {"reason": "CONNECTION_NOT_FOUND"},
    }
    assert removed["result"] == {"connection_id": "ca_1", "status": "removed"}
