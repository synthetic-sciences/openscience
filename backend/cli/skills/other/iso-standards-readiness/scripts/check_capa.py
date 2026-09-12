#!/usr/bin/env python3
"""Check CAPA record structure, evidence, and effectiveness gates."""

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

CAPA_STATUSES = {
    "open",
    "investigating",
    "actions-in-progress",
    "effectiveness-pending",
    "closed",
    "cancelled",
}
EFFECTIVENESS_RESULTS = {"pending", "effective", "ineffective"}
RISK_DECISIONS = {"escalate", "control-and-monitor", "no-escalation"}


def _text_array(
    review: Review,
    value: Any,
    path: str,
    *,
    min_items: int = 1,
) -> list[str]:
    raw = review.list(value, path, min_items=min_items)
    if raw is None:
        return []
    result: list[str] = []
    for index, item in enumerate(raw):
        if not isinstance(item, str) or not item.strip():
            review.add(
                "TEXT_REQUIRED",
                f"{path}[{index}]",
                "requires non-placeholder text",
            )
        else:
            result.append(item.strip())
    return result


def validate(data: dict[str, Any]) -> tuple[Review, dict[str, int]]:
    review = Review()
    metadata = review.object(data.get("metadata"), "metadata")
    if metadata is not None:
        review.controlled_item(metadata, "metadata", require_approved=True)
        review.text(metadata, "register_id", "metadata", max_chars=120)
        review.date(metadata, "review_date", "metadata")

    capas = review.list(data.get("capas"), "capas", min_items=1) or []
    closed = 0
    for index, value in enumerate(capas):
        path = f"capas[{index}]"
        capa = review.object(value, path)
        if capa is None:
            continue
        review.text(capa, "id", path, max_chars=120)
        review.text(capa, "owner", path, max_chars=200)
        status = review.choice(capa, "status", CAPA_STATUSES, path)
        review.text(capa, "source_event", path, max_chars=1_000)
        review.text(capa, "problem_statement", path, max_chars=2_000)
        review.text(capa, "scope", path, max_chars=2_000)
        review.text(capa, "correction_or_containment", path, max_chars=2_000)
        review.evidence(capa, path)
        review.source_refs(capa, path)
        review.approval(capa, path, require_approved=status in {"closed", "cancelled"})

        risk_path = f"{path}.risk_assessment"
        risk = review.object(capa.get("risk_assessment"), risk_path)
        if risk is not None:
            review.text(risk, "patient_and_user_impact", risk_path, max_chars=2_000)
            review.text(risk, "product_and_process_impact", risk_path, max_chars=2_000)
            review.text(risk, "reportability_review", risk_path, max_chars=2_000)
            review.choice(risk, "decision", RISK_DECISIONS, risk_path)
            review.text(risk, "decision_rationale", risk_path, max_chars=2_000)
            review.text(risk, "owner", risk_path, max_chars=200)
            review.evidence(risk, risk_path)
            review.approval(risk, risk_path, require_approved=True)

        investigation_path = f"{path}.investigation"
        investigation = review.object(capa.get("investigation"), investigation_path)
        if investigation is not None:
            review.text(investigation, "method", investigation_path, max_chars=500)
            review.text(
                investigation,
                "root_cause_or_justified_conclusion",
                investigation_path,
                max_chars=3_000,
            )
            review.text(
                investigation,
                "systemic_extent_review",
                investigation_path,
                max_chars=2_000,
            )
            review.text(investigation, "owner", investigation_path, max_chars=200)
            review.evidence(investigation, investigation_path)
            review.approval(
                investigation,
                investigation_path,
                require_approved=status not in {"open", "investigating"},
            )

        actions = review.list(capa.get("actions"), f"{path}.actions", min_items=1) or []
        all_implemented = True
        for action_index, action_value in enumerate(actions):
            action_path = f"{path}.actions[{action_index}]"
            action = review.object(action_value, action_path)
            if action is None:
                all_implemented = False
                continue
            review.text(action, "id", action_path, max_chars=120)
            review.text(action, "description", action_path, max_chars=2_000)
            review.text(action, "owner", action_path, max_chars=200)
            review.date(action, "due_date", action_path)
            implemented = action.get("implemented_date")
            if implemented in (None, ""):
                all_implemented = False
                if status in {"effectiveness-pending", "closed"}:
                    review.add(
                        "ACTION_NOT_IMPLEMENTED",
                        f"{action_path}.implemented_date",
                        "implemented date is required at this CAPA status",
                    )
            else:
                review.date(action, "implemented_date", action_path)
                review.evidence(action, action_path)
                review.approval(action, action_path, require_approved=True)
        review.unique_ids(actions, f"{path}.actions")

        _text_array(
            review,
            capa.get("change_control_refs"),
            f"{path}.change_control_refs",
            min_items=1,
        )

        effect_path = f"{path}.effectiveness"
        effectiveness = review.object(capa.get("effectiveness"), effect_path)
        result = None
        if effectiveness is not None:
            review.text(effectiveness, "plan", effect_path, max_chars=2_000)
            review.text(
                effectiveness,
                "objective_acceptance_criteria",
                effect_path,
                max_chars=2_000,
            )
            review.text(effectiveness, "baseline", effect_path, max_chars=1_000)
            review.text(
                effectiveness,
                "sample_or_observation_window",
                effect_path,
                max_chars=1_000,
            )
            review.date(effectiveness, "due_date", effect_path)
            review.text(effectiveness, "owner", effect_path, max_chars=200)
            review.text(
                effectiveness,
                "independent_reviewer",
                effect_path,
                max_chars=200,
            )
            result = review.choice(
                effectiveness,
                "result",
                EFFECTIVENESS_RESULTS,
                effect_path,
            )
            if result != "pending":
                review.text(
                    effectiveness,
                    "conclusion",
                    effect_path,
                    max_chars=2_000,
                )
                review.date(effectiveness, "review_date", effect_path)
                review.evidence(effectiveness, effect_path)
                review.approval(
                    effectiveness,
                    effect_path,
                    require_approved=True,
                )

        if status == "closed":
            closed += 1
            if not all_implemented:
                review.add(
                    "CLOSURE_BLOCKED",
                    path,
                    "closed CAPA has unimplemented actions",
                    "blocker",
                )
            if result != "effective":
                review.add(
                    "CLOSURE_BLOCKED",
                    f"{effect_path}.result",
                    "closed CAPA requires approved effective result",
                    "blocker",
                )
            review.date(capa, "closure_date", path)
            review.text(capa, "closure_summary", path, max_chars=2_000)
        elif result == "ineffective":
            review.add(
                "REOPEN_REQUIRED",
                f"{effect_path}.result",
                "ineffective action must not be closed and needs documented follow-up",
                "blocker",
            )

        if status == "cancelled":
            review.text(capa, "cancellation_rationale", path, max_chars=2_000)

    review.unique_ids(capas, "capas")
    return review, {"capas": len(capas), "closed_capas": closed}


def main() -> int:
    parser = standard_parser(
        "Check CAPA records and fail closed on missing effectiveness evidence.",
        "Path to the local CAPA JSON file",
    )
    args = parser.parse_args()
    data = require_root_object(load_json(args.input))
    review, metrics = validate(data)
    return finish("check_capa", review, args, metrics=metrics)


if __name__ == "__main__":
    guarded_main(main)
