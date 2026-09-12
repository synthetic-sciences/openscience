#!/usr/bin/env python3
"""Check risk/design/production/postmarket traceability references."""

from __future__ import annotations

from typing import Any

from _catalog import TRACEABILITY_LINKS
from _common import (
    ALLOWED_STATUSES,
    Review,
    finish,
    guarded_main,
    load_json,
    require_root_object,
    standard_parser,
)

ARTIFACT_TYPES = {
    "intended-use",
    "hazard",
    "postmarket-signal",
    "risk-evaluation",
    "risk-control",
    "design-input",
    "design-output",
    "verification",
    "validation",
    "production-control",
    "change-control",
    "capa",
    "not-applicable-decision",
    "other",
}


def _reference_list(
    review: Review,
    value: Any,
    path: str,
    artifact_ids: set[str],
) -> list[str]:
    raw = review.list(value, path, min_items=1)
    if raw is None:
        return []
    result: list[str] = []
    for index, item in enumerate(raw):
        item_path = f"{path}[{index}]"
        if not isinstance(item, str) or not item.strip():
            review.add("REFERENCE_REQUIRED", item_path, "requires an artifact id")
            continue
        result.append(item)
        if item not in artifact_ids:
            review.add(
                "REFERENCE_MISSING",
                item_path,
                f"artifact id is not defined: {item}",
            )
    if len(result) != len(set(result)):
        review.add("REFERENCE_DUPLICATE", path, "contains duplicate artifact ids")
    return result


def validate(data: dict[str, Any]) -> tuple[Review, dict[str, int]]:
    review = Review()
    metadata = review.object(data.get("metadata"), "metadata")
    if metadata is not None:
        review.controlled_item(metadata, "metadata", require_approved=True)
        review.text(metadata, "matrix_id", "metadata", max_chars=120)
        review.date(metadata, "review_date", "metadata")

    artifacts = review.list(data.get("artifacts"), "artifacts", min_items=1) or []
    artifact_ids: set[str] = set()
    for index, value in enumerate(artifacts):
        path = f"artifacts[{index}]"
        artifact = review.object(value, path)
        if artifact is None:
            continue
        identifier = review.text(artifact, "id", path, max_chars=120)
        if identifier:
            artifact_ids.add(identifier)
        review.choice(artifact, "type", ARTIFACT_TYPES, path)
        review.text(artifact, "title", path, max_chars=300)
        review.text(artifact, "owner", path, max_chars=200)
        status = review.choice(artifact, "status", ALLOWED_STATUSES, path)
        review.evidence(artifact, path)
        review.approval(
            artifact,
            path,
            require_approved=status in {"approved", "implemented", "verified", "closed"},
        )
        review.source_refs(artifact, path)
        if artifact.get("type") == "not-applicable-decision":
            review.text(artifact, "rationale", path, max_chars=2_000)
            review.approval(artifact, path, require_approved=True)
    review.unique_ids(artifacts, "artifacts")

    rows = review.list(data.get("rows"), "rows", min_items=1) or []
    verified_rows = 0
    for index, value in enumerate(rows):
        path = f"rows[{index}]"
        row = review.object(value, path)
        if row is None:
            continue
        review.text(row, "id", path, max_chars=120)
        review.text(row, "product_id", path, max_chars=120)
        review.text(row, "owner", path, max_chars=200)
        status = review.choice(row, "status", ALLOWED_STATUSES, path)
        review.text(row, "linkage_rationale", path, max_chars=3_000)
        review.evidence(row, path)
        review.source_refs(row, path)
        review.approval(row, path, require_approved=status == "verified")

        links_path = f"{path}.links"
        links = review.object(row.get("links"), links_path)
        if links is not None:
            for link_name in TRACEABILITY_LINKS:
                _reference_list(
                    review,
                    links.get(link_name),
                    f"{links_path}.{link_name}",
                    artifact_ids,
                )

        change_refs = row.get("change_control_refs")
        if change_refs in (None, []):
            review.add(
                "CHANGE_LINK_REQUIRED",
                f"{path}.change_control_refs",
                "requires a change-control artifact or approved not-applicable decision",
            )
        else:
            _reference_list(
                review,
                change_refs,
                f"{path}.change_control_refs",
                artifact_ids,
            )

        gaps = review.list(row.get("open_gaps"), f"{path}.open_gaps", min_items=0)
        if status == "verified":
            verified_rows += 1
            if gaps:
                review.add(
                    "VERIFICATION_BLOCKED",
                    f"{path}.open_gaps",
                    "verified row must not contain open gaps",
                    "blocker",
                )
    review.unique_ids(rows, "rows")

    return review, {
        "artifacts": len(artifacts),
        "rows": len(rows),
        "verified_rows": verified_rows,
    }


def main() -> int:
    parser = standard_parser(
        "Check explicit traceability from risks and design through postmarket evidence.",
        "Path to the local traceability-matrix JSON file",
    )
    args = parser.parse_args()
    data = require_root_object(load_json(args.input))
    review, metrics = validate(data)
    return finish("check_traceability", review, args, metrics=metrics)


if __name__ == "__main__":
    guarded_main(main)
