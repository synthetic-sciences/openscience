#!/usr/bin/env python3
"""Audit local document/record register metadata without opening evidence files."""

from __future__ import annotations

from typing import Any

from _common import (
    Review,
    finish,
    guarded_main,
    load_json,
    require_root_object,
    standard_parser,
)

DOCUMENT_STATUSES = {"draft", "in-review", "effective", "obsolete"}
RECORD_STATUSES = {"active", "archived", "disposed"}
EXTERNAL_STATUSES = {"current", "review-due", "superseded"}


def _core(
    review: Review,
    item: dict[str, Any],
    path: str,
    *,
    require_approved: bool,
) -> None:
    review.text(item, "owner", path, max_chars=200)
    review.evidence(item, path)
    review.approval(item, path, require_approved=require_approved)
    review.source_refs(item, path)


def validate(data: dict[str, Any]) -> tuple[Review, dict[str, int]]:
    review = Review()

    metadata = review.object(data.get("metadata"), "metadata")
    if metadata is not None:
        review.controlled_item(metadata, "metadata", require_approved=True)
        review.text(metadata, "register_id", "metadata", max_chars=120)
        review.date(metadata, "review_date", "metadata")

    documents = review.list(data.get("documents"), "documents", min_items=1) or []
    document_ids: set[str] = set()
    for index, value in enumerate(documents):
        path = f"documents[{index}]"
        item = review.object(value, path)
        if item is None:
            continue
        identifier = review.text(item, "id", path, max_chars=120)
        if identifier:
            document_ids.add(identifier)
        review.text(item, "title", path, max_chars=300)
        review.text(item, "document_type", path, max_chars=120)
        review.text(item, "revision", path, max_chars=80)
        status = review.choice(item, "status", DOCUMENT_STATUSES, path)
        review.text(item, "change_summary", path, max_chars=2_000)
        review.text(item, "training_impact", path, max_chars=1_000)
        _core(review, item, path, require_approved=status == "effective")
        if status == "effective":
            review.date(item, "effective_date", path)
        if status == "obsolete":
            review.text(item, "disposition", path, max_chars=500)
            review.date(item, "obsolete_date", path)
    review.unique_ids(documents, "documents")

    for index, value in enumerate(documents):
        if not isinstance(value, dict):
            continue
        supersedes = value.get("supersedes")
        if supersedes in (None, ""):
            continue
        if not isinstance(supersedes, str) or supersedes not in document_ids:
            review.add(
                "REFERENCE_MISSING",
                f"documents[{index}].supersedes",
                "must reference another document id in this register",
            )

    records = review.list(data.get("records"), "records", min_items=1) or []
    for index, value in enumerate(records):
        path = f"records[{index}]"
        item = review.object(value, path)
        if item is None:
            continue
        review.text(item, "id", path, max_chars=120)
        review.text(item, "record_type", path, max_chars=200)
        status = review.choice(item, "status", RECORD_STATUSES, path)
        review.text(item, "retention_period", path, max_chars=300)
        review.text(item, "retention_basis", path, max_chars=1_000)
        review.text(item, "storage_and_integrity_controls", path, max_chars=2_000)
        review.text(item, "retrieval_method", path, max_chars=1_000)
        review.text(item, "disposition_method", path, max_chars=1_000)
        _core(review, item, path, require_approved=True)
        if status == "disposed":
            review.date(item, "disposition_date", path)
            review.text(item, "disposition_authorized_by", path, max_chars=200)
    review.unique_ids(records, "records")

    external = (
        review.list(
            data.get("external_sources"),
            "external_sources",
            min_items=1,
        )
        or []
    )
    for index, value in enumerate(external):
        path = f"external_sources[{index}]"
        item = review.object(value, path)
        if item is None:
            continue
        review.text(item, "id", path, max_chars=120)
        review.text(item, "title", path, max_chars=300)
        review.text(item, "publisher", path, max_chars=200)
        review.text(item, "version_or_date", path, max_chars=120)
        status = review.choice(item, "status", EXTERNAL_STATUSES, path)
        review.date(item, "last_currency_review", path)
        _core(review, item, path, require_approved=status == "current")
        if status != "current":
            review.add(
                "SOURCE_NOT_CURRENT",
                f"{path}.status",
                "source requires documented impact assessment or replacement",
            )
    review.unique_ids(external, "external_sources")

    return review, {
        "documents": len(documents),
        "external_sources": len(external),
        "records": len(records),
    }


def main() -> int:
    parser = standard_parser(
        "Audit a bounded local document, record, and external-source register.",
        "Path to the local document-register JSON file",
    )
    args = parser.parse_args()
    data = require_root_object(load_json(args.input))
    review, metrics = validate(data)
    return finish("audit_document_records", review, args, metrics=metrics)


if __name__ == "__main__":
    guarded_main(main)
