#!/usr/bin/env python3
"""
Bifurcation Analysis by Parameter Sweep

Perform continuation-style bifurcation analysis on gene circuit models by
sweeping a parameter across a range, solving ODEs to steady state at each
value, and detecting saddle-node bifurcation points where the number of
stable steady states changes.

Supports toggle-switch (bistable) and inducible (monostable/graded response)
circuit architectures. For bistable circuits, multiple initial conditions are
tested at each parameter value to find coexisting steady states.

Usage:
    python bifurcation.py --circuit toggle-switch --parameter alpha --range 0,15 --steps 150 --output-dir ./results
    python bifurcation.py --circuit inducible --parameter inducer --range 0,50 --output-dir ./results

Examples:
    # Toggle switch bifurcation over repression strength
    python bifurcation.py --circuit toggle-switch --parameter alpha --range 1,12 --steps 200

    # Toggle switch bifurcation over Hill coefficient
    python bifurcation.py --circuit toggle-switch --parameter n --range 1,5 --steps 100

    # Inducible promoter dose-response curve
    python bifurcation.py --circuit inducible --parameter inducer --range 0,100 --steps 120

    # Custom output directory
    python bifurcation.py --circuit toggle-switch --parameter alpha --range 2,10 --output-dir ./bifurcation_results

Dependencies: numpy, scipy, matplotlib, pandas
"""

import argparse
import json
import sys
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
from scipy.integrate import solve_ivp


# ---------------------------------------------------------------------------
# Circuit ODE definitions (self-contained, matching gene_circuit.py)
# ---------------------------------------------------------------------------

DEFAULT_PARAMS_TOGGLE = {
    "alpha1": 6.0,
    "alpha2": 6.0,
    "n1": 2.5,
    "n2": 2.5,
    "K1": 1.0,
    "K2": 1.0,
    "delta_m": 1.0,
    "delta_p": 0.2,
    "alpha0": 0.03,
}
DEFAULT_PARAMS_TOGGLE["beta"] = DEFAULT_PARAMS_TOGGLE["delta_p"] / DEFAULT_PARAMS_TOGGLE["delta_m"]

DEFAULT_PARAMS_INDUCIBLE = {
    "alpha_max": 10.0,
    "K_ind": 5.0,
    "n": 2.0,
    "inducer": 0.0,
    "delta_m": 1.0,
    "delta_p": 0.2,
    "mu": 0.01,
    "alpha0": 0.05,
}
DEFAULT_PARAMS_INDUCIBLE["beta"] = DEFAULT_PARAMS_INDUCIBLE["delta_p"] / DEFAULT_PARAMS_INDUCIBLE["delta_m"]

# Canonical aliases: allow "alpha" and "n" and "K" to map to circuit-specific names
TOGGLE_ALIASES = {
    "alpha": ["alpha1", "alpha2"],
    "n": ["n1", "n2"],
    "K": ["K1", "K2"],
}

INDUCIBLE_ALIASES = {
    "alpha": ["alpha_max"],
    "K": ["K_ind"],
}


def toggle_switch_odes(t, y, params):
    """Toggle switch: 2 mutually repressing genes (4 ODEs)."""
    m1, m2, p1, p2 = y

    alpha1 = params.get("alpha1", 6.0)
    alpha2 = params.get("alpha2", 6.0)
    n1 = params.get("n1", 2.5)
    n2 = params.get("n2", 2.5)
    K1 = params.get("K1", 1.0)
    K2 = params.get("K2", 1.0)
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
    """Inducible promoter: single gene (2 ODEs)."""
    m, p = y

    alpha_max = params.get("alpha_max", 10.0)
    K_ind = params.get("K_ind", 5.0)
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
# Steady-state finder
# ---------------------------------------------------------------------------

def find_steady_state(ode_func, y0, params, t_max=5000.0):
    """
    Integrate ODEs to steady state. Returns the final state vector.
    Uses long-time integration and checks convergence.
    """
    sol = solve_ivp(
        ode_func,
        (0, t_max),
        y0,
        args=(params,),
        method="RK45",
        rtol=1e-9,
        atol=1e-11,
        max_step=t_max / 200,
    )

    if not sol.success:
        return None

    # Check that it converged (derivative is small)
    final = sol.y[:, -1]
    deriv = ode_func(t_max, final, params)
    max_deriv = max(abs(d) for d in deriv)

    if max_deriv > 1e-4:
        # Not converged, try longer integration
        sol2 = solve_ivp(
            ode_func,
            (0, t_max * 5),
            final.tolist(),
            args=(params,),
            method="RK45",
            rtol=1e-10,
            atol=1e-12,
            max_step=t_max / 100,
        )
        if sol2.success:
            final = sol2.y[:, -1]

    return final


def find_all_steady_states_toggle(params, n_trials=30):
    """
    Find all steady states of the toggle switch by trying many initial conditions.
    Returns a list of (p1, p2) tuples for distinct steady states.
    """
    steady_states = []
    rng = np.random.RandomState(42)

    # Include biased initial conditions to probe both sides
    special_ics = [
        [10.0, 0.1, 10.0, 0.1],  # Gene 1 high
        [0.1, 10.0, 0.1, 10.0],  # Gene 2 high
        [5.0, 5.0, 5.0, 5.0],    # Symmetric
        [0.1, 0.1, 0.1, 0.1],    # Low
    ]

    all_ics = special_ics + [rng.uniform(0, 15, 4).tolist() for _ in range(n_trials - len(special_ics))]

    for y0 in all_ics:
        result = find_steady_state(toggle_switch_odes, y0, params)
        if result is None:
            continue

        p1_ss = float(result[2])
        p2_ss = float(result[3])

        # Skip negative values (numerical artifact)
        if p1_ss < -0.01 or p2_ss < -0.01:
            continue

        # Check uniqueness
        is_new = True
        for p1_prev, p2_prev in steady_states:
            if abs(p1_ss - p1_prev) < 0.05 and abs(p2_ss - p2_prev) < 0.05:
                is_new = False
                break
        if is_new:
            steady_states.append((max(0, p1_ss), max(0, p2_ss)))

    return sorted(steady_states, key=lambda x: x[0])


def find_steady_state_inducible(params):
    """Find the steady state for the inducible circuit."""
    y0 = [0.0, 0.0]
    result = find_steady_state(inducible_odes, y0, params)
    if result is None:
        return None
    return (max(0, float(result[0])), max(0, float(result[1])))


# ---------------------------------------------------------------------------
# Parameter sweep
# ---------------------------------------------------------------------------

def resolve_param_name(param_name, circuit):
    """Resolve alias parameter names to actual parameter names."""
    if circuit == "toggle-switch":
        aliases = TOGGLE_ALIASES
    elif circuit == "inducible":
        aliases = INDUCIBLE_ALIASES
    else:
        return [param_name]

    if param_name in aliases:
        return aliases[param_name]
    return [param_name]


def sweep_toggle(base_params, param_name, param_range, steps):
    """
    Sweep a parameter for the toggle switch, finding all steady states.
    Returns list of dicts with keys: param_value, p1_ss, p2_ss, state_index.
    """
    resolved = resolve_param_name(param_name, "toggle-switch")
    values = np.linspace(param_range[0], param_range[1], steps)
    results = []

    for val in values:
        params = {**base_params}
        for rname in resolved:
            params[rname] = val

        ss_list = find_all_steady_states_toggle(params, n_trials=20)

        if not ss_list:
            # Record NaN if no steady state found
            results.append({
                "param_value": float(val),
                "p1_ss": np.nan,
                "p2_ss": np.nan,
                "state_index": 0,
                "n_states": 0,
            })
        else:
            for idx, (p1, p2) in enumerate(ss_list):
                results.append({
                    "param_value": float(val),
                    "p1_ss": p1,
                    "p2_ss": p2,
                    "state_index": idx,
                    "n_states": len(ss_list),
                })

    return results


def sweep_inducible(base_params, param_name, param_range, steps):
    """
    Sweep a parameter for the inducible circuit.
    Returns list of dicts with keys: param_value, m_ss, p_ss.
    """
    resolved = resolve_param_name(param_name, "inducible")
    values = np.linspace(param_range[0], param_range[1], steps)
    results = []

    for val in values:
        params = {**base_params}
        for rname in resolved:
            params[rname] = val

        ss = find_steady_state_inducible(params)
        if ss is None:
            results.append({
                "param_value": float(val),
                "m_ss": np.nan,
                "p_ss": np.nan,
            })
        else:
            results.append({
                "param_value": float(val),
                "m_ss": ss[0],
                "p_ss": ss[1],
            })

    return results


# ---------------------------------------------------------------------------
# Bifurcation detection
# ---------------------------------------------------------------------------

def detect_bifurcation_points(results, circuit):
    """
    Detect saddle-node bifurcation points where the number of steady states
    changes. Returns a list of (param_value, type) tuples.
    """
    bifurcations = []

    if circuit == "toggle-switch":
        # Group by parameter value, count distinct steady states
        by_param = {}
        for r in results:
            val = r["param_value"]
            if val not in by_param:
                by_param[val] = r["n_states"]

        param_values = sorted(by_param.keys())
        for i in range(1, len(param_values)):
            prev_n = by_param[param_values[i - 1]]
            curr_n = by_param[param_values[i]]
            if prev_n != curr_n and prev_n > 0 and curr_n > 0:
                # Bifurcation between these two parameter values
                bif_val = (param_values[i - 1] + param_values[i]) / 2
                if curr_n > prev_n:
                    bif_type = f"saddle-node (monostable -> {curr_n} states)"
                else:
                    bif_type = f"saddle-node ({prev_n} states -> monostable)"
                bifurcations.append((bif_val, bif_type))

    return bifurcations


# ---------------------------------------------------------------------------
# Plotting
# ---------------------------------------------------------------------------

def plot_toggle_bifurcation(results, param_name, bifurcations, output_dir):
    """Generate bifurcation diagram for toggle switch."""
    df = pd.DataFrame(results)
    df = df.dropna(subset=["p1_ss", "p2_ss"])

    fig, axes = plt.subplots(1, 2, figsize=(14, 6))

    # Protein 1 bifurcation diagram
    for state_idx in df["state_index"].unique():
        mask = df["state_index"] == state_idx
        sub = df[mask].sort_values("param_value")
        axes[0].plot(
            sub["param_value"], sub["p1_ss"],
            "o", markersize=2, color="#e74c3c" if state_idx == 0 else "#3498db",
            label=f"State {state_idx + 1}",
        )

    # Mark bifurcation points
    for bval, btype in bifurcations:
        axes[0].axvline(bval, color="#2c3e50", linestyle="--", alpha=0.6, linewidth=1)
        axes[0].annotate(
            "BIF", (bval, axes[0].get_ylim()[1] * 0.95),
            fontsize=8, ha="center", color="#2c3e50",
        )

    axes[0].set_xlabel(param_name)
    axes[0].set_ylabel("Protein 1 (steady state)")
    axes[0].set_title(f"Toggle Switch Bifurcation: Protein 1 vs {param_name}")
    axes[0].legend(markerscale=3)

    # Protein 2 bifurcation diagram
    for state_idx in df["state_index"].unique():
        mask = df["state_index"] == state_idx
        sub = df[mask].sort_values("param_value")
        axes[1].plot(
            sub["param_value"], sub["p2_ss"],
            "o", markersize=2, color="#e74c3c" if state_idx == 0 else "#3498db",
            label=f"State {state_idx + 1}",
        )

    for bval, btype in bifurcations:
        axes[1].axvline(bval, color="#2c3e50", linestyle="--", alpha=0.6, linewidth=1)

    axes[1].set_xlabel(param_name)
    axes[1].set_ylabel("Protein 2 (steady state)")
    axes[1].set_title(f"Toggle Switch Bifurcation: Protein 2 vs {param_name}")
    axes[1].legend(markerscale=3)

    plt.tight_layout()
    path = Path(output_dir) / "bifurcation_toggle.png"
    plt.savefig(path, dpi=150, bbox_inches="tight")
    plt.close()
    return str(path)


def plot_inducible_bifurcation(results, param_name, output_dir):
    """Generate dose-response / bifurcation diagram for inducible circuit."""
    df = pd.DataFrame(results).dropna(subset=["p_ss"])

    fig, axes = plt.subplots(1, 2, figsize=(14, 6))

    # mRNA
    axes[0].plot(df["param_value"], df["m_ss"], "o-", markersize=2, color="#e67e22", linewidth=1.2)
    axes[0].set_xlabel(param_name)
    axes[0].set_ylabel("mRNA (steady state)")
    axes[0].set_title(f"Inducible Circuit: mRNA vs {param_name}")

    # Protein
    axes[1].plot(df["param_value"], df["p_ss"], "o-", markersize=2, color="#8e44ad", linewidth=1.2)
    axes[1].set_xlabel(param_name)
    axes[1].set_ylabel("Protein (steady state)")
    axes[1].set_title(f"Inducible Circuit: Protein vs {param_name}")

    # Annotate half-maximal response
    p_max = df["p_ss"].max()
    p_min = df["p_ss"].min()
    p_half = (p_max + p_min) / 2
    idx_half = (df["p_ss"] - p_half).abs().idxmin()
    if idx_half is not None:
        val_half = df.loc[idx_half, "param_value"]
        axes[1].axhline(p_half, color="gray", linestyle=":", alpha=0.5)
        axes[1].axvline(val_half, color="gray", linestyle=":", alpha=0.5)
        axes[1].annotate(
            f"EC50 ~ {val_half:.2f}",
            (val_half, p_half),
            textcoords="offset points", xytext=(15, 10),
            fontsize=9, color="#2c3e50",
            arrowprops=dict(arrowstyle="->", color="#2c3e50"),
        )

    plt.tight_layout()
    path = Path(output_dir) / "bifurcation_inducible.png"
    plt.savefig(path, dpi=150, bbox_inches="tight")
    plt.close()
    return str(path)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description="Bifurcation analysis by parameter sweep for gene circuits",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Circuits:
  toggle-switch   Bistable toggle (sweep alpha, n, K, alpha1, alpha2, etc.)
  inducible       Inducible promoter (sweep inducer, alpha_max, K_ind, n, etc.)

Parameter aliases:
  alpha -> alpha1 & alpha2 (toggle), alpha_max (inducible)
  n     -> n1 & n2 (toggle), n (inducible)
  K     -> K1 & K2 (toggle), K_ind (inducible)

Examples:
  %(prog)s --circuit toggle-switch --parameter alpha --range 1,12 --steps 150
  %(prog)s --circuit inducible --parameter inducer --range 0,50 --steps 100
        """,
    )
    parser.add_argument(
        "--circuit", required=True,
        choices=["toggle-switch", "inducible"],
        help="Circuit to analyze",
    )
    parser.add_argument(
        "--parameter", required=True,
        help="Parameter name to sweep (e.g., alpha, n, K, inducer)",
    )
    parser.add_argument(
        "--range", required=True,
        help="Parameter range as min,max (e.g., 0,15)",
    )
    parser.add_argument(
        "--steps", type=int, default=100,
        help="Number of parameter values to sample (default: 100)",
    )
    parser.add_argument(
        "--output-dir", default=None,
        help="Directory for output files (default: current directory)",
    )
    parser.add_argument(
        "--parameters", default=None,
        help="JSON string of additional parameter overrides for base model",
    )
    args = parser.parse_args()

    # Parse range
    try:
        parts = args.range.split(",")
        if len(parts) != 2:
            raise ValueError
        param_range = (float(parts[0]), float(parts[1]))
    except (ValueError, IndexError):
        print("ERROR: --range must be min,max (e.g., 0,15)", file=sys.stderr)
        sys.exit(1)

    if param_range[0] >= param_range[1]:
        print("ERROR: range min must be less than max", file=sys.stderr)
        sys.exit(1)

    # Parse additional parameters
    extra_params = {}
    if args.parameters:
        try:
            extra_params = json.loads(args.parameters)
        except json.JSONDecodeError as e:
            print(f"ERROR: Invalid JSON for --parameters: {e}", file=sys.stderr)
            sys.exit(1)

    # Set up output
    output_dir = Path(args.output_dir) if args.output_dir else Path(".")
    output_dir.mkdir(parents=True, exist_ok=True)

    print(f"=== Bifurcation Analysis ===")
    print(f"Circuit:   {args.circuit}")
    print(f"Parameter: {args.parameter}")
    print(f"Range:     {param_range[0]} to {param_range[1]}")
    print(f"Steps:     {args.steps}")
    print()

    # Validate parameter name
    if args.circuit == "toggle-switch":
        base_params = {**DEFAULT_PARAMS_TOGGLE, **extra_params}
        resolved = resolve_param_name(args.parameter, "toggle-switch")
        valid_params = set(DEFAULT_PARAMS_TOGGLE.keys()) | set(TOGGLE_ALIASES.keys())
    else:
        base_params = {**DEFAULT_PARAMS_INDUCIBLE, **extra_params}
        resolved = resolve_param_name(args.parameter, "inducible")
        valid_params = set(DEFAULT_PARAMS_INDUCIBLE.keys()) | set(INDUCIBLE_ALIASES.keys())

    if args.parameter not in valid_params and not any(r in base_params for r in resolved):
        print(f"WARNING: Parameter '{args.parameter}' not recognized. "
              f"Valid parameters: {sorted(valid_params)}", file=sys.stderr)

    print(f"Resolved parameter(s): {resolved}")
    print(f"Base parameters: {json.dumps(base_params, indent=2)}")
    print()

    # Run sweep
    print(f"Sweeping {args.steps} values...")
    if args.circuit == "toggle-switch":
        results = sweep_toggle(base_params, args.parameter, param_range, args.steps)
    else:
        results = sweep_inducible(base_params, args.parameter, param_range, args.steps)

    print(f"Collected {len(results)} data points")
    print()

    # Detect bifurcations
    bifurcations = detect_bifurcation_points(results, args.circuit)
    if bifurcations:
        print(f"Bifurcation points detected ({len(bifurcations)}):")
        for bval, btype in bifurcations:
            print(f"  {args.parameter} ~ {bval:.4f}: {btype}")
    else:
        print("No bifurcation points detected in the swept range.")
    print()

    # Summary statistics
    if args.circuit == "toggle-switch":
        df = pd.DataFrame(results)
        n_states_by_param = df.groupby("param_value")["n_states"].first()
        n_bistable = (n_states_by_param >= 2).sum()
        n_monostable = (n_states_by_param == 1).sum()
        print(f"Monostable region: {n_monostable} parameter values")
        print(f"Bistable region:   {n_bistable} parameter values")

        if n_bistable > 0:
            bistable_range = df[df["n_states"] >= 2]["param_value"]
            print(f"Bistable range:    [{bistable_range.min():.4f}, {bistable_range.max():.4f}]")
    else:
        df = pd.DataFrame(results)
        p_max = df["p_ss"].max()
        p_min = df["p_ss"].min()
        dynamic_range = p_max / p_min if p_min > 1e-10 else float("inf")
        print(f"Protein range:     [{p_min:.4f}, {p_max:.4f}]")
        print(f"Dynamic range:     {dynamic_range:.2f}x")

        # EC50
        p_half = (p_max + p_min) / 2
        idx_half = (df["p_ss"] - p_half).abs().idxmin()
        ec50 = float(df.loc[idx_half, "param_value"])
        print(f"EC50:              {ec50:.4f}")
    print()

    # Save CSV
    df = pd.DataFrame(results)
    csv_path = output_dir / f"bifurcation_{args.circuit.replace('-', '_')}.csv"
    df.to_csv(csv_path, index=False, float_format="%.6f")
    print(f"Data saved: {csv_path}")

    # Plot
    if args.circuit == "toggle-switch":
        plot_path = plot_toggle_bifurcation(results, args.parameter, bifurcations, output_dir)
    else:
        plot_path = plot_inducible_bifurcation(results, args.parameter, output_dir)
    print(f"Plot saved: {plot_path}")


if __name__ == "__main__":
    main()
