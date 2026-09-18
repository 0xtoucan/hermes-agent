"""Errors specific to connector tool listings from the portal."""

from __future__ import annotations

from tools.connectors.gateway.errors import ToolGatewayError


class PortalToolsUnavailable(ToolGatewayError):
    """The portal cannot provide a connector's tool list right now."""
