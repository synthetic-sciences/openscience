#!/usr/bin/env python3
"""Validate a bounded audit/readiness evidence manifest and optional local files."""

from __future__ import annotations

import argparse
import hashlib
from pathlib import Path
from typing import Any

from _catalog import StandardProfile
from _common import (
    ALLOWED_STATUSES,
    MAX_INPUT_BYTES,
    InputError,
    Review,
    finish,
    guarded_main,
    load_json,
    profile_for,
    require_root_object,
    standard_parser,
)

PURPOSES = {
    "internal-audit",
    "iso-certification-readiness",
    "accreditation-assessment-readiness",
    "fda-inspection-readiness",
    "national-regulatory-inspection-readiness",
    "mdsap-audit-readiness",
    "eu-conformity-assessment-readiness",
}
CLASSIFICATIONS = {"public", "internal", "confidential", "restricted"}


def _safe_evidence_file(base: Path, relative_text: str) -> Path:
    relative = Path(relative_text)
    if relative.is_absolute() or ".." in relative.parts:
        raise InputError(f"evidence path must be relative and contained: {relative}")
    if relative.suffix.lower() not in {".json", ".md", ".markdown"}:
        raise InputError(f"evidence file must be JSON or Markdown: {relative}")
    candidate = base / relative
    if candidate.is_symlink():
        raise InputError(f"symbolic-link evidence is refused: {relative}")
    try:
        resolved_base = base.resolve(strict=True)
        resolved = candidate.resolve(strict=True)
        resolved.relative_to(resolved_base)
        stat = resolved.stat()
    except (OSError, ValueError) as exc:
        raise InputError(f"invalid evidence path {relative}: {exc}") from exc
    if not resolved.is_file():
        raise InputError(f"evidence is not a regular file: {relative}")
    if stat.st_size > MAX_INPUT_BYTES:
        raise InputError(
            f"evidence exceeds {MAX_INPUT_BYTES} bytes: {relative}"
        )
    return resolved


def _text_array(
    review: Review,
    value: Any,
    path: str,
    allowed: set[str],
) -> list[str]:
    raw = review.list(value, path, min_items=1)
    if raw is None:
        return []
    result: list[str] = []
    for index, item in enumerate(raw):
        item_path = f"{path}[{index}]"
        if not isinstance(item, str) or item not in allowed:
            review.add(
                "VALUE_UNKNOWN",
                item_path,
                f"must be one of: {', '.join(sorted(allowed))}",
            )
        else:
            result.append(item)
    if len(result) != len(set(result)):
        review.add("VALUE_DUPLICATE", path, "must not contain duplicates")
    return result


def validate(
    data: dict[str, Any],
    *,
    base_dir: str | None,
    verify_files: bool,
    profile: StandardProfile,
) -> tuple[Review, dict[str, int]]:
    review = Review()
    domains = set(profile.process_domains)
    metadata = review.object(data.get("metadata"), "metadata")
    if metadata is not None:
        review.controlled_item(metadata, "metadata", require_approved=True)
        review.text(metadata, "manifest_id", "metadata", max_chars=120)
        review.date(metadata, "review_date", "metadata")

    context = review.object(data.get("audit_context"), "audit_context")
    if context is not None:
        review.choice(context, "purpose", PURPOSES, "audit_context")
        review.text(context, "scope", "audit_context", max_chars=3_000)
        review.text(context, "sampling_plan", "audit_context", max_chars=3_000)
        review.text(context, "limitations", "audit_context", max_chars=3_000)
        review.text(context, "owner", "audit_context", max_chars=200)
        review.evidence(context, "audit_context")
        review.approval(context, "audit_context", require_approved=True)
        review.source_refs(context, "audit_context")

    expected = _text_array(
        review,
        data.get("expected_domains"),
        "expected_domains",
        domains,
    )

    if verify_files and base_dir is None:
        raise InputError("--verify-files requires --base-dir")
    base = Path(base_dir) if base_dir is not None else None

    entries = review.list(data.get("entries"), "entries", min_items=1) or []
    covered: set[str] = set()
    verified_files = 0
    for index, value in enumerate(entries):
        path = f"entries[{index}]"
        entry = review.object(value, path)
        if entry is None:
            continue
        review.text(entry, "id", path, max_chars=120)
        domain = review.choice(
            entry,
            "domain",
            domains,
            path,
        )
        if domain:
            covered.add(domain)
        review.text(entry, "title", path, max_chars=300)
        review.text(entry, "owner", path, max_chars=200)
        status = review.choice(entry, "status", ALLOWED_STATUSES, path)
        review.text(entry, "revision_or_date", path, max_chars=120)
        review.choice(entry, "classification", CLASSIFICATIONS, path)
        local_path = review.text(entry, "local_path", path, max_chars=1_000)
        review.evidence(entry, path)
        review.source_refs(entry, path)
        review.approval(
            entry,
            path,
            require_approved=status in {"approved", "implemented", "verified", "closed"},
        )
        if verify_files and local_path is not None and base is not None:
            evidence_path = _safe_evidence_file(base, local_path)
            digest = hashlib.sha256(evidence_path.read_bytes()).hexdigest()
            expected_digest = entry.get("sha256")
            if expected_digest is not None:
                if (
                    not isinstance(expected_digest, str)
                    or len(expected_digest) != 64
                    or any(char not in "0123456789abcdef" for char in expected_digest)
                ):
                    review.add(
                        "HASH_INVALID",
                        f"{path}.sha256",
                        "must be a lowercase SHA-256 hex digest",
                    )
                elif expected_digest != digest:
                    review.add(
                        "HASH_MISMATCH",
                        f"{path}.sha256",
                        "does not match the local evidence file",
                        "blocker",
                    )
            verified_files += 1
    review.unique_ids(entries, "entries")

    for domain in sorted(set(expected) - covered):
        review.add(
            "DOMAIN_EVIDENCE_MISSING",
            "entries",
            f"no manifest entry covers expected domain: {domain}",
        )

    gaps = review.list(data.get("open_gaps"), "open_gaps", min_items=0) or []
    for index, value in enumerate(gaps):
        path = f"open_gaps[{index}]"
        gap = review.object(value, path)
        if gap is None:
            continue
        review.text(gap, "id", path, max_chars=120)
        review.text(gap, "description", path, max_chars=2_000)
        review.text(gap, "owner", path, max_chars=200)
        review.choice(gap, "status", {"open", "accepted", "closed"}, path)
        review.evidence(gap, path, min_items=0)
        review.approval(
            gap,
            path,
            require_approved=gap.get("status") in {"accepted", "closed"},
        )
    review.unique_ids(gaps, "open_gaps")

    return review, {
        "entries": len(entries),
        "expected_domains": len(expected),
        "open_gaps": len(gaps),
        "verified_files": verified_files,
    }


def main() -> int:
    parser = standard_parser(
        "Validate a local audit/readiness evidence manifest.",
        "Path to the local evidence-manifest JSON file",
        with_standard=True,
    )
    parser.add_argument(
        "--base-dir",
        help="Base directory for contained relative evidence paths",
    )
    parser.add_argument(
        "--verify-files",
        action="store_true",
        help="Verify bounded local JSON/Markdown evidence paths and optional hashes",
    )
    args: argparse.Namespace = parser.parse_args()
    profile = profile_for(args)
    data = require_root_object(load_json(args.input))
    review, metrics = validate(
        data,
        base_dir=args.base_dir,
        verify_files=args.verify_files,
        profile=profile,
    )
    return finish(
        "validate_evidence_manifest",
        review,
        args,
        metrics=metrics,
        standard=profile.key,
    )


if __name__ == "__main__":
    guarded_main(main)
