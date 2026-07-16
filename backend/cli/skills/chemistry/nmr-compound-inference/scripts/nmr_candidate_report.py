#!/usr/bin/env python3
"""Generate a first-pass 1D NMR figure, peak list, and search-ready report."""

from __future__ import annotations

import argparse
import csv
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import matplotlib.pyplot as plt
import nmrglue as ng
import numpy as np


@dataclass
class SpectrumData:
    input_kind: str
    x: np.ndarray
    y: np.ndarray
    x_label: str
    metadata: dict[str, Any]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True, help="Spectrum path")
    parser.add_argument("--output-dir", required=True, help="Output directory")
    parser.add_argument("--nucleus", default="1H", help="Nucleus label")
    parser.add_argument("--solvent", default="", help="Solvent label if known")
    parser.add_argument("--field-mhz", type=float, default=None, help="Field strength if known")
    parser.add_argument("--top-peaks", type=int, default=12, help="Number of peaks to keep")
    parser.add_argument(
        "--peak-threshold",
        type=float,
        default=0.08,
        help="Relative threshold vs maximum normalized intensity",
    )
    return parser.parse_args()


def ensure_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)


def _ppm_scale_from_udic(udic: dict[str, Any]) -> np.ndarray | None:
    try:
        uc = ng.fileiobase.uc_from_udic(udic, dim=0)
        return np.asarray(uc.ppm_scale(), dtype=float)
    except Exception:
        return None


def load_two_column_text(path: Path) -> SpectrumData:
    for delimiter in (",", "\t", None):
        try:
            data = np.genfromtxt(path, delimiter=delimiter, comments="#", dtype=float, invalid_raise=False)
        except Exception:
            continue
        if data.ndim == 2 and data.shape[1] >= 2:
            x = np.asarray(data[:, 0], dtype=float)
            y = np.asarray(data[:, 1], dtype=float)
            mask = np.isfinite(x) & np.isfinite(y)
            x = x[mask]
            y = y[mask]
            if len(x) >= 8:
                return SpectrumData(
                    input_kind="two-column-text",
                    x=x,
                    y=y,
                    x_label="ppm",
                    metadata={"source": str(path)},
                )
    raise ValueError(f"Could not parse two-column spectrum from {path}")


def load_bruker_processed(path: Path) -> SpectrumData:
    dic, data = ng.bruker.read_pdata(str(path))
    arr = np.asarray(data).squeeze()
    if arr.ndim != 1:
        raise ValueError("Only 1D Bruker processed data is supported.")
    ppm = None
    try:
        ppm = _ppm_scale_from_udic(ng.bruker.guess_udic(dic, arr))
    except Exception:
        ppm = None
    if ppm is None or len(ppm) != len(arr):
        ppm = np.arange(len(arr), dtype=float)
        x_label = "point"
    else:
        x_label = "ppm"
    return SpectrumData(
        input_kind="bruker-processed",
        x=ppm,
        y=np.asarray(arr, dtype=float),
        x_label=x_label,
        metadata={"source": str(path)},
    )


def load_bruker_raw(path: Path) -> SpectrumData:
    dic, data = ng.bruker.read(str(path))
    fid = np.asarray(data).squeeze()
    if fid.ndim != 1:
        raise ValueError("Only 1D Bruker raw FID data is supported.")
    try:
        fid = ng.bruker.remove_digital_filter(dic, fid)
    except Exception:
        pass
    spec = ng.proc_base.fft(fid)
    spec = ng.proc_base.rev(spec)
    y = np.abs(spec).astype(float)
    ppm = None
    try:
        ppm = _ppm_scale_from_udic(ng.bruker.guess_udic(dic, fid))
    except Exception:
        ppm = None
    if ppm is None or len(ppm) != len(y):
        ppm = np.arange(len(y), dtype=float)
        x_label = "point"
    else:
        x_label = "ppm"
    return SpectrumData(
        input_kind="bruker-raw-fid",
        x=ppm,
        y=y,
        x_label=x_label,
        metadata={"source": str(path), "processing_note": "magnitude spectrum from raw FID"},
    )


def load_pipe_1d(path: Path) -> SpectrumData:
    dic, data = ng.pipe.read(str(path))
    arr = np.asarray(data).squeeze()
    if arr.ndim != 1:
        raise ValueError("Only 1D NMRPipe data is supported.")
    y = arr.real.astype(float) if np.iscomplexobj(arr) else arr.astype(float)
    ppm = None
    try:
        ppm = _ppm_scale_from_udic(ng.pipe.guess_udic(dic, arr))
    except Exception:
        ppm = None
    if ppm is None or len(ppm) != len(y):
        ppm = np.arange(len(y), dtype=float)
        x_label = "point"
    else:
        x_label = "ppm"
    return SpectrumData(
        input_kind="nmrpipe-1d",
        x=ppm,
        y=y,
        x_label=x_label,
        metadata={"source": str(path)},
    )


def detect_and_load(path: Path) -> SpectrumData:
    if path.is_file() and path.suffix.lower() in {".csv", ".tsv", ".txt", ".dat"}:
        return load_two_column_text(path)
    if path.is_file() and path.suffix.lower() in {".ft", ".fid", ".pipe", ".ft1"}:
        return load_pipe_1d(path)
    if path.is_dir():
        if (path / "1r").exists() or path.name.startswith("pdata"):
            return load_bruker_processed(path)
        if (path / "fid").exists():
            return load_bruker_raw(path)
        pdata_dir = path / "pdata" / "1"
        if pdata_dir.exists():
            return load_bruker_processed(pdata_dir)
    raise ValueError(
        "Unsupported input. Use Bruker processed data, Bruker raw fid, NMRPipe 1D data, "
        "or a two-column ppm,intensity text file."
    )


def normalize_signal(y: np.ndarray) -> np.ndarray:
    y = np.asarray(y, dtype=float)
    y = np.nan_to_num(y, nan=0.0, posinf=0.0, neginf=0.0)
    y = y - np.percentile(y, 5)
    scale = np.max(np.abs(y))
    if scale == 0:
        return y
    return y / scale


def smooth_signal(y: np.ndarray, window: int = 7) -> np.ndarray:
    if window <= 1 or len(y) < window:
        return y
    kernel = np.ones(window, dtype=float) / float(window)
    return np.convolve(y, kernel, mode="same")


def find_peaks(x: np.ndarray, y: np.ndarray, rel_threshold: float, top_n: int) -> list[dict[str, float]]:
    smooth_y = smooth_signal(y, window=7)
    floor = float(np.max(smooth_y) * rel_threshold)
    candidates: list[tuple[int, float]] = []
    for idx in range(1, len(smooth_y) - 1):
        if smooth_y[idx] >= floor and smooth_y[idx] >= smooth_y[idx - 1] and smooth_y[idx] >= smooth_y[idx + 1]:
            candidates.append((idx, float(smooth_y[idx])))
    candidates.sort(key=lambda item: item[1], reverse=True)

    peaks: list[dict[str, float]] = []
    seen: list[int] = []
    min_spacing = max(4, len(x) // 400)
    for idx, peak_height in candidates:
        if any(abs(idx - prev) < min_spacing for prev in seen):
            continue
        seen.append(idx)
        peaks.append(
            {
                "position": float(x[idx]),
                "intensity": float(y[idx]),
                "normalized_intensity": peak_height,
            }
        )
        if len(peaks) >= top_n:
            break
    peaks.sort(key=lambda item: item["position"], reverse=True)
    return peaks


def region_flags(peaks: list[dict[str, float]]) -> dict[str, bool]:
    positions = [peak["position"] for peak in peaks]
    return {
        "has_aldehyde_region": any(9.0 <= pos <= 10.5 for pos in positions),
        "has_aromatic_region": any(6.0 <= pos <= 8.5 for pos in positions),
        "has_olefinic_region": any(4.5 <= pos <= 6.5 for pos in positions),
        "has_oxygenated_aliphatic_region": any(3.0 <= pos <= 4.5 for pos in positions),
        "has_simple_aliphatic_region": any(0.5 <= pos <= 3.0 for pos in positions),
    }


def build_search_query(args: argparse.Namespace, peaks: list[dict[str, float]]) -> str:
    peak_text = ", ".join(f"{peak['position']:.3f}" for peak in peaks[:8])
    parts = [args.nucleus, "NMR", "peaks", peak_text]
    if args.solvent:
        parts.extend(["solvent", args.solvent])
    if args.field_mhz:
        parts.extend(["field", f"{args.field_mhz:g}", "MHz"])
    return " | ".join(parts)


def save_peak_table(path: Path, peaks: list[dict[str, float]]) -> None:
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=["position", "intensity", "normalized_intensity"])
        writer.writeheader()
        writer.writerows(peaks)


def save_plot(path: Path, spectrum: SpectrumData, y_norm: np.ndarray, title: str) -> None:
    fig, ax = plt.subplots(figsize=(12, 4.8))
    ax.plot(spectrum.x, y_norm, color="#1f4e79", linewidth=1.0)
    ax.set_title(title)
    ax.set_xlabel(spectrum.x_label)
    ax.set_ylabel("normalized intensity")
    if spectrum.x_label == "ppm":
        ax.invert_xaxis()
    ax.grid(alpha=0.18, linewidth=0.4)
    fig.tight_layout()
    fig.savefig(path, dpi=220)
    plt.close(fig)


def save_report(
    path: Path,
    args: argparse.Namespace,
    spectrum: SpectrumData,
    peaks: list[dict[str, float]],
    query: str,
    flags: dict[str, bool],
    outputs: dict[str, str],
) -> None:
    lines = [
        "# NMR Candidate Analysis Report",
        "",
        "## Summary",
        f"- Input kind: `{spectrum.input_kind}`",
        f"- Nucleus: `{args.nucleus}`",
        f"- Solvent: `{args.solvent or 'unknown'}`",
        f"- Field strength: `{args.field_mhz if args.field_mhz else 'unknown'}`",
        f"- Plot: `{outputs['spectrum_png']}`",
        f"- Peak table: `{outputs['peak_csv']}`",
        "",
        "## Major peaks",
    ]
    for peak in peaks:
        lines.append(f"- {peak['position']:.4f} {spectrum.x_label}, normalized peak intensity {peak['normalized_intensity']:.3f}")
    lines.extend(
        [
            "",
            "## Pattern hints",
            f"- Aromatic region present: `{flags['has_aromatic_region']}`",
            f"- Olefinic region present: `{flags['has_olefinic_region']}`",
            f"- Oxygenated aliphatic region present: `{flags['has_oxygenated_aliphatic_region']}`",
            f"- Simple aliphatic region present: `{flags['has_simple_aliphatic_region']}`",
            f"- Aldehyde region present: `{flags['has_aldehyde_region']}`",
            "",
            "## Search next",
            f"- Recommended query: `{query}`",
            "- BMRB Metabolomics: https://bmrb.io/metabolomics/",
            "- HMDB NMR spectra: https://hmdb.ca/spectra/nmr_one_d",
            "- SDBS: https://sdbs.db.aist.go.jp/SearchResult.aspx",
            "- nmrshiftdb2: https://nmrshiftdb.nmr.uni-koeln.de/nmrshiftdbhtml/t1.html",
            "",
            "## Guardrails",
            "- This is a first-pass evidence package, not a final identity claim.",
            "- Downrank hits that mismatch nucleus, solvent, field strength, or obvious peak pattern.",
            "- If this spectrum comes from raw FID magnitude processing, confidence should be lower than for a properly phased processed spectrum.",
        ]
    )
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def main() -> None:
    args = parse_args()
    input_path = Path(args.input).expanduser().resolve()
    output_dir = Path(args.output_dir).expanduser().resolve()
    ensure_dir(output_dir)

    spectrum = detect_and_load(input_path)
    y_norm = normalize_signal(spectrum.y)
    peaks = find_peaks(spectrum.x, y_norm, rel_threshold=args.peak_threshold, top_n=args.top_peaks)
    flags = region_flags(peaks)
    query = build_search_query(args, peaks)

    spectrum_png = output_dir / "spectrum.png"
    peak_csv = output_dir / "peak_table.csv"
    summary_json = output_dir / "analysis_summary.json"
    report_md = output_dir / "analysis_report.md"

    title = f"{args.nucleus} NMR" + (f" in {args.solvent}" if args.solvent else "")
    save_plot(spectrum_png, spectrum, y_norm, title)
    save_peak_table(peak_csv, peaks)

    outputs = {
        "spectrum_png": str(spectrum_png),
        "peak_csv": str(peak_csv),
        "summary_json": str(summary_json),
        "report_md": str(report_md),
    }
    summary = {
        "input": str(input_path),
        "input_kind": spectrum.input_kind,
        "nucleus": args.nucleus,
        "solvent": args.solvent,
        "field_mhz": args.field_mhz,
        "x_label": spectrum.x_label,
        "peak_count": len(peaks),
        "peaks": peaks,
        "pattern_flags": flags,
        "recommended_search_query": query,
        "metadata": spectrum.metadata,
        "outputs": outputs,
    }
    summary_json.write_text(json.dumps(summary, indent=2), encoding="utf-8")
    save_report(report_md, args, spectrum, peaks, query, flags, outputs)
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
