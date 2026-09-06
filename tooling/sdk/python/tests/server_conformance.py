"""Run against an isolated real OpenScience server; no model work by default.

Usage: PYTHONPATH=tooling/sdk/python python tooling/sdk/python/tests/server_conformance.py URL
Optional environment: OPENSCIENCE_AUTH_TOKEN, OPENSCIENCE_CLIENT_DIRECTORY.
Creates one empty session in that server's state; use isolated test directories.
--fixture-model stress/fixture-model explicitly enables model protocol calls;
use it only with the local deterministic backend fixture provider.
"""

from __future__ import annotations

import argparse
import json
import os
import time
from contextlib import closing
from itertools import pairwise

from openscience import Client, CursorError, HTTPError


def check_fixture_run(client: Client, session_id: str, model: str) -> dict:
    provider_id, model_id = model.split("/", 1)
    before = client.snapshot(session_id)
    request = {
        "session_id": session_id,
        "request_id": "python-conformance-fixture-request",
        "parts": [
            {
                "type": "text",
                "text": "Explain this deterministic Python protocol fixture.",
            },
            {"type": "text", "text": "Reply with a short acknowledgement: science α."},
        ],
        "model": {"providerID": provider_id, "modelID": model_id},
        "effort": "normal",
        "context": 65_536,
        "delegation": False,
    }
    receipt = client.prompt(**request)
    assert client.prompt(**request) == receipt
    run_id = receipt["runID"]
    terminal_types = {"runtime.completed", "runtime.failed", "runtime.cancelled"}
    streamed = []
    with closing(
        client.events(session_id, after_sequence=before["latestSequence"])
    ) as events:
        for event in events:
            streamed.append(event)
            if event.run_id == run_id and event.type in terminal_types:
                assert event.type == "runtime.completed", event.properties
                break
    assert streamed and streamed[-1].type == "runtime.completed"
    assert all(b.sequence == a.sequence + 1 for a, b in pairwise(streamed))
    deadline = time.monotonic() + 20
    while True:
        run = client.get_run(session_id, run_id)
        if run["state"] not in ("accepted", "running"):
            break
        if time.monotonic() > deadline:
            raise AssertionError("The fixture run did not settle")
        time.sleep(0.05)
    assert run["state"] == "completed", run
    assert run["requestID"] == request["request_id"]
    assert (
        client.get_message(session_id, run["resultMessageID"])["info"]["id"]
        == run["resultMessageID"]
    )
    assert client.prompt(**request) == receipt
    messages = client.messages(session_id)
    users = [message for message in messages if message["info"]["role"] == "user"]
    assert len(users) == 1, (
        "Identical prompt retries must not duplicate the user message"
    )
    text = "\n".join(
        part["text"] for part in users[0]["parts"] if part["type"] == "text"
    )
    assert all(part["text"] in text for part in request["parts"])
    snapshot = client.snapshot(session_id)
    assert len(snapshot["runs"]) == 1 and snapshot["runs"][0]["runID"] == run_id
    replay = client.replay(session_id, after_sequence=before["latestSequence"])
    terminals = [
        event
        for event in replay["events"]
        if event["runID"] == run_id and event["type"] in terminal_types
    ]
    assert len(terminals) == 1 and terminals[0]["type"] == "runtime.completed"
    assert replay["latestSequence"] == snapshot["latestSequence"]
    try:
        client.prompt(
            **{**request, "parts": [{"type": "text", "text": "A changed prompt"}]}
        )
    except HTTPError as error:
        assert error.status == 409 and error.code == "request_conflict"
    else:
        raise AssertionError("Changing an idempotent prompt must conflict")
    return {
        "runID": run_id,
        "state": run["state"],
        "events": len(streamed),
        "userMessages": len(users),
    }


def check_server(url: str, fixture_model: str | None = None) -> dict:
    client = Client(
        url,
        token=os.environ.get("OPENSCIENCE_AUTH_TOKEN"),
        directory=os.environ.get("OPENSCIENCE_CLIENT_DIRECTORY"),
        timeout=10,
    )
    capabilities = client.capabilities()
    assert capabilities["crashRecovery"] == "interrupt"
    session = client.create_session(title="Python zero-cost conformance")
    session_id = session["id"]
    assert client.get_session(session_id)["id"] == session_id
    assert client.messages(session_id) == []
    snapshot = client.snapshot(session_id)
    assert snapshot["runs"] == []
    assert snapshot["permissions"] == snapshot["questions"] == []
    assert snapshot["decisionScope"] == "connected_runtime"
    replay = client.replay(session_id, after_sequence=0)
    assert replay["events"] == []
    assert replay["latestSequence"] == snapshot["latestSequence"] == 0
    try:
        client.replay(session_id, after_sequence=1)
    except CursorError as error:
        assert error.code == "cursor_ahead" and error.latest_sequence == 0
    else:
        raise AssertionError("A cursor ahead of history must fail")
    try:
        client.get_run(session_id, "run_nonexistent")
    except HTTPError as error:
        assert error.status == 404
    else:
        raise AssertionError("Unknown runs must fail")
    if client._token:
        try:
            Client(url, directory=client.directory).capabilities()
        except HTTPError as error:
            assert error.status == 401
        else:
            raise AssertionError("The configured bearer token must be required")
    assert client.abort_session(session_id) is True
    result = {
        "protocolVersion": capabilities["protocolVersion"],
        "sessionID": session_id,
        "modelsCalled": 0,
        "checks": "capabilities, auth, sessions, snapshot, replay, cursor errors, missing run, idle abort",
    }
    if fixture_model:
        result.pop("modelsCalled")
        result["fixtureRun"] = check_fixture_run(client, session_id, fixture_model)
        result["modelMode"] = "explicit local fixture provider"
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("url")
    parser.add_argument("--fixture-model", choices=["stress/fixture-model"])
    arguments = parser.parse_args()
    print(json.dumps(check_server(arguments.url, arguments.fixture_model)))
