#!/usr/bin/env python3
"""
Count bacterial colonies from agar plate images.

Uses adaptive thresholding, distance-transform watershed segmentation,
and morphological filtering to detect and count individual colonies,
including touching/overlapping ones.  Reports colony count, size
distribution statistics, and saves an annotated image.

Usage:
    python colony_counter.py --image plate.jpg --output-dir results/
    python colony_counter.py --image plate.png --min-radius 5 --max-radius 40 --sensitivity 0.85 --output-dir results/

Examples:
    # Default settings
    python colony_counter.py --image plate_photo.jpg --output-dir ./out

    # Adjust for very small colonies
    python colony_counter.py --image plate.tif --min-radius 2 --max-radius 30 --output-dir ./out

    # Lower sensitivity for noisy images
    python colony_counter.py --image noisy_plate.png --sensitivity 0.7 --output-dir ./out

Dependencies: numpy, scipy, matplotlib, scikit-image, opencv-python (cv2)
"""

import argparse
import sys
from pathlib import Path

import cv2
import matplotlib.pyplot as plt
import numpy as np
from scipy import ndimage
from skimage.feature import peak_local_max
from skimage.segmentation import watershed


# ---------------------------------------------------------------------------
# Image pre-processing
# ---------------------------------------------------------------------------

def load_image(path):
    """Load an image in BGR (OpenCV default) and return BGR + grayscale."""
    img = cv2.imread(str(path))
    if img is None:
        raise FileNotFoundError(f"Cannot read image: {path}")
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    return img, gray


def preprocess(gray, blur_ksize=11):
    """Apply Gaussian blur and return smoothed grayscale image."""
    blurred = cv2.GaussianBlur(gray, (blur_ksize, blur_ksize), 0)
    return blurred


def threshold_image(blurred, sensitivity=0.85):
    """
    Binarize the image using a combined Otsu + adaptive approach.

    sensitivity (0-1) controls the adaptive threshold offset.  Higher
    values retain more foreground (colonies).

    Returns a binary image where colonies are white (255).
    """
    # Otsu threshold
    otsu_val, otsu_binary = cv2.threshold(
        blurred, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU
    )

    # Adaptive threshold for uneven illumination
    block_size = max(11, (blurred.shape[0] // 20) | 1)  # ensure odd
    offset = int((1.0 - sensitivity) * 30) + 2
    adaptive_binary = cv2.adaptiveThreshold(
        blurred,
        255,
        cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
        cv2.THRESH_BINARY_INV,
        block_size,
        offset,
    )

    # Combine: pixel is foreground if EITHER method says so
    combined = cv2.bitwise_or(otsu_binary, adaptive_binary)

    # Morphological clean-up
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
    combined = cv2.morphologyEx(combined, cv2.MORPH_OPEN, kernel, iterations=2)
    combined = cv2.morphologyEx(combined, cv2.MORPH_CLOSE, kernel, iterations=1)

    return combined


# ---------------------------------------------------------------------------
# Colony segmentation via watershed
# ---------------------------------------------------------------------------

def segment_colonies(binary):
    """
    Watershed segmentation to split touching colonies.

    Returns
    -------
    labels : ndarray  – labelled image (0 = background)
    n_labels : int    – number of detected regions
    """
    # Distance transform
    dist = ndimage.distance_transform_edt(binary)

    # Local maxima as markers
    coords = peak_local_max(dist, min_distance=5, labels=binary)
    mask = np.zeros(dist.shape, dtype=bool)
    mask[tuple(coords.T)] = True
    markers, n_markers = ndimage.label(mask)

    # Watershed
    labels = watershed(-dist, markers, mask=binary)
    return labels, n_markers


def filter_colonies(labels, min_radius, max_radius, min_circularity=0.5):
    """
    Filter labelled regions by size and circularity.

    Parameters
    ----------
    labels : ndarray    – labelled image
    min_radius : int    – minimum colony radius in pixels
    max_radius : int    – maximum colony radius in pixels
    min_circularity : float – minimum circularity (4*pi*area / perimeter^2)

    Returns
    -------
    kept : list of dict – each entry has 'label', 'area', 'centroid',
                          'radius', 'circularity', 'bbox'
    filtered_labels : ndarray – labels with rejected regions set to 0
    """
    min_area = np.pi * min_radius ** 2
    max_area = np.pi * max_radius ** 2

    unique_labels = np.unique(labels)
    unique_labels = unique_labels[unique_labels != 0]  # skip background

    kept = []
    filtered_labels = np.zeros_like(labels)

    for lbl in unique_labels:
        mask = (labels == lbl).astype(np.uint8)
        area = int(np.sum(mask))

        if area < min_area or area > max_area:
            continue

        # Contour for circularity
        contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        if not contours:
            continue
        cnt = max(contours, key=cv2.contourArea)
        perimeter = cv2.arcLength(cnt, True)
        if perimeter == 0:
            continue
        circularity = 4.0 * np.pi * area / (perimeter ** 2)

        if circularity < min_circularity:
            continue

        # Centroid
        M = cv2.moments(cnt)
        if M["m00"] == 0:
            continue
        cx = int(M["m10"] / M["m00"])
        cy = int(M["m01"] / M["m00"])

        radius = np.sqrt(area / np.pi)
        x, y, w, h = cv2.boundingRect(cnt)

        kept.append({
            "label": int(lbl),
            "area": area,
            "centroid": (cx, cy),
            "radius": radius,
            "circularity": circularity,
            "bbox": (x, y, w, h),
        })
        filtered_labels[labels == lbl] = lbl

    return kept, filtered_labels


# ---------------------------------------------------------------------------
# Annotation & output
# ---------------------------------------------------------------------------

def annotate_image(img, colonies):
    """Draw colony outlines and labels on the original image."""
    annotated = img.copy()
    for i, col in enumerate(colonies, start=1):
        cx, cy = col["centroid"]
        r = int(col["radius"]) + 2
        cv2.circle(annotated, (cx, cy), r, (0, 255, 0), 2)
        cv2.putText(
            annotated,
            str(i),
            (cx + r + 2, cy + 4),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.4,
            (0, 255, 255),
            1,
            cv2.LINE_AA,
        )
    return annotated


def size_distribution(colonies):
    """Compute size distribution statistics (areas and radii)."""
    areas = np.array([c["area"] for c in colonies])
    radii = np.array([c["radius"] for c in colonies])
    stats = {
        "count": len(colonies),
        "area_mean": float(np.mean(areas)) if len(areas) else 0.0,
        "area_median": float(np.median(areas)) if len(areas) else 0.0,
        "area_std": float(np.std(areas, ddof=1)) if len(areas) > 1 else 0.0,
        "area_min": float(np.min(areas)) if len(areas) else 0.0,
        "area_max": float(np.max(areas)) if len(areas) else 0.0,
        "radius_mean": float(np.mean(radii)) if len(radii) else 0.0,
        "radius_std": float(np.std(radii, ddof=1)) if len(radii) > 1 else 0.0,
    }
    return stats


def save_outputs(annotated, colonies, stats, output_dir):
    """Save annotated image and print summary."""
    # Annotated image
    img_path = output_dir / "colonies_annotated.png"
    cv2.imwrite(str(img_path), annotated)

    # Size histogram
    if len(colonies) > 0:
        areas = [c["area"] for c in colonies]
        fig, ax = plt.subplots(figsize=(6, 4))
        ax.hist(areas, bins=min(30, max(5, len(areas) // 3)), color="steelblue", edgecolor="white")
        ax.set_xlabel("Colony Area (px²)")
        ax.set_ylabel("Frequency")
        ax.set_title(f"Colony Size Distribution (n={len(colonies)})")
        ax.grid(True, alpha=0.3)
        fig.tight_layout()
        hist_path = output_dir / "colony_size_histogram.png"
        fig.savefig(hist_path, dpi=150)
        plt.close(fig)
    else:
        hist_path = None

    return img_path, hist_path


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description="Count bacterial colonies from agar plate images."
    )
    parser.add_argument(
        "--image",
        required=True,
        help="Path to plate image (JPEG, PNG, TIFF).",
    )
    parser.add_argument(
        "--min-radius",
        type=int,
        default=3,
        help="Minimum colony radius in pixels (default: 3).",
    )
    parser.add_argument(
        "--max-radius",
        type=int,
        default=50,
        help="Maximum colony radius in pixels (default: 50).",
    )
    parser.add_argument(
        "--sensitivity",
        type=float,
        default=0.85,
        help="Threshold sensitivity 0-1, higher retains more foreground (default: 0.85).",
    )
    parser.add_argument(
        "--output-dir",
        default=".",
        help="Directory for output files (default: current directory).",
    )
    args = parser.parse_args()

    image_path = Path(args.image)
    if not image_path.exists():
        print(f"ERROR: Image file not found: {image_path}", file=sys.stderr)
        sys.exit(1)

    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    # Load and process
    print(f"Loading image: {image_path}")
    img, gray = load_image(image_path)
    h, w = gray.shape
    print(f"Image size: {w} x {h} pixels")

    print("Pre-processing (blur + threshold)...")
    blurred = preprocess(gray)
    binary = threshold_image(blurred, sensitivity=args.sensitivity)

    print("Segmenting colonies (watershed)...")
    labels, n_raw = segment_colonies(binary)
    print(f"  Raw regions detected: {n_raw}")

    print(f"Filtering (radius {args.min_radius}-{args.max_radius} px, circularity > 0.5)...")
    colonies, filtered_labels = filter_colonies(
        labels, args.min_radius, args.max_radius
    )

    # Statistics
    stats = size_distribution(colonies)
    count = stats["count"]

    print(f"\n=== Colony Count: {count} ===")
    print(f"  Area  — mean: {stats['area_mean']:.1f}  median: {stats['area_median']:.1f}  "
          f"std: {stats['area_std']:.1f}  range: [{stats['area_min']:.0f}, {stats['area_max']:.0f}] px²")
    print(f"  Radius — mean: {stats['radius_mean']:.1f}  std: {stats['radius_std']:.1f} px")

    # Annotate and save
    annotated = annotate_image(img, colonies)
    img_path, hist_path = save_outputs(annotated, colonies, stats, output_dir)

    print(f"\nAnnotated image:     {img_path}")
    if hist_path:
        print(f"Size histogram:      {hist_path}")
    print(f"Total colonies:      {count}")


if __name__ == "__main__":
    main()
