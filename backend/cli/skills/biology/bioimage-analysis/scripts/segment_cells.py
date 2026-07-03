#!/usr/bin/env python3
"""Cell segmentation using Cellpose deep learning models with watershed fallback.

Segments cells or nuclei from microscopy images using the Cellpose library
(cyto2, nuclei, or cyto models). Falls back to classical watershed segmentation
if Cellpose is unavailable. Extracts morphological properties for each detected
object and exports masks and measurements.

Usage:
    python segment_cells.py --image input.tif --model-type cyto2 --output-dir results/
    python segment_cells.py --image dapi.png --model-type nuclei --diameter 40
    python segment_cells.py --image phase.tif --model-type cyto --channels 0 0 --output-dir seg/

Examples:
    # Segment nuclei with automatic diameter estimation
    python segment_cells.py --image nuclei_dapi.tif --model-type nuclei --diameter auto

    # Segment cytoplasm with specified diameter
    python segment_cells.py --image cells.tif --model-type cyto2 --diameter 60 --output-dir output/

    # Use specific channel configuration (green cytoplasm, blue nuclei)
    python segment_cells.py --image fluorescence.tif --model-type cyto2 --channels 2 3
"""

import argparse
import os
import sys
import warnings
from pathlib import Path

import numpy as np
import pandas as pd

warnings.filterwarnings("ignore", category=DeprecationWarning)


def load_image(image_path):
    """Load a microscopy image from file.

    Supports TIFF (via tifffile), PNG, JPEG, and other formats via skimage.

    Args:
        image_path: Path to the image file.

    Returns:
        numpy.ndarray: The loaded image.

    Raises:
        FileNotFoundError: If the image file does not exist.
        RuntimeError: If the image cannot be loaded.
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
        raise RuntimeError(f"Failed to load image or image is empty: {image_path}")

    print(f"Loaded image: {image_path}")
    print(f"  Shape: {img.shape}, dtype: {img.dtype}")
    return img


def segment_cellpose(image, model_type, diameter, channels):
    """Segment cells using a Cellpose deep learning model.

    Args:
        image: Input image as numpy array (2D or 3D).
        model_type: Cellpose model name ('cyto2', 'nuclei', 'cyto').
        diameter: Expected cell diameter in pixels, or None for auto.
        channels: List of two ints specifying [cytoplasm_channel, nucleus_channel].

    Returns:
        numpy.ndarray: Integer-labeled mask where each cell has a unique ID.
    """
    from cellpose import models

    model = models.Cellpose(model_type=model_type, gpu=False)
    print(f"Running Cellpose model '{model_type}' (diameter={diameter}, channels={channels})...")

    masks, flows, styles, diams = model.eval(
        image,
        diameter=diameter,
        channels=channels,
        flow_threshold=0.4,
        cellprob_threshold=0.0,
    )

    n_cells = len(np.unique(masks)) - 1  # exclude background (0)
    print(f"  Cellpose detected {n_cells} objects (estimated diameter: {diams:.1f} px)")
    return masks


def segment_watershed(image):
    """Segment cells using classical watershed as a fallback method.

    Applies Otsu thresholding, distance transform, and marker-controlled
    watershed segmentation.

    Args:
        image: Input image as numpy array (2D grayscale or 3D color).

    Returns:
        numpy.ndarray: Integer-labeled mask where each cell has a unique ID.
    """
    from skimage import filters, morphology, segmentation, measure
    from skimage.color import rgb2gray
    from scipy import ndimage as ndi

    print("Cellpose not available. Using watershed fallback...")

    if image.ndim == 3:
        gray = rgb2gray(image)
    else:
        gray = image.astype(np.float64)
        if gray.max() > 1.0:
            gray = gray / gray.max()

    thresh = filters.threshold_otsu(gray)
    binary = gray > thresh

    # Clean up binary mask
    binary = morphology.remove_small_objects(binary, min_size=64)
    binary = morphology.remove_small_holes(binary, area_threshold=64)

    distance = ndi.distance_transform_edt(binary)
    local_max_coords = morphology.local_maxima(distance)
    markers = measure.label(local_max_coords)
    labels = segmentation.watershed(-distance, markers, mask=binary)

    n_cells = len(np.unique(labels)) - 1
    print(f"  Watershed detected {n_cells} objects")
    return labels


def extract_properties(masks, image):
    """Extract morphological properties for each segmented object.

    Args:
        masks: Integer-labeled segmentation mask.
        image: Original image for intensity measurements.

    Returns:
        pandas.DataFrame: Table of per-object measurements including area,
            eccentricity, mean_intensity, perimeter, and solidity.
    """
    from skimage.measure import regionprops_table

    # Prepare intensity image (grayscale)
    if image.ndim == 3:
        from skimage.color import rgb2gray
        intensity_image = rgb2gray(image)
    else:
        intensity_image = image.astype(np.float64)

    props = regionprops_table(
        masks,
        intensity_image=intensity_image,
        properties=(
            "label",
            "area",
            "eccentricity",
            "mean_intensity",
            "perimeter",
            "solidity",
            "centroid",
        ),
    )
    df = pd.DataFrame(props)
    df.rename(columns={"centroid-0": "centroid_y", "centroid-1": "centroid_x"}, inplace=True)
    return df


def save_results(masks, props_df, output_dir, image_name):
    """Save segmentation masks and property measurements to disk.

    Args:
        masks: Integer-labeled segmentation mask.
        props_df: DataFrame of object measurements.
        output_dir: Directory to write output files.
        image_name: Base name for output files (without extension).
    """
    os.makedirs(output_dir, exist_ok=True)

    mask_path = os.path.join(output_dir, f"{image_name}_masks.tif")
    try:
        import tifffile
        tifffile.imwrite(mask_path, masks.astype(np.int32))
    except ImportError:
        from skimage.io import imsave
        imsave(mask_path, masks.astype(np.int32), check_contrast=False)
    print(f"  Masks saved: {mask_path}")

    csv_path = os.path.join(output_dir, f"{image_name}_properties.csv")
    props_df.to_csv(csv_path, index=False)
    print(f"  Properties saved: {csv_path}")


def print_summary(props_df):
    """Print summary statistics of segmentation results to stdout.

    Args:
        props_df: DataFrame of object measurements.
    """
    n = len(props_df)
    print(f"\n{'='*60}")
    print(f"SEGMENTATION SUMMARY")
    print(f"{'='*60}")
    print(f"Total objects detected: {n}")

    if n == 0:
        print("No objects found.")
        return

    print(f"\nArea (px):")
    print(f"  Mean:   {props_df['area'].mean():.1f}")
    print(f"  Median: {props_df['area'].median():.1f}")
    print(f"  Std:    {props_df['area'].std():.1f}")
    print(f"  Min:    {props_df['area'].min():.1f}")
    print(f"  Max:    {props_df['area'].max():.1f}")

    print(f"\nEccentricity:")
    print(f"  Mean:   {props_df['eccentricity'].mean():.3f}")
    print(f"  Std:    {props_df['eccentricity'].std():.3f}")

    print(f"\nMean Intensity:")
    print(f"  Mean:   {props_df['mean_intensity'].mean():.4f}")
    print(f"  Std:    {props_df['mean_intensity'].std():.4f}")

    print(f"\nPerimeter (px):")
    print(f"  Mean:   {props_df['perimeter'].mean():.1f}")
    print(f"  Std:    {props_df['perimeter'].std():.1f}")

    print(f"\nSolidity:")
    print(f"  Mean:   {props_df['solidity'].mean():.3f}")
    print(f"  Std:    {props_df['solidity'].std():.3f}")
    print(f"{'='*60}")


def main():
    parser = argparse.ArgumentParser(
        description="Cell segmentation using Cellpose or watershed fallback.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "--image", required=True, help="Path to input microscopy image."
    )
    parser.add_argument(
        "--model-type",
        choices=["cyto2", "nuclei", "cyto"],
        default="cyto2",
        help="Cellpose model type (default: cyto2).",
    )
    parser.add_argument(
        "--diameter",
        default="auto",
        help="Expected cell diameter in pixels, or 'auto' for estimation (default: auto).",
    )
    parser.add_argument(
        "--channels",
        nargs=2,
        type=int,
        default=[0, 0],
        metavar=("CYTO", "NUC"),
        help="Channel indices [cytoplasm nucleus]. 0=grayscale, 1=R, 2=G, 3=B (default: 0 0).",
    )
    parser.add_argument(
        "--output-dir",
        default="./segmentation_output",
        help="Directory for output files (default: ./segmentation_output).",
    )
    args = parser.parse_args()

    # Parse diameter
    diameter = None if args.diameter.lower() == "auto" else int(args.diameter)

    # Load image
    image = load_image(args.image)

    # Segment
    try:
        masks = segment_cellpose(image, args.model_type, diameter, args.channels)
    except ImportError:
        masks = segment_watershed(image)
    except Exception as e:
        print(f"Cellpose failed ({e}), falling back to watershed.", file=sys.stderr)
        masks = segment_watershed(image)

    # Extract properties
    if masks.max() == 0:
        print("No objects detected in the image.")
        sys.exit(0)

    props_df = extract_properties(masks, image)

    # Save and report
    image_name = Path(args.image).stem
    save_results(masks, props_df, args.output_dir, image_name)
    print_summary(props_df)


if __name__ == "__main__":
    main()
