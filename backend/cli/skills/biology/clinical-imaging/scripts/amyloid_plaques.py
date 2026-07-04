#!/usr/bin/env python3
"""
Amyloid Plaque Quantification from Fluorescence Microscopy Images

Segments and quantifies amyloid plaques from fluorescence microscopy images
(e.g., Thioflavin-S, Congo Red, or immunofluorescence staining). Supports
Otsu, adaptive, and manual thresholding methods. Computes plaque morphometrics
including count, area, eccentricity, and spatial density.

Usage:
    python amyloid_plaques.py --image section_01.tif --threshold-method otsu --output-dir results/
    python amyloid_plaques.py --image cortex.png --threshold-method adaptive --min-plaque-size 100 --output-dir results/

Examples:
    # Otsu thresholding (automatic)
    python amyloid_plaques.py --image brain_section.tif --threshold-method otsu --output-dir ./plaque_results

    # Adaptive thresholding for uneven illumination
    python amyloid_plaques.py --image hippocampus.png --threshold-method adaptive \\
        --min-plaque-size 75 --output-dir ./plaque_results

    # Manual threshold value
    python amyloid_plaques.py --image cortex_thioS.tif --threshold-method manual \\
        --manual-threshold 45 --output-dir ./plaque_results

Dependencies: numpy, opencv-python, scikit-image, matplotlib, pandas
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
from skimage.filters import threshold_otsu
from skimage.measure import label, regionprops
from skimage.morphology import remove_small_objects
from skimage.segmentation import clear_border


def load_image(image_path):
    """
    Load microscopy image from file.

    Args:
        image_path: Path to image file (TIFF, PNG, JPEG, etc.).

    Returns:
        Tuple of (grayscale 2D array, original BGR/grayscale image for overlay).

    Raises:
        FileNotFoundError: If file does not exist.
        RuntimeError: If image cannot be loaded.
    """
    path = Path(image_path)
    if not path.exists():
        raise FileNotFoundError(f"Image file not found: {image_path}")

    img = cv2.imread(str(path), cv2.IMREAD_UNCHANGED)
    if img is None:
        raise RuntimeError(f"Cannot load image: {image_path}")

    # Handle different image formats
    if len(img.shape) == 3:
        if img.shape[2] == 4:
            # BGRA -> BGR
            img_bgr = cv2.cvtColor(img, cv2.COLOR_BGRA2BGR)
        else:
            img_bgr = img.copy()
        gray = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2GRAY)
    elif len(img.shape) == 2:
        gray = img.copy()
        img_bgr = cv2.cvtColor(img, cv2.COLOR_GRAY2BGR)
    else:
        raise RuntimeError(f"Unexpected image dimensions: {img.shape}")

    # Normalize to 8-bit if needed
    if gray.dtype != np.uint8:
        gray = cv2.normalize(gray, None, 0, 255, cv2.NORM_MINMAX).astype(np.uint8)
        img_bgr = cv2.normalize(img_bgr, None, 0, 255, cv2.NORM_MINMAX).astype(np.uint8)

    return gray, img_bgr


def smooth_image(gray, sigma=2.0):
    """
    Apply Gaussian smoothing to reduce noise.

    Args:
        gray: 2D uint8 grayscale image.
        sigma: Gaussian kernel sigma.

    Returns:
        Smoothed 2D uint8 image.
    """
    ksize = int(2 * np.ceil(2 * sigma) + 1)
    return cv2.GaussianBlur(gray, (ksize, ksize), sigma)


def threshold_image(gray, method, manual_value=None):
    """
    Threshold grayscale image to produce binary mask.

    Args:
        gray: 2D uint8 grayscale image (already smoothed).
        method: One of 'otsu', 'adaptive', 'manual'.
        manual_value: Threshold value for manual method.

    Returns:
        Tuple of (binary mask as bool array, threshold value used).

    Raises:
        ValueError: If method is invalid or manual_value missing.
    """
    if method == "otsu":
        thresh_val = threshold_otsu(gray)
        binary = gray > thresh_val

    elif method == "adaptive":
        # Adaptive Gaussian thresholding
        block_size = max(51, (min(gray.shape) // 10) | 1)  # ensure odd
        binary_cv = cv2.adaptiveThreshold(
            gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
            cv2.THRESH_BINARY, block_size, -5
        )
        binary = binary_cv.astype(bool)
        thresh_val = float(np.mean(gray[binary]))  # effective threshold

    elif method == "manual":
        if manual_value is None:
            raise ValueError("--manual-threshold required when using manual method.")
        thresh_val = float(manual_value)
        binary = gray > thresh_val

    else:
        raise ValueError(f"Unknown threshold method: {method}. Use otsu/adaptive/manual.")

    return binary, thresh_val


def segment_plaques(binary, min_plaque_size):
    """
    Segment individual plaques from binary mask.

    Removes objects smaller than min_plaque_size and optionally clears
    objects touching the image border.

    Args:
        binary: 2D boolean mask.
        min_plaque_size: Minimum object area in pixels.

    Returns:
        Labeled 2D integer array (0 = background, 1..N = plaques).
    """
    # Remove small objects
    cleaned = remove_small_objects(binary, min_size=min_plaque_size)

    # Optionally clear border objects (plaques cut off at edge are unreliable)
    cleaned = clear_border(cleaned)

    # Label connected components
    labeled = label(cleaned)

    return labeled


def measure_plaques(labeled, gray):
    """
    Measure morphometric properties of segmented plaques.

    Args:
        labeled: 2D labeled integer array from segment_plaques.
        gray: Original grayscale image for intensity measurements.

    Returns:
        List of dicts with per-plaque measurements.
    """
    regions = regionprops(labeled, intensity_image=gray)

    measurements = []
    for region in regions:
        measurements.append({
            "label": region.label,
            "centroid_row": region.centroid[0],
            "centroid_col": region.centroid[1],
            "area_px": region.area,
            "perimeter_px": region.perimeter,
            "eccentricity": region.eccentricity,
            "mean_intensity": region.mean_intensity,
            "min_intensity": region.min_intensity,
            "max_intensity": region.max_intensity,
            "major_axis_px": region.major_axis_length,
            "minor_axis_px": region.minor_axis_length,
            "solidity": region.solidity,
            "extent": region.extent,
            "equivalent_diameter_px": region.equivalent_diameter,
        })

    return measurements


def create_overlay(img_bgr, labeled):
    """
    Create overlay image with plaque outlines and labels.

    Args:
        img_bgr: Original BGR image.
        labeled: 2D labeled array.

    Returns:
        BGR overlay image.
    """
    overlay = img_bgr.copy()

    # Draw contours for each plaque
    for region_label in range(1, labeled.max() + 1):
        mask = (labeled == region_label).astype(np.uint8) * 255
        contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        cv2.drawContours(overlay, contours, -1, (0, 255, 0), 1)

        # Label with number
        region = regionprops(label(labeled == region_label))[0]
        cy, cx = int(region.centroid[0]), int(region.centroid[1])
        cv2.putText(
            overlay, str(region_label), (cx - 5, cy + 5),
            cv2.FONT_HERSHEY_SIMPLEX, 0.3, (255, 255, 0), 1
        )

    return overlay


def save_overlay(overlay, output_path):
    """Save overlay image to file."""
    output_path = Path(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(output_path), overlay)


def print_plaque_summary(measurements, image_shape):
    """
    Print summary statistics of plaque quantification.

    Args:
        measurements: List of per-plaque measurement dicts.
        image_shape: Tuple (height, width) of original image.
    """
    total_image_area = image_shape[0] * image_shape[1]
    n_plaques = len(measurements)

    print("\n=== Amyloid Plaque Quantification Summary ===")
    print(f"  Image dimensions:   {image_shape[1]}x{image_shape[0]} px")
    print(f"  Total image area:   {total_image_area} px")
    print(f"  Plaque count:       {n_plaques}")

    if n_plaques == 0:
        print("  WARNING: No plaques detected. Consider adjusting threshold or min-plaque-size.")
        return

    areas = np.array([m["area_px"] for m in measurements])
    total_plaque_area = np.sum(areas)
    plaque_density = n_plaques / (total_image_area / 1e6)  # per million pixels
    burden_pct = 100.0 * total_plaque_area / total_image_area

    print(f"  Plaque density:     {plaque_density:.2f} plaques per Mpx")
    print(f"  Total plaque area:  {total_plaque_area} px")
    print(f"  Plaque burden:      {burden_pct:.4f}% of image area")
    print(f"  Mean area:          {np.mean(areas):.1f} +/- {np.std(areas):.1f} px")
    print(f"  Median area:        {np.median(areas):.1f} px")
    print(f"  Min area:           {np.min(areas)} px")
    print(f"  Max area:           {np.max(areas)} px")

    eccs = np.array([m["eccentricity"] for m in measurements])
    print(f"  Mean eccentricity:  {np.mean(eccs):.3f} +/- {np.std(eccs):.3f}")

    intensities = np.array([m["mean_intensity"] for m in measurements])
    print(f"  Mean intensity:     {np.mean(intensities):.1f} +/- {np.std(intensities):.1f}")

    solidity = np.array([m["solidity"] for m in measurements])
    print(f"  Mean solidity:      {np.mean(solidity):.3f} +/- {np.std(solidity):.3f}")


def main():
    parser = argparse.ArgumentParser(
        description="Amyloid plaque quantification from fluorescence microscopy.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python amyloid_plaques.py --image section.tif --threshold-method otsu --output-dir ./results
  python amyloid_plaques.py --image cortex.png --threshold-method adaptive --output-dir ./results
  python amyloid_plaques.py --image stain.tif --threshold-method manual --manual-threshold 50 --output-dir ./results
        """,
    )
    parser.add_argument(
        "--image", required=True, help="Path to fluorescence microscopy image."
    )
    parser.add_argument(
        "--threshold-method",
        required=True,
        choices=["otsu", "adaptive", "manual"],
        help="Thresholding method: otsu, adaptive, or manual.",
    )
    parser.add_argument(
        "--manual-threshold",
        type=int,
        default=None,
        help="Threshold value (0-255) for manual method.",
    )
    parser.add_argument(
        "--min-plaque-size",
        type=int,
        default=50,
        help="Minimum plaque area in pixels (default: 50).",
    )
    parser.add_argument(
        "--output-dir",
        required=True,
        help="Directory for output files.",
    )

    args = parser.parse_args()

    # Validate manual threshold
    if args.threshold_method == "manual" and args.manual_threshold is None:
        print("ERROR: --manual-threshold required when using manual method.", file=sys.stderr)
        sys.exit(1)

    if args.min_plaque_size < 1:
        print("ERROR: --min-plaque-size must be at least 1.", file=sys.stderr)
        sys.exit(1)

    # Load image
    print(f"Loading image: {args.image}")
    gray, img_bgr = load_image(args.image)
    print(f"  Dimensions:       {gray.shape[1]}x{gray.shape[0]} px")
    print(f"  Intensity range:  [{gray.min()}, {gray.max()}]")
    print(f"  Mean intensity:   {gray.mean():.1f}")

    # Smooth
    print("\nApplying Gaussian smoothing (sigma=2.0) ...")
    smoothed = smooth_image(gray, sigma=2.0)

    # Threshold
    print(f"Thresholding with method: {args.threshold_method}")
    binary, thresh_val = threshold_image(smoothed, args.threshold_method, args.manual_threshold)
    print(f"  Threshold value:  {thresh_val:.1f}")
    print(f"  Foreground pixels: {np.sum(binary)} ({100*np.sum(binary)/binary.size:.2f}%)")

    # Segment plaques
    print(f"Segmenting plaques (min size = {args.min_plaque_size} px) ...")
    labeled = segment_plaques(binary, args.min_plaque_size)
    n_plaques = labeled.max()
    print(f"  Plaques segmented: {n_plaques}")

    # Measure plaques
    measurements = measure_plaques(labeled, gray)

    # Print summary
    print_plaque_summary(measurements, gray.shape)

    # Save outputs
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    # Overlay image
    overlay_path = output_dir / "plaque_overlay.png"
    if n_plaques > 0:
        overlay = create_overlay(img_bgr, labeled)
        save_overlay(overlay, overlay_path)
        print(f"\nOverlay image saved: {overlay_path}")
    else:
        print("\nNo plaques to overlay.")

    # Measurements CSV
    csv_path = output_dir / "plaque_measurements.csv"
    if measurements:
        pd.DataFrame(measurements).to_csv(str(csv_path), index=False)
        print(f"Measurements CSV saved: {csv_path}")
    else:
        print("No measurements to save.")

    # Save binary mask
    mask_path = output_dir / "plaque_binary_mask.png"
    cv2.imwrite(str(mask_path), (labeled > 0).astype(np.uint8) * 255)
    print(f"Binary mask saved: {mask_path}")

    # Save labeled map
    label_path = output_dir / "plaque_labeled.npy"
    np.save(str(label_path), labeled)
    print(f"Labeled map saved: {label_path}")


if __name__ == "__main__":
    main()
