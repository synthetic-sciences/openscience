#!/usr/bin/env python3
"""
Gene Circuit ODE Simulator

Simulate synthetic gene circuit dynamics using ordinary differential equations.
Supports three canonical circuit architectures:

  - Repressilator: 3-gene ring oscillator with Hill repression (6 ODEs)
  - Toggle switch: 2 mutually repressing genes with cooperativity (4 ODEs)
  - Inducible promoter: single gene with inducer-responsive promoter (2 ODEs)

Uses scipy.integrate.solve_ivp for numerical integration and matplotlib for
time-series and phase portrait visualization.

Usage:
    python gene_circuit.py --circuit repressilator --time-span 200 --output-dir ./results
    python gene_circuit.py --circuit toggle-switch --parameters '{"alpha": 5.0}' --output-dir ./results
    python gene_circuit.py --circuit inducible --inducer 10.0 --output-dir ./results

Examples:
    # Simulate repressilator with default parameters
    python gene_circuit.py --circuit repressilator

    # Toggle switch with custom cooperativity
    python gene_circuit.py --circuit toggle-switch --parameters '{"n": 4.0, "alpha": 8.0}'

    # Inducible promoter dose-response
    python gene_circuit.py --circuit inducible --inducer 50.0 --time-span 50

Dependencies: numpy, scipy, matplotlib
"""

import argparse
import json
import os
import sys
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
from scipy.integrate import solve_ivp
from scipy.signal import find_peaks


# ---------------------------------------------------------------------------
# Circuit models
# ---------------------------------------------------------------------------

def repressilator_odes(t, y, params):
    """
    Repressilator: 3-gene ring oscillator.

    Species: m1, m2, m3 (mRNA), p1, p2, p3 (protein)
    Each gene is repressed by the protein of the upstream gene in the ring:
        gene1 repressed by p3
        gene2 repressed by p1
        gene3 repressed by p2

    Parameters:
        alpha0  - basal transcription rate (leakiness)
        alpha   - maximal transcription rate
        beta    - ratio of protein to mRNA degradation rates
        n       - Hill coefficient
        K       - repression threshold
        delta_m - mRNA degradation rate
        delta_p - protein degradation rate
    """
    m1, m2, m3, p1, p2, p3 = y

    alpha0 = params.get("alpha0", 0.03)
    alpha = params.get("alpha", 5.0)
    n = params.get("n", 2.0)
    K = params.get("K", 1.0)
    delta_m = params.get("delta_m", 1.0)
    delta_p = params.get("delta_p", 0.2)
    beta = params.get("beta", delta_p / delta_m)

    def hill_repress(p):
        return alpha / (1.0 + (p / K) ** n) + alpha0

    dm1 = hill_repress(p3) - delta_m * m1
    dm2 = hill_repress(p1) - delta_m * m2
    dm3 = hill_repress(p2) - delta_m * m3

    dp1 = beta * m1 - delta_p * p1
    dp2 = beta * m2 - delta_p * p2
    dp3 = beta * m3 - delta_p * p3

    return [dm1, dm2, dm3, dp1, dp2, dp3]


def toggle_switch_odes(t, y, params):
    """
    Toggle switch: 2 mutually repressing genes.

    Species: m1, m2 (mRNA), p1, p2 (protein)
    Gene 1 repressed by p2; Gene 2 repressed by p1.

    Parameters:
        alpha1, alpha2 - maximal transcription rates
        n1, n2         - Hill coefficients
        K1, K2         - repression thresholds
        delta_m        - mRNA degradation rate
        delta_p        - protein degradation rate
        beta           - translation rate
    """
    m1, m2, p1, p2 = y

    alpha1 = params.get("alpha1", params.get("alpha", 6.0))
    alpha2 = params.get("alpha2", params.get("alpha", 6.0))
    n1 = params.get("n1", params.get("n", 2.5))
    n2 = params.get("n2", params.get("n", 2.5))
    K1 = params.get("K1", params.get("K", 1.0))
    K2 = params.get("K2", params.get("K", 1.0))
    delta_m = params.get("delta_m", 1.0)
    delta_p = params.get("delta_p", 0.2)
    beta = params.get("beta", delta_p / delta_m)
    alpha0 = params.get("alpha0", 0.03)

    dm1 = alpha1 / (1.0 + (p2 / K2) ** n2) + alpha0 - delta_m * m1
    dm2 = alpha2 / (1.0 + (p1 / K1) ** n1) + alpha0 - delta_m * m2

    dp1 = beta * m1 - delta_p * p1
    dp2 = beta * m2 - delta_p * p2

    return [dm1, dm2, dp1, dp2]


def inducible_odes(t, y, params):
    """
    Inducible promoter: single gene with inducer-responsive activation.

    Species: m (mRNA), p (protein)
    Inducer activates transcription through a Hill function.
    Includes growth dilution term.

    Parameters:
        alpha_max - maximal transcription rate
        K_ind     - inducer concentration for half-maximal activation
        n         - Hill coefficient for inducer response
        inducer   - inducer concentration (constant)
        delta_m   - mRNA degradation rate
        delta_p   - protein degradation rate
        beta      - translation rate
        mu        - growth/dilution rate
        alpha0    - basal transcription (leakiness)
    """
    m, p = y

    alpha_max = params.get("alpha_max", params.get("alpha", 10.0))
    K_ind = params.get("K_ind", params.get("K", 5.0))
    n = params.get("n", 2.0)
    inducer = params.get("inducer", 0.0)
    delta_m = params.get("delta_m", 1.0)
    delta_p = params.get("delta_p", 0.2)
    beta = params.get("beta", delta_p / delta_m)
    mu = params.get("mu", 0.01)
    alpha0 = params.get("alpha0", 0.05)

    activation = alpha_max * (inducer ** n) / (K_ind ** n + inducer ** n) + alpha0

    dm = activation - (delta_m + mu) * m
    dp = beta * m - (delta_p + mu) * p

    return [dm, dp]


# ---------------------------------------------------------------------------
# Simulation and analysis
# ---------------------------------------------------------------------------

def simulate(circuit, params, t_span, t_eval=None, y0=None):
    """Run ODE integration for the specified circuit."""
    if circuit == "repressilator":
        if y0 is None:
            y0 = [0.5, 0.3, 0.1, 2.0, 1.0, 0.5]
        func = repressilator_odes
    elif circuit == "toggle-switch":
        if y0 is None:
            y0 = [0.1, 5.0, 0.1, 5.0]
        func = toggle_switch_odes
    elif circuit == "inducible":
        if y0 is None:
            y0 = [0.0, 0.0]
        func = inducible_odes
    else:
        raise ValueError(f"Unknown circuit: {circuit}")

    if t_eval is None:
        t_eval = np.linspace(t_span[0], t_span[1], max(2000, int((t_span[1] - t_span[0]) * 20)))

    sol = solve_ivp(
        func,
        t_span,
        y0,
        args=(params,),
        t_eval=t_eval,
        method="RK45",
        rtol=1e-8,
        atol=1e-10,
        max_step=(t_span[1] - t_span[0]) / 500,
    )

    if not sol.success:
        raise RuntimeError(f"ODE integration failed: {sol.message}")

    return sol


def estimate_period(t, signal, min_prominence=0.1):
    """Estimate oscillation period from time series using peak detection."""
    signal = np.asarray(signal)
    # Normalize
    sig_range = signal.max() - signal.min()
    if sig_range < 1e-6:
        return None

    prominence = max(min_prominence, sig_range * 0.2)
    peaks, properties = find_peaks(signal, prominence=prominence, distance=len(t) // 50)

    if len(peaks) < 2:
        return None

    periods = np.diff(t[peaks])
    # Use the last few periods (after transients settle)
    if len(periods) >= 3:
        periods = periods[-min(5, len(periods)):]

    return float(np.mean(periods))


def find_steady_states_toggle(params, n_trials=20):
    """
    Find steady states of the toggle switch by trying many initial conditions.
    Returns a list of (p1_ss, p2_ss) tuples.
    """
    steady_states = []
    t_span = (0, 5000)

    for _ in range(n_trials):
        y0 = np.random.uniform(0, 10, 4).tolist()
        try:
            sol = simulate("toggle-switch", params, t_span, y0=y0)
            # Take the last few points as steady state
            p1_ss = float(np.mean(sol.y[2, -50:]))
            p2_ss = float(np.mean(sol.y[3, -50:]))

            # Check if this is a new steady state
            is_new = True
            for p1_prev, p2_prev in steady_states:
                if abs(p1_ss - p1_prev) < 0.1 and abs(p2_ss - p2_prev) < 0.1:
                    is_new = False
                    break
            if is_new:
                steady_states.append((p1_ss, p2_ss))
        except RuntimeError:
            continue

    return sorted(steady_states, key=lambda x: x[0])


def compute_fold_induction(params_base, inducer_conc):
    """Compute fold induction for the inducible circuit at given inducer concentration."""
    # Basal (no inducer)
    params_off = {**params_base, "inducer": 0.0}
    sol_off = simulate("inducible", params_off, (0, 2000))
    p_basal = float(np.mean(sol_off.y[1, -100:]))

    # Induced
    params_on = {**params_base, "inducer": inducer_conc}
    sol_on = simulate("inducible", params_on, (0, 2000))
    p_induced = float(np.mean(sol_on.y[1, -100:]))

    if p_basal < 1e-10:
        return float("inf") if p_induced > 1e-10 else 1.0
    return p_induced / p_basal


# ---------------------------------------------------------------------------
# Plotting
# ---------------------------------------------------------------------------

def plot_repressilator(sol, output_dir):
    """Generate time-series plot for the repressilator."""
    fig, axes = plt.subplots(2, 1, figsize=(10, 8), sharex=True)

    colors = ["#e74c3c", "#2ecc71", "#3498db"]
    labels = ["Gene 1", "Gene 2", "Gene 3"]

    # mRNA
    for i, (c, lbl) in enumerate(zip(colors, labels)):
        axes[0].plot(sol.t, sol.y[i], color=c, label=f"{lbl} mRNA", linewidth=1.2)
    axes[0].set_ylabel("mRNA concentration")
    axes[0].legend(loc="upper right")
    axes[0].set_title("Repressilator Dynamics")

    # Protein
    for i, (c, lbl) in enumerate(zip(colors, labels)):
        axes[1].plot(sol.t, sol.y[i + 3], color=c, label=f"{lbl} protein", linewidth=1.2)
    axes[1].set_ylabel("Protein concentration")
    axes[1].set_xlabel("Time (a.u.)")
    axes[1].legend(loc="upper right")

    plt.tight_layout()
    path = Path(output_dir) / "repressilator_timeseries.png"
    plt.savefig(path, dpi=150, bbox_inches="tight")
    plt.close()
    return str(path)


def plot_toggle_switch(sol, output_dir):
    """Generate time-series and phase portrait for the toggle switch."""
    fig, axes = plt.subplots(1, 2, figsize=(14, 6))

    # Time series
    axes[0].plot(sol.t, sol.y[2], color="#e74c3c", label="Protein 1", linewidth=1.5)
    axes[0].plot(sol.t, sol.y[3], color="#3498db", label="Protein 2", linewidth=1.5)
    axes[0].set_xlabel("Time (a.u.)")
    axes[0].set_ylabel("Protein concentration")
    axes[0].set_title("Toggle Switch Time Series")
    axes[0].legend()

    # Phase portrait
    axes[1].plot(sol.y[2], sol.y[3], color="#2c3e50", linewidth=0.8, alpha=0.7)
    axes[1].plot(sol.y[2, 0], sol.y[3, 0], "go", markersize=8, label="Start")
    axes[1].plot(sol.y[2, -1], sol.y[3, -1], "rs", markersize=8, label="End")
    axes[1].set_xlabel("Protein 1")
    axes[1].set_ylabel("Protein 2")
    axes[1].set_title("Phase Portrait")
    axes[1].legend()
    axes[1].set_aspect("equal", adjustable="box")

    plt.tight_layout()
    path = Path(output_dir) / "toggle_switch.png"
    plt.savefig(path, dpi=150, bbox_inches="tight")
    plt.close()
    return str(path)


def plot_inducible(sol, params, output_dir):
    """Generate time-series plot for the inducible promoter."""
    fig, axes = plt.subplots(2, 1, figsize=(10, 7), sharex=True)

    axes[0].plot(sol.t, sol.y[0], color="#e67e22", linewidth=1.5)
    axes[0].set_ylabel("mRNA concentration")
    axes[0].set_title(f"Inducible Promoter (inducer = {params.get('inducer', 0):.2f})")

    axes[1].plot(sol.t, sol.y[1], color="#8e44ad", linewidth=1.5)
    axes[1].set_ylabel("Protein concentration")
    axes[1].set_xlabel("Time (a.u.)")

    plt.tight_layout()
    path = Path(output_dir) / "inducible_timeseries.png"
    plt.savefig(path, dpi=150, bbox_inches="tight")
    plt.close()
    return str(path)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description="Simulate gene circuit ODE models",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Circuits:
  repressilator   3-gene ring oscillator (6 ODEs: 3 mRNA + 3 protein)
  toggle-switch   2 mutually repressing genes (4 ODEs: 2 mRNA + 2 protein)
  inducible       Single gene, inducer-activated (2 ODEs: mRNA + protein)

Examples:
  %(prog)s --circuit repressilator --time-span 200
  %(prog)s --circuit toggle-switch --parameters '{"alpha": 8.0, "n": 3.0}'
  %(prog)s --circuit inducible --inducer 10.0 --time-span 100
        """,
    )
    parser.add_argument(
        "--circuit", required=True,
        choices=["repressilator", "toggle-switch", "inducible"],
        help="Circuit architecture to simulate",
    )
    parser.add_argument(
        "--parameters", default=None,
        help="JSON string of parameter overrides (e.g., '{\"alpha\": 5.0, \"n\": 2.0}')",
    )
    parser.add_argument(
        "--time-span", type=float, default=100.0,
        help="Simulation time span (default: 100)",
    )
    parser.add_argument(
        "--inducer", type=float, default=None,
        help="Inducer concentration (for inducible circuit)",
    )
    parser.add_argument(
        "--output-dir", default=None,
        help="Directory for output plots (default: current directory)",
    )
    args = parser.parse_args()

    # Parse parameters
    params = {}
    if args.parameters:
        try:
            params = json.loads(args.parameters)
        except json.JSONDecodeError as e:
            print(f"ERROR: Invalid JSON for --parameters: {e}", file=sys.stderr)
            sys.exit(1)

    if args.inducer is not None:
        params["inducer"] = args.inducer

    # Set up output
    output_dir = Path(args.output_dir) if args.output_dir else Path(".")
    output_dir.mkdir(parents=True, exist_ok=True)

    t_span = (0, args.time_span)

    print(f"=== Gene Circuit Simulation ===")
    print(f"Circuit:    {args.circuit}")
    print(f"Time span:  0 to {args.time_span}")
    print(f"Parameters: {json.dumps(params, indent=2) if params else '(defaults)'}")
    print()

    # Simulate
    try:
        sol = simulate(args.circuit, params, t_span)
    except (RuntimeError, ValueError) as e:
        print(f"ERROR: Simulation failed: {e}", file=sys.stderr)
        sys.exit(1)

    print(f"Integration: {len(sol.t)} time points, status = success")
    print()

    # Circuit-specific analysis and plotting
    if args.circuit == "repressilator":
        # Estimate period from protein 1
        period = estimate_period(sol.t, sol.y[3])
        if period:
            print(f"Oscillation period: {period:.2f} (time units)")
            print(f"Frequency:          {1.0/period:.4f}")
        else:
            print("Oscillation period: Not detected (system may not oscillate)")

        # Amplitude
        p1 = sol.y[3]
        amp = float(p1.max() - p1.min())
        print(f"Protein 1 amplitude: {amp:.3f}")
        print(f"Protein 1 range:     [{p1.min():.3f}, {p1.max():.3f}]")

        plot_path = plot_repressilator(sol, output_dir)
        print(f"\nPlot saved: {plot_path}")

    elif args.circuit == "toggle-switch":
        # Final state
        p1_final = float(np.mean(sol.y[2, -50:]))
        p2_final = float(np.mean(sol.y[3, -50:]))
        print(f"Final state: p1 = {p1_final:.4f}, p2 = {p2_final:.4f}")

        # Find all steady states
        print("\nSearching for steady states (multiple initial conditions)...")
        steady_states = find_steady_states_toggle(params)
        print(f"Found {len(steady_states)} steady state(s):")
        for i, (p1, p2) in enumerate(steady_states):
            dominant = "Gene 1 HIGH" if p1 > p2 else "Gene 2 HIGH" if p2 > p1 else "Symmetric"
            print(f"  SS{i+1}: p1 = {p1:.4f}, p2 = {p2:.4f}  ({dominant})")

        if len(steady_states) >= 2:
            print(f"\nBistability: CONFIRMED ({len(steady_states)} stable states)")
        else:
            print(f"\nBistability: NOT DETECTED (monostable)")

        plot_path = plot_toggle_switch(sol, output_dir)
        print(f"\nPlot saved: {plot_path}")

    elif args.circuit == "inducible":
        inducer_conc = params.get("inducer", 0.0)
        p_ss = float(np.mean(sol.y[1, -100:]))
        m_ss = float(np.mean(sol.y[0, -100:]))

        print(f"Inducer:            {inducer_conc:.2f}")
        print(f"Steady-state mRNA:  {m_ss:.4f}")
        print(f"Steady-state prot:  {p_ss:.4f}")

        # Fold induction
        fold = compute_fold_induction(params, inducer_conc)
        if fold == float("inf"):
            print(f"Fold induction:     INF (zero basal expression)")
        else:
            print(f"Fold induction:     {fold:.2f}x")

        # Time to 90% steady state
        target = p_ss * 0.9
        if target > 0:
            idx_90 = np.argmax(sol.y[1] >= target)
            if idx_90 > 0:
                t_90 = float(sol.t[idx_90])
                print(f"Time to 90% SS:     {t_90:.2f}")

        plot_path = plot_inducible(sol, params, output_dir)
        print(f"\nPlot saved: {plot_path}")


if __name__ == "__main__":
    main()
