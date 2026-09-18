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


def register(server):
    bind_module(globals(), server, skip=("_",))
    # Portal reads and cache writes can block, so the RPC must run off the server loop.
    server._LONG_HANDLERS = server._LONG_HANDLERS | {"connectors.tools"}
