"""A small HTTP client; the scientific agent loop stays in the OpenScience server."""

from .client import (
    Client,
    ConnectionError,
    CursorError,
    EventGapError,
    HTTPError,
    ProtocolError,
    RuntimeEvent,
)

__all__ = [
    "Client",
    "ConnectionError",
    "CursorError",
    "EventGapError",
    "HTTPError",
    "ProtocolError",
    "RuntimeEvent",
]
