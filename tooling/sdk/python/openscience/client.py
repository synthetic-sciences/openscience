"""OpenScience runtime protocol 1.0 using Python's standard library only.

Commands are never retried implicitly. SSE reconnects, when explicitly enabled,
resume from the last delivered sequence. Expired cursors require a fresh snapshot;
this client never silently skips the retention gap or repeats a prompt.
"""

from __future__ import annotations

import http.client
import io
import json
import math
import time
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Iterator
from dataclasses import dataclass
from typing import Any, BinaryIO, Literal


class ProtocolError(RuntimeError):
    """The response cannot be interpreted as the advertised protocol."""


class ConnectionError(RuntimeError):
    """A transport failed; a submitted command may already have been accepted."""


class HTTPError(RuntimeError):
    def __init__(self, status: int, body: Any):
        self.status = status
        self.body = body
        self.code = body.get("error") if isinstance(body, dict) else None
        super().__init__(
            f"OpenScience HTTP {status}" + (f": {self.code}" if self.code else "")
        )


class CursorError(HTTPError):
    """Resynchronize with snapshot() before opening another event stream."""

    @property
    def oldest_sequence(self) -> int | None:
        return self.body.get("oldestSequence")

    @property
    def latest_sequence(self) -> int | None:
        return self.body.get("latestSequence")


class EventGapError(ProtocolError):
    def __init__(self, expected: int, received: int):
        self.expected = expected
        self.received = received
        super().__init__(
            f"Event sequence gap: expected {expected}, received {received}; resynchronize with snapshot()"
        )


@dataclass(frozen=True)
class RuntimeEvent:
    sequence: int
    type: str
    session_id: str
    run_id: str
    time: int
    properties: dict[str, Any]

    @classmethod
    def parse(
        cls, data: dict[str, Any], *, event_id: str, event_type: str
    ) -> RuntimeEvent:
        sequence = data.get("sequence")
        if type(sequence) is not int or sequence < 1 or event_id != str(sequence):
            raise ProtocolError("SSE id must match a positive runtime sequence")
        if not isinstance(data.get("type"), str) or event_type != data["type"]:
            raise ProtocolError("SSE event name must match runtime event type")
        if not all(
            isinstance(data.get(key), str) and data[key]
            for key in ("sessionID", "runID")
        ):
            raise ProtocolError("Runtime event is missing session or run identity")
        if type(data.get("time")) is not int or not isinstance(
            data.get("properties"), dict
        ):
            raise ProtocolError("Runtime event is missing timestamp or properties")
        return cls(
            sequence,
            data["type"],
            data["sessionID"],
            data["runID"],
            data["time"],
            data["properties"],
        )


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        # A runtime API has no redirect contract. In particular, do not forward
        # a deployment bearer token to a different origin or login service.
        return None


def _decode(raw: bytes) -> Any:
    try:
        return json.loads(raw)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ProtocolError("Runtime response is not valid JSON") from error


def _sse(source: BinaryIO, max_event_bytes: int) -> Iterator[RuntimeEvent]:
    # Universal newlines cover LF, CRLF and CR; the incremental decoder handles
    # UTF-8 characters split across network reads. Comments are heartbeats.
    with io.TextIOWrapper(source, encoding="utf-8-sig", newline=None) as lines:
        data: list[str] = []
        event_id = ""
        event_type = "message"
        size = 0
        while True:
            try:
                line = lines.readline(max_event_bytes + 1)
            except UnicodeDecodeError as error:
                raise ProtocolError("Runtime SSE data is not valid UTF-8") from error
            if not line:
                # SSE dispatches only on an empty line. Never accept a partial
                # final frame when the socket closes mid-event.
                if data:
                    raise ConnectionError(
                        "Runtime event stream ended within an SSE event"
                    )
                return
            size += len(line.encode("utf-8"))
            if size > max_event_bytes:
                raise ProtocolError(
                    "Runtime SSE event exceeds the configured size limit"
                )
            line = line.removesuffix("\n")
            if not line:
                if data:
                    parsed = _decode("\n".join(data).encode("utf-8"))
                    if not isinstance(parsed, dict):
                        raise ProtocolError("Runtime SSE data must be an object")
                    yield RuntimeEvent.parse(
                        parsed, event_id=event_id, event_type=event_type
                    )
                data = []
                event_id = ""
                event_type = "message"
                size = 0
                continue
            if line.startswith(":"):
                continue
            field, _, value = line.partition(":")
            value = value.removeprefix(" ")
            if field == "data":
                data.append(value)
            elif field == "event":
                event_type = value
            elif field == "id" and "\x00" not in value:
                event_id = value


class Client:
    def __init__(
        self,
        base_url: str = "http://127.0.0.1:4096",
        *,
        token: str | None = None,
        directory: str | None = None,
        timeout: float = 60,
        max_response_bytes: int = 32 * 1024 * 1024,
        max_event_bytes: int = 4 * 1024 * 1024,
    ):
        url = urllib.parse.urlsplit(base_url)
        if (
            url.scheme not in ("http", "https")
            or not url.hostname
            or url.username
            or url.password
            or url.query
            or url.fragment
        ):
            raise ValueError(
                "base_url must be an HTTP(S) origin/path without credentials, query, or fragment"
            )
        if token is not None and (not token or "\r" in token or "\n" in token):
            raise ValueError("token must be a nonempty single-line bearer token")
        if (
            not math.isfinite(timeout)
            or timeout <= 0
            or type(max_response_bytes) is not int
            or max_response_bytes <= 0
            or type(max_event_bytes) is not int
            or max_event_bytes <= 0
        ):
            raise ValueError("timeouts and response limits must be positive")
        self.base_url = base_url.rstrip("/")
        self.directory = directory
        self.timeout = timeout
        self.max_response_bytes = max_response_bytes
        self.max_event_bytes = max_event_bytes
        self._token = token
        self._opener = urllib.request.build_opener(_NoRedirect())

    def _open(self, method: str, path: str, *, query=None, body=None, headers=None):
        parameters = {
            key: value for key, value in (query or {}).items() if value is not None
        }
        if self.directory is not None:
            parameters["directory"] = self.directory
        url = self.base_url + path
        if parameters:
            url += "?" + urllib.parse.urlencode(parameters)
        request_headers = {"Accept": "application/json", **(headers or {})}
        if self._token:
            request_headers["Authorization"] = "Bearer " + self._token
        payload = (
            None if body is None else json.dumps(body, allow_nan=False).encode("utf-8")
        )
        if payload is not None:
            request_headers["Content-Type"] = "application/json"
        request = urllib.request.Request(
            url, data=payload, headers=request_headers, method=method
        )
        try:
            return self._opener.open(request, timeout=self.timeout)
        except urllib.error.HTTPError as error:
            with error:
                raw = error.read(self.max_response_bytes + 1)
            try:
                detail = _decode(raw) if len(raw) <= self.max_response_bytes else None
            except ProtocolError:
                detail = None
            cls = (
                CursorError
                if error.code == 409
                and isinstance(detail, dict)
                and detail.get("error") in ("cursor_expired", "cursor_ahead")
                else HTTPError
            )
            raise cls(error.code, detail) from None
        except (urllib.error.URLError, OSError) as error:
            raise ConnectionError(
                "Runtime connection failed; a submitted command may already be accepted"
            ) from error

    def _request(self, method: str, path: str, *, query=None, body=None) -> Any:
        try:
            with self._open(method, path, query=query, body=body) as response:
                raw = response.read(self.max_response_bytes + 1)
                if len(raw) > self.max_response_bytes:
                    raise ProtocolError(
                        "Runtime response exceeds the configured size limit"
                    )
                return _decode(raw) if raw else None
        except (TimeoutError, OSError, http.client.HTTPException) as error:
            raise ConnectionError(
                "Runtime response interrupted; a submitted command may already be accepted"
            ) from error

    @staticmethod
    def _segment(value: str) -> str:
        if not isinstance(value, str) or not value or value in (".", ".."):
            raise ValueError("resource IDs must be nonempty strings")
        return urllib.parse.quote(value, safe="")

    def capabilities(self) -> dict[str, Any]:
        result = self._request("GET", "/runtime/capabilities")
        if not isinstance(result, dict) or result.get("protocolVersion") != "1.0":
            raise ProtocolError("This client requires runtime protocol 1.0")
        return result

    def create_session(
        self,
        *,
        title: str | None = None,
        workspace: Literal["isolated", "project"] | None = None,
    ) -> dict[str, Any]:
        if workspace not in (None, "isolated", "project"):
            raise ValueError("workspace must be isolated or project")
        body = {} if title is None else {"title": title}
        if workspace is not None:
            body["workspace"] = workspace
        return self._request("POST", "/session", body=body)

    def get_session(self, session_id: str) -> dict[str, Any]:
        return self._request("GET", f"/session/{self._segment(session_id)}")

    def messages(
        self, session_id: str, *, limit: int | None = None
    ) -> list[dict[str, Any]]:
        return self._request(
            "GET",
            f"/session/{self._segment(session_id)}/message",
            query={"limit": limit},
        )

    def get_message(self, session_id: str, message_id: str) -> dict[str, Any]:
        return self._request(
            "GET",
            f"/session/{self._segment(session_id)}/message/{self._segment(message_id)}",
        )

    def prompt(
        self,
        session_id: str,
        message: str | None = None,
        *,
        request_id: str,
        parts: list[dict[str, Any]] | None = None,
        effort: str = "normal",
        model: dict[str, str] | None = None,
        variant: str | None = None,
        tier: str | None = None,
        context: int | None = None,
        message_id: str | None = None,
        delegation: bool | None = None,
        delegation_settings: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        if not request_id or not request_id.strip():
            raise ValueError("Persist a nonempty request_id before submitting work")
        if (message is None) == (parts is None):
            raise ValueError("Supply exactly one of message or parts")
        if effort not in ("normal", "ultra"):
            raise ValueError("effort must be normal or ultra")
        body = {
            "sessionID": session_id,
            "requestID": request_id,
            "effort": effort,
            "message": message,
            "parts": parts,
            "model": model,
            "variant": variant,
            "tier": tier,
            "context": context,
            "messageID": message_id,
            "delegation": delegation,
            "delegationSettings": delegation_settings,
        }
        return self._request(
            "POST",
            "/runtime/prompt",
            body={key: value for key, value in body.items() if value is not None},
        )

    def get_run(self, session_id: str, run_id: str) -> dict[str, Any]:
        return self._request(
            "GET", "/runtime/run", query={"sessionID": session_id, "runID": run_id}
        )

    def snapshot(self, session_id: str) -> dict[str, Any]:
        return self._request(
            "GET", "/runtime/snapshot", query={"sessionID": session_id}
        )

    def cancel_run(self, session_id: str, run_id: str) -> dict[str, Any]:
        """Request cancellation of this run only; running tools may still be settling."""
        return self._request(
            "POST", "/runtime/cancel", body={"sessionID": session_id, "runID": run_id}
        )

    def reply_permission(
        self,
        session_id: str,
        request_id: str,
        reply: str,
        *,
        message: str | None = None,
    ) -> dict[str, Any]:
        """Resolve a permission found in a fresh snapshot, retaining a decision receipt."""
        if reply not in ("once", "session", "project", "always", "reject"):
            raise ValueError("invalid permission reply")
        body = {
            "sessionID": session_id,
            "requestID": request_id,
            "kind": "permission",
            "reply": reply,
        }
        if message is not None:
            body["message"] = message
        return self._request("POST", "/runtime/decision", body=body)

    def reply_question(
        self, session_id: str, request_id: str, answers: list[list[str]]
    ) -> dict[str, Any]:
        return self._request(
            "POST",
            "/runtime/decision",
            body={
                "sessionID": session_id,
                "requestID": request_id,
                "kind": "question",
                "answers": answers,
            },
        )

    def reject_question(self, session_id: str, request_id: str) -> dict[str, Any]:
        return self._request(
            "POST",
            "/runtime/decision",
            body={
                "sessionID": session_id,
                "requestID": request_id,
                "kind": "question_reject",
            },
        )

    def replay(
        self, session_id: str, *, after_sequence: int | None = None
    ) -> dict[str, Any]:
        self._cursor(after_sequence)
        return self._request(
            "GET",
            "/runtime/events/replay",
            query={"sessionID": session_id, "afterSequence": after_sequence},
        )

    def abort_session(self, session_id: str) -> bool:
        """Abort the session's current work. Prefer cancel_run for a known run."""
        return self._request(
            "POST", f"/session/{self._segment(session_id)}/abort", body={}
        )

    @staticmethod
    def _cursor(sequence: int | None):
        if sequence is not None and (type(sequence) is not int or sequence < 0):
            raise ValueError("after_sequence must be a nonnegative integer")

    def events(
        self,
        session_id: str,
        *,
        after_sequence: int | None = None,
        reconnects: int = 0,
        retry_delay: float = 1,
    ) -> Iterator[RuntimeEvent]:
        """Stream session events, optionally reconnecting a bounded number of times.

        Persist each processed sequence. Use contextlib.closing() if leaving the
        iterator early. HTTP, protocol, and cursor errors never trigger retries.
        """
        self._cursor(after_sequence)
        if (
            type(reconnects) is not int
            or reconnects < 0
            or not math.isfinite(retry_delay)
            or retry_delay < 0
        ):
            raise ValueError("reconnects and retry_delay must be nonnegative")
        cursor = after_sequence
        for attempt in range(reconnects + 1):
            headers = {"Accept": "text/event-stream"}
            if cursor is not None:
                headers["Last-Event-ID"] = str(cursor)
            try:
                with self._open(
                    "GET",
                    "/runtime/events",
                    query={"sessionID": session_id, "afterSequence": cursor},
                    headers=headers,
                ) as response:
                    if response.headers.get_content_type() != "text/event-stream":
                        raise ProtocolError(
                            "Runtime subscription did not return text/event-stream"
                        )
                    for event in _sse(response, self.max_event_bytes):
                        if event.session_id != session_id:
                            raise ProtocolError(
                                "Runtime stream contains a different session"
                            )
                        if cursor is not None and event.sequence <= cursor:
                            continue
                        if cursor is not None and event.sequence != cursor + 1:
                            raise EventGapError(cursor + 1, event.sequence)
                        cursor = event.sequence
                        yield event
            except (
                OSError,
                urllib.error.URLError,
                http.client.HTTPException,
                ConnectionError,
            ) as error:
                if attempt == reconnects:
                    raise ConnectionError(
                        "Runtime event stream interrupted; reconnect from the last processed sequence"
                    ) from error
            if attempt < reconnects:
                time.sleep(retry_delay)
