# OpenScience Python runtime client

A small, synchronous client for runtime protocol **1.0** using only the Python
standard library (Python 3.10+). This is a source preview; it is not a published
PyPI release. The server owns the agent loop, tools, permissions, session state,
and run receipts. A notebook, service, or chat integration can use this client
without importing the CLI implementation or starting another agent loop.

Install from this checkout:

```bash
python -m pip install -e tooling/sdk/python
```

Start the OpenScience server from a build containing this protocol:

```bash
openscience serve --hostname 127.0.0.1 --port 4096
```

`Client.capabilities()` checks the protocol version. Use `token=` when the server
is configured with `OPENSCIENCE_AUTH_TOKEN`. `directory=` selects the project on
the server; it is a server-side path. The client does not read provider API keys.
Do not treat the deployment bearer token as per-user authorization: this protocol
serves one trusted runtime and does not supply tenant isolation.

New sessions default to an isolated scratch workspace. Use
`client.create_session(title="Native analysis", workspace="project")` when tools
should resolve relative paths in the selected project directory. This option
requires a matching source build. Project mode retains filesystem permissions and
does not transfer ownership of the directory to session cleanup.

## Submit and observe work

Submitting a prompt can spend money and run tools according to server policy.
Persist a request ID **before** submission. If the HTTP response is lost, retry
the same request with the same ID and identical inputs to recover its receipt.
Changing the inputs with that ID returns HTTP 409. The client never retries a
command implicitly.

```python
import json
from contextlib import closing
from pathlib import Path
from uuid import uuid4

from openscience import Client

client = Client("http://127.0.0.1:4096", directory="/path/on/server")
client.capabilities()
session = client.create_session(title="Reproduce an analysis")
session_id = session["id"]
snapshot = client.snapshot(session_id)

request = {
    "session_id": session_id,
    "message": "Inspect the supplied dataset and reproduce the analysis in this project.",
    "request_id": str(uuid4()),
    "effort": "normal",
}
Path("openscience-request.json").write_text(json.dumps(request))
receipt = client.prompt(**request)
run_id = receipt["runID"]

with closing(
    client.events(
        session_id,
        after_sequence=snapshot["latestSequence"],
        reconnects=2,
    )
) as events:
    for event in events:
        print(event.type, event.properties)
        # Persist event.sequence after processing it; consumers must tolerate
        # delivery again if they crash before saving their cursor.
        if event.run_id == run_id and event.type in {
            "runtime.completed",
            "runtime.failed",
            "runtime.cancelled",
        }:
            break

run = client.get_run(session_id, run_id)
print(run["state"])
if run.get("resultMessageID"):
    result = client.get_message(session_id, run["resultMessageID"])
```

`prompt()` also accepts `parts` instead of `message`, plus `model` (`providerID`
and `modelID`), `variant`, `tier`, `context`, `message_id`, `delegation`, and
`delegation_settings`. The server validates these against its prompt schema.
Explicit `False` values are preserved. The client returns server response
objects as dictionaries; `RuntimeEvent` is a dataclass with `sequence`, `type`,
`session_id`, `run_id`, `time`, and `properties`.

## Disconnects and recovery

- `events()` replays retained events and then follows the live session stream.
  It is a blocking iterator; `timeout` is the socket inactivity timeout, not a
  run deadline. Close the iterator when leaving early.
- Reconnection is opt-in and bounded by `reconnects`. Each reconnect sends the
  last delivered sequence in both the query and `Last-Event-ID`. Duplicate
  sequences are filtered. Saving a processed cursor is the application's job.
- Omitting `after_sequence` starts from the oldest **retained** event, which may
  not be the beginning of the session. Use an explicit persisted cursor when
  continuity matters.
- `CursorError` (expired or ahead, HTTP 409) and `EventGapError` require a fresh
  `snapshot()`. Read authoritative `get_run()` state and messages, reconcile
  your application state, then subscribe from the snapshot's `latestSequence`.
  The client never silently skips a gap or resubmits a prompt to fill it.
- A stream ending does not mean work completed. Query the durable run receipt.
  Run states are `accepted`, `running`, `completed`, `failed`, `cancelled`, and
  `interrupted`. A stopped owning runtime becomes `interrupted`; this is not
  automatic recovery of an in-flight tool or an exactly-once effect guarantee.
- `cancel_run(session_id, run_id)` targets one run. It may return `running` while
  tools settle. `abort_session(session_id)` targets the current session work.

HTTP failures raise `HTTPError` with `status`, `code`, and parsed `body`.
Connection failures raise `ConnectionError`; after a submission, acceptance may
be uncertain. HTTP/protocol/cursor failures are never automatically retried.
Redirects are rejected so bearer credentials cannot follow an unexpected API
redirect. Response and SSE-event size limits are configurable on `Client`.

## Pending decisions

Only requests in a **fresh snapshot** are actionable; replayed decision events
are history. Present the request to the authorized user or apply your explicitly
configured policy before sending a response:

```python
pending = client.snapshot(session_id)
# After a decision has been made for a request in pending["permissions"]:
receipt = client.reply_permission(session_id, permission_id, "once")
# For a request in pending["questions"]:
receipt = client.reply_question(session_id, question_id, [["chosen answer"]])
# Or reject a question:
receipt = client.reject_question(session_id, question_id)
```

These use `/runtime/decision`. Identical retries return the recorded receipt;
a changed response or a request no longer pending in the connected runtime
returns 409. An `indeterminate` receipt must be investigated, not automatically
reapplied. Decision receipts persist, but suspended tool continuations and the
snapshot's pending requests belong to the connected runtime process. The client
does not approve permissions or answer questions automatically.

## Verification

The socket-level tests have no third-party dependencies:

```bash
PYTHONPATH=tooling/sdk/python python -m unittest discover -s tooling/sdk/python/tests -v
```

They cover HTTP methods and auth, rich inputs, decisions/cancellation, SSE
framing and UTF-8, reconnect cursors and deduplication, truncation, gap/409
handling, response limits, and redirect rejection using a local HTTP fixture.

A separate check runs against an **isolated real source server** and creates one
empty session. It checks capabilities, authentication, sessions, snapshots,
replay, cursor errors and missing runs without submitting model work:

```bash
OPENSCIENCE_CLIENT_DIRECTORY=/path/to/isolated/server/workspace \
PYTHONPATH=tooling/sdk/python \
python tooling/sdk/python/tests/server_conformance.py http://127.0.0.1:4096
```

Set `OPENSCIENCE_AUTH_TOKEN` for that server if configured. These are protocol
conformance checks, not benchmark or scientific-result evaluations.

Backend integration tests can opt into a real agent-loop protocol check with
`--fixture-model stress/fixture-model`, but only against a server configured with
the local deterministic stress provider. This explicit mode checks rich prompt
submission, identical retries without duplicate user messages, the actual SSE
stream, durable terminal state, replay, result-message retrieval, and changed
request conflicts. The default conformance command above never submits a prompt.
