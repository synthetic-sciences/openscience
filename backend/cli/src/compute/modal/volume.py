#!/usr/bin/env python3
"""Control-plane access to Modal Volumes for OpenScience.

The process reads one JSON request from stdin and writes one JSON response to
stdout. Credentials arrive only through MODAL_TOKEN_ID/MODAL_TOKEN_SECRET.
No Modal Function or Sandbox is created by this driver.
"""

import json
import hashlib
import os
import posixpath
import sys
import time


def fail(message):
    print("modal volume bridge: %s" % message, file=sys.stderr)
    raise SystemExit(2)


def relative(value):
    if not isinstance(value, str) or "\x00" in value:
        fail("invalid volume path")
    clean = posixpath.normpath(value).lstrip("/")
    if clean in ("", ".") or ".." in clean.split("/"):
        fail("volume path must name a file")
    return clean


def destination(root, remote):
    base = os.path.realpath(root)
    target = os.path.realpath(os.path.join(base, *relative(remote).split("/")))
    if target != base and not target.startswith(base + os.sep):
        fail("download path escaped its staging directory")
    return target


def volume(modal, spec):
    name = spec.get("volume")
    if not isinstance(name, str) or not name:
        fail("volume is required")
    environment = spec.get("environment")
    if environment is not None and not isinstance(environment, str):
        fail("environment must be a string")
    return modal.Volume.from_name(name, environment_name=environment, create_if_missing=False)


def kind(entry):
    value = getattr(entry.type, "name", entry.type)
    return str(value).lower()


def timestamp(entry):
    value = getattr(entry, "mtime", None)
    if hasattr(value, "timestamp"):
        return value.timestamp()
    return value


def entries(target, root, recursive):
    rows = []
    for entry in target.listdir(root, recursive=recursive):
        path = str(entry.path).lstrip("/")
        rows.append(
            {
                "path": path,
                "type": kind(entry),
                "size": int(getattr(entry, "size", 0) or 0),
                "mtime": timestamp(entry),
            }
        )
    return rows


def main():
    try:
        spec = json.load(sys.stdin)
    except Exception:
        fail("stdin must contain one JSON request")
    if not isinstance(spec, dict):
        fail("request must be an object")
    action = spec.get("action")
    if action not in ("check", "volumes", "list", "wait", "download"):
        fail("unsupported action")

    try:
        import modal
    except Exception:
        fail("the pinned Modal Python SDK could not be imported")

    if action == "check":
        print(json.dumps({"version": getattr(modal, "__version__", "unknown")}))
        return

    if action == "volumes":
        environment = spec.get("environment")
        if environment is not None and not isinstance(environment, str):
            fail("environment must be a string")
        rows = [{"name": item.name} for item in modal.Volume.objects.list(environment_name=environment)]
        print(json.dumps(rows))
        return

    target = volume(modal, spec)
    if action in ("list", "wait"):
        root = spec.get("path", "/")
        if not isinstance(root, str):
            fail("path must be a string")
        recursive = spec.get("recursive", False)
        if not isinstance(recursive, bool):
            fail("recursive must be a boolean")
        if action == "list":
            print(json.dumps(entries(target, root, recursive)))
            return
        marker = relative(spec.get("marker"))
        attempts = spec.get("attempts")
        interval = spec.get("interval_ms")
        if not isinstance(attempts, int) or isinstance(attempts, bool) or attempts < 1 or attempts > 120:
            fail("attempts must be an integer from 1 to 120")
        if not isinstance(interval, int) or isinstance(interval, bool) or interval < 0 or interval > 5000:
            fail("interval_ms must be an integer from 0 to 5000")
        rows = []
        for attempt in range(attempts):
            rows = entries(target, root, recursive)
            if any(item["type"] == "file" and item["path"] == marker for item in rows):
                break
            if attempt + 1 < attempts:
                time.sleep(interval / 1000)
        print(json.dumps(rows))
        return

    staging = spec.get("staging")
    paths = spec.get("paths")
    if not isinstance(staging, str) or not os.path.isabs(staging):
        fail("staging must be an absolute path")
    if not isinstance(paths, list) or not all(isinstance(item, str) for item in paths):
        fail("paths must be a list of strings")
    os.makedirs(staging, mode=0o700, exist_ok=True)
    rows = []
    for item in paths:
        remote = relative(item)
        local = destination(staging, remote)
        os.makedirs(os.path.dirname(local), mode=0o700, exist_ok=True)
        size = 0
        digest = hashlib.sha256()
        with open(local, "wb") as output:
            for chunk in target.read_file(remote):
                output.write(chunk)
                size += len(chunk)
                digest.update(chunk)
        rows.append({"path": remote, "staging": local, "size": size, "sha256": digest.hexdigest()})
    print(json.dumps(rows))


if __name__ == "__main__":
    main()
