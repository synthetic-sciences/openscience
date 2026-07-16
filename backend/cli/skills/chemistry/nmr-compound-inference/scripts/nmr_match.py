#!/usr/bin/env python3
"""Rank local reference candidates against an observed 1D NMR peak list."""

from __future__ import annotations

import argparse
import csv
import json
import math
from pathlib import Path
from typing import Any


def normalize_nucleus(value: str) -> str:
    compact = value.upper().replace("^", "").replace("-", "").replace(" ", "")
    if compact in {"1H", "H1", "PROTON"}:
        return "1H"
    if compact in {"13C", "C13", "CARBON"}:
        return "13C"
    raise ValueError(f"Unsupported nucleus {value!r}; expected 1H or 13C")


def region_flags(peaks: list[dict[str, float]], nucleus: str) -> dict[str, bool]:
    positions = [float(peak["position"]) for peak in peaks]
    ranges = {
        "1H": {
            "aldehyde": (9.0, 10.5),
            "aromatic": (6.0, 9.0),
            "olefinic": (4.5, 7.0),
            "heteroatom_bound": (3.0, 5.0),
            "aliphatic": (0.0, 3.0),
        },
        "13C": {
            "carbonyl": (160.0, 220.0),
            "aromatic_or_olefinic": (100.0, 160.0),
            "heteroatom_bound": (45.0, 100.0),
            "aliphatic": (0.0, 60.0),
        },
    }[normalize_nucleus(nucleus)]
    return {name: any(low <= position <= high for position in positions) for name, (low, high) in ranges.items()}


def load_library(path: Path) -> list[dict[str, Any]]:
    if path.suffix.lower() == ".json":
        value = json.loads(path.read_text(encoding="utf-8"))
        candidates = value.get("candidates", []) if isinstance(value, dict) else value
        if not isinstance(candidates, list):
            raise ValueError(f"Library {path} must contain a JSON list or a candidates list")
        return [candidate for candidate in candidates if isinstance(candidate, dict)]

    rows = list(csv.DictReader(path.open(newline="", encoding="utf-8")))
    grouped: dict[tuple[str, str, str, str, str, str], dict[str, Any]] = {}
    for row in rows:
        key = (
            row.get("name", ""),
            row.get("nucleus", ""),
            row.get("solvent", ""),
            row.get("field_mhz", ""),
            row.get("source", ""),
            row.get("url", ""),
        )
        candidate = grouped.setdefault(
            key,
            {
                "name": key[0],
                "nucleus": key[1],
                "solvent": key[2],
                "field_mhz": float(key[3]) if key[3] else None,
                "source": key[4],
                "url": key[5],
                "peaks": [],
            },
        )
        if row.get("position"):
            candidate["peaks"].append(float(row["position"]))
    return list(grouped.values())


def _positions(value: Any) -> list[float]:
    if not isinstance(value, list):
        return []
    return [float(item["position"] if isinstance(item, dict) else item) for item in value]


def _matches(observed: list[float], reference: list[float], tolerance: float) -> list[dict[str, float]]:
    choices = sorted(
        (abs(obs - ref), oi, ri, obs, ref)
        for oi, obs in enumerate(observed)
        for ri, ref in enumerate(reference)
        if abs(obs - ref) <= tolerance
    )
    used_observed: set[int] = set()
    used_reference: set[int] = set()
    matches: list[dict[str, float]] = []
    for delta, oi, ri, obs, ref in choices:
        if oi in used_observed or ri in used_reference:
            continue
        used_observed.add(oi)
        used_reference.add(ri)
        matches.append({"observed": obs, "reference": ref, "delta": delta})
    return sorted(matches, key=lambda match: match["reference"], reverse=True)


def rank_candidates(
    observed: list[dict[str, float]],
    candidates: list[dict[str, Any]],
    nucleus: str,
    solvent: str = "",
    field_mhz: float | None = None,
    tolerance: float | None = None,
    limit: int = 5,
) -> list[dict[str, Any]]:
    normalized = normalize_nucleus(nucleus)
    maximum = tolerance if tolerance is not None else (0.08 if normalized == "1H" else 0.8)
    positions = _positions(observed)
    ranked: list[dict[str, Any]] = []
    for candidate in candidates:
        candidate_nucleus = str(candidate.get("nucleus", "")).upper().replace("^", "").replace("-", "").replace(" ", "")
        if candidate_nucleus not in {"1H", "H1", "PROTON", "13C", "C13", "CARBON"}:
            continue
        if normalize_nucleus(candidate_nucleus) != normalized:
            continue
        reference = _positions(candidate.get("peaks", []))
        if not reference or not positions:
            continue
        matches = _matches(positions, reference, maximum)
        recall = len(matches) / len(reference)
        precision = len(matches) / len(positions)
        rmse = math.sqrt(sum(match["delta"] ** 2 for match in matches) / len(matches)) if matches else None
        closeness = max(0.0, 1.0 - (rmse / maximum)) if rmse is not None else 0.0
        candidate_solvent = str(candidate.get("solvent", "")).strip().lower()
        solvent_penalty = 0.08 if solvent and candidate_solvent and solvent.strip().lower() != candidate_solvent else 0.0
        candidate_field = candidate.get("field_mhz")
        field_delta = abs(float(candidate_field) - field_mhz) / field_mhz if candidate_field and field_mhz else 0.0
        field_penalty = min(0.05, field_delta * 0.1)
        score = max(0.0, min(1.0, 0.55 * recall + 0.35 * precision + 0.1 * closeness - solvent_penalty - field_penalty))
        matched_reference = {match["reference"] for match in matches}
        matched_observed = {match["observed"] for match in matches}
        ranked.append(
            {
                "name": str(candidate.get("name", "unknown")),
                "score": round(score, 4),
                "confidence": "high" if score >= 0.8 else "medium" if score >= 0.55 else "low",
                "matched_count": len(matches),
                "reference_count": len(reference),
                "observed_count": len(positions),
                "rmse_ppm": round(rmse, 5) if rmse is not None else None,
                "matches": matches,
                "missing_reference_peaks": [peak for peak in reference if peak not in matched_reference],
                "unmatched_observed_peaks": [peak for peak in positions if peak not in matched_observed],
                "nucleus": normalized,
                "solvent": candidate.get("solvent", ""),
                "field_mhz": candidate_field,
                "source": candidate.get("source", ""),
                "url": candidate.get("url", ""),
            }
        )
    return sorted(ranked, key=lambda candidate: (-candidate["score"], candidate["name"]))[: max(1, limit)]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--observed", required=True, help="JSON peak list or analysis summary")
    parser.add_argument("--library", action="append", required=True, help="Reference JSON or CSV; repeatable")
    parser.add_argument("--nucleus", required=True, help="1H or 13C")
    parser.add_argument("--solvent", default="")
    parser.add_argument("--field-mhz", type=float)
    parser.add_argument("--tolerance-ppm", type=float)
    parser.add_argument("--limit", type=int, default=5)
    args = parser.parse_args()
    value = json.loads(Path(args.observed).read_text(encoding="utf-8"))
    observed = value.get("peaks", []) if isinstance(value, dict) else value
    candidates = [candidate for item in args.library for candidate in load_library(Path(item))]
    ranked = rank_candidates(
        observed,
        candidates,
        args.nucleus,
        args.solvent,
        args.field_mhz,
        args.tolerance_ppm,
        args.limit,
    )
    print(json.dumps({"candidates": ranked}, indent=2))


if __name__ == "__main__":
    main()
