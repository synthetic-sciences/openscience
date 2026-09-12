#!/usr/bin/env python3
"""Validate a declared applicability and scope intake for one standard profile.

The script checks whether accountable humans documented decisions and evidence. It
does not decide whether a law, regulation, standard, conformity route, or
accreditation scheme applies.
"""

from __future__ import annotations

from typing import Any

from _catalog import StandardProfile
from _common import (
    Review,
    finish,
    guarded_main,
    load_json,
    profile_for,
    require_root_object,
    standard_parser,
)

APPLICABILITY = {"applicable", "not-applicable", "undetermined"}


def _text_list(
    review: Review,
    value: Any,
    path: str,
    *,
    allowed: set[str] | None = None,
    min_items: int = 1,
) -> list[str]:
    raw = review.list(value, path, min_items=min_items)
    if raw is None:
        return []
    result: list[str] = []
    for index, item in enumerate(raw):
        item_path = f"{path}[{index}]"
        if not isinstance(item, str) or not item.strip():
            review.add("TEXT_REQUIRED", item_path, "requires non-empty text")
            continue
        if allowed is not None and item not in allowed:
            review.add(
                "VALUE_UNKNOWN",
                item_path,
                f"must be one of: {', '.join(sorted(allowed))}",
            )
            continue
        result.append(item)
    if len(result) != len(set(result)):
        review.add("VALUE_DUPLICATE", path, "must not contain duplicate values")
    return result


def validate(
    data: dict[str, Any],
    profile: StandardProfile,
) -> tuple[Review, dict[str, int]]:
    review = Review()
    activities = set(profile.scope_activities)

    metadata = review.object(data.get("metadata"), "metadata")
    if metadata is not None:
        review.controlled_item(metadata, "metadata", require_approved=True)
        review.text(metadata, "intake_id", "metadata", max_chars=120)
        review.date(metadata, "review_date", "metadata")

    organization = review.object(data.get("organization"), "organization")
    if organization is not None:
        review.text(organization, "legal_name", "organization", max_chars=300)
        review.text(
            organization,
            "declared_lifecycle_role",
            "organization",
            max_chars=300,
        )
        review.text(
            organization,
            "authorized_management_representative",
            "organization",
            max_chars=200,
        )
        review.text(organization, "raqa_owner", "organization", max_chars=200)
        review.text(
            organization,
            "applicability_decision_owner",
            "organization",
            max_chars=200,
        )

    scope = review.object(data.get("scope"), "scope")
    sites: list[Any] = []
    scope_items: list[Any] = []
    markets: list[Any] = []
    if scope is not None:
        _text_list(
            review,
            scope.get(profile.activities_section),
            f"scope.{profile.activities_section}",
            allowed=activities,
        )

        sites = review.list(scope.get("sites"), "scope.sites", min_items=1) or []
        for index, item in enumerate(sites):
            path = f"scope.sites[{index}]"
            site = review.object(item, path)
            if site is None:
                continue
            review.text(site, "id", path, max_chars=120)
            review.text(site, "name", path, max_chars=300)
            review.text(site, "address", path, max_chars=500)
            _text_list(
                review,
                site.get("activities"),
                f"{path}.activities",
                allowed=activities,
            )
            review.controlled_item(site, path, require_approved=True)
        review.unique_ids(sites, "scope.sites")

        section = profile.scope_item_section
        scope_items = (
            review.list(scope.get(section), f"scope.{section}", min_items=1) or []
        )
        for index, item in enumerate(scope_items):
            path = f"scope.{section}[{index}]"
            scope_item = review.object(item, path)
            if scope_item is None:
                continue
            review.text(scope_item, "id", path, max_chars=120)
            for field, max_chars in profile.scope_item_fields:
                review.text(scope_item, field, path, max_chars=max_chars)
            _text_list(review, scope_item.get("market_ids"), f"{path}.market_ids")
            review.controlled_item(scope_item, path, require_approved=True)
        review.unique_ids(scope_items, f"scope.{section}")

        markets = review.list(scope.get("markets"), "scope.markets", min_items=1) or []
        for index, item in enumerate(markets):
            path = f"scope.markets[{index}]"
            market = review.object(item, path)
            if market is None:
                continue
            review.text(market, "id", path, max_chars=120)
            review.text(market, "jurisdiction", path, max_chars=300)
            decision = review.choice(
                market,
                "applicability",
                APPLICABILITY,
                path,
            )
            if decision == "undetermined":
                review.add(
                    "HUMAN_DECISION_REQUIRED",
                    f"{path}.applicability",
                    "authorized RA/QA or legal review must resolve applicability",
                    "blocker",
                )
            review.text(market, "decision_rationale", path, max_chars=2_000)
            review.controlled_item(market, path, require_approved=True)
        review.unique_ids(markets, "scope.markets")

        outsourced = review.list(
            scope.get("outsourced_processes"),
            "scope.outsourced_processes",
            min_items=0,
        )
        if outsourced is not None:
            for index, item in enumerate(outsourced):
                path = f"scope.outsourced_processes[{index}]"
                process = review.object(item, path)
                if process is None:
                    continue
                review.text(process, "id", path, max_chars=120)
                review.text(process, "process", path, max_chars=300)
                review.text(process, "provider", path, max_chars=300)
                review.text(process, "control_strategy", path, max_chars=2_000)
                review.controlled_item(process, path, require_approved=True)
            review.unique_ids(outsourced, "scope.outsourced_processes")

    return review, {
        "markets": len(markets),
        profile.scope_item_section: len(scope_items),
        "sites": len(sites),
    }


def main() -> int:
    parser = standard_parser(
        "Validate a local scope/applicability intake without deciding applicability.",
        "Path to the local scope-intake JSON file",
        with_standard=True,
    )
    args = parser.parse_args()
    profile = profile_for(args)
    data = require_root_object(load_json(args.input))
    review, metrics = validate(data, profile)
    return finish(
        "validate_scope_intake",
        review,
        args,
        metrics=metrics,
        standard=profile.key,
    )


if __name__ == "__main__":
    guarded_main(main)
