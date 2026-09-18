"""HTTP client for the portal connector-tool listing route."""

from __future__ import annotations

from dataclasses import dataclass
import re
from typing import Any, Callable, Mapping, Protocol

import requests
from pydantic import ValidationError

from hermes_cli.nous_account import resolve_nous_portal_base_url
from tools.connectors.gateway.errors import (
    GatewayAuthError,
    GatewayUnavailable,
    ToolGatewayError,
    parse_gateway_error,
)
from tools.connectors.portal.errors import PortalToolsUnavailable
from tools.connectors.portal.wire import ConnectorToolsListing
from tools.managed_gateway_auth import read_nous_access_token


DEFAULT_TIMEOUT_SECONDS = 30.0
_SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9_-]*$")


class Transport(Protocol):
    def request(
        self,
        method: str,
        url: str,
        *,
        headers: dict[str, str] | None = None,
        timeout: float | None = None,
    ) -> Any: ...


@dataclass(frozen=True)
class NotModified:
    """The portal confirmed that the caller's cached listing remains current."""


def validate_slug(slug: str) -> None:
    if not _SLUG_RE.fullmatch(slug):
        raise GatewayUnavailable("connector not found", code="CONNECTOR_NOT_FOUND", status=404)


def _default_transport() -> Transport:
    return requests


def _default_endpoint_resolver() -> str:
    return resolve_nous_portal_base_url()


def _default_header_provider(_url: str) -> dict[str, str]:
    token = read_nous_access_token()
    return {"Authorization": f"Bearer {token}"} if isinstance(token, str) and token.strip() else {}


class PortalConnectorClient:
    """Fetch one connector's typed tools, without retries or response-body logging."""

    def __init__(
        self,
        *,
        transport: Transport | None = None,
        endpoint_resolver: Callable[[], str] | None = None,
        header_provider: Callable[[str], dict[str, str]] | None = None,
    ) -> None:
        self._transport = transport or _default_transport()
        self._endpoint_resolver = endpoint_resolver or _default_endpoint_resolver
        self._header_provider = header_provider or _default_header_provider

    def origin(self) -> str:
        return self._endpoint_resolver().rstrip("/")

    def require_authentication(self) -> None:
        headers = self._header_provider(self.origin())
        if not isinstance(headers.get("Authorization"), str) or not headers["Authorization"].strip():
            raise GatewayAuthError("portal authorization required", code="NO_TOKEN", status=401)

    def tools(self, slug: str, *, if_none_match: str | None = None) -> ConnectorToolsListing | NotModified:
        validate_slug(slug)
        url = f"{self.origin()}/api/v1/connectors/{slug}/tools"
        headers = {"Accept": "application/json", **self._header_provider(url)}
        if not isinstance(headers.get("Authorization"), str) or not headers["Authorization"].strip():
            raise GatewayAuthError("portal authorization required", code="NO_TOKEN", status=401)
        if if_none_match:
            headers["If-None-Match"] = if_none_match
        try:
            response = self._transport.request("GET", url, headers=headers, timeout=DEFAULT_TIMEOUT_SECONDS)
        except Exception as exc:
            raise PortalToolsUnavailable("portal tools unavailable", code="TRANSPORT_ERROR", retryable=True) from exc
        status = int(getattr(response, "status_code", 0))
        if status == 304:
            return NotModified()
        if not 200 <= status < 300:
            error = parse_gateway_error(status, _safe_json(response), getattr(response, "headers", None))
            if type(error) is ToolGatewayError:
                raise PortalToolsUnavailable(
                    "portal tools unavailable",
                    code=error.code,
                    status=error.status,
                    request_id=error.request_id,
                    retryable=error.retryable,
                ) from error
            raise error
        try:
            payload = response.json()
            if not isinstance(payload, Mapping):
                raise ValueError("response must be an object")
            listing = ConnectorToolsListing.model_validate(payload)
        except (AttributeError, TypeError, ValueError, ValidationError) as exc:
            raise PortalToolsUnavailable("portal tools unavailable", code="INVALID_RESPONSE", status=status) from exc
        etag = getattr(response, "headers", {}).get("etag")
        return listing.model_copy(update={"etag": etag}) if isinstance(etag, str) and etag else listing


def _safe_json(response: Any) -> Any:
    try:
        return response.json()
    except Exception:
        return None
