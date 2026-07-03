#!/usr/bin/env python3
"""Count bacterial colonies on agar plate images.

Detects and counts individual bacterial colonies from photographs of agar plates.
Uses Gaussian blur, Otsu (or manual) thresholding, and watershed segmentation
to separate touching colonies. Filters detections by area and reports colony
size statistics.

Usage:
    python count_colonies.py --image plate.jpg --output-dir results/
    python count_colonies.py --image plate.png --min-area 100 --max-area 3000
    python count_colonies.py --image plate.tif --threshold 120 --output-dir counts/

Examples:
    # Automatic threshold with default area filters
    python count_colonies.py --image agar_plate.jpg

    # Manual threshold for low-contrast plates
    python count_colonies.py --image dim_plate.png --threshold 100 --min-area 30

    # Strict area filtering for uniform colony sizes
    python count_colonies.py --image plate.tif --min-area 200 --max-area 2000 --output-dir output/
"""

import argparse
import os
import sys
import warnings
from pathlib import Path

import cv2
import numpy as np
import pandas as pd

warnings.filterwarnings("ignore", category=DeprecationWarning)


def load_image(image_path):
    """Load an image from disk using OpenCV.

    Args:
        image_path: Path to the image file.

    Returns:
        numpy.ndarray: BGR image as loaded by OpenCV.

    Raises:
        FileNotFoundError: If the image file does not exist.
        RuntimeError: If OpenCV cannot decode the image.
    """
    if not os.path.isfile(image_path):
        raise FileNotFoundError(f"Image not found: {image_path}")

    img = cv2.imread(image_path)
    if img is None:
        raise RuntimeError(f"Failed to load image: {image_path}")

    print(f"Loaded image: {image_path}")
    print(f"  Shape: {img.shape}, dtype: {img.dtype}")
    return img


def preprocess(image, threshold_value=None):
    """Convert to grayscale, blur, and threshold the image.

    Applies Gaussian blur for noise reduction, then Otsu's method (or a manual
    threshold) to produce a binary mask of colony candidates.

    Args:
        image: BGR input image.
        threshold_value: Manual threshold (0-255), or None for Otsu's method.

    Returns:
        tuple: (grayscale image, binary mask with colonies as foreground)
    """
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)

    # Gaussian blur to reduce noise
    blurred = cv2.GaussianBlur(gray, (11, 11), 0)

    if threshold_value is not None:
        print(f"  Using manual threshold: {threshold_value}")
        _, binary = cv2.threshold(blurred, threshold_value, 255, cv2.THRESH_BINARY)
    else:
        thresh_val, binary = cv2.threshold(
            blurred, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU
        )
        print(f"  Otsu threshold: {thresh_val:.0f}")

    # Colonies are typically darker than background on agar; invert so colonies are white
    binary = cv2.bitwise_not(binary)

    # Morphological operations to clean up
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
    binary = cv2.morphologyEx(binary, cv2.MORPH_OPEN, kernel, iterations=2)
    binary = cv2.morphologyEx(binary, cv2.MORPH_CLOSE, kernel, iterations=1)

    return gray, binary


def watershed_split(binary):
    """Apply watershed segmentation to separate touching colonies.

    Uses distance transform and marker-based watershed to split merged blobs
    into individual colony detections.

    Args:
        binary: Binary mask (uint8, colonies=255, background=0).

    Returns:
        numpy.ndarray: Integer-labeled image where each colony has a unique ID.
    """
    from scipy import ndimage as ndi

    # Distance transform
    dist = ndi.distance_transform_edt(binary)

    # Find local maxima as markers
    dist_8u = cv2.normalize(dist, None, 0, 255, cv2.NORM_MINMAX).astype(np.uint8)
    _, sure_fg = cv2.threshold(dist_8u, 0.5 * dist_8u.max(), 255, cv2.THRESH_BINARY)
    sure_fg = sure_fg.astype(np.uint8)

    # Sure background via dilation
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
    sure_bg = cv2.dilate(binary, kernel, iterations=3)

    # Unknown region
    unknown = cv2.subtract(sure_bg, sure_fg)

    # Label markers
    num_labels, markers = cv2.connectedComponents(sure_fg)
    markers = markers + 1  # background becomes 1
    markers[unknown == 255] = 0  # unknown region marked 0

    # Watershed requires 3-channel image
    vis = cv2.cvtColor(binary, cv2.COLOR_GRAY2BGR)
    markers = cv2.watershed(vis, markers)

    # Build clean labels: background=0, colonies=1,2,3...
    labels = np.zeros_like(markers, dtype=np.int32)
    unique_labels = [lbl for lbl in np.unique(markers) if lbl > 1]
    for i, lbl in enumerate(unique_labels, start=1):
        labels[markers == lbl] = i

    return labels


def filter_colonies(labels, min_area, max_area):
    """Filter labeled regions by area and compute colony properties.

    Args:
        labels: Integer-labeled image from watershed segmentation.
        min_area: Minimum colony area in pixels to keep.
        max_area: Maximum colony area in pixels to keep.

    Returns:
        tuple: (filtered label image, pandas DataFrame of colony properties)
    """
    from skimage.measure import regionprops

    props_list = []
    filtered_labels = np.zeros_like(labels)
    new_id = 0

    for region in regionprops(labels):
        if min_area <= region.area <= max_area:
            new_id += 1
            filtered_labels[labels == region.label] = new_id
            props_list.append({
                "colony_id": new_id,
                "area_px": region.area,
                "centroid_y": region.centroid[0],
                "centroid_x": region.centroid[1],
                "eccentricity": region.eccentricity,
                "perimeter": region.perimeter,
                "equivalent_diameter": region.equivalent_diameter,
            })

    df = pd.DataFrame(props_list)
    return filtered_labels, df


def save_annotated_image(image, labels, output_dir, image_name):
    """Save an annotated image with colony outlines drawn.

    Args:
        image: Original BGR image.
        labels: Filtered integer-labeled colony mask.
        output_dir: Output directory path.
        image_name: Base filename for output.

    Returns:
        str: Path to the saved annotated image.
    """
    annotated = image.copy()

    for label_id in range(1, labels.max() + 1):
        mask = (labels == label_id).astype(np.uint8)
        contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        cv2.drawContours(annotated, contours, -1, (0, 255, 0), 2)

        # Label colony ID at centroid
        ys, xs = np.where(mask > 0)
        if len(ys) > 0:
            cy, cx = int(np.mean(ys)), int(np.mean(xs))
            cv2.putText(
                annotated, str(label_id), (cx - 8, cy + 5),
                cv2.FONT_HERSHEY_SIMPLEX, 0.4, (0, 0, 255), 1, cv2.LINE_AA,
            )

    out_path = os.path.join(output_dir, f"{image_name}_annotated.png")
    cv2.imwrite(out_path, annotated)
    return out_path


def print_summary(colony_df, total_before_filter, min_area, max_area):
    """Print colony counting results to stdout.

    Args:
        colony_df: DataFrame of colony measurements.
        total_before_filter: Number of connected components before area filtering.
        min_area: Minimum area threshold used.
        max_area: Maximum area threshold used.
    """
    n = len(colony_df)
    print(f"\n{'='*60}")
    print(f"COLONY COUNT RESULTS")
    print(f"{'='*60}")
    print(f"Connected components (pre-filter): {total_before_filter}")
    print(f"Area filter: {min_area} - {max_area} px")
    print(f"Colonies detected: {n}")

    if n == 0:
        print("No colonies found matching the area criteria.")
        return

    print(f"\nColony Area (px):")
    print(f"  Mean:   {colony_df['area_px'].mean():.1f}")
    print(f"  Median: {colony_df['area_px'].median():.1f}")
    print(f"  Std:    {colony_df['area_px'].std():.1f}")
    print(f"  Min:    {colony_df['area_px'].min():.1f}")
    print(f"  Max:    {colony_df['area_px'].max():.1f}")

    print(f"\nEquivalent Diameter (px):")
    print(f"  Mean:   {colony_df['equivalent_diameter'].mean():.1f}")
    print(f"  Std:    {colony_df['equivalent_diameter'].std():.1f}")

    print(f"\nEccentricity:")
    print(f"  Mean:   {colony_df['eccentricity'].mean():.3f}")
    print(f"  Std:    {colony_df['eccentricity'].std():.3f}")
    print(f"{'='*60}")


def main():
    parser = argparse.ArgumentParser(
        description="Count bacterial colonies on agar plate images.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "--image", required=True, help="Path to agar plate image."
    )
    parser.add_argument(
        "--min-area",
        type=int,
        default=50,
        help="Minimum colony area in pixels (default: 50).",
    )
    parser.add_argument(
        "--max-area",
        type=int,
        default=5000,
        help="Maximum colony area in pixels (default: 5000).",
    )
    parser.add_argument(
        "--threshold",
        default="auto",
        help="Threshold value (0-255), or 'auto' for Otsu (default: auto).",
    )
    parser.add_argument(
        "--output-dir",
        default="./colony_output",
        help="Directory for output files (default: ./colony_output).",
    )
    args = parser.parse_args()

    # Parse threshold
    threshold_value = None if args.threshold.lower() == "auto" else int(args.threshold)

    # Load and preprocess
    image = load_image(args.image)
    gray, binary = preprocess(image, threshold_value)

    # Count connected components before watershed (for reporting)
    from skimage.measure import label as sk_label
    pre_labels = sk_label(binary > 0)
    total_before_filter = pre_labels.max()
    print(f"  Connected components before watershed: {total_before_filter}")

    # Watershed to split touching colonies
    labels = watershed_split(binary)
    print(f"  Labels after watershed: {labels.max()}")

    # Filter by area
    filtered_labels, colony_df = filter_colonies(labels, args.min_area, args.max_area)

    # Save results
    os.makedirs(args.output_dir, exist_ok=True)
    image_name = Path(args.image).stem

    annotated_path = save_annotated_image(image, filtered_labels, args.output_dir, image_name)
    print(f"  Annotated image saved: {annotated_path}")

    csv_path = os.path.join(args.output_dir, f"{image_name}_colonies.csv")
    colony_df.to_csv(csv_path, index=False)
    print(f"  Colony data saved: {csv_path}")

    # Print summary
    print_summary(colony_df, total_before_filter, args.min_area, args.max_area)


if __name__ == "__main__":
    main()
