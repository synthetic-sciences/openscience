---
name: sindy-identification
description: Sparse Identification of Nonlinear Dynamics (SINDy) — discover governing equations from time-series data. Builds sparse dynamical system models dx/dt = f(x) from measurements using PySINDy. Use when you have trajectory data and want to find the underlying ODE.
category: physics
version: 1.0.0
author: Synthetic Sciences
license: MIT
tags: [SINDy, System Identification, Dynamical Systems, Equation Discovery, Sparse Regression]
dependencies: ["pysindy>=2.1.0", "scipy>=1.11.0", "numpy>=1.24.0", "matplotlib>=3.7.0"]
---

# SINDy — Sparse Identification of Nonlinear Dynamics

## Overview

Discover governing ODEs from time-series data using SINDy (Brunton et al., PNAS 2016). Given measurements of state variables x(t), SINDy identifies the sparse set of terms in a library of candidate functions that best describe dx/dt.

## When to Use

- You have trajectory data and want to find the governing ODE
- System is expected to have a sparse representation (few active terms)
- Input variables are known (you measured the right state variables)
- Data is relatively clean (or you can denoise it)

## Do NOT Use When

- You want arbitrary symbolic expressions (use `symbolic-regression` with PySR)
- You only have steady-state data (SINDy needs time derivatives)
- System is stochastic (SINDy assumes deterministic dynamics)
- You have PDE data (use PDE-FIND variant, not standard SINDy)

## Installation

```bash
pip install pysindy
```

## Core Workflows

### 1. Basic SINDy (Discover ODE from Data)

```python
import numpy as np
import pysindy as ps
from scipy.integrate import solve_ivp
import matplotlib.pyplot as plt

# Generate training data from Lorenz system (ground truth)
def lorenz(t, y, sigma=10, rho=28, beta=8/3):
    return [sigma*(y[1]-y[0]), y[0]*(rho-y[2])-y[1], y[0]*y[1]-beta*y[2]]

dt = 0.001
t_train = np.arange(0, 10, dt)
sol = solve_ivp(lorenz, (0, 10), [1, 1, 1], t_eval=t_train, rtol=1e-10)
x_train = sol.y.T  # shape (N, 3)

# Fit SINDy model
model = ps.SINDy(
    feature_names=["x", "y", "z"],
    optimizer=ps.STLSQ(threshold=0.1),  # sparsity threshold
    feature_library=ps.PolynomialLibrary(degree=2),
)
model.fit(x_train, t=dt)
model.print()

# Expected output:
# x' = -10.000 x + 10.000 y
# y' = 28.000 x + -1.000 y + -1.000 x z
# z' = -2.667 z + 1.000 x y
```

### 2. Choosing the Sparsity Threshold

```python
# Sweep thresholds and check model complexity vs error
thresholds = [0.001, 0.01, 0.05, 0.1, 0.5, 1.0]
for thresh in thresholds:
    model_t = ps.SINDy(
        optimizer=ps.STLSQ(threshold=thresh),
        feature_library=ps.PolynomialLibrary(degree=2),
    )
    model_t.fit(x_train, t=dt)
    complexity = model_t.complexity  # number of nonzero terms
    # Simulate and compute error
    x_sim = model_t.simulate(x_train[0], t_train)
    rmse = np.sqrt(np.mean((x_sim - x_train)**2))
    print(f"threshold={thresh:.3f}: {complexity} terms, RMSE={rmse:.4f}")
```

### 3. Custom Function Libraries

```python
# Include trigonometric functions for oscillatory systems
library = ps.PolynomialLibrary(degree=2) + ps.FourierLibrary(n_frequencies=3)

# Or build a custom library
import pysindy as ps
custom_library = ps.CustomLibrary(
    library_functions=[
        lambda x: x,           # linear
        lambda x: x**2,        # quadratic
        lambda x: np.sin(x),   # sinusoidal
        lambda x: np.cos(x),
    ],
    function_names=[
        lambda x: x,
        lambda x: f"{x}^2",
        lambda x: f"sin({x})",
        lambda x: f"cos({x})",
    ]
)

model = ps.SINDy(
    feature_library=custom_library,
    optimizer=ps.STLSQ(threshold=0.1),
)
model.fit(x_train, t=dt)
model.print()
```

### 4. Noisy Data (Smoothed Differentiation)

```python
# Add noise
x_noisy = x_train + 0.1 * np.random.randn(*x_train.shape)

# Use smoothed finite differences for derivatives
model_noisy = ps.SINDy(
    differentiation_method=ps.SmoothedFiniteDifference(),
    optimizer=ps.STLSQ(threshold=0.2),  # higher threshold for noisy data
    feature_library=ps.PolynomialLibrary(degree=2),
)
model_noisy.fit(x_noisy, t=dt)
model_noisy.print()
```

### 5. Validate: Simulate and Compare

```python
# Simulate discovered model from same IC
x_sim = model.simulate(x_train[0], t_train)

fig, axes = plt.subplots(3, 1, figsize=(10, 8), sharex=True)
labels = ['x', 'y', 'z']
for i, ax in enumerate(axes):
    ax.plot(t_train, x_train[:, i], 'b-', linewidth=0.5, label='Ground truth')
    ax.plot(t_train, x_sim[:, i], 'r--', linewidth=0.5, label='SINDy model')
    ax.set_ylabel(labels[i], fontsize=13)
    ax.legend(loc='upper right')
    ax.grid(True, alpha=0.3)
axes[-1].set_xlabel('Time [s]')
axes[0].set_title('SINDy Model vs Ground Truth')
plt.tight_layout()
plt.savefig('sindy_validation.png', dpi=150, bbox_inches='tight')

# Quantitative error
rmse = np.sqrt(np.mean((x_sim - x_train)**2, axis=0))
print(f"RMSE per variable: x={rmse[0]:.4f}, y={rmse[1]:.4f}, z={rmse[2]:.4f}")
```

### 6. Coefficient Extraction

```python
# Get coefficient matrix (rows = equations, cols = library functions)
coefficients = model.coefficients()
feature_names = model.get_feature_names()

print("Discovered equations:")
for i, eq_name in enumerate(['dx/dt', 'dy/dt', 'dz/dt']):
    terms = []
    for j, name in enumerate(feature_names):
        if abs(coefficients[i, j]) > 1e-10:
            terms.append(f"{coefficients[i,j]:+.3f}·{name}")
    print(f"  {eq_name} = {' '.join(terms)}")
```

## Key Parameters

| Parameter | Default | Description |
|---|---|---|
| `threshold` (STLSQ) | 0.1 | Sparsity threshold — coefficients below this are zeroed |
| `degree` (PolynomialLibrary) | 2 | Maximum polynomial degree in library |
| `alpha` (STLSQ) | 0.05 | Ridge regularization strength |
| `max_iter` (STLSQ) | 20 | Maximum iterations for thresholding |

## Tips

1. **Start with polynomial degree 2** — most physics ODEs are low-order polynomial
2. **Threshold tuning is critical** — too low = overfitting, too high = missing terms
3. **Clean data first** — SINDy is sensitive to noise in derivatives
4. **Check the library** — if the true terms aren't in the library, SINDy can't find them
5. **Validate by simulation** — a good SINDy model should reproduce the trajectory

## Troubleshooting

| Symptom | Fix |
|---|---|
| Too many terms discovered | Increase `threshold` |
| Missing terms | Decrease `threshold` or check library contains needed functions |
| Poor simulation accuracy | Data too noisy — use `SmoothedFiniteDifference` |
| Model diverges on simulation | Discovered model is unstable — check coefficient signs |
| `x_train` wrong shape | Must be (n_samples, n_features), NOT (n_features, n_samples) |
