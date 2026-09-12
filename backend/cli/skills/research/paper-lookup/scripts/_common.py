#!/usr/bin/env python3
"""Shared helpers for the paper-lookup scripts. Standard library only.

Three concerns are factored out here because all four CLIs need them and getting
any of them subtly wrong is how a literature retrieval turns into a plausible
lie:

`read_input` / `emit`
    Bounded stdin-or-path reading and JSON writing, so a 400 MB full-text pull
    cannot exhaust memory unnoticed.

`collapse_ws` / `strip_control`
    API payloads are third-party text. Titles and abstracts arrive hard-wrapped,
    and full text can carry control characters that corrupt a terminal or a
    downstream parse.

`Reconciliation`
    Expected total versus retrieved total, in one place, because every paginated
    API in this skill counts differently and the whole point is to fail visibly
    when they disagree.
"""

from __future__ import annotations

import json
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

#: A single response should never be this large. PMC full text runs ~1 MB; a
#: 64 MB payload means a bulk dump was piped in by mistake.
MAX_INPUT_BYTES = 64 * 1024 * 1024

_CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
_WHITESPACE = re.compile(r"\s+")


class InputError(Exception):
    """Bad input from the caller: unreadable path, oversized payload, bad JSON."""


def read_input(source: str, *, max_bytes: int = MAX_INPUT_BYTES) -> str:
    """Read `source`, or stdin when it is `-`, refusing anything oversized.

    stdin is read in chunks rather than whole so that an accidental
    `cat huge.xml | script` fails fast instead of after filling memory.
    """
    if source == "-":
        chunks: list[bytes] = []
        total = 0
        stream = sys.stdin.buffer
        while True:
            chunk = stream.read(1024 * 1024)
            if not chunk:
                break
            total += len(chunk)
            if total > max_bytes:
                raise InputError(
                    f"stdin exceeded {max_bytes} bytes; write it to a file and pass a path, "
                    "or slice the payload first"
                )
            chunks.append(chunk)
        raw = b"".join(chunks)
    else:
        path = Path(source)
        if not path.is_file():
            raise InputError(f"not a file: {source}")
        size = path.stat().st_size
        if size > max_bytes:
            raise InputError(f"{source} is {size} bytes, over the {max_bytes} byte limit")
        raw = path.read_bytes()

    if not raw.strip():
        raise InputError("input was empty")
    return raw.decode("utf-8", errors="replace")


def load_json(source: str, *, max_bytes: int = MAX_INPUT_BYTES) -> Any:
    """`read_input` plus a JSON parse, with the failure attributed to the source."""
    text = read_input(source, max_bytes=max_bytes)
    try:
        return json.loads(text)
    except json.JSONDecodeError as error:
        where = "stdin" if source == "-" else source
        raise InputError(f"{where} is not valid JSON: {error}") from error


def emit(payload: Any, destination: str | None = None) -> None:
    """Write `payload` as UTF-8 JSON to a path, or to stdout when None."""
    text = json.dumps(payload, indent=2, ensure_ascii=False, sort_keys=False)
    if destination is None:
        sys.stdout.write(text + "\n")
    else:
        Path(destination).write_text(text + "\n", encoding="utf-8")


def strip_control(text: str) -> str:
    """Drop control characters, keeping tab, newline, and carriage return."""
    return _CONTROL.sub("", text)


def collapse_ws(text: str | None) -> str:
    """Collapse all whitespace runs to single spaces and trim.

    arXiv hard-wraps `<title>` and `<summary>` mid-sentence, and JATS indents
    element text, so raw values compare unequal to the same string from any other
    source. Every field this skill emits for display goes through here.
    """
    if not text:
        return ""
    return _WHITESPACE.sub(" ", strip_control(text)).strip()


@dataclass
class Reconciliation:
    """Expected versus retrieved, and *why* they differ when they do.

    Three outcomes, deliberately not collapsed into one boolean:

    `complete`
        The API said it was done and the counts agree. Nothing to caveat.

    `stopped_at_limit`
        A `--max-records` / `--max-calls` bound was reached. The result is
        partial **because the caller asked for a partial result** -- honest, and
        not an error. It still must be reported as partial, since presenting 100
        of 697,030 as "the papers on X" is the misleading case this skill exists
        to prevent.

    shortfall
        The walk believed it had finished, yet retrieved fewer than the total the
        API reported. Records went missing. This is the one that must never pass
        quietly -- it is what an out-of-step bioRxiv cursor produces.

    `expected` is None for the several endpoints here that report no total at all
    (bioRxiv DOI lookups, `/details/{N}`). That is a documented state, not a
    failure.
    """

    expected: int | None = None
    retrieved: int = 0
    pages: int = 0
    stopped_at_limit: bool = False
    notes: list[str] = field(default_factory=list)

    @property
    def complete(self) -> bool:
        """Did the walk retrieve everything the API said exists?"""
        if self.stopped_at_limit:
            return False
        if self.expected is None:
            return True
        return self.retrieved == self.expected

    @property
    def ok(self) -> bool:
        """Is the shortfall explained? False only when records went missing."""
        return self.complete or self.stopped_at_limit

    def note(self, message: str) -> None:
        self.notes.append(message)

    def as_dict(self) -> dict[str, Any]:
        summary: dict[str, Any] = {
            "expected_total": self.expected,
            "retrieved_total": self.retrieved,
            "pages_fetched": self.pages,
            "complete": self.complete,
            "stopped_at_limit": self.stopped_at_limit,
        }
        if self.expected is None:
            summary["expected_total_note"] = (
                "endpoint reports no total; retrieved_total is all that can be asserted"
            )
        elif self.retrieved != self.expected:
            summary["shortfall"] = self.expected - self.retrieved
            summary["shortfall_reason"] = (
                "bounded by --max-records/--max-calls; raise the bound to continue"
                if self.stopped_at_limit
                else "UNEXPLAINED: the walk ended on its own but came up short -- records are missing"
            )
        if self.notes:
            summary["notes"] = list(self.notes)
        return summary


#: Query parameters that must never appear in emitted provenance.
#:
#: Several of these APIs authenticate by query string rather than header, so the
#: URL that was actually fetched contains the credential. Provenance is supposed
#: to let someone repeat the call with *their own* key -- printing yours is a leak,
#: not reproducibility. `email`/`mailto` are contact details rather than secrets,
#: but they are still the caller's personal address and do not belong in output
#: that gets pasted into a report.
REDACTED_PARAMS = frozenset({"api_key", "apikey", "key", "email", "mailto", "tool"})
REDACTION = "REDACTED"


def redact_url(url: str) -> str:
    """Replace credential query-parameter values with a placeholder.

    The parameter *names* survive so the call stays reproducible: a reader can
    see that `api_key` was supplied and substitute their own.
    """
    from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

    parts = urlsplit(url)
    if not parts.query:
        return url
    pairs = [
        (name, REDACTION if name.lower() in REDACTED_PARAMS else value)
        for name, value in parse_qsl(parts.query, keep_blank_values=True)
    ]
    return urlunsplit(parts._replace(query=urlencode(pairs)))


def fail(message: str, code: int = 1) -> None:
    """Write `message` to stderr and exit non-zero.

    Scripts here exit non-zero on silent-failure conditions -- a JATS document
    with no `<body>`, an arXiv Error entry, a pagination shortfall -- precisely
    because the APIs return HTTP 200 for them.
    """
    sys.stderr.write(f"error: {message}\n")
    raise SystemExit(code)
