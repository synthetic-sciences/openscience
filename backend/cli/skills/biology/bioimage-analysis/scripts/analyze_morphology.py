#!/usr/bin/env python3
"""Cell and fiber morphology quantification from segmented or raw images.

Measures shape descriptors for objects in microscopy images. Accepts either a
pre-segmented label mask or a raw image (which is thresholded and labeled
automatically). Reports area, perimeter, eccentricity, solidity, axis lengths,
orientation, and circularity for every detected object.

Usage:
    python analyze_morphology.py --image cells.tif --output-dir results/
    python analyze_morphology.py --image raw.png --threshold-method adaptive --min-size 200
    python analyze_morphology.py --image cells.tif --mask segmented_mask.tif --output-dir morph/

Examples:
    # Analyze morphology from a raw image with Otsu thresholding
    python analyze_morphology.py --image phase_contrast.tif --threshold-method otsu

    # Use a pre-computed segmentation mask
    python analyze_morphology.py --image fluorescence.tif --mask cellpose_masks.tif

    # Adaptive threshold for uneven illumination, filter small debris
    python analyze_morphology.py --image brightfield.png --threshold-method adaptive --min-size 500
"""

import argparse
import math
import os
import sys
import warnings
from pathlib import Path

import numpy as np
import pandas as pd

warnings.filterwarnings("ignore", category=DeprecationWarning)


def load_image(image_path):
    """Load a microscopy image from file.

    Args:
        image_path: Path to the image file.

    Returns:
        numpy.ndarray: The loaded image.

    Raises:
        FileNotFoundError: If the file does not exist.
        RuntimeError: If the image cannot be read.
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
        raise RuntimeError(f"Failed to load image: {image_path}")

    print(f"Loaded image: {image_path}")
    print(f"  Shape: {img.shape}, dtype: {img.dtype}")
    return img


def load_mask(mask_path):
    """Load a pre-segmented integer label mask.

    Args:
        mask_path: Path to the mask image file.

    Returns:
        numpy.ndarray: 2D integer-labeled mask.

    Raises:
        FileNotFoundError: If the file does not exist.
    """
    if not os.path.isfile(mask_path):
        raise FileNotFoundError(f"Mask not found: {mask_path}")

    ext = Path(mask_path).suffix.lower()
    if ext in (".tif", ".tiff"):
        try:
            import tifffile
            mask = tifffile.imread(mask_path)
        except ImportError:
            from skimage.io import imread
            mask = imread(mask_path)
    else:
        from skimage.io import imread
        mask = imread(mask_path)

    if mask.ndim > 2:
        mask = mask[:, :, 0]

    mask = mask.astype(np.int32)
    n_labels = len(np.unique(mask)) - 1  # exclude background
    print(f"Loaded mask: {mask_path}")
    print(f"  Shape: {mask.shape}, labels: {n_labels}")
    return mask


def segment_image(image, threshold_method, min_size):
    """Segment a raw image into labeled objects using thresholding.

    Converts to grayscale, applies the specified threshold method, removes
    small objects, and labels connected components.

    Args:
        image: Input image (2D or 3D).
        threshold_method: 'otsu' for global Otsu, 'adaptive' for local adaptive.
        min_size: Minimum object area in pixels to retain.

    Returns:
        numpy.ndarray: 2D integer-labeled mask.
    """
    from skimage import filters, morphology, measure
    from skimage.color import rgb2gray

    # Convert to grayscale
    if image.ndim == 3:
        gray = rgb2gray(image)
    else:
        gray = image.astype(np.float64)
        if gray.max() > 1.0:
            gray = gray / gray.max()

    # Threshold
    if threshold_method == "otsu":
        thresh_val = filters.threshold_otsu(gray)
        binary = gray > thresh_val
        print(f"  Otsu threshold: {thresh_val:.4f}")
    elif threshold_method == "adaptive":
        block_size = max(35, int(min(gray.shape) * 0.05) | 1)  # Ensure odd
        if block_size % 2 == 0:
            block_size += 1
        thresh_val = filters.threshold_local(gray, block_size, offset=0.01)
        binary = gray > thresh_val
        print(f"  Adaptive threshold (block_size={block_size})")
    else:
        raise ValueError(f"Unknown threshold method: {threshold_method}")

    # Clean up
    binary = morphology.remove_small_objects(binary, min_size=min_size)
    binary = morphology.remove_small_holes(binary, area_threshold=min_size // 2)

    # Label connected components
    labels = measure.label(binary)
    n_objects = labels.max()
    print(f"  Segmented objects: {n_objects} (min_size={min_size})")
    return labels


def measure_morphology(labels, image=None):
    """Extract morphological measurements for each labeled object.

    Computes standard shape descriptors and derived circularity metric.

    Args:
        labels: Integer-labeled 2D mask.
        image: Optional intensity image for mean_intensity measurement.

    Returns:
        pandas.DataFrame: Table with one row per object and shape columns.
    """
    from skimage.measure import regionprops_table

    properties = [
        "label",
        "area",
        "perimeter",
        "eccentricity",
        "solidity",
        "major_axis_length",
        "minor_axis_length",
        "orientation",
        "centroid",
        "equivalent_diameter",
    ]

    # Prepare intensity image if available
    intensity = None
    if image is not None:
        if image.ndim == 3:
            from skimage.color import rgb2gray
            intensity = rgb2gray(image)
        else:
            intensity = image.astype(np.float64)
        properties.append("mean_intensity")

    props = regionprops_table(
        labels,
        intensity_image=intensity,
        properties=properties,
    )

    df = pd.DataFrame(props)
    df.rename(
        columns={"centroid-0": "centroid_y", "centroid-1": "centroid_x"},
        inplace=True,
    )

    # Calculate circularity: 4 * pi * area / perimeter^2
    # Perfect circle = 1.0, increasingly irregular shapes < 1.0
    df["circularity"] = df.apply(
        lambda row: (4.0 * math.pi * row["area"]) / (row["perimeter"] ** 2)
        if row["perimeter"] > 0
        else 0.0,
        axis=1,
    )

    # Convert orientation from radians to degrees for readability
    df["orientation_deg"] = np.degrees(df["orientation"])

    # Aspect ratio (major / minor axis)
    df["aspect_ratio"] = df.apply(
        lambda row: row["major_axis_length"] / row["minor_axis_length"]
        if row["minor_axis_length"] > 0
        else float("inf"),
        axis=1,
    )

    return df


def save_labeled_image(labels, output_dir, image_name):
    """Save the labeled image as a colored PNG for visualization.

    Args:
        labels: Integer-labeled mask.
        output_dir: Output directory path.
        image_name: Base filename.

    Returns:
        str: Path to the saved image.
    """
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from skimage.color import label2rgb

    rgb_labels = label2rgb(labels, bg_label=0)

    fig, ax = plt.subplots(1, 1, figsize=(10, 10))
    ax.imshow(rgb_labels)
    ax.set_title(f"Labeled Objects (n={labels.max()})")
    ax.axis("off")
    fig.tight_layout()

    out_path = os.path.join(output_dir, f"{image_name}_labeled.png")
    fig.savefig(out_path, dpi=150)
    plt.close(fig)
    return out_path


def print_summary(morph_df):
    """Print morphology summary statistics to stdout.

    Args:
        morph_df: DataFrame of morphological measurements.
    """
    n = len(morph_df)
    print(f"\n{'='*60}")
    print(f"MORPHOLOGY SUMMARY")
    print(f"{'='*60}")
    print(f"Total objects: {n}")

    if n == 0:
        print("No objects to summarize.")
        return

    metrics = [
        ("Area (px)", "area"),
        ("Perimeter (px)", "perimeter"),
        ("Circularity", "circularity"),
        ("Eccentricity", "eccentricity"),
        ("Solidity", "solidity"),
        ("Major Axis (px)", "major_axis_length"),
        ("Minor Axis (px)", "minor_axis_length"),
        ("Aspect Ratio", "aspect_ratio"),
        ("Eq. Diameter (px)", "equivalent_diameter"),
    ]

    if "mean_intensity" in morph_df.columns:
        metrics.append(("Mean Intensity", "mean_intensity"))

    for label, col in metrics:
        values = morph_df[col]
        # Skip inf values for aspect ratio stats
        finite_values = values.replace([np.inf, -np.inf], np.nan).dropna()
        if len(finite_values) == 0:
            continue
        print(f"\n{label}:")
        print(f"  Mean:   {finite_values.mean():.3f}")
        print(f"  Median: {finite_values.median():.3f}")
        print(f"  Std:    {finite_values.std():.3f}")
        print(f"  Min:    {finite_values.min():.3f}")
        print(f"  Max:    {finite_values.max():.3f}")

    # Shape classification summary
    if "circularity" in morph_df.columns:
        round_cells = (morph_df["circularity"] > 0.8).sum()
        elongated = (morph_df["circularity"] < 0.5).sum()
        intermediate = n - round_cells - elongated
        print(f"\nShape Classification:")
        print(f"  Round (circ > 0.8):        {round_cells} ({100*round_cells/n:.1f}%)")
        print(f"  Intermediate (0.5-0.8):    {intermediate} ({100*intermediate/n:.1f}%)")
        print(f"  Elongated (circ < 0.5):    {elongated} ({100*elongated/n:.1f}%)")

    print(f"{'='*60}")


def main():
    parser = argparse.ArgumentParser(
        description="Cell/fiber morphology quantification from microscopy images.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "--image", required=True, help="Path to input microscopy image."
    )
    parser.add_argument(
        "--mask",
        default=None,
        help="Path to pre-segmented label mask (optional). If not provided, the image is thresholded.",
    )
    parser.add_argument(
        "--threshold-method",
        choices=["otsu", "adaptive"],
        default="otsu",
        help="Thresholding method when no mask is provided (default: otsu).",
    )
    parser.add_argument(
        "--min-size",
        type=int,
        default=100,
        help="Minimum object area in pixels to retain (default: 100).",
    )
    parser.add_argument(
        "--output-dir",
        default="./morphology_output",
        help="Directory for output files (default: ./morphology_output).",
    )
    args = parser.parse_args()

    # Load input image
    image = load_image(args.image)

    # Get segmentation mask
    if args.mask:
        print(f"\nUsing pre-segmented mask: {args.mask}")
        labels = load_mask(args.mask)
    else:
        print(f"\nSegmenting image (method={args.threshold_method}, min_size={args.min_size})...")
        labels = segment_image(image, args.threshold_method, args.min_size)

    if labels.max() == 0:
        print("No objects detected in image.")
        sys.exit(0)

    # Measure morphology
    print(f"\nMeasuring morphology for {labels.max()} objects...")
    morph_df = measure_morphology(labels, image=image)

    # Save results
    os.makedirs(args.output_dir, exist_ok=True)
    image_name = Path(args.image).stem

    csv_path = os.path.join(args.output_dir, f"{image_name}_morphology.csv")
    morph_df.to_csv(csv_path, index=False)
    print(f"  Measurements saved: {csv_path}")

    labeled_path = save_labeled_image(labels, args.output_dir, image_name)
    print(f"  Labeled image saved: {labeled_path}")

    # Print summary
    print_summary(morph_df)


if __name__ == "__main__":
    main()
