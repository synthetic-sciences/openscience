---
name: physics-fitting
description: Nonlinear curve fitting for physics data with proper error propagation, chi-squared analysis, residual diagnostics, confidence intervals, and model comparison (AIC/BIC). Use for any parameter extraction from experimental or simulation data.
category: physics
version: 1.0.0
author: Synthetic Sciences
license: MIT
tags: [Curve Fitting, Regression, Chi-Squared, Error Propagation, Parameter Estimation, Physics]
dependencies: ["scipy>=1.11.0", "numpy>=1.24.0", "matplotlib>=3.7.0", "lmfit>=1.2.0"]
---

# Physics Data Fitting

## Overview

Extract physical parameters from data using nonlinear least squares, chi-squared minimization, and Bayesian inference. Proper error propagation, residual analysis, confidence intervals, and model comparison included.

## When to Use

- Fitting a model function to experimental data
- Extracting physical constants from measurements
- Comparing competing models (which theory fits better?)
- Propagating measurement uncertainties to derived quantities
- Any parameter estimation with proper error bars

## Do NOT Use When

- You need MCMC / full posterior distributions (use `bayesian-inference` with emcee/PyMC)
- You're discovering the model itself (use `symbolic-regression`)
- Data is a time series from an ODE (use `ode-solver` + this skill)

## Core Workflows

### 1. Basic Nonlinear Fit (scipy)

```python
import numpy as np
from scipy.optimize import curve_fit
import matplotlib.pyplot as plt

# Model function
def exponential_decay(t, A, tau, C):
    """y = A * exp(-t/tau) + C"""
    return A * np.exp(-t / tau) + C

# Data with uncertainties
t_data = np.array([0.5, 1, 2, 3, 5, 7, 10, 15, 20])
y_data = np.array([9.8, 8.1, 5.5, 3.9, 2.1, 1.3, 0.7, 0.35, 0.22])
y_err = np.array([0.3, 0.2, 0.2, 0.15, 0.1, 0.1, 0.08, 0.05, 0.04])

# Fit with uncertainties
popt, pcov = curve_fit(exponential_decay, t_data, y_data,
                       sigma=y_err, absolute_sigma=True,
                       p0=[10, 3, 0.1])  # initial guess

# Extract parameters with uncertainties
perr = np.sqrt(np.diag(pcov))
A, tau, C = popt
dA, dtau, dC = perr
print(f"A   = {A:.3f} ± {dA:.3f}")
print(f"τ   = {tau:.3f} ± {dtau:.3f}")
print(f"C   = {C:.3f} ± {dC:.3f}")

# Chi-squared
residuals = (y_data - exponential_decay(t_data, *popt)) / y_err
chi2 = np.sum(residuals**2)
ndof = len(t_data) - len(popt)
chi2_red = chi2 / ndof
print(f"χ²/ndof = {chi2:.2f}/{ndof} = {chi2_red:.2f}")
```

### 2. Advanced Fitting with lmfit

```python
from lmfit import Model, Parameters

model = Model(exponential_decay)
params = Parameters()
params.add('A', value=10, min=0)         # bounded
params.add('tau', value=3, min=0.01)     # positive definite
params.add('C', value=0, min=-1, max=1)  # bounded

result = model.fit(y_data, params, t=t_data,
                   weights=1/y_err)

# Full report
print(result.fit_report())

# Confidence intervals (profile likelihood)
ci = result.conf_interval()
print("\nConfidence Intervals:")
for name in result.params:
    print(f"  {name}: {ci[name]}")

# Plot with confidence band
fig, axes = plt.subplots(2, 1, figsize=(10, 8), gridspec_kw={'height_ratios': [3, 1]})

t_fine = np.linspace(0, 22, 200)

ax = axes[0]
ax.errorbar(t_data, y_data, yerr=y_err, fmt='ko', capsize=3, label='Data')
ax.plot(t_fine, exponential_decay(t_fine, *popt), 'r-', linewidth=2, label='Best fit')

# Confidence band via parameter covariance
from scipy.stats import t as t_dist
n_boot = 1000
y_samples = np.zeros((n_boot, len(t_fine)))
rng = np.random.default_rng(42)
for i in range(n_boot):
    p_sample = rng.multivariate_normal(popt, pcov)
    y_samples[i] = exponential_decay(t_fine, *p_sample)
y_lo = np.percentile(y_samples, 2.5, axis=0)
y_hi = np.percentile(y_samples, 97.5, axis=0)
ax.fill_between(t_fine, y_lo, y_hi, alpha=0.2, color='red', label='95% CI')
ax.set_ylabel('y', fontsize=13)
ax.legend(fontsize=11)
ax.grid(True, alpha=0.3)

# Residuals
ax = axes[1]
ax.errorbar(t_data, residuals, yerr=1, fmt='ko', capsize=3)
ax.axhline(0, color='r', linestyle='--')
ax.set_xlabel('t', fontsize=13)
ax.set_ylabel('Residual (σ)', fontsize=13)
ax.grid(True, alpha=0.3)

plt.tight_layout()
plt.savefig('fit_with_residuals.png', dpi=150, bbox_inches='tight')
```

### 3. Model Comparison (AIC / BIC)

```python
def model_comparison(models, data_x, data_y, data_err):
    """Compare models using AIC and BIC."""
    results = []

    for name, func, p0 in models:
        try:
            popt, pcov = curve_fit(func, data_x, data_y,
                                   sigma=data_err, absolute_sigma=True, p0=p0)
            residuals = (data_y - func(data_x, *popt)) / data_err
            chi2 = np.sum(residuals**2)
            n = len(data_y)
            k = len(popt)
            ndof = n - k

            # Log-likelihood (Gaussian errors)
            log_L = -0.5 * chi2 - 0.5 * n * np.log(2*np.pi) - np.sum(np.log(data_err))

            aic = 2*k - 2*log_L
            bic = k*np.log(n) - 2*log_L

            results.append({
                'name': name, 'k': k, 'chi2': chi2,
                'chi2_red': chi2/ndof, 'AIC': aic, 'BIC': bic
            })
        except RuntimeError:
            results.append({'name': name, 'k': 0, 'chi2': np.inf,
                           'chi2_red': np.inf, 'AIC': np.inf, 'BIC': np.inf})

    # Print comparison
    print(f"{'Model':<20} {'k':<4} {'χ²/ndof':<10} {'AIC':<10} {'BIC':<10}")
    print("-" * 54)
    for r in sorted(results, key=lambda x: x['AIC']):
        print(f"{r['name']:<20} {r['k']:<4} {r['chi2_red']:<10.3f} {r['AIC']:<10.2f} {r['BIC']:<10.2f}")

    return results

# Example: compare exponential vs power law
def power_law(t, A, n, C):
    return A * t**(-n) + C

models = [
    ('Exponential', exponential_decay, [10, 3, 0.1]),
    ('Power law', power_law, [10, 1, 0.1]),
]
model_comparison(models, t_data, y_data, y_err)
```

### 4. Error Propagation

```python
def error_propagation(func, params, cov_matrix, *args):
    """
    Propagate parameter uncertainties through a function.
    Uses the Jacobian: σ²_f = J^T · Σ · J
    """
    eps = 1e-8
    f0 = func(params, *args)
    n_params = len(params)

    # Compute Jacobian numerically
    J = np.zeros((np.size(f0), n_params))
    for i in range(n_params):
        p_up = params.copy()
        p_up[i] += eps
        J[:, i] = (func(p_up, *args) - f0) / eps

    # Propagate: Σ_f = J Σ_p J^T
    cov_f = J @ cov_matrix @ J.T

    return f0, np.sqrt(np.diag(cov_f))

# Example: compute half-life from decay constant
def half_life(params):
    tau = params[1]  # decay time
    return np.array([tau * np.log(2)])

t_half, dt_half = error_propagation(half_life, popt, pcov)
print(f"Half-life: {t_half[0]:.3f} ± {dt_half[0]:.3f}")
```

## Goodness-of-Fit Reference

| χ²/ndof | Interpretation |
|---|---|
| ≈ 1 | Good fit — model matches data within uncertainties |
| ≪ 1 | Overfitting or overestimated uncertainties |
| ≫ 1 | Poor fit — model inadequate or underestimated uncertainties |
| 0.5 - 2.0 | Acceptable range for most physics analyses |

## Common Pitfalls

| Pitfall | Fix |
|---|---|
| `absolute_sigma=False` (default!) | Always set `absolute_sigma=True` when you have real error bars |
| Bad initial guess → wrong minimum | Try multiple starting points or use `lmfit` bounds |
| Correlated parameters | Check off-diagonal elements of covariance matrix |
| Non-Gaussian residuals | Plot residual histogram, consider robust fitting |
| Overfitting (too many parameters) | Use AIC/BIC for model selection |
| Ignoring systematic errors | Report systematics separately from statistical errors |
