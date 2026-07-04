#!/usr/bin/env python3
"""
Ciliary Beat Frequency (CBF) Analysis from High-Speed Video

Analyzes ciliary beating patterns from high-speed video microscopy by computing
the dominant frequency of intensity oscillations in a grid of regions of interest.
Uses FFT-based spectral analysis to extract beat frequencies in the physiological
range (typically 5-30 Hz for human respiratory cilia).

Usage:
    python ciliary_beat.py --video cilia_recording.avi --fps 250 --output-dir results/
    python ciliary_beat.py --video cilia.mp4 --fps 500 --roi-size 16 --min-freq 8 --max-freq 25 --output-dir results/

Examples:
    # Basic CBF analysis at 250 fps
    python ciliary_beat.py --video nasal_cilia.avi --fps 250 --output-dir ./cbf_results

    # High-resolution analysis with smaller ROIs
    python ciliary_beat.py --video bronchial_cilia.mp4 --fps 500 --roi-size 16 \\
        --min-freq 5 --max-freq 30 --output-dir ./cbf_results

Dependencies: numpy, opencv-python, scipy, matplotlib, pandas
"""

import argparse
import sys
from pathlib import Path

import cv2
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
from scipy.signal import windows as sig_windows


def load_video_frames(video_path, fps_override=None):
    """
    Load video frames as grayscale numpy array.

    Args:
        video_path: Path to video file.
        fps_override: If provided, use this as the frame rate instead of metadata.

    Returns:
        Tuple of (3D array [frames, height, width], fps).

    Raises:
        FileNotFoundError: If video file does not exist.
        RuntimeError: If video cannot be opened or has no frames.
    """
    path = Path(video_path)
    if not path.exists():
        raise FileNotFoundError(f"Video file not found: {video_path}")

    cap = cv2.VideoCapture(str(path))
    if not cap.isOpened():
        raise RuntimeError(f"Cannot open video: {video_path}")

    # Get metadata
    n_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    meta_fps = cap.get(cv2.CAP_PROP_FPS)
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))

    fps = fps_override if fps_override else meta_fps
    if fps <= 0:
        raise RuntimeError(
            "Cannot determine frame rate. Provide --fps explicitly."
        )

    if n_frames <= 0:
        raise RuntimeError("Video reports 0 frames.")

    # Read all frames
    frames = []
    while True:
        ret, frame = cap.read()
        if not ret:
            break
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY) if len(frame.shape) == 3 else frame
        frames.append(gray.astype(np.float64))

    cap.release()

    if len(frames) == 0:
        raise RuntimeError("No frames could be read from video.")

    return np.array(frames), fps


def create_roi_grid(height, width, roi_size):
    """
    Create a grid of square ROIs covering the image.

    Args:
        height: Image height in pixels.
        width: Image width in pixels.
        roi_size: Side length of each square ROI in pixels.

    Returns:
        List of tuples (row_start, row_end, col_start, col_end, row_idx, col_idx).
    """
    rois = []
    row_idx = 0
    for r in range(0, height - roi_size + 1, roi_size):
        col_idx = 0
        for c in range(0, width - roi_size + 1, roi_size):
            rois.append((r, r + roi_size, c, c + roi_size, row_idx, col_idx))
            col_idx += 1
        row_idx += 1

    return rois


def extract_roi_timeseries(frames, roi):
    """
    Extract mean intensity time series from a single ROI.

    Args:
        frames: 3D array [n_frames, height, width].
        roi: Tuple (row_start, row_end, col_start, col_end, row_idx, col_idx).

    Returns:
        1D array of mean intensity values per frame.
    """
    r0, r1, c0, c1 = roi[:4]
    return np.mean(frames[:, r0:r1, c0:c1], axis=(1, 2))


def compute_dominant_frequency(timeseries, fps, min_freq, max_freq):
    """
    Compute dominant frequency of a time series using FFT.

    Applies a Hanning window before FFT to reduce spectral leakage.

    Args:
        timeseries: 1D array of intensity values.
        fps: Sampling rate in Hz.
        min_freq: Minimum frequency of interest in Hz.
        max_freq: Maximum frequency of interest in Hz.

    Returns:
        Dominant frequency in Hz, or NaN if no valid peak found.
    """
    n = len(timeseries)
    if n < 8:
        return np.nan

    # Remove DC offset
    signal = timeseries - np.mean(timeseries)

    # Check if signal has variance (cilia must be beating)
    if np.std(signal) < 1e-6:
        return np.nan

    # Apply Hanning window
    window = sig_windows.hann(n)
    windowed = signal * window

    # FFT
    fft_vals = np.fft.rfft(windowed)
    freqs = np.fft.rfftfreq(n, d=1.0 / fps)
    magnitude = np.abs(fft_vals)

    # Select frequency range
    mask = (freqs >= min_freq) & (freqs <= max_freq)
    if not np.any(mask):
        return np.nan

    masked_freqs = freqs[mask]
    masked_mag = magnitude[mask]

    # Find dominant peak
    peak_idx = np.argmax(masked_mag)
    dominant_freq = masked_freqs[peak_idx]

    # Confidence check: peak must be at least 2x the median magnitude in range
    median_mag = np.median(masked_mag)
    if masked_mag[peak_idx] < 2.0 * median_mag:
        return np.nan

    return dominant_freq


def analyze_cbf(frames, fps, roi_size, min_freq, max_freq):
    """
    Perform CBF analysis across all ROIs in the video.

    Args:
        frames: 3D array [n_frames, height, width].
        fps: Frame rate in Hz.
        roi_size: ROI side length in pixels.
        min_freq: Minimum frequency in Hz.
        max_freq: Maximum frequency in Hz.

    Returns:
        Tuple of (frequency_map 2D array, roi_results list of dicts).
    """
    n_frames, height, width = frames.shape
    rois = create_roi_grid(height, width, roi_size)

    n_rows = height // roi_size
    n_cols = width // roi_size
    freq_map = np.full((n_rows, n_cols), np.nan)

    roi_results = []
    total = len(rois)
    progress_step = max(total // 10, 1)

    print(f"Analyzing {total} ROIs ({n_rows}x{n_cols} grid, {roi_size}px each) ...")

    for idx, roi in enumerate(rois):
        r0, r1, c0, c1, ri, ci = roi

        timeseries = extract_roi_timeseries(frames, roi)
        freq = compute_dominant_frequency(timeseries, fps, min_freq, max_freq)

        freq_map[ri, ci] = freq
        roi_results.append({
            "row_idx": ri,
            "col_idx": ci,
            "row_start": r0,
            "col_start": c0,
            "frequency_hz": freq,
            "mean_intensity": np.mean(timeseries),
            "intensity_std": np.std(timeseries),
        })

        if (idx + 1) % progress_step == 0:
            print(f"  Progress: {100*(idx+1)//total}% ({idx+1}/{total} ROIs)")

    return freq_map, roi_results


def save_frequency_map(freq_map, output_path):
    """
    Save frequency map as a heatmap image.

    Args:
        freq_map: 2D array of frequencies in Hz (NaN for invalid).
        output_path: Path to save PNG.
    """
    output_path = Path(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    fig, ax = plt.subplots(figsize=(10, 8))

    # Mask NaN for display
    masked = np.ma.masked_where(np.isnan(freq_map), freq_map)

    im = ax.imshow(masked, cmap="jet", interpolation="nearest", aspect="auto")
    cbar = plt.colorbar(im, ax=ax, label="Frequency (Hz)")
    ax.set_title("Ciliary Beat Frequency Map")
    ax.set_xlabel("Column Index")
    ax.set_ylabel("Row Index")

    plt.tight_layout()
    plt.savefig(str(output_path), dpi=150, bbox_inches="tight")
    plt.close(fig)


def print_cbf_summary(roi_results):
    """Print summary statistics of CBF analysis."""
    freqs = np.array([r["frequency_hz"] for r in roi_results])
    valid = freqs[~np.isnan(freqs)]

    total = len(freqs)
    n_valid = len(valid)

    print("\n=== Ciliary Beat Frequency Summary ===")
    print(f"  Total ROIs:       {total}")
    print(f"  Valid ROIs:       {n_valid} ({100*n_valid/max(total,1):.1f}%)")
    print(f"  Invalid ROIs:     {total - n_valid}")

    if n_valid == 0:
        print("  WARNING: No valid CBF measurements. Check video quality and frequency range.")
        return

    q25, median, q75 = np.percentile(valid, [25, 50, 75])
    iqr = q75 - q25

    print(f"  Median CBF:       {median:.2f} Hz")
    print(f"  Mean CBF:         {np.mean(valid):.2f} Hz")
    print(f"  Std CBF:          {np.std(valid):.2f} Hz")
    print(f"  IQR:              {iqr:.2f} Hz (Q1={q25:.2f}, Q3={q75:.2f})")
    print(f"  Min CBF:          {np.min(valid):.2f} Hz")
    print(f"  Max CBF:          {np.max(valid):.2f} Hz")

    # Spatial distribution: coefficient of variation
    cv = np.std(valid) / np.mean(valid) * 100 if np.mean(valid) > 0 else 0
    print(f"  Spatial CV:       {cv:.1f}%")

    if cv < 15:
        print("  Distribution:     Spatially homogeneous (CV < 15%)")
    elif cv < 30:
        print("  Distribution:     Moderate spatial variation (15% <= CV < 30%)")
    else:
        print("  Distribution:     High spatial variation (CV >= 30%)")


def main():
    parser = argparse.ArgumentParser(
        description="Ciliary beat frequency analysis from high-speed video.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python ciliary_beat.py --video cilia.avi --fps 250 --output-dir ./results
  python ciliary_beat.py --video cilia.mp4 --fps 500 --roi-size 16 --output-dir ./results
        """,
    )
    parser.add_argument(
        "--video", required=True, help="Path to high-speed video file."
    )
    parser.add_argument(
        "--roi-size",
        type=int,
        default=32,
        help="ROI side length in pixels (default: 32).",
    )
    parser.add_argument(
        "--min-freq",
        type=float,
        default=5.0,
        help="Minimum frequency of interest in Hz (default: 5).",
    )
    parser.add_argument(
        "--max-freq",
        type=float,
        default=30.0,
        help="Maximum frequency of interest in Hz (default: 30).",
    )
    parser.add_argument(
        "--fps",
        type=float,
        default=None,
        help="Frame rate in Hz (overrides video metadata).",
    )
    parser.add_argument(
        "--output-dir",
        required=True,
        help="Directory for output files.",
    )

    args = parser.parse_args()

    # Validate arguments
    if args.roi_size < 4:
        print("ERROR: --roi-size must be at least 4 pixels.", file=sys.stderr)
        sys.exit(1)

    if args.min_freq >= args.max_freq:
        print("ERROR: --min-freq must be less than --max-freq.", file=sys.stderr)
        sys.exit(1)

    # Load video
    print(f"Loading video: {args.video}")
    frames, fps = load_video_frames(args.video, args.fps)
    n_frames, height, width = frames.shape
    duration = n_frames / fps

    print(f"  Frames:     {n_frames}")
    print(f"  Resolution: {width}x{height}")
    print(f"  FPS:        {fps:.1f} Hz")
    print(f"  Duration:   {duration:.3f} s")

    # Check Nyquist criterion
    nyquist = fps / 2.0
    if args.max_freq > nyquist:
        print(
            f"WARNING: max_freq ({args.max_freq} Hz) exceeds Nyquist frequency ({nyquist:.1f} Hz). "
            f"Clamping to {nyquist:.1f} Hz.",
            file=sys.stderr,
        )
        max_freq = nyquist * 0.95
    else:
        max_freq = args.max_freq

    # Minimum number of frames for reliable FFT
    min_frames = int(2 * fps / args.min_freq)
    if n_frames < min_frames:
        print(
            f"WARNING: Video has {n_frames} frames but at least {min_frames} recommended "
            f"for detecting {args.min_freq} Hz.",
            file=sys.stderr,
        )

    # Analyze CBF
    freq_map, roi_results = analyze_cbf(
        frames, fps, args.roi_size, args.min_freq, max_freq
    )

    # Print summary
    print_cbf_summary(roi_results)

    # Save outputs
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    # Frequency map heatmap
    map_path = output_dir / "cbf_frequency_map.png"
    save_frequency_map(freq_map, map_path)
    print(f"\nFrequency map saved: {map_path}")

    # Per-ROI CSV
    csv_path = output_dir / "cbf_roi_frequencies.csv"
    pd.DataFrame(roi_results).to_csv(str(csv_path), index=False)
    print(f"ROI frequencies saved: {csv_path}")

    # Save raw frequency map as numpy
    npy_path = output_dir / "cbf_frequency_map.npy"
    np.save(str(npy_path), freq_map)
    print(f"Raw frequency map saved: {npy_path}")


if __name__ == "__main__":
    main()
