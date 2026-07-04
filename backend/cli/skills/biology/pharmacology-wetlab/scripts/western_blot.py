#!/usr/bin/env python3
"""Western blot densitometry analysis.

Quantifies band intensities from a western blot image, performs background
subtraction, normalises to a loading control, and computes fold-change
relative to a reference lane.

Usage:
    python western_blot.py --image blot.tif --lanes 6 --output-dir results/
    python western_blot.py --image blot.png --lanes 4 --loading-control actin --output-dir results/

Examples:
    # Basic densitometry (no loading control)
    python western_blot.py --image gel.tif --lanes 5 --output-dir ./wb_out

    # With GAPDH loading control
    python western_blot.py --image blot.png --lanes 6 --loading-control gapdh --output-dir ./wb_out
"""

import argparse
import os
import sys
import warnings
from typing import List, Tuple, Optional

import numpy as np
import pandas as pd
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import matplotlib.patches as mpatches

try:
    import cv2
except ImportError:
    cv2 = None

try:
    from skimage import filters, morphology, measure, exposure
    from skimage.io import imread
except ImportError:
    filters = morphology = measure = exposure = None
    imread = None


# ---------------------------------------------------------------------------
# Image loading helpers
# ---------------------------------------------------------------------------

def load_grayscale(path: str) -> np.ndarray:
    """Load an image and convert to float64 grayscale [0, 1]."""
    if cv2 is not None:
        img = cv2.imread(path, cv2.IMREAD_UNCHANGED)
        if img is None:
            raise FileNotFoundError(f"Cannot read image: {path}")
        if img.ndim == 3:
            img = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        img = img.astype(np.float64)
        img = img / img.max() if img.max() > 0 else img
        return img
    if imread is not None:
        img = imread(path, as_gray=True).astype(np.float64)
        if img.max() > 1.0:
            img = img / img.max()
        return img
    raise ImportError("Neither cv2 nor skimage available for image loading.")


# ---------------------------------------------------------------------------
# Lane and band detection
# ---------------------------------------------------------------------------

def detect_lane_boundaries(img: np.ndarray, n_lanes: int,
                           margin_frac: float = 0.05
                           ) -> List[Tuple[int, int]]:
    """Detect lane x-boundaries from vertical intensity projection.

    Falls back to equal-width splitting when peak detection is unreliable.
    """
    profile = np.mean(img, axis=0)
    h, w = img.shape

    # Simple equal-width fallback (robust for most gel images)
    margin = int(w * margin_frac)
    usable = w - 2 * margin
    lane_w = usable // n_lanes
    boundaries = []
    for i in range(n_lanes):
        x0 = margin + i * lane_w
        x1 = x0 + lane_w
        boundaries.append((x0, min(x1, w)))
    return boundaries


def rolling_ball_background(signal: np.ndarray, radius: int = 50) -> np.ndarray:
    """Simple rolling-ball (erosion-dilation) background estimation."""
    from scipy.ndimage import minimum_filter1d, maximum_filter1d
    bg = minimum_filter1d(signal, size=radius)
    bg = maximum_filter1d(bg, size=radius)
    return bg


def detect_bands(lane_img: np.ndarray, min_band_height: int = 5
                 ) -> List[Tuple[int, int]]:
    """Detect horizontal bands in a single lane sub-image.

    Returns list of (y_start, y_end) for each band.
    """
    profile = np.mean(lane_img, axis=1)
    bg = rolling_ball_background(profile, radius=max(len(profile) // 4, 10))
    corrected = np.clip(profile - bg, 0, None)

    threshold = np.mean(corrected) + 0.5 * np.std(corrected)
    binary = corrected > threshold

    # Label connected regions
    bands = []
    in_band = False
    start = 0
    for i, val in enumerate(binary):
        if val and not in_band:
            start = i
            in_band = True
        elif not val and in_band:
            if i - start >= min_band_height:
                bands.append((start, i))
            in_band = False
    if in_band and len(binary) - start >= min_band_height:
        bands.append((start, len(binary)))

    if not bands:
        # Fallback: treat entire lane as one band
        bands = [(0, lane_img.shape[0])]
    return bands


def quantify_band(lane_img: np.ndarray, y0: int, y1: int) -> float:
    """Integrated density for a band ROI after local background subtraction."""
    roi = lane_img[y0:y1, :]
    profile = np.mean(roi, axis=1)
    bg = rolling_ball_background(profile, radius=max(len(profile) // 3, 5))
    corrected = np.clip(profile - bg, 0, None)
    integrated = float(np.sum(corrected) * roi.shape[1])
    return integrated


# ---------------------------------------------------------------------------
# Annotation / plotting
# ---------------------------------------------------------------------------

def annotate_image(img: np.ndarray, lanes: List[Tuple[int, int]],
                   bands_per_lane: List[List[Tuple[int, int]]],
                   output_path: str) -> None:
    """Save annotated blot image showing detected ROIs."""
    fig, ax = plt.subplots(figsize=(10, 6))
    ax.imshow(img, cmap="gray", aspect="auto")
    colors = plt.cm.Set1(np.linspace(0, 1, max(len(lanes), 3)))

    for idx, ((x0, x1), band_list) in enumerate(zip(lanes, bands_per_lane)):
        c = colors[idx % len(colors)]
        for y0, y1 in band_list:
            rect = mpatches.Rectangle((x0, y0), x1 - x0, y1 - y0,
                                       linewidth=1.5, edgecolor=c,
                                       facecolor="none")
            ax.add_patch(rect)
        ax.text((x0 + x1) / 2, img.shape[0] + 10, f"L{idx + 1}",
                ha="center", fontsize=8, color=c)

    ax.set_title("Detected Bands")
    ax.axis("off")
    fig.tight_layout()
    fig.savefig(output_path, dpi=150)
    plt.close(fig)


# ---------------------------------------------------------------------------
# Main analysis
# ---------------------------------------------------------------------------

def run_analysis(image_path: str, n_lanes: int,
                 loading_control: Optional[str], output_dir: str) -> None:
    """Full western blot densitometry pipeline."""
    img = load_grayscale(image_path)
    # Invert if image is dark-on-light (bands darker than background)
    if np.mean(img) > 0.5:
        img = 1.0 - img

    lanes = detect_lane_boundaries(img, n_lanes)
    all_bands: List[List[Tuple[int, int]]] = []
    raw_intensities: List[List[float]] = []

    for x0, x1 in lanes:
        lane_img = img[:, x0:x1]
        band_list = detect_bands(lane_img)
        intensities = [quantify_band(lane_img, y0, y1) for y0, y1 in band_list]
        all_bands.append(band_list)
        raw_intensities.append(intensities)

    # Determine number of bands per lane (use mode)
    band_counts = [len(b) for b in all_bands]
    n_bands = max(set(band_counts), key=band_counts.count)

    # Build data rows
    rows = []
    for i in range(n_lanes):
        row = {"lane": i + 1}
        for j in range(n_bands):
            if j < len(raw_intensities[i]):
                row[f"band_{j + 1}_raw"] = raw_intensities[i][j]
            else:
                row[f"band_{j + 1}_raw"] = 0.0
        rows.append(row)

    df = pd.DataFrame(rows)

    # Loading control normalisation
    lc_col = None
    target_col = "band_1_raw"
    if loading_control is not None:
        if loading_control.isdigit():
            lc_band_idx = int(loading_control)
            lc_col = f"band_{lc_band_idx}_raw"
        else:
            # Assume loading control is the last detected band
            lc_col = f"band_{n_bands}_raw"
            target_col = "band_1_raw"

    if lc_col and lc_col in df.columns:
        df["normalised"] = df[target_col] / df[lc_col].replace(0, np.nan)
    else:
        df["normalised"] = df[target_col]

    # Fold change relative to lane 1
    ref = df["normalised"].iloc[0]
    df["fold_change"] = df["normalised"] / ref if ref != 0 else np.nan

    # Save outputs
    annotated_path = os.path.join(output_dir, "annotated_blot.png")
    annotate_image(img, lanes, all_bands, annotated_path)

    csv_path = os.path.join(output_dir, "western_blot_intensities.csv")
    df.to_csv(csv_path, index=False)

    # Print results
    print("=" * 65)
    print("WESTERN BLOT DENSITOMETRY RESULTS")
    print("=" * 65)
    print(f"\nLanes detected: {n_lanes}")
    print(f"Bands per lane: {n_bands}")
    if lc_col:
        print(f"Loading control: {lc_col}")
    print()

    header = f"{'Lane':<6}"
    for j in range(n_bands):
        header += f"{'Band_' + str(j+1) + '_Raw':>14}"
    header += f"{'Normalised':>14}{'Fold_Change':>14}"
    print(header)
    print("-" * len(header))

    for _, row in df.iterrows():
        line = f"{int(row['lane']):<6}"
        for j in range(n_bands):
            col = f"band_{j + 1}_raw"
            line += f"{row[col]:>14.1f}"
        line += f"{row['normalised']:>14.4f}"
        line += f"{row['fold_change']:>14.4f}"
        print(line)

    print(f"\nAnnotated image: {annotated_path}")
    print(f"Intensities CSV: {csv_path}")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Western blot densitometry analysis."
    )
    parser.add_argument("--image", required=True, help="Path to blot image (TIFF, PNG, etc.)")
    parser.add_argument("--lanes", required=True, type=int, help="Number of lanes")
    parser.add_argument("--loading-control", default=None,
                        help="Band index (1-based) or 'actin'/'gapdh' for loading control normalisation")
    parser.add_argument("--output-dir", default=".", help="Directory for output files")
    args = parser.parse_args()

    if not os.path.isfile(args.image):
        print(f"ERROR: Image not found: {args.image}", file=sys.stderr)
        sys.exit(1)

    os.makedirs(args.output_dir, exist_ok=True)
    run_analysis(args.image, args.lanes, args.loading_control, args.output_dir)


if __name__ == "__main__":
    main()
