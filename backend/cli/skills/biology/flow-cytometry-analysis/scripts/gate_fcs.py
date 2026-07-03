#!/usr/bin/env python3
"""
FCS File Loading and Sequential Rectangular Gating

Load FCS files, optionally apply a compensation matrix, and apply sequential
rectangular gates to isolate cell populations. Reports population statistics
at each gating step and saves gated events as CSV.

Dependencies: flowio, numpy, pandas

Usage:
    python gate_fcs.py --fcs sample.fcs --gates '{"FSC-A": [50000, 250000], "SSC-A": [10000, 200000]}'
    python gate_fcs.py --fcs sample.fcs --gates gates.json --compensation-matrix spill.csv --output-dir gated/
    python gate_fcs.py --fcs sample.fcs --gates '{"FSC-A": [50000, 250000]}' --output-dir results/

Examples:
    # Basic scatter gate to remove debris
    python gate_fcs.py --fcs blood.fcs --gates '{"FSC-A": [25000, 262143], "SSC-A": [5000, 250000]}'

    # Multi-step gating with compensation
    python gate_fcs.py --fcs panel.fcs \\
        --gates '{"FSC-A": [30000, 250000], "SSC-A": [10000, 200000], "FL1-A": [500, 100000]}' \\
        --compensation-matrix spillover.csv \\
        --output-dir analysis/

    # Gates from a JSON file
    python gate_fcs.py --fcs experiment.fcs --gates gate_definitions.json
"""

import argparse
import json
import os
import sys
from pathlib import Path

import numpy as np
import pandas as pd

try:
    import flowio
except ImportError:
    print("ERROR: flowio is required. Install with: pip install flowio", file=sys.stderr)
    sys.exit(1)


def load_fcs(fcs_path):
    """
    Load an FCS file and return channel names and event data as a numpy array.

    Parameters:
        fcs_path: Path to the FCS file.

    Returns:
        Tuple of (channel_names, events) where events is an ndarray of shape
        (n_events, n_channels).
    """
    fcs_path = str(fcs_path)
    fdata = flowio.FlowData(fcs_path)

    # Extract channel names — prefer $PnS (stain name) over $PnN (detector name)
    n_channels = int(fdata.channel_count)
    channel_names = []
    for i in range(1, n_channels + 1):
        stain_key = f"p{i}s"
        name_key = f"p{i}n"
        stain = fdata.text.get(stain_key, "").strip()
        name = fdata.text.get(name_key, f"Ch{i}").strip()
        channel_names.append(stain if stain else name)

    # Parse events into numpy array
    events = np.array(fdata.events, dtype=np.float64).reshape(-1, n_channels)

    return channel_names, events


def load_gates(gates_arg):
    """
    Parse gate definitions from a JSON string or a file path.

    Parameters:
        gates_arg: Either a JSON string like '{"FSC-A": [lo, hi]}' or a path
                   to a JSON file with the same structure.

    Returns:
        Dictionary mapping channel names to [low, high] bounds.
    """
    # Try as file path first
    if os.path.isfile(gates_arg):
        with open(gates_arg, "r") as f:
            gates = json.load(f)
    else:
        try:
            gates = json.loads(gates_arg)
        except json.JSONDecodeError as exc:
            print(f"ERROR: Could not parse gates as JSON: {exc}", file=sys.stderr)
            sys.exit(1)

    # Validate structure
    for channel, bounds in gates.items():
        if not isinstance(bounds, (list, tuple)) or len(bounds) != 2:
            print(
                f"ERROR: Gate for '{channel}' must be [low, high], got: {bounds}",
                file=sys.stderr,
            )
            sys.exit(1)
        lo, hi = bounds
        if lo >= hi:
            print(
                f"ERROR: Gate for '{channel}' has low >= high: [{lo}, {hi}]",
                file=sys.stderr,
            )
            sys.exit(1)

    return gates


def load_compensation_matrix(csv_path, channel_names):
    """
    Load a compensation (spillover) matrix from CSV and validate against
    the channel list.

    Parameters:
        csv_path: Path to a CSV file. Rows and columns should correspond to
                  fluorescence channels. If the CSV has headers, they are used
                  for alignment; otherwise, the matrix is applied to the first
                  N fluorescence channels.
        channel_names: List of channel names from the FCS file.

    Returns:
        Tuple of (channel_indices, inverse_matrix) where channel_indices are
        the column indices in the event array to compensate, and inverse_matrix
        is the inverse of the spillover matrix.
    """
    df = pd.read_csv(csv_path, index_col=0 if pd.read_csv(csv_path).iloc[:, 0].dtype == object else None)

    matrix = df.values.astype(np.float64)
    n = matrix.shape[0]

    if matrix.shape[0] != matrix.shape[1]:
        print(
            f"ERROR: Compensation matrix must be square, got shape {matrix.shape}",
            file=sys.stderr,
        )
        sys.exit(1)

    # Determine which channels to compensate
    if hasattr(df, "columns") and not all(isinstance(c, int) for c in df.columns):
        comp_channels = list(df.columns)
    else:
        # Assume first N fluorescence channels (exclude scatter channels)
        comp_channels = [
            ch for ch in channel_names
            if not any(tag in ch.upper() for tag in ("FSC", "SSC", "TIME"))
        ][:n]

    channel_indices = []
    for ch in comp_channels:
        if ch in channel_names:
            channel_indices.append(channel_names.index(ch))
        else:
            print(
                f"WARNING: Compensation channel '{ch}' not found in FCS channels, skipping.",
                file=sys.stderr,
            )

    if len(channel_indices) != n:
        print(
            f"WARNING: Expected {n} channels for compensation, matched {len(channel_indices)}.",
            file=sys.stderr,
        )

    # Compute inverse
    try:
        inv_matrix = np.linalg.inv(matrix)
    except np.linalg.LinAlgError:
        print("ERROR: Compensation matrix is singular, cannot invert.", file=sys.stderr)
        sys.exit(1)

    return channel_indices, inv_matrix


def apply_compensation(events, channel_indices, inv_matrix):
    """
    Apply compensation to fluorescence channels by multiplying with the
    inverse spillover matrix.

    Parameters:
        events: ndarray of shape (n_events, n_channels).
        channel_indices: List of column indices to compensate.
        inv_matrix: Inverse of the spillover matrix.

    Returns:
        Compensated events array (copy).
    """
    compensated = events.copy()
    fl_data = compensated[:, channel_indices]
    compensated[:, channel_indices] = fl_data @ inv_matrix.T
    return compensated


def apply_rectangular_gates(events, channel_names, gates):
    """
    Apply sequential rectangular gates and report statistics at each step.

    Parameters:
        events: ndarray of shape (n_events, n_channels).
        channel_names: List of channel names.
        gates: Ordered dict of channel_name -> [low, high].

    Returns:
        Tuple of (gated_events, gate_stats) where gate_stats is a list of
        dicts with per-gate population statistics.
    """
    mask = np.ones(events.shape[0], dtype=bool)
    total_events = events.shape[0]
    gate_stats = []

    print("\n--- Sequential Gating ---")
    print(f"{'Gate':<25} {'Events In':>12} {'Events Out':>12} {'% Parent':>10} {'% Total':>10}")
    print("-" * 72)

    for channel, (lo, hi) in gates.items():
        if channel not in channel_names:
            print(f"WARNING: Channel '{channel}' not found. Available: {channel_names}", file=sys.stderr)
            continue

        parent_count = mask.sum()
        ch_idx = channel_names.index(channel)
        channel_data = events[:, ch_idx]

        gate_mask = (channel_data >= lo) & (channel_data <= hi)
        mask = mask & gate_mask

        child_count = mask.sum()
        pct_parent = (child_count / parent_count * 100) if parent_count > 0 else 0.0
        pct_total = (child_count / total_events * 100) if total_events > 0 else 0.0

        gate_name = f"{channel} [{lo:.0f}, {hi:.0f}]"
        print(f"{gate_name:<25} {parent_count:>12,} {child_count:>12,} {pct_parent:>9.1f}% {pct_total:>9.1f}%")

        gate_stats.append({
            "gate": gate_name,
            "channel": channel,
            "low": lo,
            "high": hi,
            "events_in": int(parent_count),
            "events_out": int(child_count),
            "pct_parent": round(pct_parent, 2),
            "pct_total": round(pct_total, 2),
        })

    gated_events = events[mask]
    return gated_events, gate_stats


def save_results(gated_events, channel_names, gate_stats, output_dir):
    """
    Save gated events as CSV and gate statistics as a summary CSV.

    Parameters:
        gated_events: ndarray of gated event data.
        channel_names: List of channel names.
        gate_stats: List of per-gate statistic dictionaries.
        output_dir: Output directory path.
    """
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    # Save gated events
    events_path = output_dir / "gated_events.csv"
    df_events = pd.DataFrame(gated_events, columns=channel_names)
    df_events.to_csv(events_path, index=False)
    print(f"\nGated events saved to: {events_path}")

    # Save gate statistics
    stats_path = output_dir / "gate_statistics.csv"
    df_stats = pd.DataFrame(gate_stats)
    df_stats.to_csv(stats_path, index=False)
    print(f"Gate statistics saved to: {stats_path}")


def main():
    parser = argparse.ArgumentParser(
        description="Load and gate FCS files with sequential rectangular gating strategy."
    )
    parser.add_argument(
        "--fcs",
        type=str,
        required=True,
        help="Path to the FCS file.",
    )
    parser.add_argument(
        "--gates",
        type=str,
        required=True,
        help=(
            'JSON string or path to JSON file defining rectangular gates. '
            'Format: {"channel_name": [low, high], ...}. '
            'Gates are applied sequentially in insertion order.'
        ),
    )
    parser.add_argument(
        "--compensation-matrix",
        type=str,
        default=None,
        help="Optional path to a CSV spillover/compensation matrix.",
    )
    parser.add_argument(
        "--output-dir",
        type=str,
        default="gated_output",
        help="Directory for output files (default: gated_output).",
    )

    args = parser.parse_args()

    # Validate FCS file
    fcs_path = Path(args.fcs)
    if not fcs_path.is_file():
        print(f"ERROR: FCS file not found: {fcs_path}", file=sys.stderr)
        sys.exit(1)

    # Load FCS
    print(f"Loading FCS file: {fcs_path}")
    channel_names, events = load_fcs(fcs_path)
    print(f"  Channels ({len(channel_names)}): {', '.join(channel_names)}")
    print(f"  Events: {events.shape[0]:,}")

    # Parse gates
    gates = load_gates(args.gates)
    print(f"  Gates defined: {list(gates.keys())}")

    # Apply compensation if provided
    if args.compensation_matrix:
        comp_path = Path(args.compensation_matrix)
        if not comp_path.is_file():
            print(f"ERROR: Compensation matrix not found: {comp_path}", file=sys.stderr)
            sys.exit(1)
        print(f"\nApplying compensation from: {comp_path}")
        channel_indices, inv_matrix = load_compensation_matrix(comp_path, channel_names)
        events = apply_compensation(events, channel_indices, inv_matrix)
        print(f"  Compensated {len(channel_indices)} channels.")

    # Apply gates
    gated_events, gate_stats = apply_rectangular_gates(events, channel_names, gates)

    # Summary
    print(f"\nFinal gated population: {gated_events.shape[0]:,} events "
          f"({gated_events.shape[0] / events.shape[0] * 100:.1f}% of total)")

    # Save
    save_results(gated_events, channel_names, gate_stats, args.output_dir)


if __name__ == "__main__":
    main()
