---
name: dynamical-systems
description: Analyze nonlinear dynamical systems — phase portraits, fixed points, stability analysis, bifurcation diagrams, Poincare sections, Lyapunov exponents, and chaos detection. Use for any autonomous or non-autonomous ODE system where qualitative behavior matters.
category: physics
version: 1.0.0
author: Synthetic Sciences
license: MIT
tags: [Dynamical Systems, Phase Portrait, Bifurcation, Chaos, Lyapunov, Stability, Nonlinear]
dependencies: ["scipy>=1.11.0", "numpy>=1.24.0", "matplotlib>=3.7.0"]
---

# Dynamical Systems Analysis

## Overview

Qualitative and quantitative analysis of nonlinear dynamical systems. Phase portraits, fixed point classification, stability analysis, bifurcation diagrams, Poincare sections, and Lyapunov exponent computation.

## When to Use

- Visualizing flow in phase space (2D and 3D systems)
- Finding and classifying fixed points (stable/unstable nodes, spirals, saddles, centers)
- Bifurcation analysis (how qualitative behavior changes with parameters)
- Detecting chaos (Lyapunov exponents, sensitivity to initial conditions)
- Poincare sections for periodicity analysis
- Limit cycle detection and characterization

## Core Workflows

### 1. Phase Portrait (2D System)

```python
import numpy as np
import matplotlib.pyplot as plt
from scipy.integrate import solve_ivp

def system(t, y, mu=1.0):
    """Van der Pol oscillator"""
    x, v = y
    return [v, mu * (1 - x**2) * v - x]

# Vector field on a grid
x_range = np.linspace(-4, 4, 20)
v_range = np.linspace(-6, 6, 20)
X, V = np.meshgrid(x_range, v_range)
U = V
W = 1.0 * (1 - X**2) * V - X

fig, ax = plt.subplots(figsize=(10, 8))

# Streamlines
ax.streamplot(X, V, U, W, density=1.5, color='gray', linewidth=0.5, arrowsize=1)

# Sample trajectories from different ICs
colors = plt.cm.viridis(np.linspace(0, 1, 6))
for i, ic in enumerate([[0.1, 0], [3, 0], [0, 4], [-2, -3], [1, -5], [4, 4]]):
    sol = solve_ivp(system, (0, 30), ic, t_eval=np.linspace(0, 30, 3000),
                    rtol=1e-10, atol=1e-12)
    ax.plot(sol.y[0], sol.y[1], color=colors[i], linewidth=1.2)
    ax.plot(ic[0], ic[1], 'o', color=colors[i], markersize=6)

# Fixed points
ax.plot(0, 0, 'rx', markersize=12, markeredgewidth=3, label='Unstable fixed point')

ax.set_xlabel('x', fontsize=13)
ax.set_ylabel('dx/dt', fontsize=13)
ax.set_title('Van der Pol Oscillator Phase Portrait (μ=1)', fontsize=14)
ax.legend(fontsize=11)
ax.grid(True, alpha=0.3)
plt.savefig('phase_portrait.png', dpi=150, bbox_inches='tight')
```

### 2. Fixed Point Analysis

```python
from scipy.optimize import fsolve

def rhs(y, mu=1.0):
    """Autonomous system: dy/dt = f(y)"""
    x, v = y
    return [v, mu * (1 - x**2) * v - x]

def jacobian(y, mu=1.0):
    """Jacobian matrix J_ij = df_i/dy_j"""
    x, v = y
    return np.array([
        [0, 1],
        [-2*mu*x*v - 1, mu*(1 - x**2)]
    ])

# Find fixed points
y_guess = [0, 0]
fp = fsolve(rhs, y_guess)
print(f"Fixed point: ({fp[0]:.4f}, {fp[1]:.4f})")

# Classify via eigenvalues of Jacobian
J = jacobian(fp)
eigenvalues = np.linalg.eigvals(J)
print(f"Eigenvalues: {eigenvalues}")

# Classification logic
def classify_fixed_point(eigenvalues):
    real_parts = eigenvalues.real
    imag_parts = eigenvalues.imag

    if np.all(np.abs(imag_parts) < 1e-10):
        # Real eigenvalues
        if np.all(real_parts < 0):
            return "Stable node"
        elif np.all(real_parts > 0):
            return "Unstable node"
        else:
            return "Saddle point"
    else:
        # Complex eigenvalues
        if np.all(real_parts < 0):
            return "Stable spiral"
        elif np.all(real_parts > 0):
            return "Unstable spiral"
        else:
            return "Center"

print(f"Classification: {classify_fixed_point(eigenvalues)}")
```

### 3. Bifurcation Diagram

```python
def logistic_map_bifurcation(r_range, n_discard=500, n_plot=200):
    """Bifurcation diagram for the logistic map x_{n+1} = r * x_n * (1 - x_n)"""
    r_values = []
    x_values = []

    for r in r_range:
        x = 0.5  # initial condition
        # Discard transients
        for _ in range(n_discard):
            x = r * x * (1 - x)
        # Collect steady-state iterates
        for _ in range(n_plot):
            x = r * x * (1 - x)
            r_values.append(r)
            x_values.append(x)

    return np.array(r_values), np.array(x_values)

r_range = np.linspace(2.5, 4.0, 2000)
r_vals, x_vals = logistic_map_bifurcation(r_range)

fig, ax = plt.subplots(figsize=(12, 7))
ax.scatter(r_vals, x_vals, s=0.01, c='black', alpha=0.5)
ax.set_xlabel('r', fontsize=13)
ax.set_ylabel('x*', fontsize=13)
ax.set_title('Logistic Map Bifurcation Diagram', fontsize=14)
ax.grid(True, alpha=0.2)
plt.savefig('bifurcation.png', dpi=200, bbox_inches='tight')
```

For continuous systems, use numerical continuation:

```python
def continuous_bifurcation(rhs_func, param_range, y_init, param_name='mu'):
    """
    Simple parameter continuation for fixed point bifurcations.
    Tracks fixed points as a parameter varies.
    """
    fixed_points = []
    stabilities = []
    y_guess = y_init

    for param in param_range:
        fp = fsolve(lambda y: rhs_func(y, param), y_guess, full_output=True)
        if fp[2] == 1:  # converged
            y_guess = fp[0]  # use as next guess
            # Compute stability
            J = np.zeros((len(y_guess), len(y_guess)))
            eps = 1e-8
            f0 = np.array(rhs_func(y_guess, param))
            for j in range(len(y_guess)):
                y_pert = y_guess.copy()
                y_pert[j] += eps
                J[:, j] = (np.array(rhs_func(y_pert, param)) - f0) / eps
            eigs = np.linalg.eigvals(J)
            stable = np.all(eigs.real < 0)
            fixed_points.append(y_guess.copy())
            stabilities.append(stable)
        else:
            fixed_points.append(np.full_like(y_guess, np.nan))
            stabilities.append(False)

    return np.array(fixed_points), np.array(stabilities)
```

### 4. Lyapunov Exponent (Variational Method)

```python
def largest_lyapunov(rhs, y0, t_total=100, dt_renorm=1.0, rtol=1e-10):
    """
    Compute largest Lyapunov exponent via variational equations.
    Method: Benettin et al. (1980), Wolf et al. (1985).
    """
    n = len(y0)

    def rhs_with_variational(t, Y):
        y = Y[:n]
        delta = Y[n:2*n]
        dydt = np.array(rhs(t, y))
        # Numerical Jacobian
        eps = 1e-8
        J = np.zeros((n, n))
        f0 = dydt
        for j in range(n):
            y_pert = np.array(y)
            y_pert[j] += eps
            J[:, j] = (np.array(rhs(t, y_pert)) - f0) / eps
        ddelta_dt = J @ delta
        return np.concatenate([dydt, ddelta_dt])

    # Random initial tangent vector
    np.random.seed(42)
    delta0 = np.random.randn(n)
    delta0 /= np.linalg.norm(delta0)
    Y = np.concatenate([y0, delta0])

    lyap_sum = 0.0
    n_steps = int(t_total / dt_renorm)
    running = []

    for i in range(n_steps):
        t0, t1 = i * dt_renorm, (i + 1) * dt_renorm
        sol = solve_ivp(rhs_with_variational, (t0, t1), Y,
                        method='RK45', rtol=rtol, atol=rtol*1e-2)
        Y = sol.y[:, -1]
        norm = np.linalg.norm(Y[n:2*n])
        lyap_sum += np.log(norm)
        Y[n:2*n] /= norm
        running.append(lyap_sum / ((i+1) * dt_renorm))

    lambda_max = lyap_sum / t_total
    return lambda_max, running

# Example: Lorenz system
def lorenz(t, y, sigma=10, rho=28, beta=8/3):
    x, y_, z = y
    return [sigma*(y_-x), x*(rho-z)-y_, x*y_-beta*z]

lam, running = largest_lyapunov(lorenz, [1, 1, 1], t_total=200)
print(f"Largest Lyapunov exponent: λ_max = {lam:.4f} s⁻¹")
print(f"Expected for Lorenz: ~0.91 s⁻¹")
```

### 5. Poincare Section

```python
def poincare_section(rhs, y0, t_total, section_var=2, section_val=None,
                     direction='positive'):
    """
    Compute Poincare section by detecting crossings of a hyperplane.
    section_var: index of variable defining the section
    section_val: value at which to take the section (default: mean of trajectory)
    """
    sol = solve_ivp(rhs, (0, t_total), y0,
                    t_eval=np.linspace(0, t_total, int(t_total * 1000)),
                    rtol=1e-10, atol=1e-12)

    if section_val is None:
        section_val = np.mean(sol.y[section_var])

    # Find crossings
    y_section = sol.y[section_var] - section_val
    crossings = []

    for i in range(1, len(y_section)):
        if direction == 'positive' and y_section[i-1] < 0 and y_section[i] >= 0:
            # Linear interpolation for precise crossing
            frac = -y_section[i-1] / (y_section[i] - y_section[i-1])
            point = sol.y[:, i-1] + frac * (sol.y[:, i] - sol.y[:, i-1])
            crossings.append(point)
        elif direction == 'negative' and y_section[i-1] >= 0 and y_section[i] < 0:
            frac = y_section[i-1] / (y_section[i-1] - y_section[i])
            point = sol.y[:, i-1] + frac * (sol.y[:, i] - sol.y[:, i-1])
            crossings.append(point)

    return np.array(crossings)

# Example: Lorenz attractor Poincare section at z = 27
crossings = poincare_section(lorenz, [1, 1, 1], t_total=500,
                             section_var=2, section_val=27.0)
plt.scatter(crossings[:, 0], crossings[:, 1], s=0.5, c='black')
plt.xlabel('x')
plt.ylabel('y')
plt.title('Poincaré Section of Lorenz Attractor (z = 27)')
plt.savefig('poincare_section.png', dpi=150)
```

## Fixed Point Classification Reference

| Eigenvalues | Type | Behavior |
|---|---|---|
| λ₁ < λ₂ < 0 (real) | Stable node | All trajectories approach FP |
| 0 < λ₁ < λ₂ (real) | Unstable node | All trajectories leave FP |
| λ₁ < 0 < λ₂ (real) | Saddle | Attracted along one axis, repelled along other |
| α ± iβ, α < 0 | Stable spiral | Spirals inward |
| α ± iβ, α > 0 | Unstable spiral | Spirals outward |
| ± iβ (pure imaginary) | Center | Closed orbits (conservative systems) |

## Common Bifurcation Types

| Bifurcation | What Happens | How to Detect |
|---|---|---|
| Saddle-node | Two FPs collide and annihilate | One eigenvalue crosses zero |
| Transcritical | Two FPs exchange stability | Eigenvalue crosses zero, FPs persist |
| Pitchfork | Symmetric FP splits into two | Eigenvalue crosses zero with symmetry |
| Hopf | FP → limit cycle | Complex eigenvalue pair crosses imaginary axis |
| Period-doubling | Limit cycle doubles period | Floquet multiplier crosses -1 |

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Phase portrait arrows too small/large | Vector field magnitude varies | Normalize arrows or use `streamplot` |
| Fixed point finder doesn't converge | Bad initial guess | Try multiple guesses on a grid |
| Lyapunov exponent not converging | Integration time too short | Increase `t_total` (10-100× Lyapunov time) |
| Poincare section too sparse | Not enough crossings | Increase integration time |
| Bifurcation diagram missing branches | Continuation step too large | Decrease parameter step size |
