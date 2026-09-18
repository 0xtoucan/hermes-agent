"""Typed wire shapes for connector tool listings from the portal."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator


class ConnectorTool(BaseModel):
    """One connector tool made available by the portal."""

    model_config = ConfigDict(extra="ignore", populate_by_name=True, strict=True)

    slug: str
    name: str
    description: str
    facet: Literal["read", "write", "destructive", "unclassified"] = "unclassified"
    hints: list[str] = Field(default_factory=list)
    categories: list[str] = Field(default_factory=list)
    no_auth: bool = Field(default=False, alias="noAuth")
    deprecated: bool = False

    @field_validator("facet", mode="before")
    @classmethod
    def _unknown_facet_is_unclassified(cls, value: object) -> object:
        if not isinstance(value, str):
            return value
        return value if value in {"read", "write", "destructive", "unclassified"} else "unclassified"

    @field_validator("categories")
    @classmethod
    def _normalize_categories(cls, value: list[str]) -> list[str]:
        return [category.lower() for category in value]


class ConnectorToolsListing(BaseModel):
    """The complete list for one connector at a portal toolkit version."""

    model_config = ConfigDict(extra="ignore", populate_by_name=True, strict=True)

    connector: str
    toolkit_version: str = Field(alias="toolkitVersion")
    etag: str
    tools: list[ConnectorTool]
