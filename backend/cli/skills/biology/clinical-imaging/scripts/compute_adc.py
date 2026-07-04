#!/usr/bin/env python3
"""
Compute Apparent Diffusion Coefficient (ADC) Map from Multi-b-value Diffusion MRI

Fits a monoexponential decay model S(b) = S0 * exp(-b * ADC) to each voxel
across multiple b-value volumes. Produces a quantitative ADC map in mm^2/s
suitable for clinical assessment of tissue cellularity, stroke evaluation,
and tumor characterization.

Usage:
    python compute_adc.py --dwi diffusion.nii.gz --bvalues "0,500,1000" --output adc_map.nii.gz
    python compute_adc.py --dwi diffusion.nii.gz --bvalues "0,200,400,800" --mask brain_mask.nii.gz --output adc.nii.gz

Examples:
    # Basic ADC from 3-shell DWI
    python compute_adc.py --dwi sub01_dwi.nii.gz --bvalues "0,500,1000" --output sub01_adc.nii.gz

    # Masked ADC with 4 b-values
    python compute_adc.py --dwi sub01_dwi.nii.gz --bvalues "0,200,600,1000" \\
        --mask sub01_brain_mask.nii.gz --output sub01_adc.nii.gz

Dependencies: nibabel, numpy, scipy
"""

import argparse
import sys
import warnings
from pathlib import Path

import nibabel as nib
import numpy as np
from scipy.optimize import curve_fit


# Physiological ADC bounds in mm^2/s
ADC_MIN = 0.0
ADC_MAX = 0.005


def monoexponential(b, s0, adc):
    """Monoexponential diffusion decay model: S(b) = S0 * exp(-b * ADC)."""
    return s0 * np.exp(-b * adc)


def load_dwi(dwi_path):
    """
    Load diffusion-weighted NIfTI image.

    Args:
        dwi_path: Path to 4D NIfTI DWI file.

    Returns:
        Tuple of (4D numpy array, NIfTI image object).

    Raises:
        FileNotFoundError: If file does not exist.
        ValueError: If image is not 4D.
    """
    path = Path(dwi_path)
    if not path.exists():
        raise FileNotFoundError(f"DWI file not found: {dwi_path}")

    img = nib.load(str(path))
    data = np.asarray(img.dataobj, dtype=np.float64)

    if data.ndim != 4:
        raise ValueError(
            f"Expected 4D DWI image, got {data.ndim}D with shape {data.shape}"
        )

    return data, img


def load_mask(mask_path):
    """
    Load binary brain mask NIfTI image.

    Args:
        mask_path: Path to 3D NIfTI mask file.

    Returns:
        3D boolean numpy array.

    Raises:
        FileNotFoundError: If file does not exist.
        ValueError: If image is not 3D.
    """
    path = Path(mask_path)
    if not path.exists():
        raise FileNotFoundError(f"Mask file not found: {mask_path}")

    img = nib.load(str(path))
    data = np.asarray(img.dataobj)

    if data.ndim != 3:
        raise ValueError(
            f"Expected 3D mask image, got {data.ndim}D with shape {data.shape}"
        )

    return data.astype(bool)


def parse_bvalues(bvalues_str):
    """
    Parse comma-separated b-value string into sorted numpy array.

    Args:
        bvalues_str: Comma-separated b-values, e.g. "0,500,1000".

    Returns:
        1D numpy array of b-values in s/mm^2.

    Raises:
        ValueError: If fewer than 2 b-values or any are negative.
    """
    try:
        bvals = np.array([float(b.strip()) for b in bvalues_str.split(",")])
    except ValueError:
        raise ValueError(f"Cannot parse b-values: '{bvalues_str}'. Use comma-separated numbers.")

    if len(bvals) < 2:
        raise ValueError("At least 2 b-values required for ADC fitting.")

    if np.any(bvals < 0):
        raise ValueError("B-values must be non-negative.")

    return bvals


def fit_adc_voxel(signal, bvals):
    """
    Fit monoexponential model to a single voxel signal across b-values.

    Args:
        signal: 1D array of signal intensities at each b-value.
        bvals: 1D array of b-values in s/mm^2.

    Returns:
        Fitted ADC value in mm^2/s, or NaN if fitting fails.
    """
    if np.any(signal <= 0) or np.all(signal == signal[0]):
        return np.nan

    s0_init = signal[0] if signal[0] > 0 else np.max(signal)
    adc_init = 0.001  # typical tissue ADC

    try:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            popt, _ = curve_fit(
                monoexponential,
                bvals,
                signal,
                p0=[s0_init, adc_init],
                bounds=([0, ADC_MIN], [np.inf, ADC_MAX * 2]),
                maxfev=1000,
            )
        return popt[1]
    except (RuntimeError, ValueError):
        return np.nan


def compute_adc_map(data, bvals, mask=None):
    """
    Compute ADC map by fitting monoexponential model to each voxel.

    Args:
        data: 4D numpy array (x, y, z, b-values).
        bvals: 1D numpy array of b-values in s/mm^2.
        mask: Optional 3D boolean array. Only voxels where mask is True are fitted.

    Returns:
        3D numpy array of ADC values in mm^2/s.
    """
    nx, ny, nz, nb = data.shape

    if nb != len(bvals):
        raise ValueError(
            f"Number of DWI volumes ({nb}) does not match number of b-values ({len(bvals)})"
        )

    adc_map = np.full((nx, ny, nz), np.nan, dtype=np.float64)

    if mask is None:
        mask = np.ones((nx, ny, nz), dtype=bool)

    voxel_indices = np.argwhere(mask)
    total = len(voxel_indices)

    print(f"Fitting {total} voxels with {nb} b-values: {bvals.tolist()}")

    progress_step = max(total // 10, 1)
    fitted_count = 0

    for idx, (i, j, k) in enumerate(voxel_indices):
        signal = data[i, j, k, :]
        adc_val = fit_adc_voxel(signal, bvals)

        if not np.isnan(adc_val):
            adc_map[i, j, k] = np.clip(adc_val, ADC_MIN, ADC_MAX)
            fitted_count += 1

        if (idx + 1) % progress_step == 0:
            pct = 100.0 * (idx + 1) / total
            print(f"  Progress: {pct:.0f}% ({idx + 1}/{total} voxels)")

    print(f"Successfully fitted {fitted_count}/{total} voxels ({100*fitted_count/max(total,1):.1f}%)")
    return adc_map


def save_nifti(data, reference_img, output_path):
    """
    Save 3D array as NIfTI using reference image for header and affine.

    Args:
        data: 3D numpy array.
        reference_img: NIfTI image to copy affine and header from.
        output_path: Path for output NIfTI file.
    """
    output_path = Path(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    header = reference_img.header.copy()
    header.set_data_dtype(np.float64)

    out_img = nib.Nifti1Image(data, reference_img.affine, header)
    nib.save(out_img, str(output_path))


def print_adc_statistics(adc_map, mask=None):
    """
    Print summary statistics of the ADC map.

    Args:
        adc_map: 3D numpy array of ADC values.
        mask: Optional boolean mask for region of interest.
    """
    if mask is not None:
        values = adc_map[mask & ~np.isnan(adc_map)]
    else:
        values = adc_map[~np.isnan(adc_map)]

    if len(values) == 0:
        print("WARNING: No valid ADC values computed.")
        return

    print("\n=== ADC Map Statistics ===")
    print(f"  Voxel count:  {len(values)}")
    print(f"  Mean ADC:     {np.mean(values):.6f} mm^2/s")
    print(f"  Median ADC:   {np.median(values):.6f} mm^2/s")
    print(f"  Std ADC:      {np.std(values):.6f} mm^2/s")
    print(f"  Min ADC:      {np.min(values):.6f} mm^2/s")
    print(f"  Max ADC:      {np.max(values):.6f} mm^2/s")
    print(f"  ADC range:    [{ADC_MIN}, {ADC_MAX}] mm^2/s (clipped)")


def main():
    parser = argparse.ArgumentParser(
        description="Compute ADC map from multi-b-value diffusion MRI.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python compute_adc.py --dwi dwi.nii.gz --bvalues "0,500,1000" --output adc.nii.gz
  python compute_adc.py --dwi dwi.nii.gz --bvalues "0,200,400,800" --mask mask.nii.gz --output adc.nii.gz
        """,
    )
    parser.add_argument(
        "--dwi", required=True, help="Path to 4D NIfTI DWI file."
    )
    parser.add_argument(
        "--bvalues",
        required=True,
        help='Comma-separated b-values in s/mm^2 (e.g. "0,500,1000").',
    )
    parser.add_argument(
        "--mask",
        default=None,
        help="Optional path to 3D NIfTI brain mask.",
    )
    parser.add_argument(
        "--output", required=True, help="Output path for ADC NIfTI map."
    )

    args = parser.parse_args()

    # Parse b-values
    bvals = parse_bvalues(args.bvalues)
    print(f"B-values: {bvals.tolist()} s/mm^2")

    # Load DWI
    print(f"Loading DWI: {args.dwi}")
    data, dwi_img = load_dwi(args.dwi)
    print(f"  Shape: {data.shape}")
    print(f"  Voxel size: {dwi_img.header.get_zooms()[:3]}")

    # Validate volume count
    if data.shape[3] != len(bvals):
        print(
            f"ERROR: DWI has {data.shape[3]} volumes but {len(bvals)} b-values provided.",
            file=sys.stderr,
        )
        sys.exit(1)

    # Load mask if provided
    mask = None
    if args.mask:
        print(f"Loading mask: {args.mask}")
        mask = load_mask(args.mask)
        if mask.shape != data.shape[:3]:
            print(
                f"ERROR: Mask shape {mask.shape} does not match DWI spatial dims {data.shape[:3]}.",
                file=sys.stderr,
            )
            sys.exit(1)
        print(f"  Mask voxels: {np.sum(mask)}")

    # Compute ADC
    adc_map = compute_adc_map(data, bvals, mask)

    # Save output
    save_nifti(adc_map, dwi_img, args.output)
    print(f"\nADC map saved: {args.output}")

    # Print statistics
    print_adc_statistics(adc_map, mask)


if __name__ == "__main__":
    main()
