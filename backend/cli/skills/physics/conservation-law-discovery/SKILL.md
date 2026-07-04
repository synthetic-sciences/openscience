---
name: conservation-law-discovery
description: Discover conserved quantities and symmetries from trajectory data. Identifies energy, momentum, angular momentum, and custom invariants using neural networks and symbolic methods. Inspired by Noether's theorem.
category: physics
version: 1.0.0
author: Synthetic Sciences
license: MIT
tags: [Conservation Laws, Noether, Symmetry, Invariants, Physics Discovery]
dependencies: ["scipy>=1.11.0", "numpy>=1.24.0", "matplotlib>=3.7.0"]
---

# Conservation Law Discovery

## Overview

Discover conserved quantities from trajectory data without knowing the governing equations. Uses numerical methods to find functions I(x) such that dI/dt = 0 along trajectories.

## When to Use

- You have trajectory data and want to find conserved quantities
- Verifying energy/momentum conservation in simulation output
- Discovering hidden symmetries in dynamical systems
- Identifying integrals of motion for Hamiltonian systems

## Core Workflows

### 1. Numerical Conservation Check

```python
import numpy as np
from scipy.integrate import solve_ivp
import matplotlib.pyplot as plt

# Example: Kepler problem (should conserve E, L, and Laplace-Runge-Lenz)
def kepler(t, y):
    x, y_pos, vx, vy = y
    r = np.sqrt(x**2 + y_pos**2)
    return [vx, vy, -x/r**3, -y_pos/r**3]

sol = solve_ivp(kepler, (0, 50), [1.0, 0.0, 0.0, 0.8],
                t_eval=np.linspace(0, 50, 5000), rtol=1e-12, atol=1e-14)
x, y_pos, vx, vy = sol.y

# Known conserved quantities
E = 0.5*(vx**2 + vy**2) - 1/np.sqrt(x**2 + y_pos**2)  # energy
L = x*vy - y_pos*vx  # angular momentum

fig, axes = plt.subplots(3, 1, figsize=(10, 8))
axes[0].plot(sol.t, E - E[0], 'b-', linewidth=0.5)
axes[0].set_ylabel(r'$\Delta E$')
axes[0].set_title('Conservation Check')
axes[0].ticklabel_format(style='sci', axis='y', scilimits=(-3,3))

axes[1].plot(sol.t, L - L[0], 'r-', linewidth=0.5)
axes[1].set_ylabel(r'$\Delta L$')
axes[1].ticklabel_format(style='sci', axis='y', scilimits=(-3,3))

# Laplace-Runge-Lenz vector (Kepler-specific)
r_vec = np.sqrt(x**2 + y_pos**2)
A_x = vy*L - x/r_vec
A_y = -vx*L - y_pos/r_vec
A_mag = np.sqrt(A_x**2 + A_y**2)
axes[2].plot(sol.t, A_mag - A_mag[0], 'g-', linewidth=0.5)
axes[2].set_ylabel(r'$\Delta |A|$ (LRL)')
axes[2].set_xlabel('Time')
axes[2].ticklabel_format(style='sci', axis='y', scilimits=(-3,3))

for ax in axes:
    ax.grid(True, alpha=0.3)
plt.tight_layout()
plt.savefig('conservation_check.png', dpi=150, bbox_inches='tight')
```

### 2. Discover Conserved Quantities via Polynomial Fitting

```python
def find_polynomial_invariant(trajectory, dt, max_degree=3):
    """
    Search for polynomial conserved quantities I(x) such that dI/dt ≈ 0.

    Method: Construct polynomial features, then find the null space of
    the time-derivative matrix.
    """
    from itertools import combinations_with_replacement

    n_samples, n_vars = trajectory.shape

    # Build polynomial feature matrix
    def poly_features(x, degree):
        """Generate all monomials up to given degree."""
        features = [np.ones(len(x))]
        names = ['1']
        for d in range(1, degree + 1):
            for combo in combinations_with_replacement(range(n_vars), d):
                feat = np.ones(len(x))
                name_parts = []
                for idx in combo:
                    feat *= x[:, idx]
                    name_parts.append(f'x{idx}')
                features.append(feat)
                names.append('*'.join(name_parts))
        return np.column_stack(features), names

    Phi, names = poly_features(trajectory, max_degree)

    # Compute time derivatives of features using finite differences
    dPhi_dt = np.gradient(Phi, dt, axis=0)

    # Find coefficients c such that dPhi/dt · c ≈ 0 (null space)
    # Use SVD
    U, S, Vt = np.linalg.svd(dPhi_dt[10:-10], full_matrices=True)  # trim edges

    # Small singular values indicate conserved quantities
    print("Singular values (smallest = most conserved):")
    for i in range(min(10, len(S))):
        print(f"  σ_{len(S)-1-i} = {S[-(i+1)]:.6e}")

    # The last row of Vt corresponds to the smallest singular value
    n_conserved = np.sum(S < 1e-6 * S[0])
    print(f"\nFound {n_conserved} candidate conserved quantities (σ < 1e-6 * σ_max)")

    invariants = []
    for i in range(max(1, n_conserved)):
        coeffs = Vt[-(i+1)]
        # Construct the invariant
        I_values = Phi @ coeffs
        # Check conservation quality
        relative_variation = np.std(I_values) / (np.abs(np.mean(I_values)) + 1e-15)

        # Print the invariant expression
        terms = []
        for j, (c, name) in enumerate(zip(coeffs, names)):
            if abs(c) > 1e-8:
                terms.append(f"{c:+.4f}·{name}")
        expr = " ".join(terms[:10])  # show first 10 terms
        if len(terms) > 10:
            expr += " + ..."

        print(f"\n  Invariant {i+1}: relative variation = {relative_variation:.2e}")
        print(f"    I = {expr}")
        invariants.append((coeffs, I_values, relative_variation))

    return invariants, names

# Example: find conserved quantities in Kepler data
trajectory = np.column_stack([x, y_pos, vx, vy])
invariants, names = find_polynomial_invariant(trajectory, dt=sol.t[1]-sol.t[0], max_degree=2)
```

### 3. Time-Derivative Test for Candidate Invariants

```python
def test_conservation(trajectory, dt, candidate_func, name="I"):
    """Test whether a candidate function is conserved along the trajectory."""
    I_values = candidate_func(trajectory)
    dI_dt = np.gradient(I_values, dt)

    mean_I = np.mean(I_values)
    std_I = np.std(I_values)
    max_dI = np.max(np.abs(dI_dt[10:-10]))  # trim edge artifacts

    print(f"{name}:")
    print(f"  Mean value: {mean_I:.6f}")
    print(f"  Std dev:    {std_I:.2e}")
    print(f"  Max |dI/dt|: {max_dI:.2e}")
    print(f"  Relative variation: {std_I/abs(mean_I):.2e}")
    conserved = std_I / abs(mean_I) < 1e-6
    print(f"  Conserved: {'YES' if conserved else 'NO'}")
    return I_values, conserved

# Test known invariants
def energy(traj):
    x, y, vx, vy = traj.T
    return 0.5*(vx**2 + vy**2) - 1/np.sqrt(x**2 + y**2)

def angular_momentum(traj):
    x, y, vx, vy = traj.T
    return x*vy - y*vx

dt = sol.t[1] - sol.t[0]
test_conservation(trajectory, dt, energy, "Energy")
test_conservation(trajectory, dt, angular_momentum, "Angular Momentum")
```

## Method Summary

| Method | Pros | Cons |
|---|---|---|
| Polynomial null space | Simple, interpretable | Limited to polynomial invariants |
| Neural network (autoencoder) | Finds arbitrary invariants | Hard to interpret, needs training |
| SINDy + conservation constraint | Sparse, interpretable | Requires good library |
| Symbolic regression (PySR) | General, human-readable | Slow, may not converge |

## Tips

1. **Start with known physics**: Check energy, momentum, angular momentum first
2. **Use high-precision trajectories**: Conservation discovery is sensitive to numerical error in the trajectory itself
3. **Trim edge data**: Finite differences are unreliable at trajectory endpoints
4. **Normalize**: Scale variables to O(1) for better numerical conditioning
5. **Cross-validate**: Check discovered invariants on a separate trajectory segment
