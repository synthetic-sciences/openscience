#!/usr/bin/env python3
"""Cell tracking from time-lapse microscopy using trackpy.

Detects bright features in each frame of a time-lapse sequence, links them
into trajectories across frames, and computes per-track motility statistics
including displacement, velocity, directionality ratio, and mean squared
displacement (MSD).

Usage:
    python track_cells.py --image-dir frames/ --output-dir results/
    python track_cells.py --image-dir timelapse.tif --pixel-size 0.65 --time-interval 30
    python track_cells.py --image-dir frames/ --diameter 21 --min-track-length 10 --output-dir tracking/

Examples:
    # Track cells from a folder of numbered PNG frames
    python track_cells.py --image-dir ./experiment/frames/ --pixel-size 0.325 --time-interval 60

    # Track from a multi-frame TIFF with larger feature diameter
    python track_cells.py --image-dir timelapse.tif --diameter 25 --min-track-length 8

    # Quick test with relaxed filtering
    python track_cells.py --image-dir frames/ --min-track-length 3 --output-dir test_output/
"""

import argparse
import os
import sys
import warnings
from pathlib import Path

import numpy as np
import pandas as pd

warnings.filterwarnings("ignore", category=DeprecationWarning)
warnings.filterwarnings("ignore", message=".*trackpy.*")


def load_frames(image_source):
    """Load time-lapse frames from a directory of images or a multi-frame TIFF.

    Args:
        image_source: Path to a directory of image files or a single multi-frame TIFF.

    Returns:
        list: List of 2D numpy arrays, one per frame.

    Raises:
        FileNotFoundError: If the source path does not exist.
        ValueError: If no valid frames can be loaded.
    """
    source = Path(image_source)

    if source.is_file():
        # Multi-frame TIFF
        ext = source.suffix.lower()
        if ext in (".tif", ".tiff"):
            try:
                import tifffile
                stack = tifffile.imread(str(source))
            except ImportError:
                from skimage.io import imread
                stack = imread(str(source))

            if stack.ndim == 2:
                frames = [stack]
            elif stack.ndim == 3:
                # Could be (T, Y, X) or (Y, X, C)
                if stack.shape[2] <= 4:
                    # Likely single frame with channels
                    from skimage.color import rgb2gray
                    frames = [rgb2gray(stack)]
                else:
                    frames = [stack[i] for i in range(stack.shape[0])]
            elif stack.ndim == 4:
                # (T, Y, X, C) - convert each frame to gray
                from skimage.color import rgb2gray
                frames = [rgb2gray(stack[i]) for i in range(stack.shape[0])]
            else:
                raise ValueError(f"Unexpected TIFF dimensions: {stack.shape}")

            print(f"Loaded multi-frame TIFF: {source}")
            print(f"  {len(frames)} frames, shape={frames[0].shape}")
            return frames
        else:
            raise ValueError(f"Single file must be TIFF, got: {ext}")

    elif source.is_dir():
        # Directory of image files
        from skimage.io import imread

        valid_extensions = {".tif", ".tiff", ".png", ".jpg", ".jpeg", ".bmp"}
        files = sorted(
            f for f in source.iterdir()
            if f.suffix.lower() in valid_extensions
        )

        if not files:
            raise ValueError(f"No image files found in: {source}")

        frames = []
        for f in files:
            img = imread(str(f))
            if img.ndim == 3:
                from skimage.color import rgb2gray
                img = rgb2gray(img)
            frames.append(img.astype(np.float64))

        print(f"Loaded {len(frames)} frames from: {source}")
        print(f"  Frame shape: {frames[0].shape}")
        return frames

    else:
        raise FileNotFoundError(f"Image source not found: {image_source}")


def detect_features(frames, diameter):
    """Detect bright features in each frame using trackpy.

    Args:
        frames: List of 2D numpy arrays (one per time point).
        diameter: Expected feature diameter in pixels (must be odd integer).

    Returns:
        pandas.DataFrame: Feature positions with columns including 'x', 'y', 'frame'.
    """
    import trackpy as tp

    # Ensure odd diameter
    if diameter % 2 == 0:
        diameter += 1
        print(f"  Adjusted diameter to odd: {diameter}")

    tp.quiet()

    all_features = []
    for i, frame in enumerate(frames):
        # Normalize to float if needed
        f = frame.astype(np.float64)
        if f.max() > 1.0:
            f = f / f.max()

        features = tp.locate(f, diameter, minmass=None)
        features["frame"] = i
        all_features.append(features)

        if (i + 1) % 10 == 0 or i == 0 or i == len(frames) - 1:
            print(f"  Frame {i+1}/{len(frames)}: {len(features)} features detected")

    df = pd.concat(all_features, ignore_index=True)
    print(f"  Total detections: {len(df)}")
    return df


def link_trajectories(features_df, search_range=15, memory=3, min_track_length=5):
    """Link detected features into trajectories across frames.

    Args:
        features_df: DataFrame from detect_features with 'x', 'y', 'frame' columns.
        search_range: Maximum displacement between frames in pixels.
        memory: Number of frames a feature can vanish and reappear.
        min_track_length: Minimum number of frames for a valid track.

    Returns:
        pandas.DataFrame: Linked trajectories with 'particle' column for track ID.
    """
    import trackpy as tp

    tp.quiet()

    print(f"  Linking trajectories (search_range={search_range}, memory={memory})...")
    linked = tp.link_df(features_df, search_range=search_range, memory=memory)

    # Filter short tracks
    linked = tp.filter_stubs(linked, threshold=min_track_length)

    n_tracks = linked["particle"].nunique()
    n_points = len(linked)
    print(f"  Tracks after filtering (min_length={min_track_length}): {n_tracks}")
    print(f"  Total linked points: {n_points}")
    return linked


def compute_track_statistics(tracks_df, pixel_size, time_interval):
    """Compute motility statistics for each tracked particle.

    Calculates displacement, velocity, directionality ratio, and MSD for
    each trajectory.

    Args:
        tracks_df: DataFrame with linked trajectories.
        pixel_size: Micrometers per pixel.
        time_interval: Seconds between frames.

    Returns:
        pandas.DataFrame: Per-track summary statistics.
    """
    results = []

    for particle_id, group in tracks_df.groupby("particle"):
        group = group.sort_values("frame").reset_index(drop=True)
        n_frames = len(group)

        # Positions in physical units (micrometers)
        x = group["x"].values * pixel_size
        y = group["y"].values * pixel_size

        # Step-wise displacements
        dx = np.diff(x)
        dy = np.diff(y)
        step_lengths = np.sqrt(dx**2 + dy**2)
        total_path = np.sum(step_lengths)

        # Net displacement
        net_dx = x[-1] - x[0]
        net_dy = y[-1] - y[0]
        net_displacement = np.sqrt(net_dx**2 + net_dy**2)

        # Directionality ratio (net displacement / total path length)
        directionality = net_displacement / total_path if total_path > 0 else 0.0

        # Velocity (um/sec)
        duration = (n_frames - 1) * time_interval
        velocity = total_path / duration if duration > 0 else 0.0

        # MSD for lag=1
        if len(step_lengths) > 0:
            msd_lag1 = np.mean(step_lengths**2)
        else:
            msd_lag1 = 0.0

        results.append({
            "particle": int(particle_id),
            "n_frames": n_frames,
            "duration_sec": duration,
            "net_displacement_um": net_displacement,
            "total_path_um": total_path,
            "mean_velocity_um_s": velocity,
            "directionality_ratio": directionality,
            "msd_lag1_um2": msd_lag1,
            "start_x_um": x[0],
            "start_y_um": y[0],
        })

    return pd.DataFrame(results)


def plot_trajectories(tracks_df, pixel_size, output_path, frame_shape=None):
    """Plot all trajectories on a single figure.

    Args:
        tracks_df: DataFrame with linked trajectories.
        pixel_size: Micrometers per pixel.
        output_path: File path for the output PNG.
        frame_shape: Optional (height, width) of frames for axis limits.
    """
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    fig, ax = plt.subplots(1, 1, figsize=(8, 8))
    cmap = plt.cm.get_cmap("tab20")

    particles = tracks_df["particle"].unique()
    for i, pid in enumerate(particles):
        subset = tracks_df[tracks_df["particle"] == pid].sort_values("frame")
        x = subset["x"].values * pixel_size
        y = subset["y"].values * pixel_size
        color = cmap(i % 20)
        ax.plot(x, y, "-", color=color, linewidth=1, alpha=0.8)
        ax.plot(x[0], y[0], "o", color=color, markersize=3)

    ax.set_xlabel("X (um)")
    ax.set_ylabel("Y (um)")
    ax.set_title(f"Cell Trajectories (n={len(particles)})")
    ax.set_aspect("equal")

    if frame_shape is not None:
        ax.set_xlim(0, frame_shape[1] * pixel_size)
        ax.set_ylim(frame_shape[0] * pixel_size, 0)  # Invert Y for image coords

    fig.tight_layout()
    fig.savefig(output_path, dpi=150)
    plt.close(fig)
    print(f"  Trajectory plot saved: {output_path}")


def print_summary(stats_df, pixel_size, time_interval):
    """Print tracking summary statistics to stdout.

    Args:
        stats_df: DataFrame of per-track statistics.
        pixel_size: Micrometers per pixel.
        time_interval: Seconds between frames.
    """
    n = len(stats_df)
    print(f"\n{'='*60}")
    print(f"TRACKING SUMMARY")
    print(f"{'='*60}")
    print(f"Pixel size:     {pixel_size} um/px")
    print(f"Time interval:  {time_interval} sec")
    print(f"Total tracks:   {n}")

    if n == 0:
        print("No tracks found.")
        return

    print(f"\nTrack Duration (sec):")
    print(f"  Mean:   {stats_df['duration_sec'].mean():.1f}")
    print(f"  Median: {stats_df['duration_sec'].median():.1f}")
    print(f"  Min:    {stats_df['duration_sec'].min():.1f}")
    print(f"  Max:    {stats_df['duration_sec'].max():.1f}")

    print(f"\nNet Displacement (um):")
    print(f"  Mean:   {stats_df['net_displacement_um'].mean():.2f}")
    print(f"  Median: {stats_df['net_displacement_um'].median():.2f}")
    print(f"  Std:    {stats_df['net_displacement_um'].std():.2f}")

    print(f"\nMean Velocity (um/s):")
    print(f"  Mean:   {stats_df['mean_velocity_um_s'].mean():.4f}")
    print(f"  Median: {stats_df['mean_velocity_um_s'].median():.4f}")
    print(f"  Std:    {stats_df['mean_velocity_um_s'].std():.4f}")

    print(f"\nDirectionality Ratio:")
    print(f"  Mean:   {stats_df['directionality_ratio'].mean():.3f}")
    print(f"  Std:    {stats_df['directionality_ratio'].std():.3f}")

    print(f"\nMSD at lag=1 (um^2):")
    print(f"  Mean:   {stats_df['msd_lag1_um2'].mean():.4f}")
    print(f"  Std:    {stats_df['msd_lag1_um2'].std():.4f}")
    print(f"{'='*60}")


def main():
    parser = argparse.ArgumentParser(
        description="Cell tracking from time-lapse microscopy using trackpy.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "--image-dir",
        required=True,
        help="Path to directory of frame images or a multi-frame TIFF file.",
    )
    parser.add_argument(
        "--pixel-size",
        type=float,
        default=1.0,
        help="Pixel size in micrometers per pixel (default: 1.0).",
    )
    parser.add_argument(
        "--time-interval",
        type=float,
        default=1.0,
        help="Time interval between frames in seconds (default: 1.0).",
    )
    parser.add_argument(
        "--diameter",
        type=int,
        default=15,
        help="Expected feature diameter in pixels for trackpy.locate (default: 15). Must be odd.",
    )
    parser.add_argument(
        "--min-track-length",
        type=int,
        default=5,
        help="Minimum number of frames for a valid track (default: 5).",
    )
    parser.add_argument(
        "--search-range",
        type=int,
        default=15,
        help="Maximum linking distance between frames in pixels (default: 15).",
    )
    parser.add_argument(
        "--memory",
        type=int,
        default=3,
        help="Number of frames a particle can disappear and reappear (default: 3).",
    )
    parser.add_argument(
        "--output-dir",
        default="./tracking_output",
        help="Directory for output files (default: ./tracking_output).",
    )
    args = parser.parse_args()

    # Load frames
    frames = load_frames(args.image_dir)
    if not frames:
        print("ERROR: No frames loaded.", file=sys.stderr)
        sys.exit(1)

    # Detect features
    print(f"\nDetecting features (diameter={args.diameter})...")
    features_df = detect_features(frames, args.diameter)

    if features_df.empty:
        print("No features detected in any frame.")
        sys.exit(0)

    # Link trajectories
    print(f"\nLinking trajectories...")
    tracks_df = link_trajectories(
        features_df,
        search_range=args.search_range,
        memory=args.memory,
        min_track_length=args.min_track_length,
    )

    if tracks_df.empty or tracks_df["particle"].nunique() == 0:
        print("No tracks survived filtering.")
        sys.exit(0)

    # Compute statistics
    print(f"\nComputing per-track statistics...")
    stats_df = compute_track_statistics(tracks_df, args.pixel_size, args.time_interval)

    # Save outputs
    os.makedirs(args.output_dir, exist_ok=True)
    source_name = Path(args.image_dir).stem

    traj_csv = os.path.join(args.output_dir, f"{source_name}_trajectories.csv")
    tracks_df.to_csv(traj_csv, index=False)
    print(f"  Trajectories saved: {traj_csv}")

    summary_csv = os.path.join(args.output_dir, f"{source_name}_track_summary.csv")
    stats_df.to_csv(summary_csv, index=False)
    print(f"  Track summary saved: {summary_csv}")

    plot_path = os.path.join(args.output_dir, f"{source_name}_trajectories.png")
    plot_trajectories(tracks_df, args.pixel_size, plot_path, frame_shape=frames[0].shape)

    # Print summary
    print_summary(stats_df, args.pixel_size, args.time_interval)


if __name__ == "__main__":
    main()
