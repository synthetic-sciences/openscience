#!/usr/bin/env python3
"""
Simulate multi-species Lotka-Volterra community dynamics.

Solves the generalised Lotka-Volterra competition ODE system:

    dNi/dt = ri * Ni * (1 - sum_j(aij * Nj) / Ki)

for N species, given growth rates, carrying capacities, and an NxN
interaction matrix.  Produces time-series trajectories, phase portraits,
and steady-state analysis.

Usage:
    python lotka_volterra.py \\
        --species "E.coli,S.aureus" \\
        --initial "100,50" \\
        --growth-rates "0.8,0.6" \\
        --carrying-capacities "1000,800" \\
        --interaction-matrix interactions.csv \\
        --time-span 100 \\
        --output-dir results/

Examples:
    # Two-species competition
    python lotka_volterra.py \\
        --species "Sp1,Sp2" --initial "10,10" \\
        --growth-rates "1.0,0.8" --carrying-capacities "500,400" \\
        --interaction-matrix alpha.csv --output-dir ./out

    # Three-species system with longer integration
    python lotka_volterra.py \\
        --species "A,B,C" --initial "50,30,20" \\
        --growth-rates "1.2,0.9,0.7" --carrying-capacities "1000,800,600" \\
        --interaction-matrix alpha3.csv --time-span 200 --output-dir ./out

Dependencies: numpy, scipy, pandas, matplotlib
"""

import argparse
import sys
from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
from scipy.integrate import solve_ivp


# ---------------------------------------------------------------------------
# ODE system
# ---------------------------------------------------------------------------

def lotka_volterra_ode(t, N, r, K, alpha):
    """
    Generalised Lotka-Volterra competition model.

    Parameters
    ----------
    t : float       – current time (unused, required by solve_ivp)
    N : array       – species abundances, shape (n,)
    r : array       – intrinsic growth rates, shape (n,)
    K : array       – carrying capacities, shape (n,)
    alpha : array   – interaction matrix, shape (n, n); alpha[i][j] is the
                      effect of species j on species i

    Returns
    -------
    dNdt : array    – rate of change for each species
    """
    N = np.maximum(N, 0.0)  # prevent negative abundances
    n = len(N)
    dNdt = np.zeros(n)
    for i in range(n):
        competition = np.dot(alpha[i], N) / K[i]
        dNdt[i] = r[i] * N[i] * (1.0 - competition)
    return dNdt


# ---------------------------------------------------------------------------
# Simulation
# ---------------------------------------------------------------------------

def run_simulation(species, N0, r, K, alpha, t_span, n_points=2000):
    """
    Integrate the Lotka-Volterra system.

    Returns
    -------
    t : ndarray         – time points, shape (n_points,)
    trajectories : dict – {species_name: abundance_array}
    sol                 – full OdeResult from solve_ivp
    """
    t_eval = np.linspace(t_span[0], t_span[1], n_points)

    sol = solve_ivp(
        lotka_volterra_ode,
        t_span,
        N0,
        args=(r, K, alpha),
        method="RK45",
        t_eval=t_eval,
        dense_output=True,
        max_step=(t_span[1] - t_span[0]) / 200.0,
        rtol=1e-8,
        atol=1e-10,
    )

    if not sol.success:
        print(f"WARNING: Integration failed – {sol.message}", file=sys.stderr)

    trajectories = {}
    for i, name in enumerate(species):
        trajectories[name] = np.maximum(sol.y[i], 0.0)

    return sol.t, trajectories, sol


def find_steady_state(trajectories, time, window_frac=0.05):
    """
    Estimate steady-state abundances from the final portion of the
    trajectory.  Uses the last *window_frac* of the time series.

    Returns dict {species: (mean, std)}.
    """
    n_pts = len(time)
    idx = max(1, int(n_pts * (1.0 - window_frac)))
    result = {}
    for name, traj in trajectories.items():
        tail = traj[idx:]
        result[name] = (float(np.mean(tail)), float(np.std(tail)))
    return result


def check_coexistence(steady, threshold=1.0):
    """Determine which species persist at steady state."""
    status = {}
    for name, (mean, _) in steady.items():
        status[name] = "persists" if mean > threshold else "extinct"
    return status


# ---------------------------------------------------------------------------
# Loading / parsing
# ---------------------------------------------------------------------------

def parse_list(s, dtype=float):
    """Parse a comma-separated string into a numpy array."""
    return np.array([dtype(x.strip()) for x in s.split(",")])


def load_interaction_matrix(path, n):
    """
    Load an NxN interaction matrix from CSV.

    The CSV should be NxN (no headers) or (N+1)x(N+1) with row/col labels.
    """
    df = pd.read_csv(path, header=None)

    # If dimensions are n+1 x n+1, assume first row/col are labels
    if df.shape[0] == n + 1 and df.shape[1] == n + 1:
        df = df.iloc[1:, 1:]
    elif df.shape[0] == n and df.shape[1] == n + 1:
        df = df.iloc[:, 1:]
    elif df.shape[0] == n + 1 and df.shape[1] == n:
        df = df.iloc[1:, :]

    alpha = df.values.astype(float)
    if alpha.shape != (n, n):
        raise ValueError(
            f"Interaction matrix shape {alpha.shape} does not match "
            f"expected ({n}, {n}) for {n} species."
        )
    return alpha


# ---------------------------------------------------------------------------
# Plotting
# ---------------------------------------------------------------------------

def plot_timeseries(time, trajectories, species, output_dir):
    """Plot abundance vs. time for all species."""
    fig, ax = plt.subplots(figsize=(9, 5))
    colors = plt.cm.Set1(np.linspace(0, 0.9, len(species)))

    for i, name in enumerate(species):
        ax.plot(time, trajectories[name], linewidth=2, color=colors[i], label=name)

    ax.set_xlabel("Time")
    ax.set_ylabel("Abundance")
    ax.set_title("Lotka-Volterra Community Dynamics")
    ax.legend(loc="best")
    ax.grid(True, alpha=0.3)
    fig.tight_layout()

    path = output_dir / "lv_timeseries.png"
    fig.savefig(path, dpi=150)
    plt.close(fig)
    return path


def plot_phase_portrait(time, trajectories, species, output_dir):
    """
    Plot a 2D phase portrait for the first two species.
    Only generated when there are exactly two species.
    """
    if len(species) < 2:
        return None

    s1, s2 = species[0], species[1]
    n1, n2 = trajectories[s1], trajectories[s2]

    fig, ax = plt.subplots(figsize=(6, 6))
    ax.plot(n1, n2, linewidth=1.5, color="steelblue")
    ax.scatter(n1[0], n2[0], color="green", s=80, zorder=5, label="Start")
    ax.scatter(n1[-1], n2[-1], color="red", s=80, zorder=5, label="End")

    # Nullclines (approximate)
    ax.set_xlabel(f"{s1} abundance")
    ax.set_ylabel(f"{s2} abundance")
    ax.set_title(f"Phase Portrait: {s1} vs {s2}")
    ax.legend(loc="best")
    ax.grid(True, alpha=0.3)
    fig.tight_layout()

    path = output_dir / "lv_phase_portrait.png"
    fig.savefig(path, dpi=150)
    plt.close(fig)
    return path


def save_trajectory_csv(time, trajectories, species, output_dir):
    """Save time-series data to CSV."""
    data = {"time": time}
    for name in species:
        data[name] = trajectories[name]
    df = pd.DataFrame(data)
    path = output_dir / "lv_trajectories.csv"
    df.to_csv(path, index=False)
    return path


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description="Simulate multi-species Lotka-Volterra community dynamics."
    )
    parser.add_argument(
        "--species",
        required=True,
        help="Comma-separated species names (e.g. 'E.coli,S.aureus').",
    )
    parser.add_argument(
        "--initial",
        required=True,
        help="Comma-separated initial abundances.",
    )
    parser.add_argument(
        "--growth-rates",
        required=True,
        help="Comma-separated intrinsic growth rates (r).",
    )
    parser.add_argument(
        "--carrying-capacities",
        required=True,
        help="Comma-separated carrying capacities (K).",
    )
    parser.add_argument(
        "--interaction-matrix",
        required=True,
        help="Path to CSV containing the NxN interaction matrix.",
    )
    parser.add_argument(
        "--time-span",
        type=float,
        default=100.0,
        help="Simulation duration (default: 100).",
    )
    parser.add_argument(
        "--output-dir",
        default=".",
        help="Directory for output files (default: current directory).",
    )
    args = parser.parse_args()

    # Parse inputs
    species = [s.strip() for s in args.species.split(",")]
    n = len(species)
    N0 = parse_list(args.initial)
    r = parse_list(args.growth_rates)
    K = parse_list(args.carrying_capacities)

    # Validate dimensions
    for label, arr in [("initial", N0), ("growth-rates", r), ("carrying-capacities", K)]:
        if len(arr) != n:
            print(
                f"ERROR: --{label} has {len(arr)} values but {n} species given.",
                file=sys.stderr,
            )
            sys.exit(1)

    alpha_path = Path(args.interaction_matrix)
    if not alpha_path.exists():
        print(f"ERROR: Interaction matrix file not found: {alpha_path}", file=sys.stderr)
        sys.exit(1)
    alpha = load_interaction_matrix(alpha_path, n)

    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    # Print configuration
    print(f"Species ({n}): {', '.join(species)}")
    print(f"Initial abundances: {N0}")
    print(f"Growth rates (r):   {r}")
    print(f"Carrying cap. (K):  {K}")
    print(f"Interaction matrix:\n{alpha}")
    print(f"Time span: 0 - {args.time_span}")

    # Run simulation
    time, trajectories, sol = run_simulation(
        species, N0, r, K, alpha, (0.0, args.time_span)
    )
    print(f"\nIntegration status: {'success' if sol.success else 'FAILED'}")
    print(f"Time points evaluated: {len(time)}")

    # Steady-state analysis
    steady = find_steady_state(trajectories, time)
    coexistence = check_coexistence(steady)

    print("\n=== Steady-State Analysis ===")
    for name in species:
        mean, std = steady[name]
        status = coexistence[name]
        print(f"  {name:20s}: {mean:10.2f} +/- {std:8.4f}  [{status}]")

    persisting = [s for s, v in coexistence.items() if v == "persists"]
    if len(persisting) == n:
        print(f"\nOutcome: COEXISTENCE — all {n} species persist.")
    elif len(persisting) == 0:
        print("\nOutcome: TOTAL EXTINCTION — no species persist.")
    else:
        print(f"\nOutcome: COMPETITIVE EXCLUSION — survivors: {', '.join(persisting)}")

    # Save outputs
    ts_path = plot_timeseries(time, trajectories, species, output_dir)
    print(f"\nTime-series plot:    {ts_path}")

    if n == 2:
        pp_path = plot_phase_portrait(time, trajectories, species, output_dir)
        print(f"Phase portrait:      {pp_path}")

    csv_path = save_trajectory_csv(time, trajectories, species, output_dir)
    print(f"Trajectory CSV:      {csv_path}")


if __name__ == "__main__":
    main()
