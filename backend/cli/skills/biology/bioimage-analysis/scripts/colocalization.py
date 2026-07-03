#!/usr/bin/env python3
"""Multi-channel fluorescence colocalization analysis.

Quantifies the spatial overlap between two fluorescence channels using
standard colocalization metrics: Pearson correlation coefficient, Manders
coefficients (M1, M2), and Manders Overlap Coefficient (MOC). Generates
scatter plots and composite overlay images for visual assessment.

Usage:
    python colocalization.py --channel1 green.tif --channel2 red.tif --output-dir results/
    python colocalization.py --channel1 ch1.png --channel2 ch2.png --threshold-method li
    python colocalization.py --channel1 gfp.tif --channel2 rfp.tif --threshold-method yen --output-dir coloc/

Examples:
    # Default Otsu thresholding
    python colocalization.py --channel1 alexa488.tif --channel2 alexa594.tif

    # Li's minimum cross-entropy threshold for dim signals
    python colocalization.py --channel1 gfp.tif --channel2 mcherry.tif --threshold-method li

    # Yen's threshold for high dynamic range
    python colocalization.py --channel1 ch1.tif --channel2 ch2.tif --threshold-method yen --output-dir output/
"""

import argparse
import os
import sys
import warnings
from pathlib import Path

import numpy as np
import pandas as pd

warnings.filterwarnings("ignore", category=DeprecationWarning)


def load_channel(image_path):
    """Load a single fluorescence channel image as a 2D grayscale array.

    Args:
        image_path: Path to the channel image file.

    Returns:
        numpy.ndarray: 2D float64 array of pixel intensities.

    Raises:
        FileNotFoundError: If the file does not exist.
        ValueError: If the image cannot be interpreted as a single channel.
    """
    if not os.path.isfile(image_path):
        raise FileNotFoundError(f"Image not found: {image_path}")

    ext = Path(image_path).suffix.lower()
    if ext in (".tif", ".tiff"):
        try:
            import tifffile
            img = tifffile.imread(image_path)
        except ImportError:
            from skimage.io import imread
            img = imread(image_path)
    else:
        from skimage.io import imread
        img = imread(image_path)

    if img is None or img.size == 0:
        raise ValueError(f"Failed to load or empty image: {image_path}")

    # Convert to 2D grayscale if needed
    if img.ndim == 3:
        if img.shape[2] == 3 or img.shape[2] == 4:
            from skimage.color import rgb2gray
            img = rgb2gray(img)
        else:
            img = img[:, :, 0]

    img = img.astype(np.float64)
    print(f"Loaded channel: {image_path}  (shape={img.shape}, range=[{img.min():.2f}, {img.max():.2f}])")
    return img


def threshold_channel(image, method):
    """Apply a thresholding method to create a binary mask of signal pixels.

    Args:
        image: 2D float array of channel intensities.
        method: Thresholding method name ('otsu', 'li', or 'yen').

    Returns:
        tuple: (threshold value, boolean mask where True = signal)

    Raises:
        ValueError: If the method name is unrecognized.
    """
    from skimage import filters

    method = method.lower()
    if method == "otsu":
        thresh = filters.threshold_otsu(image)
    elif method == "li":
        thresh = filters.threshold_li(image)
    elif method == "yen":
        thresh = filters.threshold_yen(image)
    else:
        raise ValueError(f"Unknown threshold method: {method}. Use 'otsu', 'li', or 'yen'.")

    mask = image > thresh
    n_signal = np.sum(mask)
    pct = 100.0 * n_signal / mask.size
    print(f"  Threshold ({method}): {thresh:.4f} -> {n_signal} signal pixels ({pct:.1f}%)")
    return thresh, mask


def compute_pearson(ch1, ch2, mask1, mask2):
    """Compute Pearson correlation coefficient on the union of masked regions.

    The Pearson coefficient measures the linear relationship between two
    channels across pixels where at least one channel shows signal.

    Args:
        ch1: Channel 1 intensity array.
        ch2: Channel 2 intensity array.
        mask1: Boolean mask for channel 1 signal.
        mask2: Boolean mask for channel 2 signal.

    Returns:
        tuple: (Pearson r value, p-value)
    """
    from scipy.stats import pearsonr

    # Use union of both masks (any signal)
    union_mask = mask1 | mask2
    if np.sum(union_mask) < 3:
        print("  WARNING: Too few signal pixels for Pearson correlation.")
        return 0.0, 1.0

    r, p = pearsonr(ch1[union_mask], ch2[union_mask])
    return r, p


def compute_manders(ch1, ch2, mask1, mask2):
    """Compute Manders colocalization coefficients M1, M2, and MOC.

    M1: fraction of channel 1 signal that overlaps with channel 2.
    M2: fraction of channel 2 signal that overlaps with channel 1.
    MOC: Manders Overlap Coefficient using intensities from both channels.

    Args:
        ch1: Channel 1 intensity array.
        ch2: Channel 2 intensity array.
        mask1: Boolean mask for channel 1 signal.
        mask2: Boolean mask for channel 2 signal.

    Returns:
        dict: Dictionary with keys 'M1', 'M2', 'MOC'.
    """
    # M1: fraction of ch1 signal colocalizing with ch2
    overlap = mask1 & mask2
    ch1_signal_sum = np.sum(ch1[mask1])
    ch2_signal_sum = np.sum(ch2[mask2])

    if ch1_signal_sum > 0:
        m1 = np.sum(ch1[overlap]) / ch1_signal_sum
    else:
        m1 = 0.0

    if ch2_signal_sum > 0:
        m2 = np.sum(ch2[overlap]) / ch2_signal_sum
    else:
        m2 = 0.0

    # MOC: Manders Overlap Coefficient
    numerator = np.sum(ch1 * ch2)
    denominator = np.sqrt(np.sum(ch1 ** 2) * np.sum(ch2 ** 2))
    moc = numerator / denominator if denominator > 0 else 0.0

    return {"M1": m1, "M2": m2, "MOC": moc}


def generate_scatter_plot(ch1, ch2, mask1, mask2, output_path):
    """Generate a scatter plot of channel intensities for colocalization.

    Plots channel 1 vs channel 2 intensity for each pixel in the union mask,
    with a density colormap.

    Args:
        ch1: Channel 1 intensity array.
        ch2: Channel 2 intensity array.
        mask1: Boolean mask for channel 1.
        mask2: Boolean mask for channel 2.
        output_path: File path for the output PNG.
    """
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    union_mask = mask1 | mask2
    x = ch1[union_mask]
    y = ch2[union_mask]

    fig, ax = plt.subplots(1, 1, figsize=(6, 6))

    # Subsample if too many points for scatter
    max_points = 50000
    if len(x) > max_points:
        idx = np.random.default_rng(42).choice(len(x), max_points, replace=False)
        x_plot, y_plot = x[idx], y[idx]
    else:
        x_plot, y_plot = x, y

    ax.scatter(x_plot, y_plot, s=1, alpha=0.3, c="steelblue", rasterized=True)
    ax.set_xlabel("Channel 1 Intensity")
    ax.set_ylabel("Channel 2 Intensity")
    ax.set_title("Colocalization Scatter Plot")
    ax.set_aspect("equal", adjustable="datalim")

    fig.tight_layout()
    fig.savefig(output_path, dpi=150)
    plt.close(fig)
    print(f"  Scatter plot saved: {output_path}")


def generate_overlay(ch1, ch2, output_path):
    """Generate a false-color overlay image (green + magenta).

    Channel 1 is mapped to green, channel 2 to magenta. Overlapping signal
    appears white.

    Args:
        ch1: Channel 1 intensity array (2D).
        ch2: Channel 2 intensity array (2D).
        output_path: File path for the output PNG.
    """
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    # Normalize each channel to 0-1
    ch1_norm = ch1.copy()
    ch2_norm = ch2.copy()
    if ch1_norm.max() > 0:
        ch1_norm = ch1_norm / ch1_norm.max()
    if ch2_norm.max() > 0:
        ch2_norm = ch2_norm / ch2_norm.max()

    # Green channel = ch1, Magenta = ch2 (R + B)
    rgb = np.zeros((*ch1.shape, 3), dtype=np.float64)
    rgb[:, :, 0] = ch2_norm         # Red from ch2
    rgb[:, :, 1] = ch1_norm         # Green from ch1
    rgb[:, :, 2] = ch2_norm         # Blue from ch2
    rgb = np.clip(rgb, 0, 1)

    fig, ax = plt.subplots(1, 1, figsize=(8, 8))
    ax.imshow(rgb)
    ax.set_title("Overlay (Green=Ch1, Magenta=Ch2)")
    ax.axis("off")
    fig.tight_layout()
    fig.savefig(output_path, dpi=150)
    plt.close(fig)
    print(f"  Overlay image saved: {output_path}")


def print_metrics(pearson_r, pearson_p, manders):
    """Print all colocalization metrics to stdout.

    Args:
        pearson_r: Pearson correlation coefficient.
        pearson_p: Pearson p-value.
        manders: Dict with M1, M2, MOC values.
    """
    print(f"\n{'='*60}")
    print(f"COLOCALIZATION METRICS")
    print(f"{'='*60}")
    print(f"Pearson Correlation Coefficient (r): {pearson_r:.4f}")
    print(f"Pearson p-value:                     {pearson_p:.2e}")
    print(f"")
    print(f"Manders M1 (ch1 overlap with ch2):   {manders['M1']:.4f}")
    print(f"Manders M2 (ch2 overlap with ch1):   {manders['M2']:.4f}")
    print(f"Manders Overlap Coefficient (MOC):    {manders['MOC']:.4f}")
    print(f"")

    # Interpretation
    r = abs(pearson_r)
    if r > 0.8:
        interp = "strong"
    elif r > 0.5:
        interp = "moderate"
    elif r > 0.3:
        interp = "weak"
    else:
        interp = "negligible"
    print(f"Interpretation: {interp} correlation (|r| = {r:.4f})")
    print(f"{'='*60}")


def main():
    parser = argparse.ArgumentParser(
        description="Multi-channel fluorescence colocalization analysis.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "--channel1", required=True, help="Path to channel 1 image."
    )
    parser.add_argument(
        "--channel2", required=True, help="Path to channel 2 image."
    )
    parser.add_argument(
        "--threshold-method",
        choices=["otsu", "li", "yen"],
        default="otsu",
        help="Thresholding method for signal detection (default: otsu).",
    )
    parser.add_argument(
        "--output-dir",
        default="./colocalization_output",
        help="Directory for output files (default: ./colocalization_output).",
    )
    args = parser.parse_args()

    # Load channels
    ch1 = load_channel(args.channel1)
    ch2 = load_channel(args.channel2)

    # Validate dimensions match
    if ch1.shape != ch2.shape:
        print(
            f"ERROR: Channel dimensions do not match: {ch1.shape} vs {ch2.shape}",
            file=sys.stderr,
        )
        sys.exit(1)

    # Threshold both channels
    print(f"\nThresholding channel 1 ({args.threshold_method}):")
    _, mask1 = threshold_channel(ch1, args.threshold_method)
    print(f"Thresholding channel 2 ({args.threshold_method}):")
    _, mask2 = threshold_channel(ch2, args.threshold_method)

    # Compute metrics
    print("\nComputing colocalization metrics...")
    pearson_r, pearson_p = compute_pearson(ch1, ch2, mask1, mask2)
    manders = compute_manders(ch1, ch2, mask1, mask2)

    # Save outputs
    os.makedirs(args.output_dir, exist_ok=True)
    ch1_name = Path(args.channel1).stem
    ch2_name = Path(args.channel2).stem
    base_name = f"{ch1_name}_vs_{ch2_name}"

    scatter_path = os.path.join(args.output_dir, f"{base_name}_scatter.png")
    generate_scatter_plot(ch1, ch2, mask1, mask2, scatter_path)

    overlay_path = os.path.join(args.output_dir, f"{base_name}_overlay.png")
    generate_overlay(ch1, ch2, overlay_path)

    # Save metrics to CSV
    metrics_df = pd.DataFrame([{
        "channel1": args.channel1,
        "channel2": args.channel2,
        "threshold_method": args.threshold_method,
        "pearson_r": pearson_r,
        "pearson_p": pearson_p,
        "manders_M1": manders["M1"],
        "manders_M2": manders["M2"],
        "manders_MOC": manders["MOC"],
    }])
    csv_path = os.path.join(args.output_dir, f"{base_name}_metrics.csv")
    metrics_df.to_csv(csv_path, index=False)
    print(f"  Metrics saved: {csv_path}")

    # Print results
    print_metrics(pearson_r, pearson_p, manders)


if __name__ == "__main__":
    main()
