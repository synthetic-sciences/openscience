#!/usr/bin/env python3
"""
Hemodynamic Parameter Analysis from Blood Pressure Waveforms

Extracts beat-by-beat hemodynamic parameters from continuous arterial blood
pressure recordings. Detects systolic peaks and diastolic troughs, computes
systolic/diastolic blood pressure, pulse pressure, mean arterial pressure (MAP),
and heart rate from inter-beat intervals.

Usage:
    python hemodynamics.py --data bp_waveform.csv --sampling-rate 1000 --output-dir results/
    python hemodynamics.py --data arterial_line.csv --sampling-rate 500 --output-dir results/

Examples:
    # Analyze arterial line recording at 1 kHz
    python hemodynamics.py --data arterial_bp.csv --sampling-rate 1000 --output-dir ./hemo_results

    # Lower sampling rate with time column in data
    python hemodynamics.py --data bp_recording.csv --sampling-rate 250 --output-dir ./hemo_results

Dependencies: numpy, scipy, pandas, matplotlib
"""

import argparse
import sys
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
from scipy.signal import butter, filtfilt, find_peaks


def load_pressure_data(filepath, sampling_rate):
    """
    Load blood pressure waveform data from CSV.

    Accepts CSV with columns 'time' and 'pressure', or just 'pressure'
    (in which case time is generated from sampling_rate).

    Args:
        filepath: Path to CSV file.
        sampling_rate: Sampling rate in Hz.

    Returns:
        Tuple of (time array in seconds, pressure array in mmHg).

    Raises:
        FileNotFoundError: If file does not exist.
        ValueError: If required columns are missing.
    """
    path = Path(filepath)
    if not path.exists():
        raise FileNotFoundError(f"Data file not found: {filepath}")

    df = pd.read_csv(path)

    if "pressure" not in df.columns:
        raise ValueError(
            f"CSV must contain a 'pressure' column. Found: {list(df.columns)}"
        )

    pressure = df["pressure"].values.astype(np.float64)

    if "time" in df.columns:
        time = df["time"].values.astype(np.float64)
    else:
        time = np.arange(len(pressure)) / sampling_rate

    # Drop NaN values
    valid = ~(np.isnan(time) | np.isnan(pressure))
    time = time[valid]
    pressure = pressure[valid]

    if len(pressure) < 10:
        raise ValueError("Insufficient data points after cleaning.")

    return time, pressure


def bandpass_filter(signal, sampling_rate, low_freq=0.5, high_freq=10.0, order=4):
    """
    Apply Butterworth bandpass filter to the pressure waveform.

    Args:
        signal: 1D pressure array.
        sampling_rate: Sampling rate in Hz.
        low_freq: Low cutoff frequency in Hz.
        high_freq: High cutoff frequency in Hz.
        order: Filter order.

    Returns:
        Filtered signal.
    """
    nyquist = sampling_rate / 2.0

    # Clamp frequencies to valid range
    low = max(low_freq, 0.01)
    high = min(high_freq, nyquist * 0.99)

    if low >= high:
        print("WARNING: Filter cutoff frequencies invalid. Returning unfiltered signal.")
        return signal

    b, a = butter(order, [low / nyquist, high / nyquist], btype="band")
    filtered = filtfilt(b, a, signal, padlen=min(3 * max(len(b), len(a)), len(signal) - 1))

    return filtered


def detect_systolic_peaks(pressure, sampling_rate):
    """
    Detect systolic peaks in the blood pressure waveform.

    Uses prominence-based peak detection with physiologically constrained
    inter-peak distance (minimum 0.3s, corresponding to ~200 bpm).

    Args:
        pressure: 1D pressure array.
        sampling_rate: Sampling rate in Hz.

    Returns:
        Array of peak indices.
    """
    # Minimum distance: 0.3s (200 bpm max)
    min_distance = int(0.3 * sampling_rate)

    # Estimate prominence from signal range
    signal_range = np.percentile(pressure, 95) - np.percentile(pressure, 5)
    min_prominence = signal_range * 0.15

    peaks, properties = find_peaks(
        pressure,
        distance=min_distance,
        prominence=min_prominence,
        height=np.percentile(pressure, 25),
    )

    return peaks


def detect_diastolic_troughs(pressure, systolic_peaks, sampling_rate):
    """
    Detect diastolic troughs between consecutive systolic peaks.

    For each pair of consecutive systolic peaks, finds the minimum pressure
    value in the interval between them.

    Args:
        pressure: 1D pressure array.
        systolic_peaks: Array of systolic peak indices.
        sampling_rate: Sampling rate in Hz.

    Returns:
        Array of trough indices (length = len(systolic_peaks) - 1).
    """
    troughs = []

    for i in range(len(systolic_peaks) - 1):
        start = systolic_peaks[i]
        end = systolic_peaks[i + 1]

        # Search in the latter portion of the interval for diastolic minimum
        search_start = start + int(0.2 * (end - start))
        segment = pressure[search_start:end]

        if len(segment) > 0:
            trough_idx = search_start + np.argmin(segment)
            troughs.append(trough_idx)

    return np.array(troughs, dtype=int)


def compute_beat_parameters(time, pressure, systolic_peaks, diastolic_troughs):
    """
    Compute hemodynamic parameters for each cardiac beat.

    Args:
        time: Time array in seconds.
        pressure: Pressure array in mmHg.
        systolic_peaks: Indices of systolic peaks.
        diastolic_troughs: Indices of diastolic troughs.

    Returns:
        List of dicts with per-beat parameters.
    """
    beats = []
    n_beats = min(len(systolic_peaks) - 1, len(diastolic_troughs))

    for i in range(n_beats):
        sbp = pressure[systolic_peaks[i]]
        dbp = pressure[diastolic_troughs[i]]
        pp = sbp - dbp
        map_val = dbp + pp / 3.0

        # Heart rate from R-R interval
        if i < len(systolic_peaks) - 1:
            rr_interval = time[systolic_peaks[i + 1]] - time[systolic_peaks[i]]
            hr = 60.0 / rr_interval if rr_interval > 0 else np.nan
        else:
            hr = np.nan

        beats.append({
            "beat_number": i + 1,
            "time_s": time[systolic_peaks[i]],
            "sbp_mmhg": sbp,
            "dbp_mmhg": dbp,
            "pulse_pressure_mmhg": pp,
            "map_mmhg": map_val,
            "heart_rate_bpm": hr,
            "rr_interval_s": rr_interval if i < len(systolic_peaks) - 1 else np.nan,
        })

    return beats


def plot_waveform(time, pressure, systolic_peaks, diastolic_troughs, output_path, max_seconds=10.0):
    """
    Plot annotated blood pressure waveform.

    Args:
        time: Time array.
        pressure: Pressure array.
        systolic_peaks: Systolic peak indices.
        diastolic_troughs: Diastolic trough indices.
        output_path: Path to save PNG.
        max_seconds: Maximum time window to display.
    """
    output_path = Path(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    # Limit display window
    mask = time <= time[0] + max_seconds
    t_disp = time[mask]
    p_disp = pressure[mask]

    fig, ax = plt.subplots(figsize=(14, 5))
    ax.plot(t_disp, p_disp, color="steelblue", linewidth=0.8, label="BP waveform")

    # Plot systolic peaks in window
    sp_mask = systolic_peaks[systolic_peaks < len(t_disp)]
    ax.scatter(
        time[sp_mask], pressure[sp_mask],
        color="red", s=30, zorder=5, label="Systolic peaks",
    )

    # Plot diastolic troughs in window
    dt_mask = diastolic_troughs[diastolic_troughs < len(t_disp)]
    ax.scatter(
        time[dt_mask], pressure[dt_mask],
        color="green", s=30, zorder=5, marker="v", label="Diastolic troughs",
    )

    ax.set_xlabel("Time (s)")
    ax.set_ylabel("Pressure (mmHg)")
    ax.set_title(f"Blood Pressure Waveform (first {max_seconds:.0f}s)")
    ax.legend(loc="upper right", fontsize=9)
    ax.grid(True, alpha=0.3)

    plt.tight_layout()
    plt.savefig(str(output_path), dpi=150, bbox_inches="tight")
    plt.close(fig)


def print_hemodynamic_summary(beats):
    """Print summary statistics of hemodynamic parameters."""
    if not beats:
        print("WARNING: No valid beats detected.")
        return

    df = pd.DataFrame(beats)

    print("\n=== Hemodynamic Parameter Summary ===")
    print(f"  Total beats analyzed:  {len(df)}")
    print(f"  Recording duration:    {df['time_s'].iloc[-1] - df['time_s'].iloc[0]:.1f} s")

    for param, unit in [
        ("sbp_mmhg", "mmHg"),
        ("dbp_mmhg", "mmHg"),
        ("pulse_pressure_mmhg", "mmHg"),
        ("map_mmhg", "mmHg"),
        ("heart_rate_bpm", "bpm"),
    ]:
        valid = df[param].dropna()
        if len(valid) > 0:
            label = param.replace("_mmhg", "").replace("_bpm", "").replace("_", " ").upper()
            print(f"  {label:24s} {valid.mean():7.1f} +/- {valid.std():5.1f} {unit}")

    # Heart rate variability
    rr = df["rr_interval_s"].dropna()
    if len(rr) > 1:
        sdnn = rr.std() * 1000  # in ms
        rmssd = np.sqrt(np.mean(np.diff(rr) ** 2)) * 1000
        print(f"\n  HRV Metrics:")
        print(f"    SDNN:   {sdnn:.1f} ms")
        print(f"    RMSSD:  {rmssd:.1f} ms")


def main():
    parser = argparse.ArgumentParser(
        description="Hemodynamic parameter analysis from blood pressure waveforms.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python hemodynamics.py --data bp.csv --sampling-rate 1000 --output-dir ./results
  python hemodynamics.py --data arterial.csv --sampling-rate 500 --output-dir ./results
        """,
    )
    parser.add_argument(
        "--data",
        required=True,
        help="Path to CSV with 'pressure' column (and optional 'time' column).",
    )
    parser.add_argument(
        "--sampling-rate",
        type=float,
        required=True,
        help="Sampling rate in Hz.",
    )
    parser.add_argument(
        "--output-dir",
        required=True,
        help="Directory for output files.",
    )

    args = parser.parse_args()

    if args.sampling_rate <= 0:
        print("ERROR: --sampling-rate must be positive.", file=sys.stderr)
        sys.exit(1)

    # Load data
    print(f"Loading data: {args.data}")
    time, pressure = load_pressure_data(args.data, args.sampling_rate)
    duration = time[-1] - time[0]
    print(f"  Samples:          {len(pressure)}")
    print(f"  Duration:         {duration:.2f} s")
    print(f"  Sampling rate:    {args.sampling_rate:.0f} Hz")
    print(f"  Pressure range:   [{np.min(pressure):.1f}, {np.max(pressure):.1f}] mmHg")

    # Bandpass filter
    print("\nApplying bandpass filter (0.5-10 Hz, 4th-order Butterworth) ...")
    filtered = bandpass_filter(pressure, args.sampling_rate)

    # Detect systolic peaks on filtered signal, but read values from original
    print("Detecting systolic peaks ...")
    systolic_peaks = detect_systolic_peaks(pressure, args.sampling_rate)
    print(f"  Systolic peaks found: {len(systolic_peaks)}")

    if len(systolic_peaks) < 2:
        print("ERROR: Fewer than 2 systolic peaks detected. Cannot compute parameters.", file=sys.stderr)
        sys.exit(1)

    # Detect diastolic troughs
    print("Detecting diastolic troughs ...")
    diastolic_troughs = detect_diastolic_troughs(pressure, systolic_peaks, args.sampling_rate)
    print(f"  Diastolic troughs found: {len(diastolic_troughs)}")

    if len(diastolic_troughs) == 0:
        print("ERROR: No diastolic troughs detected.", file=sys.stderr)
        sys.exit(1)

    # Compute per-beat parameters
    print("Computing beat-by-beat parameters ...")
    beats = compute_beat_parameters(time, pressure, systolic_peaks, diastolic_troughs)

    # Print summary
    print_hemodynamic_summary(beats)

    # Save outputs
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    # Beat parameters CSV
    beats_path = output_dir / "beat_parameters.csv"
    pd.DataFrame(beats).to_csv(str(beats_path), index=False)
    print(f"\nBeat parameters saved: {beats_path}")

    # Summary statistics CSV
    summary_path = output_dir / "hemodynamic_summary.csv"
    df = pd.DataFrame(beats)
    summary = {}
    for col in ["sbp_mmhg", "dbp_mmhg", "pulse_pressure_mmhg", "map_mmhg", "heart_rate_bpm"]:
        valid = df[col].dropna()
        if len(valid) > 0:
            summary[f"{col}_mean"] = valid.mean()
            summary[f"{col}_std"] = valid.std()
            summary[f"{col}_min"] = valid.min()
            summary[f"{col}_max"] = valid.max()
    summary["n_beats"] = len(beats)
    summary["duration_s"] = duration
    pd.DataFrame([summary]).to_csv(str(summary_path), index=False)
    print(f"Summary statistics saved: {summary_path}")

    # Waveform plot
    plot_path = output_dir / "bp_waveform_annotated.png"
    plot_waveform(time, pressure, systolic_peaks, diastolic_troughs, plot_path)
    print(f"Annotated waveform plot saved: {plot_path}")


if __name__ == "__main__":
    main()
