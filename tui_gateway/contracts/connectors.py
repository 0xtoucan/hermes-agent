"""Contracts for connector catalog, authorization, and tool-list reads."""

from __future__ import annotations

from .base import Result, WireEnum
from .common import OpenModel, ProfileParams
from .connectors_operation import ConnectionOperationStatus
from .registry import method


class ConnectorErrorReason(WireEnum):
    invalid_params = "INVALID_PARAMS"
    needs_nous_auth = "NEEDS_NOUS_AUTH"
    connector_not_found = "CONNECTOR_NOT_FOUND"
    tools_unavailable = "TOOLS_UNAVAILABLE"
    connectors_unavailable = "CONNECTORS_UNAVAILABLE"


class ConnectorsListParams(ProfileParams):
    session_id: str


class ConnectorRow(OpenModel):
    """One ``manage_connections`` status entry after ``connector_ui_payload`` redaction; the
    connector service owns the closed key set, so unknown metadata passes through."""

    connector: str = ""
    connected: bool | None = None
    enabled: bool | None = None
    connectionStatus: str | None = None
    name: str | None = None
    description: str | None = None


class ConnectorsListResult(Result):
    available: bool
    connectors: list[ConnectorRow]


method(
    "connectors.list",
    params=ConnectorsListParams,
    result=ConnectorsListResult,
    doc="Connector catalog + connection state for one owned session (``available=False`` when the toolset is off).",
)


class ConnectorsConnectParams(ProfileParams):
    session_id: str
    connectors: list[str]
    reconnect: bool = False


class ConnectorsConnectResult(ConnectionOperationStatus):
    """The operation the connect opened (or re-minted on): ``tools/connectors/managed.py``
    ``_off_desktop_result`` / ``methods_connectors._reissue``. ``status``/``note`` ride along from
    the tool result when the call ran through ``manage_connections``."""

    status: str | None = None
    note: str | None = None


method(
    "connectors.connect",
    params=ConnectorsConnectParams,
    result=ConnectorsConnectResult,
    doc="Start (or re-initiate) authorization for named connectors on the session's connection operation.",
)


class ConnectorToolsParams(ProfileParams):
    slug: str
    refresh: bool = False


class ConnectorToolFacet(WireEnum):
    read = "read"
    write = "write"
    destructive = "destructive"
    unclassified = "unclassified"


class ConnectorToolRow(Result):
    slug: str
    name: str
    description: str
    facet: ConnectorToolFacet
    hints: list[str]
    categories: list[str]
    deprecated: bool


class ConnectorToolsSource(WireEnum):
    cache = "cache"
    network = "network"
    revalidated = "revalidated"


class ConnectorToolsResult(Result):
    connector: str
    toolkit_version: str
    etag: str
    fetched_at: float
    source: ConnectorToolsSource
    stale: bool
    tools: list[ConnectorToolRow]


method(
    "connectors.tools",
    params=ConnectorToolsParams,
    result=ConnectorToolsResult,
    doc="The scoped profile's cached or current tool list for one connector.",
)
