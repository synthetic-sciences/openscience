#!/usr/bin/env python3
"""IHC (Immunohistochemistry) image quantification with H-score calculation.

Performs color deconvolution to separate chromogen stain (DAB or AEC) from
hematoxylin counterstain using Ruifrok & Johnston stain vectors. Classifies
pixels by staining intensity into negative, weak (1+), moderate (2+), and
strong (3+) categories, then computes the H-score.

H-score = 1*(% weak) + 2*(% moderate) + 3*(% strong), range 0-300.

Usage:
    python quantify_ihc.py --image tissue_section.tif --output-dir results/

Examples:
    # DAB-stained section (default)
    python quantify_ihc.py --image slide_001.tif --output-dir ihc_output

    # AEC-stained section
    python quantify_ihc.py --image slide_002.tif --stain AEC --output-dir ihc_output

    # Supported formats: TIFF, PNG, JPEG, BMP
"""

import argparse
import os
import sys

import numpy as np


def load_image(path):
    """Load an image from disk using skimage.

    Parameters
    ----------
    path : str
        Path to the image file.

    Returns
    -------
    np.ndarray
        RGB image as uint8 array with shape (H, W, 3).

    Raises
    ------
    FileNotFoundError
        If image file does not exist.
    ValueError
        If image cannot be loaded or is not RGB.
    """
    from skimage.io import imread

    if not os.path.isfile(path):
        raise FileNotFoundError(f"Image not found: {path}")

    img = imread(path)

    if img.ndim == 2:
        raise ValueError("Grayscale images are not supported. Provide an RGB image.")

    if img.ndim == 3 and img.shape[2] == 4:
        img = img[:, :, :3]

    if img.ndim != 3 or img.shape[2] != 3:
        raise ValueError(f"Expected RGB image, got shape {img.shape}")

    if img.dtype != np.uint8:
        if img.max() <= 1.0:
            img = (img * 255).astype(np.uint8)
        else:
            img = img.astype(np.uint8)

    return img


def deconvolve_stains(img, stain_type="DAB"):
    """Separate stains using color deconvolution.

    Uses Ruifrok & Johnston stain vectors for H&E / H-DAB / H-AEC.

    Parameters
    ----------
    img : np.ndarray
        RGB image, uint8.
    stain_type : str
        'DAB' or 'AEC'.

    Returns
    -------
    tuple of (np.ndarray, np.ndarray, np.ndarray)
        Hematoxylin channel, chromogen channel, residual channel.
        Each is a 2D float array where higher values = more stain.
    """
    from skimage.color import separate_stains, hdx_from_rgb, aec_from_rgb

    if stain_type.upper() == "DAB":
        stain_matrix = hdx_from_rgb
    elif stain_type.upper() == "AEC":
        stain_matrix = aec_from_rgb
    else:
        raise ValueError(f"Unsupported stain type: {stain_type}. Use DAB or AEC.")

    deconv = separate_stains(img, stain_matrix)

    hematoxylin = deconv[:, :, 0]
    chromogen = deconv[:, :, 1]
    residual = deconv[:, :, 2]

    return hematoxylin, chromogen, residual


def create_tissue_mask(img, hematoxylin_ch, chromogen_ch):
    """Create a binary mask of tissue regions (exclude background).

    Uses a combination of grayscale intensity thresholding and
    stain channel presence to identify tissue.

    Parameters
    ----------
    img : np.ndarray
        Original RGB image.
    hematoxylin_ch : np.ndarray
        Hematoxylin deconvolution channel.
    chromogen_ch : np.ndarray
        Chromogen deconvolution channel.

    Returns
    -------
    np.ndarray
        Boolean mask where True = tissue.
    """
    from skimage.color import rgb2gray
    from skimage.filters import threshold_otsu
    from skimage.morphology import binary_closing, disk

    gray = rgb2gray(img)
    try:
        thresh = threshold_otsu(gray)
        tissue = gray < thresh
    except ValueError:
        tissue = gray < 0.9

    stain_present = (hematoxylin_ch > 0.02) | (chromogen_ch > 0.02)
    mask = tissue | stain_present
    mask = binary_closing(mask, disk(5))

    return mask


def classify_intensity(chromogen_ch, tissue_mask):
    """Classify chromogen staining intensity into 4 categories.

    Thresholds are derived from intensity quartiles of positive pixels.

    Parameters
    ----------
    chromogen_ch : np.ndarray
        2D chromogen channel (higher = more stain).
    tissue_mask : np.ndarray
        Boolean tissue mask.

    Returns
    -------
    tuple of (np.ndarray, dict)
        Classification map (0=negative, 1=weak, 2=moderate, 3=strong)
        and dictionary with percentages and thresholds.
    """
    tissue_values = chromogen_ch[tissue_mask]

    if tissue_values.size == 0:
        classification = np.zeros_like(chromogen_ch, dtype=np.int8)
        stats = {
            "pct_negative": 100.0,
            "pct_weak": 0.0,
            "pct_moderate": 0.0,
            "pct_strong": 0.0,
            "threshold_positive": 0.0,
            "threshold_moderate": 0.0,
            "threshold_strong": 0.0,
        }
        return classification, stats

    positive_threshold = np.percentile(tissue_values, 60)
    if positive_threshold < 0.05:
        positive_threshold = 0.05

    positive_values = tissue_values[tissue_values >= positive_threshold]
    if positive_values.size > 0:
        q33 = np.percentile(positive_values, 33)
        q66 = np.percentile(positive_values, 66)
    else:
        q33 = positive_threshold
        q66 = positive_threshold

    classification = np.zeros_like(chromogen_ch, dtype=np.int8)

    in_tissue = tissue_mask.copy()
    classification[in_tissue & (chromogen_ch >= positive_threshold) & (chromogen_ch < q33)] = 1
    classification[in_tissue & (chromogen_ch >= q33) & (chromogen_ch < q66)] = 2
    classification[in_tissue & (chromogen_ch >= q66)] = 3

    n_tissue = tissue_mask.sum()
    n_neg = (classification[tissue_mask] == 0).sum()
    n_weak = (classification[tissue_mask] == 1).sum()
    n_mod = (classification[tissue_mask] == 2).sum()
    n_strong = (classification[tissue_mask] == 3).sum()

    stats = {
        "pct_negative": 100.0 * n_neg / n_tissue,
        "pct_weak": 100.0 * n_weak / n_tissue,
        "pct_moderate": 100.0 * n_mod / n_tissue,
        "pct_strong": 100.0 * n_strong / n_tissue,
        "threshold_positive": float(positive_threshold),
        "threshold_moderate": float(q33),
        "threshold_strong": float(q66),
        "n_tissue_pixels": int(n_tissue),
    }

    return classification, stats


def compute_h_score(stats):
    """Compute H-score from classification percentages.

    H-score = 1*(% weak) + 2*(% moderate) + 3*(% strong)
    Range: 0 to 300.

    Parameters
    ----------
    stats : dict
        Dictionary with keys pct_weak, pct_moderate, pct_strong.

    Returns
    -------
    float
        H-score value.
    """
    return (
        1.0 * stats["pct_weak"]
        + 2.0 * stats["pct_moderate"]
        + 3.0 * stats["pct_strong"]
    )


def compute_mean_intensity(chromogen_ch, tissue_mask):
    """Compute mean chromogen intensity in tissue region.

    Parameters
    ----------
    chromogen_ch : np.ndarray
        Chromogen channel.
    tissue_mask : np.ndarray
        Boolean tissue mask.

    Returns
    -------
    float
        Mean chromogen intensity in tissue pixels.
    """
    values = chromogen_ch[tissue_mask]
    return float(np.mean(values)) if values.size > 0 else 0.0


def compute_positive_area(stats):
    """Compute percentage of tissue that is positive (any staining).

    Parameters
    ----------
    stats : dict
        Classification stats dictionary.

    Returns
    -------
    float
        Percentage of tissue area that is positive.
    """
    return stats["pct_weak"] + stats["pct_moderate"] + stats["pct_strong"]


def save_deconvolved(chromogen_ch, output_path):
    """Save the chromogen deconvolution channel as an image.

    Parameters
    ----------
    chromogen_ch : np.ndarray
        2D chromogen channel.
    output_path : str
        File path for saving.
    """
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    fig, ax = plt.subplots(figsize=(8, 8))
    im = ax.imshow(chromogen_ch, cmap="OrRd", vmin=0)
    ax.set_title("Deconvolved Chromogen Channel", fontsize=14)
    ax.axis("off")
    fig.colorbar(im, ax=ax, fraction=0.046, pad=0.04, label="Stain Intensity")
    fig.tight_layout()
    fig.savefig(output_path, dpi=150, bbox_inches="tight")
    plt.close(fig)
    print(f"Deconvolved image saved: {output_path}")


def save_annotated_overlay(img, classification, tissue_mask, output_path):
    """Save original image with classification overlay.

    Colors: green=negative, yellow=weak, orange=moderate, red=strong.

    Parameters
    ----------
    img : np.ndarray
        Original RGB image.
    classification : np.ndarray
        Pixel classification map.
    tissue_mask : np.ndarray
        Boolean tissue mask.
    output_path : str
        File path for saving.
    """
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from matplotlib.colors import ListedColormap
    from matplotlib.patches import Patch

    fig, axes = plt.subplots(1, 2, figsize=(16, 8))

    axes[0].imshow(img)
    axes[0].set_title("Original Image", fontsize=14)
    axes[0].axis("off")

    overlay = np.zeros((*classification.shape, 4), dtype=float)
    colors = {
        0: [0.0, 0.8, 0.0, 0.3],
        1: [1.0, 1.0, 0.0, 0.4],
        2: [1.0, 0.6, 0.0, 0.5],
        3: [1.0, 0.0, 0.0, 0.6],
    }
    for val, color in colors.items():
        mask = tissue_mask & (classification == val)
        overlay[mask] = color

    axes[1].imshow(img)
    axes[1].imshow(overlay)
    axes[1].set_title("IHC Classification Overlay", fontsize=14)
    axes[1].axis("off")

    legend_elements = [
        Patch(facecolor="green", alpha=0.5, label="Negative (0)"),
        Patch(facecolor="yellow", alpha=0.5, label="Weak (1+)"),
        Patch(facecolor="orange", alpha=0.5, label="Moderate (2+)"),
        Patch(facecolor="red", alpha=0.5, label="Strong (3+)"),
    ]
    axes[1].legend(handles=legend_elements, loc="lower right", fontsize=10)

    fig.tight_layout()
    fig.savefig(output_path, dpi=150, bbox_inches="tight")
    plt.close(fig)
    print(f"Annotated overlay saved: {output_path}")


def main():
    parser = argparse.ArgumentParser(
        description="IHC image quantification with H-score calculation."
    )
    parser.add_argument(
        "--image",
        required=True,
        help="Path to IHC-stained tissue image (TIFF, PNG, JPEG).",
    )
    parser.add_argument(
        "--stain",
        choices=["DAB", "AEC"],
        default="DAB",
        help="Chromogen stain type (default: DAB).",
    )
    parser.add_argument(
        "--output-dir",
        default="ihc_output",
        help="Output directory for results (default: ihc_output).",
    )
    args = parser.parse_args()

    os.makedirs(args.output_dir, exist_ok=True)

    print("=" * 60)
    print("IHC IMAGE QUANTIFICATION")
    print("=" * 60)
    print(f"Image:  {args.image}")
    print(f"Stain:  {args.stain}")

    try:
        img = load_image(args.image)
    except (FileNotFoundError, ValueError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        sys.exit(1)

    print(f"Image size: {img.shape[1]} x {img.shape[0]} pixels")

    print("\nPerforming color deconvolution...")
    try:
        hematoxylin_ch, chromogen_ch, residual_ch = deconvolve_stains(img, args.stain)
    except ValueError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        sys.exit(1)

    print("Creating tissue mask...")
    tissue_mask = create_tissue_mask(img, hematoxylin_ch, chromogen_ch)
    tissue_pct = 100.0 * tissue_mask.sum() / tissue_mask.size
    print(f"Tissue area: {tissue_pct:.1f}% of image ({tissue_mask.sum():,} pixels)")

    if tissue_mask.sum() == 0:
        print("ERROR: No tissue detected in image.", file=sys.stderr)
        sys.exit(1)

    print("Classifying staining intensity...")
    classification, stats = classify_intensity(chromogen_ch, tissue_mask)

    h_score = compute_h_score(stats)
    positive_area = compute_positive_area(stats)
    mean_intensity = compute_mean_intensity(chromogen_ch, tissue_mask)

    print(f"\n{'RESULTS':=^60}")
    print(f"\n  H-Score:             {h_score:.1f} / 300")
    print(f"  Positive Area:       {positive_area:.1f}%")
    print(f"  Mean DAB Intensity:  {mean_intensity:.4f}")
    print(f"\n  Intensity Breakdown:")
    print(f"    Negative (0):  {stats['pct_negative']:.1f}%")
    print(f"    Weak (1+):     {stats['pct_weak']:.1f}%")
    print(f"    Moderate (2+): {stats['pct_moderate']:.1f}%")
    print(f"    Strong (3+):   {stats['pct_strong']:.1f}%")
    print(f"\n  Thresholds Used:")
    print(f"    Positive: {stats['threshold_positive']:.4f}")
    print(f"    Moderate: {stats['threshold_moderate']:.4f}")
    print(f"    Strong:   {stats['threshold_strong']:.4f}")

    deconv_path = os.path.join(args.output_dir, "deconvolved_chromogen.png")
    save_deconvolved(chromogen_ch, deconv_path)

    overlay_path = os.path.join(args.output_dir, "classification_overlay.png")
    save_annotated_overlay(img, classification, tissue_mask, overlay_path)

    print("\n" + "=" * 60)
    print("QUANTIFICATION COMPLETE")
    print("=" * 60)


if __name__ == "__main__":
    main()
