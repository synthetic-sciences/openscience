---
name: dimensional-analysis
description: Automated dimensional analysis — Buckingham Pi theorem, non-dimensionalization, unit validation with pint, and characteristic scale estimation. Use before any physics computation to verify consistency and reduce parameter space.
category: physics
version: 1.0.0
author: Synthetic Sciences
license: MIT
tags: [Dimensional Analysis, Buckingham Pi, Units, Non-dimensionalization, Physics]
dependencies: ["scipy>=1.11.0", "numpy>=1.24.0", "sympy>=1.12.0"]
---

# Dimensional Analysis

## Overview

Systematic dimensional analysis for physics problems. Implements Buckingham Pi theorem to find dimensionless groups, validates unit consistency, non-dimensionalizes equations, and estimates characteristic scales.

## When to Use

- Before any physics computation: verify unit consistency
- Reducing parameter space via dimensionless groups
- Identifying which physical effects dominate (comparing dimensionless numbers)
- Non-dimensionalizing PDEs before numerical solution
- Checking if a derived formula has correct dimensions

## Core Workflows

### 1. Buckingham Pi Theorem

```python
import numpy as np
from sympy import symbols, Matrix, zeros, Rational

def buckingham_pi(variables, dimensions):
    """
    Buckingham Pi theorem: find dimensionless groups.

    Args:
        variables: dict of {name: {dim: power}} e.g. {'v': {'L': 1, 'T': -1}}
        dimensions: list of fundamental dimensions e.g. ['M', 'L', 'T']

    Returns:
        List of dimensionless Pi groups
    """
    var_names = list(variables.keys())
    n_vars = len(var_names)
    n_dims = len(dimensions)

    # Build dimension matrix
    D = np.zeros((n_dims, n_vars))
    for j, var in enumerate(var_names):
        for i, dim in enumerate(dimensions):
            D[i, j] = variables[var].get(dim, 0)

    rank = np.linalg.matrix_rank(D)
    n_pi = n_vars - rank

    print(f"Variables: {n_vars}, Dimensions: {n_dims}, Rank: {rank}")
    print(f"Number of Pi groups: {n_pi}")
    print(f"\nDimension matrix:")
    print(f"     {' '.join(f'{v:>8}' for v in var_names)}")
    for i, dim in enumerate(dimensions):
        print(f"  {dim}  {' '.join(f'{D[i,j]:>8.0f}' for j in range(n_vars))}")

    # Find null space of D (Pi groups)
    # Use sympy for exact rational arithmetic
    D_sym = Matrix(D).T
    null = D_sym.nullspace()

    print(f"\nDimensionless groups:")
    for k, vec in enumerate(null):
        terms = []
        for j, exp in enumerate(vec):
            if exp != 0:
                terms.append(f"{var_names[j]}^{exp}")
        print(f"  Π_{k+1} = {' · '.join(terms)}")

    return null

# Example: Drag force on a sphere
# F_drag depends on: velocity v, diameter d, density ρ, viscosity μ
variables = {
    'F':   {'M': 1, 'L': 1, 'T': -2},  # force [kg·m/s²]
    'v':   {'L': 1, 'T': -1},            # velocity [m/s]
    'd':   {'L': 1},                      # diameter [m]
    'rho': {'M': 1, 'L': -3},            # density [kg/m³]
    'mu':  {'M': 1, 'L': -1, 'T': -1},  # viscosity [Pa·s]
}
pi_groups = buckingham_pi(variables, ['M', 'L', 'T'])

# Result: 2 Pi groups
# Π₁ = F / (ρ v² d²)  → drag coefficient C_D
# Π₂ = ρ v d / μ       → Reynolds number Re
# Therefore: C_D = f(Re)
```

### 2. Unit Validation with pint

```python
# pip install pint
import pint
ureg = pint.UnitRegistry()
Q_ = ureg.Quantity

# Define quantities with units
mass = Q_(2.0, 'kg')
velocity = Q_(3.0, 'm/s')
height = Q_(10.0, 'm')
g = Q_(9.80665, 'm/s^2')

# Compute kinetic and potential energy
KE = 0.5 * mass * velocity**2
PE = mass * g * height

print(f"KE = {KE.to('J')}")
print(f"PE = {PE.to('J')}")
print(f"Total E = {(KE + PE).to('J')}")

# Unit checking: this would raise DimensionalityError
try:
    bad = mass + velocity  # Can't add kg + m/s
except pint.DimensionalityError as e:
    print(f"\nUnit error caught: {e}")

# Convert between unit systems
force = Q_(100, 'N')
print(f"\n{force} = {force.to('dyn')} = {force.to('lbf')}")

# Check dimensional consistency of a formula
# Period of a pendulum: T = 2π√(L/g)
L = Q_(1.0, 'm')
T = 2 * 3.14159 * (L / g)**0.5
print(f"\nPendulum period: T = {T.to('s')}")
```

### 3. Non-dimensionalization

```python
import sympy as sp

def nondimensionalize(equation, scales):
    """
    Non-dimensionalize an equation given characteristic scales.

    Args:
        equation: sympy equation (lhs - rhs = 0)
        scales: dict of {variable: scale_value}
    """
    # Define dimensionless variables
    for var, scale in scales.items():
        dim_less = sp.Symbol(f'{var.name}*')
        equation = equation.subs(var, scale * dim_less)

    return sp.simplify(equation)

# Example: Navier-Stokes non-dimensionalization
# ρ(∂u/∂t + u·∇u) = -∇p + μ∇²u
#
# Scales: U (velocity), L (length), ρ₀ (density)
# → t* = t·U/L, x* = x/L, u* = u/U, p* = p/(ρU²)
# → ∂u*/∂t* + u*·∇*u* = -∇*p* + (1/Re)∇*²u*
# where Re = ρUL/μ

print("Navier-Stokes non-dimensionalization:")
print("  Scales: U (velocity), L (length), ρ₀ (density)")
print("  Dimensionless variables:")
print("    t* = tU/L")
print("    x* = x/L")
print("    u* = u/U")
print("    p* = p/(ρU²)")
print("  Result:")
print("    ∂u*/∂t* + u*·∇*u* = -∇*p* + (1/Re)∇*²u*")
print("    where Re = ρUL/μ")
```

### 4. Common Dimensionless Numbers

```python
def dimensionless_numbers(params):
    """Compute common dimensionless numbers from physical parameters."""
    rho = params.get('density')        # kg/m³
    v = params.get('velocity')          # m/s
    L = params.get('length')            # m
    mu = params.get('viscosity')        # Pa·s
    alpha = params.get('thermal_diff')  # m²/s
    g = params.get('gravity', 9.81)     # m/s²
    beta = params.get('thermal_exp')    # 1/K
    dT = params.get('delta_T')          # K
    D = params.get('mass_diff')         # m²/s
    c = params.get('sound_speed')       # m/s

    nu = mu / rho if (mu and rho) else None  # kinematic viscosity

    numbers = {}
    if rho and v and L and mu:
        numbers['Re'] = rho * v * L / mu
    if v and c:
        numbers['Ma'] = v / c
    if nu and alpha:
        numbers['Pr'] = nu / alpha
    if g and beta and dT and L and nu and alpha:
        numbers['Ra'] = g * beta * dT * L**3 / (nu * alpha)
    if v and L and D:
        numbers['Pe'] = v * L / D
    if nu and D:
        numbers['Sc'] = nu / D

    for name, val in numbers.items():
        print(f"  {name:4s} = {val:.4e}")

    return numbers

# Example: water flowing in a pipe
print("Water in a pipe (d=5cm, v=2m/s):")
nums = dimensionless_numbers({
    'density': 998,       # kg/m³
    'velocity': 2.0,      # m/s
    'length': 0.05,       # m (diameter)
    'viscosity': 1.0e-3,  # Pa·s
    'sound_speed': 1480,  # m/s
})
if 'Re' in nums:
    Re = nums['Re']
    if Re < 2300:
        print(f"  → Re = {Re:.0f}: LAMINAR flow")
    elif Re < 4000:
        print(f"  → Re = {Re:.0f}: TRANSITIONAL flow")
    else:
        print(f"  → Re = {Re:.0f}: TURBULENT flow")
```

### 5. Dimension Checking for Formulas

```python
def check_dimensions(formula_str, var_dims):
    """
    Check if a formula is dimensionally consistent.

    Args:
        formula_str: string like "0.5 * m * v**2"
        var_dims: dict of {var_name: {dim: power}}
    """
    import re

    # Parse terms and check each has same dimensions
    # This is a simplified checker — for full checking use pint
    print(f"Formula: {formula_str}")
    print(f"Variable dimensions:")
    for var, dims in var_dims.items():
        dim_str = " · ".join(f"{d}^{p}" for d, p in dims.items() if p != 0)
        print(f"  {var}: [{dim_str}]")

    # Use pint for actual checking
    ureg = pint.UnitRegistry()

    # Map dimension dict to pint units
    dim_to_unit = {'M': 'kg', 'L': 'm', 'T': 's', 'Θ': 'K', 'I': 'A'}

    context = {}
    for var, dims in var_dims.items():
        unit_str = " * ".join(f"{dim_to_unit[d]}**{p}" for d, p in dims.items() if p != 0)
        context[var] = ureg.Quantity(1.0, unit_str)

    try:
        result = eval(formula_str, {"__builtins__": {}}, context)
        print(f"Result dimensions: [{result.units}]")
        return True
    except pint.DimensionalityError as e:
        print(f"DIMENSIONAL ERROR: {e}")
        return False

# Example
check_dimensions("0.5 * m * v**2", {
    'm': {'M': 1},
    'v': {'L': 1, 'T': -1}
})
# → [kg * m² / s²] = [J] ✓
```

## Quick Reference: Fundamental Dimensions

| Dimension | Symbol | SI Unit |
|---|---|---|
| Mass | M | kg |
| Length | L | m |
| Time | T | s |
| Temperature | Θ | K |
| Electric current | I | A |
| Amount | N | mol |
| Luminous intensity | J | cd |

## Common Dimensionless Numbers

| Number | Formula | Physical Meaning |
|---|---|---|
| Reynolds (Re) | ρvL/μ | Inertia / viscosity |
| Mach (Ma) | v/c | Flow speed / sound speed |
| Prandtl (Pr) | ν/α | Momentum diffusion / thermal diffusion |
| Rayleigh (Ra) | gβΔTL³/(να) | Buoyancy / diffusion |
| Peclet (Pe) | vL/D | Advection / diffusion |
| Knudsen (Kn) | λ/L | Mean free path / system size |
| Froude (Fr) | v/√(gL) | Inertia / gravity |
| Weber (We) | ρv²L/σ | Inertia / surface tension |
| Strouhal (St) | fL/v | Oscillation / flow |
| Nusselt (Nu) | hL/k | Convective / conductive heat transfer |
