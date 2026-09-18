"""Compose member-scoped connector-policy writes from a visible policy layer."""

from __future__ import annotations

from typing import Any

from tools.connectors.portal.client import validate_slug
from tools.connectors.portal.wire import (
    AllowPolicyBody,
    DenyAllPolicyBody,
    DenyPolicyBody,
    PolicyBody,
    UnrestrictedPolicyBody,
)


class InvalidMemberPolicy(ValueError):
    """The requested policy change cannot be represented by the member layer."""


def compose_member_write(member_body: PolicyBody | None, change: Any) -> dict[str, Any]:
    """Return the strict portal write for one connector or tool-list change."""
    body = member_body or UnrestrictedPolicyBody(mode="unrestricted")
    connector = _validated_connector(getattr(change, "connector", None))
    change_type = getattr(change, "type", None)
    table = {
        "unrestricted": _compose_unrestricted,
        "deny-all": _compose_deny_all,
        "allow": _compose_allow,
        "deny": _compose_deny,
    }
    try:
        return table[body.mode](body, change_type, connector, change)
    except KeyError as exc:
        raise InvalidMemberPolicy("unsupported policy change") from exc


def _validated_connector(value: object) -> str:
    if not isinstance(value, str):
        raise InvalidMemberPolicy("connector must be a slug")
    try:
        validate_slug(value)
    except Exception as exc:
        raise InvalidMemberPolicy("connector must be a slug") from exc
    return value


def _disabled_tools(change: Any) -> list[str]:
    value = getattr(change, "disabled_tools", None)
    if not isinstance(value, list) or len(value) > 2000:
        raise InvalidMemberPolicy("disabled_tools must be a list of at most 2000 tool slugs")
    if any(not isinstance(tool, str) or not tool or len(tool) > 256 for tool in value):
        raise InvalidMemberPolicy("disabled_tools must contain non-empty tool slugs up to 256 characters")
    return value


def _connector_change(change_type: object, change: Any) -> bool:
    enabled = getattr(change, "enabled", None)
    if change_type != "connector" or not isinstance(enabled, bool):
        raise InvalidMemberPolicy("connector change must include enabled")
    return enabled


def _list_write(key: str, values: list[str]) -> dict[str, Any]:
    return {"scope": "member", key: values}


def _tools_write(
    key: str,
    values: list[str],
    connector: str,
    change: Any,
    *,
    connector_is_off: bool,
) -> dict[str, Any]:
    if getattr(change, "type", None) != "tools":
        raise InvalidMemberPolicy("unsupported policy change")
    if connector_is_off:
        raise InvalidMemberPolicy("connector is off in the member policy")
    return {"scope": "member", key: values, "tools": {connector: _disabled_tools(change)}}


def _compose_unrestricted(
    _body: UnrestrictedPolicyBody,
    change_type: object,
    connector: str,
    change: Any,
) -> dict[str, Any]:
    values: list[str] = []
    if change_type == "connector":
        return _list_write("disabledConnectors", values if _connector_change(change_type, change) else [connector])
    return _tools_write("disabledConnectors", values, connector, change, connector_is_off=False)


def _compose_deny_all(
    _body: DenyAllPolicyBody,
    change_type: object,
    connector: str,
    change: Any,
) -> dict[str, Any]:
    values: list[str] = []
    if change_type == "connector":
        return _list_write("connectors", [connector] if _connector_change(change_type, change) else values)
    raise InvalidMemberPolicy("connector is off in the member policy")


def _compose_allow(
    body: AllowPolicyBody,
    change_type: object,
    connector: str,
    change: Any,
) -> dict[str, Any]:
    values = list(body.connectors)
    if change_type == "connector":
        enabled = _connector_change(change_type, change)
        updated = _with_membership(values, connector, enabled)
        return _list_write("connectors", updated)
    return _tools_write("connectors", values, connector, change, connector_is_off=connector not in values)


def _compose_deny(
    body: DenyPolicyBody,
    change_type: object,
    connector: str,
    change: Any,
) -> dict[str, Any]:
    values = list(body.disabled_connectors)
    if change_type == "connector":
        enabled = _connector_change(change_type, change)
        updated = _with_membership(values, connector, not enabled)
        return _list_write("disabledConnectors", updated)
    return _tools_write("disabledConnectors", values, connector, change, connector_is_off=connector in values)


def _with_membership(values: list[str], connector: str, included: bool) -> list[str]:
    retained = [item for item in values if item != connector]
    return retained if not included else [*retained, connector]
