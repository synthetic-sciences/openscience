#!/usr/bin/env python3
"""Explicit, read-only access to Zotero's local API v3. No external hosts."""

import argparse
from http.client import HTTPException, HTTPResponse
import json
import re
import socket
import sys
import threading
import time
from urllib.parse import urlencode


MAX_BYTES = 2 * 1024 * 1024
TIMEOUT = 10


def key(value):
    if not re.fullmatch(r"[A-Z0-9]{8}", value):
        raise ValueError("Use an eight-character Zotero item/collection key from a previous result.")
    return value


class ZoteroLocal:
    def __init__(self, port=23119):
        if isinstance(port, bool) or not isinstance(port, int) or not 1 <= port <= 65535:
            raise ValueError("Port must be an integer between 1 and 65535.")
        self.port = port

    def _read(self, path, params=None):
        target = "/api/" + path + ("?" + urlencode(params) if params else "")
        deadline = time.monotonic() + TIMEOUT
        expired = threading.Event()
        try:
            # A direct, fixed-loopback socket cannot inherit HTTP proxy settings.
            # Own it explicitly so a total deadline can interrupt slow headers as
            # well as bodies; per-read timeouts alone permit indefinite trickles.
            with socket.create_connection(("127.0.0.1", self.port), timeout=TIMEOUT) as connection:
                def expire():
                    expired.set()
                    try:
                        connection.shutdown(socket.SHUT_RDWR)
                    except OSError:
                        pass

                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise TimeoutError()
                timer = threading.Timer(remaining, expire)
                timer.daemon = True
                timer.start()
                try:
                    connection.settimeout(remaining)
                    request = (
                        f"GET {target} HTTP/1.1\r\nHost: 127.0.0.1:{self.port}\r\n"
                        "Zotero-API-Version: 3\r\nAccept: application/json\r\nConnection: close\r\n\r\n"
                    )
                    connection.sendall(request.encode("ascii"))
                    with HTTPResponse(connection) as response:
                        response.begin()
                        if expired.is_set() or time.monotonic() >= deadline:
                            raise TimeoutError()
                        if response.status in (401, 403):
                            raise RuntimeError("Zotero local API access denied. Check Settings → Advanced and this Zotero version's local-access requirements.")
                        if 300 <= response.status < 400:
                            raise RuntimeError("Zotero local API redirected the request; redirects are not allowed.")
                        if response.status != 200:
                            raise RuntimeError(f"Zotero local API returned HTTP {response.status}.")
                        if response.headers.get("Zotero-API-Version") not in (None, "3"):
                            raise RuntimeError("Unsupported Zotero local API version; this helper supports v3.")
                        body = bytearray()
                        while len(body) <= MAX_BYTES:
                            remaining = deadline - time.monotonic()
                            if remaining <= 0 or expired.is_set():
                                raise TimeoutError()
                            connection.settimeout(remaining)
                            chunk = response.read1(min(64 * 1024, MAX_BYTES + 1 - len(body)))
                            if expired.is_set() or time.monotonic() >= deadline:
                                raise TimeoutError()
                            if not chunk:
                                break
                            body.extend(chunk)
                finally:
                    timer.cancel()
        except (OSError, HTTPException) as error:
            if expired.is_set() or time.monotonic() >= deadline or isinstance(error, TimeoutError):
                raise RuntimeError(f"Zotero request timed out after {TIMEOUT:g} seconds; no retry was made.") from error
            raise RuntimeError("Could not connect to Zotero. Open Zotero and enable local API access in Settings → Advanced.") from error
        if len(body) > MAX_BYTES:
            raise RuntimeError("Zotero response too large (over 2 MiB). Narrow the query or reduce --limit.")
        try:
            return json.loads(body)
        except (ValueError, UnicodeDecodeError) as error:
            raise RuntimeError("Zotero local API did not return valid JSON.") from error

    def doctor(self):
        types = self._read("itemTypes")
        if not isinstance(types, list) or not types or not all(isinstance(row, dict) and isinstance(row.get("itemType"), str) for row in types):
            raise RuntimeError("The local endpoint did not return Zotero item-type metadata.")
        return {"connected": True, "transport": "local", "read_only": True, "api_version": 3}

    def read(self, command, value=None, collection=None, limit=20, start=0):
        if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 100:
            raise ValueError("Limit must be between 1 and 100.")
        if isinstance(start, bool) or not isinstance(start, int) or start < 0:
            raise ValueError("Start must be a nonnegative integer.")
        params = {"format": "json", "limit": limit, "start": start}
        if command == "item":
            return self._read("users/0/items/" + key(value or ""), {"format": "json"})
        if command == "collections":
            return self._read("users/0/collections", params)
        if command not in ("items", "search"):
            raise ValueError("Unsupported read operation.")
        path = "users/0/collections/" + key(collection) + "/items/top" if collection else "users/0/items/top"
        if command == "search":
            if not value or not value.strip():
                raise ValueError("Provide a search query.")
            params.update({"q": value, "qmode": "titleCreatorYear"})
        return self._read(path, params)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["doctor", "search", "collections", "items", "item"])
    parser.add_argument("value", nargs="?")
    parser.add_argument("--collection")
    parser.add_argument("--limit", type=int, default=20)
    parser.add_argument("--start", type=int, default=0)
    parser.add_argument("--port", type=int, default=23119)
    args = parser.parse_args()
    try:
        client = ZoteroLocal(args.port)
        data = client.doctor() if args.command == "doctor" else client.read(args.command, args.value, args.collection, args.limit, args.start)
        print(json.dumps(data, ensure_ascii=False, indent=2))
    except (ValueError, RuntimeError) as error:
        print(str(error), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
