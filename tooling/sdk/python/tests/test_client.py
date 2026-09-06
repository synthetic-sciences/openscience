"""Deterministic socket-level client tests; no scientific agent or model runs."""

from __future__ import annotations

import contextlib
import io
import json
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

from openscience import (
    Client,
    ConnectionError,
    CursorError,
    EventGapError,
    HTTPError,
    ProtocolError,
)
from openscience.client import _sse


def event(sequence=1, *, session="ses_test"):
    return {
        "sequence": sequence,
        "type": "runtime.started",
        "sessionID": session,
        "runID": "run_test",
        "time": 123,
        "properties": {"text": "science α"},
    }


def frame(sequence=1, *, newline="\n", session="ses_test"):
    data = json.dumps(event(sequence, session=session), ensure_ascii=False, indent=2)
    return newline.join(
        [
            f"id: {sequence}",
            "event: runtime.started",
            *["data: " + line for line in data.splitlines()],
            "",
            "",
        ]
    ).encode()


@contextlib.contextmanager
def server(respond):
    calls = []

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *_):
            pass

        def do_GET(self):
            self.handle_request()

        def do_POST(self):
            self.handle_request()

        def handle_request(self):
            body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
            url = urlsplit(self.path)
            call = {
                "method": self.command,
                "path": url.path,
                "query": parse_qs(url.query),
                "headers": self.headers,
                "body": json.loads(body) if body else None,
            }
            calls.append(call)
            status, content, headers = respond(call, len(calls))
            data = (
                content if isinstance(content, bytes) else json.dumps(content).encode()
            )
            self.send_response(status)
            self.send_header(
                "Content-Type", headers.pop("Content-Type", "application/json")
            )
            for key, value in headers.items():
                self.send_header(key, value)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Connection", "close")
            self.end_headers()
            try:
                for start in range(0, len(data), 7):
                    self.wfile.write(data[start : start + 7])
                    self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                pass
            self.close_connection = True

    host = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=host.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{host.server_port}", calls
    finally:
        host.shutdown()
        host.server_close()
        thread.join(timeout=2)


class ClientTests(unittest.TestCase):
    def test_session_workspace_is_explicit_and_validated(self):
        with server(lambda *_: (200, {"ok": True}, {})) as (url, calls):
            client = Client(url)
            client.create_session()
            client.create_session(title="Native task", workspace="project")
            client.create_session(workspace="isolated")
            with self.assertRaises(ValueError):
                client.create_session(workspace="/arbitrary/path")
        self.assertEqual(
            [call["body"] for call in calls],
            [
                {},
                {"title": "Native task", "workspace": "project"},
                {"workspace": "isolated"},
            ],
        )

    def test_http_methods_rich_prompt_and_scoping(self):
        with server(lambda *_: (200, {"ok": True}, {})) as (url, calls):
            client = Client(
                url, token="fixture-token", directory="/lab/科学 and spaces"
            )
            client.create_session(title="A study")
            client.get_session("ses_test")
            client.messages("ses_test", limit=2)
            client.get_message("ses_test", "msg_test")
            client.prompt(
                "ses_test",
                request_id="persisted-id",
                parts=[{"type": "text", "text": "reproduce"}],
                model={"providerID": "fixture", "modelID": "test"},
                effort="ultra",
                variant="high",
                delegation=False,
            )
            client.get_run("ses_test", "run_test")
            client.snapshot("ses_test")
            client.replay("ses_test", after_sequence=7)
            client.cancel_run("ses_test", "run_test")
            client.reply_permission("ses_test", "per_test", "once", message="approved")
            client.reply_question("ses_test", "que_test", [["answer"]])
            client.reject_question("ses_test", "que_test")
            client.abort_session("ses_test")
        self.assertEqual(calls[0]["body"], {"title": "A study"})
        self.assertEqual(calls[2]["query"]["limit"], ["2"])
        self.assertEqual(
            calls[4]["body"],
            {
                "sessionID": "ses_test",
                "requestID": "persisted-id",
                "effort": "ultra",
                "parts": [{"type": "text", "text": "reproduce"}],
                "model": {"providerID": "fixture", "modelID": "test"},
                "variant": "high",
                "delegation": False,
            },
        )
        self.assertEqual(
            calls[8]["body"], {"sessionID": "ses_test", "runID": "run_test"}
        )
        self.assertEqual(calls[9]["body"]["kind"], "permission")
        self.assertEqual(calls[10]["body"]["answers"], [["answer"]])
        self.assertEqual(calls[11]["body"]["kind"], "question_reject")
        self.assertTrue(
            all(
                call["headers"]["Authorization"] == "Bearer fixture-token"
                for call in calls
            )
        )
        self.assertTrue(
            all(
                call["query"]["directory"] == ["/lab/科学 and spaces"] for call in calls
            )
        )

    def test_mutation_errors_are_never_retried(self):
        with server(lambda *_: (409, {"error": "request_conflict"}, {})) as (
            url,
            calls,
        ):
            with self.assertRaises(HTTPError) as error:
                Client(url).prompt("ses_test", "hello", request_id="saved")
            self.assertEqual(error.exception.status, 409)
            self.assertEqual(error.exception.code, "request_conflict")
            self.assertEqual(len(calls), 1)

    def test_cursor_errors_are_explicit_for_replay_and_stream(self):
        with server(
            lambda *_: (409, {"error": "cursor_expired", "oldestSequence": 12}, {})
        ) as (url, calls):
            client = Client(url)
            with self.assertRaises(CursorError) as error:
                client.replay("ses_test", after_sequence=0)
            self.assertEqual(error.exception.oldest_sequence, 12)
            with self.assertRaises(CursorError):
                list(
                    client.events(
                        "ses_test", after_sequence=0, reconnects=3, retry_delay=0
                    )
                )
            self.assertEqual(len(calls), 2)

    def test_sse_reconnect_deduplicates_and_advances_header(self):
        def respond(_, count):
            data = b": heartbeat\r\n\r\n" + frame(1, newline="\r\n")
            if count == 1:
                data += b"id: 2\nevent: runtime.started\ndata: {"
            else:
                data += frame(2)
            return 200, data, {"Content-Type": "text/event-stream"}

        with server(respond) as (url, calls):
            events = list(
                Client(url).events(
                    "ses_test", after_sequence=0, reconnects=1, retry_delay=0
                )
            )
        self.assertEqual([item.sequence for item in events], [1, 2])
        self.assertEqual(events[0].properties["text"], "science α")
        self.assertEqual(calls[0]["headers"]["Last-Event-ID"], "0")
        self.assertEqual(calls[1]["headers"]["Last-Event-ID"], "1")
        self.assertEqual(calls[1]["query"]["afterSequence"], ["1"])

    def test_sse_gap_wrong_session_and_content_type_fail(self):
        cases = [
            (frame(2), "text/event-stream", EventGapError),
            (frame(1, session="ses_other"), "text/event-stream", ProtocolError),
            (b"{}", "application/json", ProtocolError),
        ]
        for data, content_type, exception in cases:
            with (
                self.subTest(exception=exception),
                server(
                    lambda *_, data=data, content_type=content_type: (
                        200,
                        data,
                        {"Content-Type": content_type},
                    )
                ) as (
                    url,
                    calls,
                ),
            ):
                with self.assertRaises(exception):
                    list(
                        Client(url).events(
                            "ses_test", after_sequence=0, reconnects=2, retry_delay=0
                        )
                    )
                self.assertEqual(len(calls), 1)

    def test_redirects_do_not_forward_credentials(self):
        with server(lambda *_: (200, {}, {})) as (destination, received):
            with server(lambda *_: (302, {}, {"Location": destination + "/steal"})) as (
                url,
                _,
            ):
                with self.assertRaises(HTTPError) as error:
                    Client(url, token="fixture-token").snapshot("ses_test")
                self.assertEqual(error.exception.status, 302)
            self.assertEqual(received, [])

    def test_capabilities_and_response_limits(self):
        with server(lambda *_: (200, {"protocolVersion": "1.0"}, {})) as (url, _):
            self.assertEqual(Client(url).capabilities()["protocolVersion"], "1.0")
            with self.assertRaises(ProtocolError):
                Client(url, max_response_bytes=4).capabilities()
        with (
            server(lambda *_: (200, {"protocolVersion": "2.0"}, {})) as (url, _),
            self.assertRaises(ProtocolError),
        ):
            Client(url).capabilities()

    def test_sse_parser_newlines_identity_and_partial_eof(self):
        for newline in ("\n", "\r\n", "\r"):
            self.assertEqual(
                next(
                    _sse(io.BytesIO(b"\xef\xbb\xbf" + frame(newline=newline)), 10000)
                ).sequence,
                1,
            )
        with self.assertRaises(ProtocolError):
            list(_sse(io.BytesIO(frame().replace(b"id: 1", b"id: 2")), 10000))
        with self.assertRaises(ProtocolError):
            list(_sse(io.BytesIO(frame()), 10))
        with self.assertRaises(ConnectionError):
            list(_sse(io.BytesIO(frame()[:-1]), 10000))
        with self.assertRaises(ProtocolError):
            list(_sse(io.BytesIO(b"data: \xff\n\n"), 10000))

    def test_invalid_inputs_fail_without_network(self):
        for url in (
            "file:///tmp/data",
            "https://user:password@example.com",
            "https://example.com?token=x",
        ):
            with self.assertRaises(ValueError):
                Client(url)
        client = Client()
        with self.assertRaises(ValueError):
            client.prompt("ses_test", "hello", parts=[], request_id="saved")
        with self.assertRaises(ValueError):
            client.prompt("ses_test", "hello", request_id="")
        with self.assertRaises(ValueError):
            client.replay("ses_test", after_sequence=True)
        with self.assertRaises(ValueError):
            client.reply_permission("ses_test", "per_test", "yes")


if __name__ == "__main__":
    unittest.main()
