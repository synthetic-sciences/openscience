---
name: symbolic-regression
description: Discover governing equations from data using PySR (evolutionary symbolic regression). Physics-constrained search with dimensional analysis, custom operators, and complexity-accuracy tradeoffs. Use when you need an interpretable equation, not a black-box model.
category: physics
version: 1.0.0
author: Synthetic Sciences
license: MIT
tags: [Symbolic Regression, Equation Discovery, PySR, Physics, Interpretable ML]
dependencies: ["pysr>=0.19.0"]
---

# Symbolic Regression (PySR)

## Overview

Discover symbolic equations that fit data using PySR — a multi-population evolutionary algorithm with a Julia backend. PySR searches over the space of mathematical expressions to find equations that balance accuracy and simplicity.

## When to Use

- Discovering governing equations from experimental data
- Finding conservation laws or invariants
- Replacing black-box ML models with interpretable formulas
- Dimensional analysis-constrained equation search
- Validating theoretical predictions against data

## Do NOT Use When

- You already know the functional form (use `physics-fitting` instead)
- Data is high-dimensional (> 5-6 input variables)
- You need a time-series model (use `sindy` for dynamical systems)

## Installation

PySR requires Julia (auto-installed on first run):

```bash
pip install pysr
# First import will install Julia ~2 min
python -c "import pysr; pysr.install()"
```

## Core Workflows

### 1. Basic Equation Discovery

```python
import numpy as np
from pysr import PySRRegressor

# Generate data from a known law (for testing)
np.random.seed(42)
X = np.random.randn(100, 2)  # 2 input variables
x1, x2 = X[:, 0], X[:, 1]
y = 2.5 * np.sin(x1) + x2**2  # true equation
y += 0.1 * np.random.randn(100)  # noise

# Fit
model = PySRRegressor(
    niterations=40,
    binary_operators=["+", "-", "*", "/"],
    unary_operators=["sin", "cos", "exp", "sqrt", "abs"],
    populations=20,
    population_size=50,
    maxsize=25,          # max expression complexity
    parsimony=0.0032,    # penalty for complexity
    progress=True,
)
model.fit(X, y)

# Results: Pareto front of accuracy vs complexity
print(model)
print(f"\nBest equation: {model.sympy()}")
print(f"Score (accuracy/complexity): {model.score(X, y):.4f}")
```

### 2. Physics-Constrained Search (Dimensional Analysis)

```python
# Tell PySR about physical dimensions to constrain the search
# Example: Kepler's 3rd law from orbital data
# Variables: a (semi-major axis [m]), M (central mass [kg]), T (period [s])

import numpy as np
from pysr import PySRRegressor

# Training data: known planets
# T^2 = (4pi^2 / GM) * a^3
from scipy import constants as const
G = const.G
M_sun = 1.989e30

a_data = np.array([57.9, 108.2, 149.6, 227.9, 778.6]) * 1e9  # meters
T_data = np.array([88, 224.7, 365.2, 687, 4331]) * 86400       # seconds

X = np.column_stack([a_data, np.full_like(a_data, M_sun), np.full_like(a_data, G)])

model = PySRRegressor(
    niterations=50,
    binary_operators=["+", "-", "*", "/", "^"],
    unary_operators=["sqrt", "square", "cube"],
    populations=30,
    maxsize=20,
    parsimony=0.005,
    # Dimensional constraints (optional but powerful)
    # variable_names=["a", "M", "G"],
)
model.fit(X, T_data**2)  # Fit T^2 as function of a, M, G

print("Discovered equation for T²:")
print(model.sympy())
# Should find something proportional to a^3 / (G * M)
```

### 3. Custom Operators for Physics

```python
model = PySRRegressor(
    niterations=40,
    binary_operators=["+", "-", "*", "/"],
    unary_operators=[
        "sin", "cos",
        "exp", "log",
        "sqrt", "square",
        "abs",
    ],
    # Extra operators defined in Julia
    extra_sympy_mappings={
        "inv": lambda x: 1/x,
    },
    # Constraints on operator nesting
    nested_constraints={
        "sin": {"sin": 0, "cos": 0},   # no sin(sin(x))
        "cos": {"sin": 0, "cos": 0},
        "exp": {"exp": 0, "log": 0},
        "log": {"exp": 0, "log": 0},
    },
    maxsize=30,
    parsimony=0.003,
)
```

### 4. Multi-Output Regression

```python
# Discover multiple equations simultaneously
# Example: find both components of a 2D force field

X = np.random.randn(200, 2)
F_x = -X[:, 0] / (X[:, 0]**2 + X[:, 1]**2)**1.5
F_y = -X[:, 1] / (X[:, 0]**2 + X[:, 1]**2)**1.5

# Fit each component separately
model_Fx = PySRRegressor(niterations=40, binary_operators=["+", "-", "*", "/"],
                          unary_operators=["sqrt", "square", "inv(x)=1/x"],
                          maxsize=20)
model_Fy = PySRRegressor(niterations=40, binary_operators=["+", "-", "*", "/"],
                          unary_operators=["sqrt", "square", "inv(x)=1/x"],
                          maxsize=20)

model_Fx.fit(X, F_x)
model_Fy.fit(X, F_y)

print(f"F_x = {model_Fx.sympy()}")
print(f"F_y = {model_Fy.sympy()}")
```

### 5. Analyzing the Pareto Front

```python
# The Pareto front shows the tradeoff between accuracy and complexity
import matplotlib.pyplot as plt

equations = model.equations_  # DataFrame of all equations

fig, ax = plt.subplots(figsize=(10, 6))
ax.scatter(equations['complexity'], equations['loss'], c='steelblue', s=20)

# Highlight Pareto-optimal equations
pareto = equations[equations['score'] > 0]
ax.scatter(pareto['complexity'], pareto['loss'], c='red', s=50,
           zorder=5, label='Pareto front')

ax.set_xlabel('Complexity', fontsize=13)
ax.set_ylabel('Loss (MSE)', fontsize=13)
ax.set_yscale('log')
ax.set_title('Accuracy vs Complexity Tradeoff')
ax.legend()
plt.savefig('pareto_front.png', dpi=150, bbox_inches='tight')

# Print top equations from Pareto front
print("\nPareto-optimal equations:")
for _, row in pareto.iterrows():
    print(f"  Complexity {int(row['complexity']):2d}: {row['equation']:<40s}  loss={row['loss']:.6f}")
```

## Key Parameters

| Parameter | Default | Description |
|---|---|---|
| `niterations` | 40 | Number of evolutionary iterations (more = better but slower) |
| `populations` | 15 | Number of independent populations (parallelism) |
| `population_size` | 33 | Size of each population |
| `maxsize` | 20 | Maximum expression tree size (complexity limit) |
| `parsimony` | 0.0032 | Penalty for complexity (higher = simpler equations) |
| `binary_operators` | `["+","-","*","/"]` | Allowed binary operations |
| `unary_operators` | `[]` | Allowed unary operations (sin, cos, exp, etc.) |
| `nested_constraints` | `{}` | Prevent operator nesting (sin(sin(x))) |
| `deterministic` | `False` | Set `True` for reproducibility (slower) |
| `procs` | auto | Number of parallel processes |

## Tips for Physics Problems

1. **Start simple**: Begin with `["+", "-", "*", "/"]` only, add `sin/cos/exp` if needed
2. **Use parsimony**: Physics equations are usually simple. Set `parsimony=0.005-0.01`
3. **Constrain nesting**: Prevent `sin(sin(x))` and `exp(exp(x))` with `nested_constraints`
4. **Normalize data**: Scale variables to O(1) for better convergence
5. **Provide enough data**: 100-1000 points is typical; more helps with noise
6. **Check the Pareto front**: The "best" equation isn't always the most complex one
7. **Validate discovered equations**: Test on held-out data and check dimensional consistency

## Troubleshooting

| Symptom | Fix |
|---|---|
| Julia installation fails | Run `python -c "import pysr; pysr.install()"` manually |
| Very slow | Reduce `maxsize`, `populations`, or `niterations` |
| Only finds constants | Data may be too noisy; increase `niterations` or clean data |
| Overly complex equations | Increase `parsimony` (e.g., 0.01) |
| Missing the true equation | Add the needed operators (e.g., `sin` if periodicity expected) |
| Inconsistent results | Set `deterministic=True` and `random_state=42` |
