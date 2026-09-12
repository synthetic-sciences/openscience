#!/usr/bin/env python3
"""Check supplier and outsourced-process control evidence."""

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

SUPPLIER_STATUSES = {"candidate", "approved", "conditional", "suspended", "disqualified"}
CRITICALITIES = {"low", "medium", "high", "critical"}
CONTROL_STATUSES = {"planned", "implemented", "verified", "not-applicable"}


def _control(
    review: Review,
    supplier: dict[str, Any],
    key: str,
    path: str,
    *,
    required: bool,
) -> None:
    control_path = f"{path}.{key}"
    control = review.object(supplier.get(key), control_path)
    if control is None:
        return
    status = review.choice(control, "status", CONTROL_STATUSES, control_path)
    review.text(control, "owner", control_path, max_chars=200)
    review.text(control, "method", control_path, max_chars=2_000)
    review.evidence(
        control,
        control_path,
        min_items=1 if status in {"implemented", "verified", "not-applicable"} else 0,
    )
    review.approval(
        control,
        control_path,
        require_approved=status in {"verified", "not-applicable"},
    )
    review.source_refs(control, control_path)
    if status == "not-applicable":
        review.text(control, "rationale", control_path, max_chars=2_000)
    if required and status not in {"implemented", "verified"}:
        review.add(
            "CONTROL_NOT_READY",
            f"{control_path}.status",
            "risk-based supplier control must be implemented or verified",
            "blocker",
        )


def validate(data: dict[str, Any]) -> tuple[Review, dict[str, int]]:
    review = Review()
    metadata = review.object(data.get("metadata"), "metadata")
    if metadata is not None:
        review.controlled_item(metadata, "metadata", require_approved=True)
        review.text(metadata, "register_id", "metadata", max_chars=120)
        review.date(metadata, "review_date", "metadata")

    methodology = review.object(data.get("control_methodology"), "control_methodology")
    if methodology is not None:
        review.text(methodology, "risk_method", "control_methodology", max_chars=2_000)
        review.text(
            methodology,
            "approval_authority",
            "control_methodology",
            max_chars=200,
        )
        review.text(
            methodology,
            "monitoring_and_escalation",
            "control_methodology",
            max_chars=2_000,
        )
        review.text(methodology, "owner", "control_methodology", max_chars=200)
        review.evidence(methodology, "control_methodology")
        review.approval(
            methodology,
            "control_methodology",
            require_approved=True,
        )
        review.source_refs(methodology, "control_methodology")

    suppliers = review.list(data.get("suppliers"), "suppliers", min_items=1) or []
    approved = 0
    for index, value in enumerate(suppliers):
        path = f"suppliers[{index}]"
        supplier = review.object(value, path)
        if supplier is None:
            continue
        review.text(supplier, "id", path, max_chars=120)
        review.text(supplier, "name", path, max_chars=300)
        review.text(supplier, "owner", path, max_chars=200)
        status = review.choice(supplier, "status", SUPPLIER_STATUSES, path)
        criticality = review.choice(supplier, "criticality", CRITICALITIES, path)
        review.text(
            supplier,
            "product_service_or_process",
            path,
            max_chars=1_000,
        )
        review.text(supplier, "risk_rationale", path, max_chars=2_000)
        review.date(supplier, "next_review_date", path)
        review.evidence(supplier, path)
        review.approval(supplier, path, require_approved=status == "approved")
        review.source_refs(supplier, path)
        if status == "approved":
            approved += 1

        strict = criticality in {"high", "critical"} and status in {
            "approved",
            "conditional",
        }
        for key in (
            "selection_and_initial_evaluation",
            "purchasing_requirements",
            "change_notification",
            "incoming_or_acceptance_verification",
            "performance_monitoring",
            "reevaluation",
            "nonconformity_and_capa",
        ):
            _control(review, supplier, key, path, required=strict)
        for key in (
            "quality_agreement",
            "subtier_controls",
            "business_continuity",
        ):
            _control(
                review,
                supplier,
                key,
                path,
                required=criticality == "critical" and status in {"approved", "conditional"},
            )

        if status == "conditional":
            review.text(supplier, "conditions", path, max_chars=2_000)
            review.date(supplier, "condition_due_date", path)
        if status in {"suspended", "disqualified"}:
            review.text(supplier, "disposition", path, max_chars=2_000)

    review.unique_ids(suppliers, "suppliers")
    return review, {"approved_suppliers": approved, "suppliers": len(suppliers)}


def main() -> int:
    parser = standard_parser(
        "Check risk-based supplier and outsourced-process control evidence.",
        "Path to the local supplier-controls JSON file",
    )
    args = parser.parse_args()
    data = require_root_object(load_json(args.input))
    review, metrics = validate(data)
    return finish("check_supplier_controls", review, args, metrics=metrics)


if __name__ == "__main__":
    guarded_main(main)
