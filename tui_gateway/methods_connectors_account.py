"""Profile-scoped connector RPCs that are not owned by a chat session."""

from .method_ctx import HandlerRegistry, bind_module

_registry = HandlerRegistry()
method = _registry.method
_profile_scoped = _registry.profile_scoped


@method("connectors.tools")
@_profile_scoped
def _(rid, params):
    from tools.connectors import connectors_available
    from tools.connectors.gateway.errors import GatewayAuthError, GatewayUnavailable
    from tools.connectors.portal.client import PortalConnectorClient, validate_slug
    from tools.connectors.portal.tools_cache import read_tools
    from tui_gateway.contracts.connectors import (
        ConnectorErrorReason,
        ConnectorToolRow,
        ConnectorToolsResult,
    )

    if not connectors_available():
        return _connector_rpc_error(
            rid,
            4031,
            ConnectorErrorReason.connectors_unavailable,
            "Connectors are not available.",
        )
    slug = params.get("slug")
    refresh = params.get("refresh", False)
    if not isinstance(slug, str) or not isinstance(refresh, bool):
        return _connector_rpc_error(
            rid,
            4000,
            ConnectorErrorReason.invalid_params,
            "slug and refresh are required parameters",
        )
    try:
        validate_slug(slug)
        client = PortalConnectorClient()
        client.require_authentication()
        listing = read_tools(slug, client=client, refresh=refresh)
    except GatewayAuthError:
        return _connector_rpc_error(
            rid,
            4032,
            ConnectorErrorReason.needs_nous_auth,
            "Sign in to use connectors.",
        )
    except GatewayUnavailable:
        return _connector_rpc_error(
            rid,
            4041,
            ConnectorErrorReason.connector_not_found,
            "Connector not found.",
        )
    except Exception:
        # Upstream failures and local cache I/O end the same way: a fixed reason, never the exception text.
        return _connector_rpc_error(
            rid,
            5034,
            ConnectorErrorReason.tools_unavailable,
            "Connector tools are unavailable.",
        )
    result = ConnectorToolsResult(
        connector=listing.connector,
        toolkit_version=listing.toolkit_version,
        etag=listing.etag,
        fetched_at=listing.fetched_at,
        source=listing.source,
        stale=listing.stale,
        tools=[
            ConnectorToolRow(
                slug=tool.slug,
                name=tool.name,
                description=tool.description,
                facet=tool.facet,
                hints=tool.hints,
                categories=tool.categories,
                deprecated=tool.deprecated,
            )
            for tool in listing.tools
        ],
    )
    return _ok(rid, result.model_dump(mode="json"))


@method("connectors.catalog")
@_profile_scoped
def _(rid, params):
    from tools.connectors import connectors_available
    from tools.connectors.gateway.errors import GatewayAuthError
    from tools.connectors.portal.client import PortalConnectorClient
    from tui_gateway.contracts.connectors import ConnectorCatalogRow, ConnectorErrorReason, ConnectorsCatalogResult

    if not connectors_available():
        return _connector_rpc_error(rid, 4031, ConnectorErrorReason.connectors_unavailable, "Connectors are not available.")
    try:
        client = PortalConnectorClient()
        client.require_authentication()
        catalog = client.catalog()
    except GatewayAuthError:
        return _connector_rpc_error(rid, 4032, ConnectorErrorReason.needs_nous_auth, "Sign in to use connectors.")
    except Exception:
        return _connector_rpc_error(rid, 5034, ConnectorErrorReason.catalog_unavailable, "Connector catalog is unavailable.")
    result = ConnectorsCatalogResult(
        connectors=[
            ConnectorCatalogRow(
                slug=row.slug,
                name=row.name,
                description=row.description,
                category=row.category,
                logo_url=row.logo_url,
            )
            for row in catalog.connectors
        ]
    )
    return _ok(rid, result.model_dump(mode="json"))


@method("connectors.accounts")
@_profile_scoped
def _(rid, params):
    from tools.connectors import connectors_available
    from tools.connectors.gateway.client import ConnectorClient
    from tools.connectors.gateway.errors import GatewayAuthError, GatewayUnavailable
    from tools.connectors.portal.client import validate_slug
    from tui_gateway.contracts.connectors import ConnectorAccountRow, ConnectorAccountsResult, ConnectorErrorReason

    if not connectors_available():
        return _connector_rpc_error(rid, 4031, ConnectorErrorReason.connectors_unavailable, "Connectors are not available.")
    connector = params.get("connector")
    if connector is not None:
        # Refused before the gateway call: a bad filter is the caller's error, not an outage.
        try:
            validate_slug(connector)
        except (GatewayUnavailable, TypeError):
            return _connector_rpc_error(rid, 4000, ConnectorErrorReason.invalid_params, "connector must be a slug.")
    try:
        accounts = ConnectorClient().list_accounts()
    except GatewayAuthError:
        return _connector_rpc_error(rid, 4032, ConnectorErrorReason.needs_nous_auth, "Sign in to use connectors.")
    except Exception:
        return _connector_rpc_error(rid, 5034, ConnectorErrorReason.accounts_unavailable, "Connector accounts are unavailable.")
    rows = [account for account in accounts if connector is None or account["connector"] == connector]
    result = ConnectorAccountsResult(accounts=[ConnectorAccountRow(
        connection_id=account["connectionId"],
        connector=account["connector"],
        status=account["status"],
        status_reason=account.get("statusReason"),
        label=account["label"],
        alias=account.get("alias"),
        active=account["active"],
        created_at=account["createdAt"],
        updated_at=account["updatedAt"],
    ) for account in rows])
    return _ok(rid, result.model_dump(mode="json"))


@method("connectors.accounts.remove")
@_profile_scoped
def _(rid, params):
    from tools.connectors import connectors_available
    from tools.connectors.gateway.client import ConnectorClient
    from tools.connectors.gateway.errors import GatewayAuthError, GatewayUnavailable
    from tui_gateway.contracts.connectors import ConnectorAccountsRemoveResult, ConnectorErrorReason

    if not connectors_available():
        return _connector_rpc_error(rid, 4031, ConnectorErrorReason.connectors_unavailable, "Connectors are not available.")
    connection_id = params.get("connection_id")
    if not isinstance(connection_id, str) or not connection_id:
        return _connector_rpc_error(rid, 4000, ConnectorErrorReason.invalid_params, "connection_id is required.")
    try:
        removed = ConnectorClient().delete_account(connection_id)
    except GatewayAuthError:
        return _connector_rpc_error(rid, 4032, ConnectorErrorReason.needs_nous_auth, "Sign in to use connectors.")
    except GatewayUnavailable as exc:
        # Only the gateway's own "no such account" is a missing card; an unresolved origin or a
        # dark route is an outage, and the card must stay.
        if exc.code == "connection_not_found":
            return _connector_rpc_error(rid, 4041, ConnectorErrorReason.connection_not_found, "Connector account not found.")
        return _connector_rpc_error(rid, 5034, ConnectorErrorReason.accounts_unavailable, "Connector accounts are unavailable.")
    except Exception:
        return _connector_rpc_error(rid, 5034, ConnectorErrorReason.accounts_unavailable, "Connector accounts are unavailable.")
    result = ConnectorAccountsRemoveResult(connection_id=removed["connectionId"], status=removed["status"])
    return _ok(rid, result.model_dump(mode="json"))


@method("connectors.policy.get")
@_profile_scoped
def _(rid, params):
    from tools.connectors import connectors_available
    from tools.connectors.gateway.errors import GatewayAuthError
    from tools.connectors.portal.client import PortalConnectorClient
    from tui_gateway.contracts.connectors import (
        ConnectorErrorReason,
        ConnectorPolicyAllowBody,
        ConnectorPolicyDenyAllBody,
        ConnectorPolicyDenyBody,
        ConnectorPolicyGetResult,
        ConnectorPolicyLayer,
        ConnectorPolicyTags,
        ConnectorPolicyUnrestrictedBody,
    )

    if not connectors_available():
        return _connector_rpc_error(rid, 4031, ConnectorErrorReason.connectors_unavailable, "Connectors are not available.")
    try:
        client = PortalConnectorClient()
        client.require_authentication()
        policy = client.policy()
    except GatewayAuthError:
        return _connector_rpc_error(rid, 4032, ConnectorErrorReason.needs_nous_auth, "Sign in to use connectors.")
    except Exception:
        return _connector_rpc_error(rid, 5034, ConnectorErrorReason.policy_unavailable, "Connector policy is unavailable.")
    result = ConnectorPolicyGetResult(layers=[
        ConnectorPolicyLayer(kind=layer.kind, revision=layer.revision, body=_contract_policy_body(
            layer.body,
            ConnectorPolicyAllowBody,
            ConnectorPolicyDenyAllBody,
            ConnectorPolicyDenyBody,
            ConnectorPolicyTags,
            ConnectorPolicyUnrestrictedBody,
        ))
        for layer in policy.layers
    ])
    return _ok(rid, result.model_dump(mode="json"))


@method("connectors.policy.set")
@_profile_scoped
def _(rid, params):
    from pydantic import ValidationError
    from tools.connectors import connectors_available
    from tools.connectors.gateway.errors import GatewayAuthError, ToolGatewayError
    from tools.connectors.portal.client import PortalConnectorClient
    from tools.connectors.portal.policy import InvalidMemberPolicy, compose_member_write
    from tui_gateway.contracts.connectors import (
        ConnectorErrorReason,
        ConnectorPolicySetParams,
        ConnectorPolicySetResult,
    )

    if not connectors_available():
        return _connector_rpc_error(rid, 4031, ConnectorErrorReason.connectors_unavailable, "Connectors are not available.")
    try:
        request = ConnectorPolicySetParams.model_validate(params)
    except ValidationError:
        return _connector_rpc_error(rid, 4000, ConnectorErrorReason.invalid_policy, "Connector policy change is invalid.")
    try:
        client = PortalConnectorClient()
        client.require_authentication()
        policy = client.policy()
        member = next((layer.body for layer in policy.layers if layer.kind == "member"), None)
        body = compose_member_write(member, request.change)
        if request.expected_revision is not None:
            body["expectedRevision"] = request.expected_revision
        result = client.set_policy(body)
    except GatewayAuthError as exc:
        if exc.status == 403:
            return _connector_rpc_error(rid, 4030, ConnectorErrorReason.forbidden_scope, "Connector policy cannot be changed for this member.")
        return _connector_rpc_error(rid, 4032, ConnectorErrorReason.needs_nous_auth, "Sign in to use connectors.")
    except InvalidMemberPolicy:
        return _connector_rpc_error(rid, 4000, ConnectorErrorReason.invalid_policy, "Connector policy change is invalid.")
    except ToolGatewayError as exc:
        error = _policy_error(exc, ConnectorErrorReason)
        if error is not None:
            return _connector_rpc_error(rid, *error)
        return _connector_rpc_error(rid, 5034, ConnectorErrorReason.policy_unavailable, "Connector policy is unavailable.")
    except Exception:
        return _connector_rpc_error(rid, 5034, ConnectorErrorReason.policy_unavailable, "Connector policy is unavailable.")
    return _ok(rid, ConnectorPolicySetResult(revision=result.revision).model_dump(mode="json"))


def _contract_policy_body(body, allow, deny_all, deny, tags, unrestricted):
    raw_tags = getattr(body, "tags", None)
    rendered_tags = None if raw_tags is None else tags(enable=raw_tags.enable, disable=raw_tags.disable)
    if body.mode == "unrestricted":
        return unrestricted(mode=body.mode)
    if body.mode == "deny-all":
        return deny_all(mode=body.mode)
    tools = {connector: rule.disable for connector, rule in body.tools.items()}
    if body.mode == "allow":
        return allow(mode=body.mode, connectors=body.connectors, tools=tools, tags=rendered_tags)
    return deny(mode=body.mode, disabled_connectors=body.disabled_connectors, tools=tools, tags=rendered_tags)


def _policy_error(exc, reasons):
    table = {
        400: (4000, reasons.invalid_policy, "Connector policy change is invalid."),
        403: (4030, reasons.forbidden_scope, "Connector policy cannot be changed for this member."),
        409: (4090, reasons.policy_conflict, "Connector policy changed. Refresh and try again."),
    }
    return table.get(exc.status)


def register(server):
    bind_module(globals(), server, skip=("_",))
    # Portal and tool gateway reads and writes can block, so these RPCs must run off the server loop.
    server._LONG_HANDLERS = server._LONG_HANDLERS | {
        "connectors.tools",
        "connectors.catalog",
        "connectors.accounts",
        "connectors.accounts.remove",
        "connectors.policy.get",
        "connectors.policy.set",
    }
