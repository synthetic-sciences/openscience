#!/usr/bin/env python3
"""
Fit bacterial growth curves to OD600 time-series data.

Fits logistic, Gompertz, or Baranyi growth models to optical density
measurements and extracts key growth parameters: lag phase duration,
maximum specific growth rate (mu_max), doubling time, and carrying
capacity (K).

Usage:
    python growth_curve.py --data od_data.csv --model logistic --output-dir results/
    python growth_curve.py --data od_data.csv --model gompertz --output-dir results/
    python growth_curve.py --data od_data.csv --model baranyi --output-dir results/

Examples:
    # Fit logistic model to single replicate
    python growth_curve.py --data growth.csv --model logistic --output-dir ./out

    # Fit Gompertz model with multiple replicates (columns: time, od600_rep1, od600_rep2, ...)
    python growth_curve.py --data multi_rep.csv --model gompertz --output-dir ./out

    # Fit Baranyi model
    python growth_curve.py --data growth.csv --model baranyi --output-dir ./out

Dependencies: numpy, scipy, pandas, matplotlib
"""

import argparse
import sys
from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
from scipy.optimize import curve_fit


# ---------------------------------------------------------------------------
# Growth models
# ---------------------------------------------------------------------------

def logistic_model(t, y0, K, r, lag):
    """
    Logistic growth with lag phase.

    N(t) = K / (1 + ((K - y0) / y0) * exp(-r * (t - lag)))

    Parameters
    ----------
    t : array-like  – time points
    y0 : float      – initial OD
    K : float       – carrying capacity
    r : float       – maximum specific growth rate
    lag : float     – lag phase duration
    """
    return K / (1.0 + ((K - y0) / y0) * np.exp(-r * (t - lag)))


def gompertz_model(t, y0, K, mu_max, lag):
    """
    Modified Gompertz growth model.

    N(t) = y0 + (K - y0) * exp(-exp((mu_max * e / (K - y0)) * (lag - t) + 1))

    Parameters
    ----------
    t : array-like  – time points
    y0 : float      – baseline OD
    K : float       – asymptotic maximum OD
    mu_max : float  – maximum specific growth rate
    lag : float     – lag phase duration
    """
    A = K - y0
    return y0 + A * np.exp(-np.exp((mu_max * np.e / A) * (lag - t) + 1))


def baranyi_model(t, y0, K, mu_max, lag):
    """
    Baranyi growth model (simplified two-parameter adjustment function).

    Uses A(t) = t + (1/mu_max)*ln(exp(-mu_max*t) + exp(-mu_max*lag) - exp(-mu_max*(t+lag)))
    N(t) = y0 + mu_max * A(t) - ln(1 + (exp(mu_max*A(t)) - 1) / exp(K - y0))

    All values in ln(OD) space internally.

    Parameters
    ----------
    t : array-like  – time points
    y0 : float      – initial OD (linear)
    K : float       – carrying capacity OD (linear)
    mu_max : float  – maximum specific growth rate
    lag : float     – lag phase duration
    """
    ln_y0 = np.log(np.maximum(y0, 1e-12))
    ln_K = np.log(np.maximum(K, 1e-12))

    # Adjustment function A(t)
    with np.errstate(over="ignore"):
        term1 = np.exp(-mu_max * t)
        term2 = np.exp(-mu_max * lag)
        term3 = np.exp(-mu_max * (t + lag))
    inner = np.maximum(term1 + term2 - term3, 1e-30)
    A = t + (1.0 / mu_max) * np.log(inner)

    # Baranyi equation in log space
    ln_N = ln_y0 + mu_max * A - np.log(
        1.0 + (np.exp(mu_max * A) - 1.0) / np.exp(ln_K - ln_y0)
    )
    return np.exp(ln_N)


MODELS = {
    "logistic": logistic_model,
    "gompertz": gompertz_model,
    "baranyi": baranyi_model,
}


# ---------------------------------------------------------------------------
# Core fitting logic
# ---------------------------------------------------------------------------

def initial_guesses(time, od):
    """Estimate initial parameter guesses from raw data."""
    y0 = float(np.median(od[:max(1, len(od) // 10)]))
    K = float(np.max(od))
    # Crude mu_max from steepest slope
    diffs = np.diff(od) / np.diff(time)
    mu_max = float(np.max(diffs)) if len(diffs) > 0 else 0.5
    mu_max = max(mu_max, 1e-4)
    # Lag: time until OD first exceeds y0 + 10% of range
    threshold = y0 + 0.1 * (K - y0)
    above = np.where(od > threshold)[0]
    lag = float(time[above[0]]) if len(above) > 0 else 0.0
    return y0, K, mu_max, lag


def fit_growth_curve(time, od, model_name="logistic"):
    """
    Fit a growth model to OD data.

    Returns
    -------
    popt : array   – fitted parameters [y0, K, r/mu_max, lag]
    pcov : array   – covariance matrix
    model_func     – the callable model
    """
    model_func = MODELS[model_name]
    y0_g, K_g, mu_g, lag_g = initial_guesses(time, od)

    lower = [1e-6, y0_g * 0.5, 1e-6, 0.0]
    upper = [K_g, K_g * 5.0, mu_g * 20.0, time[-1] * 0.8]

    # Ensure lower < upper
    for i in range(len(lower)):
        if lower[i] >= upper[i]:
            upper[i] = lower[i] * 10.0 + 1.0

    try:
        popt, pcov = curve_fit(
            model_func,
            time,
            od,
            p0=[y0_g, K_g, mu_g, lag_g],
            bounds=(lower, upper),
            maxfev=20000,
        )
    except RuntimeError as exc:
        print(f"WARNING: curve_fit did not converge – {exc}", file=sys.stderr)
        popt = np.array([y0_g, K_g, mu_g, lag_g])
        pcov = np.full((4, 4), np.nan)

    return popt, pcov, model_func


def extract_parameters(popt, pcov):
    """
    Derive growth parameters from fitted values.

    Returns dict with y0, K, mu_max (or r), lag, doubling_time, and
    standard errors where available.
    """
    y0, K, mu_max, lag = popt
    doubling_time = np.log(2) / mu_max if mu_max > 0 else np.inf

    perr = np.sqrt(np.diag(pcov)) if not np.any(np.isnan(pcov)) else [np.nan] * 4

    return {
        "y0": y0,
        "y0_se": perr[0],
        "K": K,
        "K_se": perr[1],
        "mu_max": mu_max,
        "mu_max_se": perr[2],
        "lag": lag,
        "lag_se": perr[3],
        "doubling_time": doubling_time,
    }


def compute_r_squared(observed, predicted):
    """Coefficient of determination."""
    ss_res = np.sum((observed - predicted) ** 2)
    ss_tot = np.sum((observed - np.mean(observed)) ** 2)
    return 1.0 - ss_res / ss_tot if ss_tot > 0 else 0.0


# ---------------------------------------------------------------------------
# I/O helpers
# ---------------------------------------------------------------------------

def load_data(path):
    """
    Load CSV with 'time' column and one or more OD columns.

    Accepted formats:
    - Two columns: time, od600
    - Multiple replicates: time, od600_rep1, od600_rep2, ...  (or any columns besides 'time')

    Returns
    -------
    time : ndarray
    od_replicates : list of ndarray
    replicate_names : list of str
    """
    df = pd.read_csv(path)
    df.columns = [c.strip().lower() for c in df.columns]

    if "time" not in df.columns:
        raise ValueError("CSV must contain a 'time' column.")

    time = df["time"].values.astype(float)
    od_cols = [c for c in df.columns if c != "time"]
    if not od_cols:
        raise ValueError("CSV must contain at least one OD column besides 'time'.")

    replicates = [df[c].values.astype(float) for c in od_cols]
    return time, replicates, od_cols


def save_plot(time, od_reps, rep_names, fitted_curves, model_name, params_list, output_dir):
    """Save growth curve plot with raw data and fitted curves."""
    fig, ax = plt.subplots(figsize=(8, 5))
    colors = plt.cm.tab10(np.linspace(0, 1, max(len(od_reps), 1)))

    t_fine = np.linspace(time[0], time[-1], 500)

    for i, (od, name, fc, params) in enumerate(
        zip(od_reps, rep_names, fitted_curves, params_list)
    ):
        ax.scatter(time, od, s=20, color=colors[i], alpha=0.6, label=f"{name} (data)")
        ax.plot(
            t_fine,
            fc,
            color=colors[i],
            linewidth=2,
            label=f"{name} (fit, R²={params.get('r_squared', 0):.4f})",
        )

    ax.set_xlabel("Time")
    ax.set_ylabel("OD600")
    ax.set_title(f"Growth Curve — {model_name.capitalize()} Model")
    ax.legend(fontsize=8, loc="best")
    ax.grid(True, alpha=0.3)
    fig.tight_layout()

    plot_path = output_dir / "growth_curve_fit.png"
    fig.savefig(plot_path, dpi=150)
    plt.close(fig)
    return plot_path


def save_parameters_csv(params_list, rep_names, model_name, output_dir):
    """Write fitted parameters to CSV."""
    rows = []
    for name, params in zip(rep_names, params_list):
        row = {"replicate": name, "model": model_name}
        row.update(params)
        rows.append(row)
    df = pd.DataFrame(rows)
    csv_path = output_dir / "growth_parameters.csv"
    df.to_csv(csv_path, index=False)
    return csv_path


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description="Fit bacterial growth curves to OD600 time-series data."
    )
    parser.add_argument(
        "--data",
        required=True,
        help="CSV file with 'time' column and one or more OD600 columns.",
    )
    parser.add_argument(
        "--model",
        choices=["logistic", "gompertz", "baranyi"],
        default="logistic",
        help="Growth model to fit (default: logistic).",
    )
    parser.add_argument(
        "--output-dir",
        default=".",
        help="Directory for output files (default: current directory).",
    )
    args = parser.parse_args()

    data_path = Path(args.data)
    if not data_path.exists():
        print(f"ERROR: Data file not found: {data_path}", file=sys.stderr)
        sys.exit(1)

    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    # Load
    time, od_reps, rep_names = load_data(data_path)
    print(f"Loaded {len(od_reps)} replicate(s) with {len(time)} time points.")

    model_name = args.model
    model_func = MODELS[model_name]
    t_fine = np.linspace(time[0], time[-1], 500)

    params_list = []
    fitted_curves = []

    for name, od in zip(rep_names, od_reps):
        print(f"\n--- Replicate: {name} ---")
        popt, pcov, _ = fit_growth_curve(time, od, model_name)
        params = extract_parameters(popt, pcov)

        predicted = model_func(time, *popt)
        r2 = compute_r_squared(od, predicted)
        params["r_squared"] = r2

        fitted_curves.append(model_func(t_fine, *popt))
        params_list.append(params)

        print(f"  Model:          {model_name}")
        print(f"  y0 (initial):   {params['y0']:.6f} +/- {params['y0_se']:.6f}")
        print(f"  K (capacity):   {params['K']:.6f} +/- {params['K_se']:.6f}")
        print(f"  mu_max:         {params['mu_max']:.6f} +/- {params['mu_max_se']:.6f}")
        print(f"  Lag phase:      {params['lag']:.4f} +/- {params['lag_se']:.4f}")
        print(f"  Doubling time:  {params['doubling_time']:.4f}")
        print(f"  R²:             {r2:.6f}")

    # Aggregate across replicates
    if len(params_list) > 1:
        print("\n=== Aggregate (mean +/- SD across replicates) ===")
        for key in ["y0", "K", "mu_max", "lag", "doubling_time", "r_squared"]:
            vals = [p[key] for p in params_list]
            print(f"  {key:16s}: {np.mean(vals):.6f} +/- {np.std(vals, ddof=1):.6f}")

    # Save outputs
    plot_path = save_plot(
        time, od_reps, rep_names, fitted_curves, model_name, params_list, output_dir
    )
    csv_path = save_parameters_csv(params_list, rep_names, model_name, output_dir)

    print(f"\nPlot saved to:       {plot_path}")
    print(f"Parameters saved to: {csv_path}")


if __name__ == "__main__":
    main()
