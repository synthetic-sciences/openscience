#!/usr/bin/env python3
"""Immune cell tracking from time-lapse microscopy under flow conditions.

Segments cells from time-lapse image sequences using adaptive thresholding
and connected components, then builds trajectories using trackpy. Computes
per-track kinematics (velocity, displacement, confinement ratio) and classifies
cell behavior into arrest, rolling, crawling, and diapedesis categories.

Usage:
    python track_immune_cells.py --image-dir frames/ --pixel-size 0.65 \\
        --time-interval 5 --output-dir tracking/

Examples:
    # Track leukocytes under flow (x-direction flow)
    python track_immune_cells.py --image-dir timelapse/ --pixel-size 0.325 \\
        --time-interval 10 --flow-direction x --output-dir results

    # Y-direction flow with larger pixel size
    python track_immune_cells.py --image-dir frames/ --pixel-size 1.0 \\
        --time-interval 5 --flow-direction y --output-dir tracking_output

    # Image directory should contain sequentially named frames (TIFF, PNG, etc.)
"""

import argparse
import glob
import os
import sys

import numpy as np
import pandas as pd


def load_frames(image_dir):
    """Load image frames from a directory in sorted order.

    Supports TIFF, PNG, JPEG, BMP formats. Converts to grayscale if needed.

    Parameters
    ----------
    image_dir : str
        Path to directory containing sequential image frames.

    Returns
    -------
    list of np.ndarray
        List of 2D grayscale images (uint8).

    Raises
    ------
    FileNotFoundError
        If directory does not exist or contains no images.
    """
    import cv2

    if not os.path.isdir(image_dir):
        raise FileNotFoundError(f"Image directory not found: {image_dir}")

    extensions = ["*.tif", "*.tiff", "*.png", "*.jpg", "*.jpeg", "*.bmp"]
    files = []
    for ext in extensions:
        files.extend(glob.glob(os.path.join(image_dir, ext)))
        files.extend(glob.glob(os.path.join(image_dir, ext.upper())))

    files = sorted(set(files))

    if not files:
        raise FileNotFoundError(f"No image files found in {image_dir}")

    frames = []
    for fpath in files:
        img = cv2.imread(fpath, cv2.IMREAD_UNCHANGED)
        if img is None:
            print(f"WARNING: Could not read {fpath}, skipping.")
            continue

        if img.ndim == 3:
            img = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)

        if img.dtype != np.uint8:
            if img.max() > 0:
                img = ((img.astype(float) / img.max()) * 255).astype(np.uint8)
            else:
                img = img.astype(np.uint8)

        frames.append(img)

    if not frames:
        raise FileNotFoundError(f"No valid image frames loaded from {image_dir}")

    return frames


def segment_cells(frame, min_area=50, max_area=5000):
    """Segment cells from a single frame using adaptive thresholding.

    Parameters
    ----------
    frame : np.ndarray
        2D grayscale image (uint8).
    min_area : int
        Minimum cell area in pixels.
    max_area : int
        Maximum cell area in pixels.

    Returns
    -------
    list of dict
        Each dict has keys: 'x', 'y', 'area', 'intensity'.
    """
    import cv2

    blurred = cv2.GaussianBlur(frame, (5, 5), 1.0)

    thresh = cv2.adaptiveThreshold(
        blurred, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY_INV, 51, 10
    )

    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
    thresh = cv2.morphologyEx(thresh, cv2.MORPH_OPEN, kernel, iterations=1)
    thresh = cv2.morphologyEx(thresh, cv2.MORPH_CLOSE, kernel, iterations=1)

    n_labels, labels, region_stats, centroids = cv2.connectedComponentsWithStats(
        thresh, connectivity=8
    )

    detections = []
    for i in range(1, n_labels):
        area = region_stats[i, cv2.CC_STAT_AREA]
        if min_area <= area <= max_area:
            cx, cy = centroids[i]
            mask = labels == i
            mean_intensity = float(np.mean(frame[mask]))
            detections.append({
                "x": float(cx),
                "y": float(cy),
                "area": int(area),
                "intensity": mean_intensity,
            })

    return detections


def detect_all_frames(frames):
    """Run cell detection on all frames and compile into a DataFrame.

    Parameters
    ----------
    frames : list of np.ndarray
        List of grayscale frames.

    Returns
    -------
    pd.DataFrame
        Columns: frame, x, y, area, intensity.
    """
    all_detections = []
    for frame_idx, frame in enumerate(frames):
        dets = segment_cells(frame)
        for det in dets:
            det["frame"] = frame_idx
            all_detections.append(det)

    if not all_detections:
        return pd.DataFrame(columns=["frame", "x", "y", "area", "intensity"])

    return pd.DataFrame(all_detections)


def link_trajectories(detections, search_range=30, memory=2, min_track_length=5):
    """Link detections into trajectories using trackpy.

    Parameters
    ----------
    detections : pd.DataFrame
        Detection data with columns: frame, x, y.
    search_range : float
        Maximum displacement between frames (pixels).
    memory : int
        Number of frames a particle can disappear and reappear.
    min_track_length : int
        Minimum number of frames for a valid track.

    Returns
    -------
    pd.DataFrame
        Linked trajectories with 'particle' column added.
    """
    import trackpy as tp

    tp.quiet()

    if detections.empty:
        return detections

    linked = tp.link(detections, search_range=search_range, memory=memory)

    linked = tp.filter_stubs(linked, min_track_length)

    linked["particle"] = linked["particle"].astype(int)

    return linked


def compute_track_kinematics(tracks, pixel_size, time_interval):
    """Compute kinematic measures for each trajectory.

    Parameters
    ----------
    tracks : pd.DataFrame
        Linked tracks with columns: frame, x, y, particle.
    pixel_size : float
        Micrometers per pixel.
    time_interval : float
        Seconds between frames.

    Returns
    -------
    pd.DataFrame
        Per-track summary with columns: particle, n_frames, displacement_um,
        path_length_um, mean_velocity_um_s, confinement_ratio, duration_s,
        start_frame, end_frame.
    """
    results = []

    for pid, group in tracks.groupby("particle"):
        group = group.sort_values("frame")
        n_frames = len(group)

        x = group["x"].values * pixel_size
        y = group["y"].values * pixel_size

        dx = np.diff(x)
        dy = np.diff(y)
        step_lengths = np.sqrt(dx ** 2 + dy ** 2)
        path_length = np.sum(step_lengths)

        displacement = np.sqrt((x[-1] - x[0]) ** 2 + (y[-1] - y[0]) ** 2)

        duration = (group["frame"].max() - group["frame"].min()) * time_interval
        mean_velocity = path_length / duration if duration > 0 else 0.0

        confinement_ratio = displacement / path_length if path_length > 0 else 0.0

        results.append({
            "particle": pid,
            "n_frames": n_frames,
            "displacement_um": displacement,
            "path_length_um": path_length,
            "mean_velocity_um_s": mean_velocity,
            "confinement_ratio": confinement_ratio,
            "duration_s": duration,
            "start_frame": int(group["frame"].min()),
            "end_frame": int(group["frame"].max()),
        })

    return pd.DataFrame(results)


def classify_behavior(kinematics, tracks, pixel_size, time_interval, flow_direction="x"):
    """Classify cell behavior based on kinematic parameters.

    Categories:
      - arrest: very low velocity (< 2 um/s)
      - rolling: low velocity with flow-aligned displacement
      - crawling: higher velocity with active movement
      - diapedesis: track disappears (cell transmigrates)

    Parameters
    ----------
    kinematics : pd.DataFrame
        Per-track kinematic summary.
    tracks : pd.DataFrame
        Full track data for directional analysis.
    pixel_size : float
        Micrometers per pixel.
    time_interval : float
        Seconds between frames.
    flow_direction : str
        'x' or 'y', indicates direction of flow for directionality analysis.

    Returns
    -------
    pd.DataFrame
        Kinematics dataframe with added 'behavior' and 'flow_alignment' columns.
    """
    arrest_velocity_threshold = 2.0
    rolling_velocity_max = 10.0
    flow_alignment_threshold = 0.7

    result = kinematics.copy()
    result["flow_alignment"] = 0.0
    result["behavior"] = "unknown"

    max_frame = tracks["frame"].max() if not tracks.empty else 0

    for idx, row in result.iterrows():
        pid = row["particle"]
        track_data = tracks[tracks["particle"] == pid].sort_values("frame")

        x = track_data["x"].values * pixel_size
        y = track_data["y"].values * pixel_size

        if len(x) >= 2:
            total_disp = np.array([x[-1] - x[0], y[-1] - y[0]])
            disp_mag = np.linalg.norm(total_disp)
            if disp_mag > 0:
                flow_idx = 0 if flow_direction == "x" else 1
                alignment = abs(total_disp[flow_idx]) / disp_mag
            else:
                alignment = 0.0
            result.at[idx, "flow_alignment"] = alignment
        else:
            alignment = 0.0

        velocity = row["mean_velocity_um_s"]
        end_frame = row["end_frame"]

        track_ends_early = end_frame < (max_frame - 2)

        if track_ends_early and velocity > arrest_velocity_threshold:
            result.at[idx, "behavior"] = "diapedesis"
        elif velocity < arrest_velocity_threshold:
            result.at[idx, "behavior"] = "arrest"
        elif velocity < rolling_velocity_max and alignment > flow_alignment_threshold:
            result.at[idx, "behavior"] = "rolling"
        else:
            result.at[idx, "behavior"] = "crawling"

    return result


def save_trajectories_csv(tracks, output_path, pixel_size, time_interval):
    """Save full trajectory data to CSV.

    Parameters
    ----------
    tracks : pd.DataFrame
        Linked track data.
    output_path : str
        Output CSV path.
    pixel_size : float
        Micrometers per pixel.
    time_interval : float
        Seconds between frames.
    """
    output = tracks.copy()
    output["x_um"] = output["x"] * pixel_size
    output["y_um"] = output["y"] * pixel_size
    output["time_s"] = output["frame"] * time_interval

    cols = ["particle", "frame", "time_s", "x", "y", "x_um", "y_um", "area", "intensity"]
    available = [c for c in cols if c in output.columns]
    output[available].to_csv(output_path, index=False)
    print(f"Trajectories CSV saved: {output_path}")


def save_behavior_csv(classified, output_path):
    """Save behavior classification results to CSV.

    Parameters
    ----------
    classified : pd.DataFrame
        Classified kinematics dataframe.
    output_path : str
        Output CSV path.
    """
    cols = [
        "particle", "n_frames", "duration_s", "displacement_um", "path_length_um",
        "mean_velocity_um_s", "confinement_ratio", "flow_alignment", "behavior",
    ]
    available = [c for c in cols if c in classified.columns]
    classified[available].to_csv(output_path, index=False)
    print(f"Behavior CSV saved: {output_path}")


def save_trajectory_plot(tracks, classified, pixel_size, output_path):
    """Save trajectory visualization colored by behavior.

    Parameters
    ----------
    tracks : pd.DataFrame
        Full trajectory data.
    classified : pd.DataFrame
        Behavior-classified kinematics.
    pixel_size : float
        Micrometers per pixel.
    output_path : str
        Output PNG path.
    """
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from matplotlib.patches import Patch

    behavior_colors = {
        "arrest": "#e74c3c",
        "rolling": "#f39c12",
        "crawling": "#2ecc71",
        "diapedesis": "#9b59b6",
        "unknown": "#95a5a6",
    }

    pid_behavior = dict(zip(classified["particle"], classified["behavior"]))

    fig, ax = plt.subplots(figsize=(10, 10))

    for pid, group in tracks.groupby("particle"):
        group = group.sort_values("frame")
        x = group["x"].values * pixel_size
        y = group["y"].values * pixel_size
        behavior = pid_behavior.get(pid, "unknown")
        color = behavior_colors.get(behavior, "#95a5a6")

        ax.plot(x, y, "-", color=color, linewidth=1.0, alpha=0.7)
        ax.plot(x[0], y[0], "o", color=color, markersize=4)
        ax.plot(x[-1], y[-1], "s", color=color, markersize=4)

    legend_elements = [
        Patch(facecolor=color, label=behavior.capitalize())
        for behavior, color in behavior_colors.items()
        if behavior in pid_behavior.values()
    ]
    ax.legend(handles=legend_elements, loc="upper right", fontsize=10)

    ax.set_xlabel("X (um)", fontsize=12)
    ax.set_ylabel("Y (um)", fontsize=12)
    ax.set_title("Cell Trajectories (colored by behavior)", fontsize=14)
    ax.set_aspect("equal")
    ax.grid(True, alpha=0.3)
    ax.invert_yaxis()

    fig.tight_layout()
    fig.savefig(output_path, dpi=150)
    plt.close(fig)
    print(f"Trajectory plot saved: {output_path}")


def main():
    parser = argparse.ArgumentParser(
        description="Immune cell tracking from time-lapse microscopy under flow."
    )
    parser.add_argument(
        "--image-dir",
        required=True,
        help="Directory containing sequential image frames.",
    )
    parser.add_argument(
        "--pixel-size",
        type=float,
        required=True,
        help="Pixel size in micrometers per pixel (um/px).",
    )
    parser.add_argument(
        "--time-interval",
        type=float,
        required=True,
        help="Time interval between frames in seconds.",
    )
    parser.add_argument(
        "--flow-direction",
        choices=["x", "y"],
        default="x",
        help="Direction of flow for directionality analysis (default: x).",
    )
    parser.add_argument(
        "--output-dir",
        default="tracking_output",
        help="Output directory (default: tracking_output).",
    )
    args = parser.parse_args()

    os.makedirs(args.output_dir, exist_ok=True)

    print("=" * 60)
    print("IMMUNE CELL TRACKING")
    print("=" * 60)
    print(f"Image directory:  {args.image_dir}")
    print(f"Pixel size:       {args.pixel_size} um/px")
    print(f"Time interval:    {args.time_interval} s")
    print(f"Flow direction:   {args.flow_direction}")

    try:
        frames = load_frames(args.image_dir)
    except FileNotFoundError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        sys.exit(1)

    n_frames = len(frames)
    h, w = frames[0].shape
    print(f"Loaded frames:    {n_frames}")
    print(f"Frame size:       {w} x {h} pixels")
    print(f"Total duration:   {(n_frames - 1) * args.time_interval:.1f} s")

    print(f"\n{'DETECTING CELLS':=^60}")
    detections = detect_all_frames(frames)
    n_detections = len(detections)
    avg_per_frame = n_detections / n_frames if n_frames > 0 else 0

    print(f"Total detections: {n_detections}")
    print(f"Avg per frame:    {avg_per_frame:.1f}")

    if detections.empty:
        print("ERROR: No cells detected. Check image quality and contrast.", file=sys.stderr)
        sys.exit(1)

    print(f"\n{'LINKING TRAJECTORIES':=^60}")
    try:
        tracks = link_trajectories(detections)
    except ImportError:
        print(
            "ERROR: trackpy is required for trajectory linking. "
            "Install with: pip install trackpy",
            file=sys.stderr,
        )
        sys.exit(1)

    if tracks.empty:
        print("WARNING: No valid trajectories found after linking and filtering.")
        sys.exit(0)

    n_tracks = tracks["particle"].nunique()
    print(f"Trajectories:     {n_tracks}")

    print(f"\n{'COMPUTING KINEMATICS':=^60}")
    kinematics = compute_track_kinematics(tracks, args.pixel_size, args.time_interval)

    print(f"\n  Velocity (um/s):")
    print(f"    Mean:   {kinematics['mean_velocity_um_s'].mean():.2f}")
    print(f"    Median: {kinematics['mean_velocity_um_s'].median():.2f}")
    print(f"    Range:  {kinematics['mean_velocity_um_s'].min():.2f} - {kinematics['mean_velocity_um_s'].max():.2f}")
    print(f"\n  Displacement (um):")
    print(f"    Mean:   {kinematics['displacement_um'].mean():.2f}")
    print(f"    Median: {kinematics['displacement_um'].median():.2f}")
    print(f"\n  Confinement ratio:")
    print(f"    Mean:   {kinematics['confinement_ratio'].mean():.3f}")
    print(f"    Median: {kinematics['confinement_ratio'].median():.3f}")

    print(f"\n{'CLASSIFYING BEHAVIOR':=^60}")
    classified = classify_behavior(
        kinematics, tracks, args.pixel_size, args.time_interval, args.flow_direction
    )

    behavior_counts = classified["behavior"].value_counts()
    print(f"\n  Behavior classification:")
    for behavior, count in behavior_counts.items():
        pct = 100.0 * count / len(classified)
        print(f"    {behavior:<15} {count:>4} ({pct:.1f}%)")

    traj_path = os.path.join(args.output_dir, "trajectories.csv")
    save_trajectories_csv(tracks, traj_path, args.pixel_size, args.time_interval)

    behavior_path = os.path.join(args.output_dir, "behavior_classification.csv")
    save_behavior_csv(classified, behavior_path)

    plot_path = os.path.join(args.output_dir, "trajectory_plot.png")
    save_trajectory_plot(tracks, classified, args.pixel_size, plot_path)

    print("\n" + "=" * 60)
    print("TRACKING COMPLETE")
    print("=" * 60)


if __name__ == "__main__":
    main()
