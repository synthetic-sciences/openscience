#!/usr/bin/env python3
"""Audit exact benchmark source pins and report upstream drift without mutating them."""

from __future__ import annotations

import argparse
import concurrent.futures
import datetime as dt
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path, PurePosixPath
from typing import Any


VERSION = "1"
HEX = re.compile(r"^[a-f0-9]{40}$")
DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
STATUSES = {"official_open", "official_subset", "methodology_only"}


class CatalogError(ValueError):
    pass


def canonical(value: Any) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()


def digest(value: Any) -> str:
    return hashlib.sha256(canonical(value)).hexdigest()


def text(value: object, name: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise CatalogError(f"{name} must be a non-empty string")
    return value.strip()


def date(value: object, name: str) -> dt.date:
    raw = text(value, name)
    if not DATE.fullmatch(raw):
        raise CatalogError(f"{name} must use YYYY-MM-DD")
    try:
        return dt.date.fromisoformat(raw)
    except ValueError as error:
        raise CatalogError(f"{name} is not a calendar date") from error


def remote(value: object, name: str, allow_local: bool) -> str:
    raw = text(value, name)
    parsed = urllib.parse.urlparse(raw)
    if parsed.scheme == "https" and parsed.netloc and not parsed.username and not parsed.password:
        return raw
    if allow_local and (parsed.scheme == "file" or Path(raw).is_absolute()):
        return raw
    raise CatalogError(f"{name} must be an HTTPS URL")


def paths(value: object, name: str) -> list[str]:
    if value is None:
        return []
    if not isinstance(value, list) or len(value) > 50:
        raise CatalogError(f"{name} must be an array with at most 50 entries")
    result: list[str] = []
    for index, item in enumerate(value):
        raw = text(item, f"{name}[{index}]")
        path = PurePosixPath(raw)
        if path.is_absolute() or ".." in path.parts or raw in result:
            raise CatalogError(f"{name}[{index}] must be a unique repository-relative path")
        result.append(raw)
    return result


def load(value: object, allow_local: bool) -> list[dict[str, Any]]:
    if not isinstance(value, list) or not value:
        raise CatalogError("catalog must be a non-empty JSON array")
    ids: set[str] = set()
    result: list[dict[str, Any]] = []
    for index, item in enumerate(value):
        if not isinstance(item, dict):
            raise CatalogError(f"catalog[{index}] must be an object")
        key = text(item.get("id"), f"catalog[{index}].id")
        if key in ids:
            raise CatalogError(f"duplicate benchmark id: {key}")
        ids.add(key)
        source = item.get("source")
        if not isinstance(source, dict) or source.get("status") not in STATUSES:
            raise CatalogError(f"catalog[{index}].source has an unsupported status")
        status = str(source["status"])
        if status == "methodology_only":
            text(source.get("reason"), f"{key}.source.reason")
            result.append({"id": key, "status": status, "reason": source["reason"]})
            continue
        revision = text(source.get("revision"), f"{key}.source.revision")
        if not HEX.fullmatch(revision):
            raise CatalogError(f"{key}.source.revision must be a lowercase 40-hex commit")
        checked = date(source.get("checkedAt"), f"{key}.source.checkedAt")
        dataset = source.get("dataset")
        entry: dict[str, Any] = {
            "id": key,
            "status": status,
            "repository": remote(source.get("repository"), f"{key}.source.repository", allow_local),
            "revision": revision,
            "checkedAt": checked.isoformat(),
            "requiredPaths": paths(source.get("requiredPaths"), f"{key}.source.requiredPaths"),
            "dataset": remote(dataset, f"{key}.source.dataset", allow_local) if dataset else None,
        }
        if status == "official_subset":
            public = source.get("publicTasks")
            total = source.get("totalTasks")
            if not isinstance(public, int) or isinstance(public, bool) or public <= 0:
                raise CatalogError(f"{key}.source.publicTasks must be a positive integer")
            if not isinstance(total, int) or isinstance(total, bool) or total <= public:
                raise CatalogError(f"{key}.source.totalTasks must exceed publicTasks")
            entry["publicTasks"] = public
            entry["totalTasks"] = total
        result.append(entry)
    return result


def command(args: list[str], timeout: float) -> subprocess.CompletedProcess[str]:
    env = {**os.environ, "GIT_TERMINAL_PROMPT": "0", "GIT_ASKPASS": ""}
    return subprocess.run(args, capture_output=True, text=True, timeout=timeout, env=env, check=False)


def detail(result: subprocess.CompletedProcess[str]) -> str:
    value = (result.stderr or result.stdout).strip().replace("\n", " ")
    return value[:500] or f"command exited {result.returncode}"


def head(repository: str, timeout: float) -> tuple[str | None, str | None, str | None]:
    try:
        result = command(["git", "ls-remote", "--symref", repository, "HEAD"], timeout)
    except (OSError, subprocess.TimeoutExpired) as error:
        return None, None, str(error)
    if result.returncode:
        return None, None, detail(result)
    revision = next(
        (line.split("\t", 1)[0] for line in result.stdout.splitlines() if line.endswith("\tHEAD") and HEX.fullmatch(line.split("\t", 1)[0])),
        None,
    )
    branch = next(
        (line.split()[1] for line in result.stdout.splitlines() if line.startswith("ref: ") and line.endswith(" HEAD")),
        None,
    )
    if not revision:
        return None, branch, "remote did not advertise a default HEAD commit"
    return revision, branch, None


def pin(
    repository: str, revision: str, required: list[str], timeout: float
) -> tuple[bool, dict[str, bool], str | None]:
    with tempfile.TemporaryDirectory(prefix="openscience-source-audit-") as temp:
        try:
            initialized = command(["git", "init", "--bare", "--quiet", temp], timeout)
            if initialized.returncode:
                return False, {}, detail(initialized)
            fetched = command(
                [
                    "git",
                    "-C",
                    temp,
                    "fetch",
                    "--quiet",
                    "--depth=1",
                    "--filter=blob:none",
                    "--no-tags",
                    repository,
                    revision,
                ],
                timeout,
            )
            if fetched.returncode:
                return False, {}, detail(fetched)
            resolved = command(["git", "-C", temp, "rev-parse", "FETCH_HEAD^{commit}"], timeout)
            if resolved.returncode or resolved.stdout.strip() != revision:
                return False, {}, detail(resolved)
            checks = {}
            for item in required:
                found = command(["git", "-C", temp, "cat-file", "-e", f"{revision}:{item}"], timeout)
                checks[item] = found.returncode == 0
            return True, checks, None if all(checks.values()) else "required repository path is missing"
        except (OSError, subprocess.TimeoutExpired) as error:
            return False, {}, str(error)


def available(url: str, timeout: float) -> tuple[bool, int | None, str | None]:
    headers = {"User-Agent": f"OpenScience-source-auditor/{VERSION}"}
    for method in ("HEAD", "GET"):
        request = urllib.request.Request(url, headers={**headers, "Range": "bytes=0-0"}, method=method)
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                if method == "GET":
                    response.read(1)
                return 200 <= response.status < 400, response.status, None
        except urllib.error.HTTPError as error:
            if method == "HEAD" and error.code in {403, 405}:
                continue
            return False, error.code, str(error)
        except (OSError, urllib.error.URLError) as error:
            return False, None, str(error)
    return False, None, "dataset source rejected both HEAD and ranged GET"


def audit(entry: dict[str, Any], today: dt.date, timeout: float, max_age: int) -> dict[str, Any]:
    if entry["status"] == "methodology_only":
        return {
            "id": entry["id"],
            "sourceStatus": entry["status"],
            "outcome": "not_applicable",
            "reason": entry["reason"],
        }
    reachable, required, pin_error = pin(
        entry["repository"], entry["revision"], entry["requiredPaths"], timeout
    )
    current, branch, head_error = head(entry["repository"], timeout)
    dataset = None
    if entry["dataset"]:
        accessible, code, dataset_error = available(entry["dataset"], timeout)
        dataset = {"source": entry["dataset"], "available": accessible, "statusCode": code, "error": dataset_error}
    age = (today - dt.date.fromisoformat(entry["checkedAt"])).days
    failures = []
    if not reachable:
        failures.append("pin_unreachable")
    if reachable and not all(required.values()):
        failures.append("required_path_missing")
    if not current:
        failures.append("head_unresolved")
    if dataset and not dataset["available"]:
        failures.append("dataset_unavailable")
    if age < 0:
        failures.append("catalog_check_future")
    reviews = []
    if current and current != entry["revision"]:
        reviews.append("upstream_changed")
    if age > max_age:
        reviews.append("catalog_check_stale")
    result = {
        "id": entry["id"],
        "sourceStatus": entry["status"],
        "outcome": "failed" if failures else "passed",
        "repository": entry["repository"],
        "revision": entry["revision"],
        "pinReachable": reachable,
        "requiredPaths": required,
        "pinError": pin_error,
        "defaultRef": branch,
        "headRevision": current,
        "headError": head_error,
        "relation": "current" if current == entry["revision"] else "upstream_changed" if current else "unknown",
        "dataset": dataset,
        "checkedAt": entry["checkedAt"],
        "ageDays": age,
        "reviews": reviews,
        "failures": failures,
    }
    if entry["status"] == "official_subset":
        result["scope"] = {"publicTasks": entry["publicTasks"], "totalTasks": entry["totalTasks"]}
    return result


def write(report: dict[str, Any], output: Path | None) -> None:
    payload = json.dumps(report, indent=2, sort_keys=True) + "\n"
    if output:
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(payload)
    sys.stdout.write(payload)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("catalog", type=Path, help="catalog JSON file, or - for stdin")
    parser.add_argument("--output", type=Path)
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--timeout", type=float, default=30)
    parser.add_argument("--max-age-days", type=int, default=30)
    parser.add_argument("--today", type=str)
    parser.add_argument("--allow-local", action="store_true")
    args = parser.parse_args()
    if not 1 <= args.workers <= 16 or args.timeout <= 0 or args.max_age_days < 0:
        parser.error("workers must be 1..16, timeout must be positive, and max-age-days must be nonnegative")
    try:
        today = date(args.today, "today") if args.today else dt.datetime.now().astimezone().date()
        raw = sys.stdin.read() if str(args.catalog) == "-" else args.catalog.read_text()
        value = json.loads(raw)
        catalog = load(value, args.allow_local)
    except (OSError, json.JSONDecodeError, CatalogError) as error:
        print(f"audit-benchmark-sources: {error}", file=sys.stderr)
        return 2
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as pool:
        entries = list(pool.map(lambda item: audit(item, today, args.timeout, args.max_age_days), catalog))
    failures = [f"{entry['id']}:{item}" for entry in entries for item in entry.get("failures", [])]
    reviews = [f"{entry['id']}:{item}" for entry in entries for item in entry.get("reviews", [])]
    official = [entry for entry in entries if entry["sourceStatus"] != "methodology_only"]
    report: dict[str, Any] = {
        "schemaVersion": 1,
        "auditor": {"name": "audit-benchmark-sources", "version": VERSION},
        "auditedAt": dt.datetime.now(dt.timezone.utc).isoformat(),
        "catalogSHA256": digest(value),
        "status": "failed" if failures else "passed",
        "summary": {
            "entries": len(entries),
            "official": len(official),
            "verified": sum(entry["outcome"] == "passed" for entry in official),
            "failed": sum(entry["outcome"] == "failed" for entry in official),
            "methodologyOnly": sum(entry["sourceStatus"] == "methodology_only" for entry in entries),
            "officialSubsets": sum(entry["sourceStatus"] == "official_subset" for entry in entries),
            "upstreamChanged": sum(entry.get("relation") == "upstream_changed" for entry in official),
            "stale": sum("catalog_check_stale" in entry.get("reviews", []) for entry in official),
        },
        "entries": entries,
        "reviews": reviews,
        "failures": failures,
    }
    report["reportSHA256"] = digest(report)
    write(report, args.output)
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
