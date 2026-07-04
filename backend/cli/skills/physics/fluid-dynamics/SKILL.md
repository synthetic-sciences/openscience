---
name: fluid-dynamics
description: Computational fluid dynamics — Navier-Stokes solvers, lid-driven cavity, channel flow, vortex methods, turbulence statistics, drag/lift computation. Spectral and finite-difference methods for incompressible and compressible flows.
category: physics
version: 1.0.0
author: Synthetic Sciences
license: MIT
tags: [CFD, Navier-Stokes, Fluid Dynamics, Turbulence, Incompressible Flow]
dependencies: ["scipy>=1.11.0", "numpy>=1.24.0", "matplotlib>=3.7.0"]
---

# Fluid Dynamics (CFD)

## Overview

Solve the Navier-Stokes equations for incompressible and compressible flows. Covers lid-driven cavity, channel flow, flow past obstacles, and turbulence analysis. For pseudospectral methods on periodic domains, also consider the `fluidsim` skill.

## When to Use

- Incompressible flow simulations (lid-driven cavity, channel flow, jets)
- Computing drag and lift on bodies
- Turbulence statistics (energy spectrum, Reynolds stresses)
- Vortex dynamics and wake analysis
- Flow visualization (streamlines, vorticity fields)

## Do NOT Use When

- Periodic-domain turbulence at high resolution (use `fluidsim` — optimized pseudospectral)
- Compressible flow with shocks (need specialized Riemann solvers)
- Complex 3D geometries with unstructured meshes (use FEniCS or OpenFOAM)

## Core Workflows

### 1. 2D Lid-Driven Cavity (Incompressible, Vorticity-Streamfunction)

```python
import numpy as np
import matplotlib.pyplot as plt

def lid_driven_cavity(N=64, Re=100, dt=0.001, n_steps=50000):
    """
    2D lid-driven cavity using vorticity-streamfunction formulation.
    ∂ω/∂t + u·∇ω = (1/Re)∇²ω
    ∇²ψ = -ω
    u = ∂ψ/∂y, v = -∂ψ/∂x
    """
    dx = 1.0 / (N - 1)
    x = np.linspace(0, 1, N)
    y = np.linspace(0, 1, N)

    omega = np.zeros((N, N))  # vorticity
    psi = np.zeros((N, N))    # streamfunction

    # CFL check
    U_lid = 1.0
    CFL = U_lid * dt / dx
    diff_num = dt / (Re * dx**2)
    print(f"Grid: {N}x{N}, Re={Re}, dt={dt}")
    print(f"CFL = {CFL:.4f}, Diffusion number = {diff_num:.4f}")
    if CFL > 0.5 or diff_num > 0.25:
        print("WARNING: stability may be marginal")

    for step in range(n_steps):
        # Solve Poisson: ∇²ψ = -ω (Jacobi iteration)
        for _ in range(50):
            psi[1:-1, 1:-1] = 0.25 * (
                psi[2:, 1:-1] + psi[:-2, 1:-1] +
                psi[1:-1, 2:] + psi[1:-1, :-2] +
                dx**2 * omega[1:-1, 1:-1]
            )
            # BCs: ψ = 0 on all walls
            psi[0, :] = 0; psi[-1, :] = 0
            psi[:, 0] = 0; psi[:, -1] = 0

        # Compute velocity from streamfunction
        u = np.zeros((N, N))
        v = np.zeros((N, N))
        u[1:-1, 1:-1] = (psi[1:-1, 2:] - psi[1:-1, :-2]) / (2*dx)
        v[1:-1, 1:-1] = -(psi[2:, 1:-1] - psi[:-2, 1:-1]) / (2*dx)

        # Lid BC: u = 1 at y = 1 (top wall)
        u[-1, :] = U_lid

        # Vorticity on boundaries (Thom's formula)
        omega[0, 1:-1] = -2*psi[1, 1:-1] / dx**2                          # bottom
        omega[-1, 1:-1] = -2*psi[-2, 1:-1] / dx**2 - 2*U_lid/dx          # top (lid)
        omega[1:-1, 0] = -2*psi[1:-1, 1] / dx**2                          # left
        omega[1:-1, -1] = -2*psi[1:-1, -2] / dx**2                        # right

        # Advection-diffusion of vorticity (FTCS)
        domega_dx = (omega[2:, 1:-1] - omega[:-2, 1:-1]) / (2*dx)
        domega_dy = (omega[1:-1, 2:] - omega[1:-1, :-2]) / (2*dx)
        laplacian = (omega[2:, 1:-1] + omega[:-2, 1:-1] +
                     omega[1:-1, 2:] + omega[1:-1, :-2] -
                     4*omega[1:-1, 1:-1]) / dx**2

        omega[1:-1, 1:-1] += dt * (
            -u[1:-1, 1:-1] * domega_dx
            -v[1:-1, 1:-1] * domega_dy
            + laplacian / Re
        )

        if (step+1) % 10000 == 0:
            max_div = np.max(np.abs(
                (u[1:-1, 2:] - u[1:-1, :-2])/(2*dx) +
                (v[2:, 1:-1] - v[:-2, 1:-1])/(2*dx)
            ))
            print(f"Step {step+1}: max|ω|={np.max(np.abs(omega)):.2f}, max|div|={max_div:.2e}")

    return x, y, u, v, omega, psi

x, y, u, v, omega, psi = lid_driven_cavity(N=64, Re=100, n_steps=30000)

X, Y = np.meshgrid(x, y)
fig, axes = plt.subplots(1, 3, figsize=(18, 5))

# Streamfunction
ax = axes[0]
cs = ax.contour(X, Y, psi.T, levels=30, cmap='RdBu_r')
ax.set_title(r'Streamfunction $\psi$')
ax.set_xlabel('x'); ax.set_ylabel('y')
ax.set_aspect('equal')
plt.colorbar(cs, ax=ax)

# Vorticity
ax = axes[1]
cf = ax.contourf(X, Y, omega.T, levels=30, cmap='RdBu_r')
ax.set_title(r'Vorticity $\omega$')
ax.set_xlabel('x'); ax.set_ylabel('y')
ax.set_aspect('equal')
plt.colorbar(cf, ax=ax)

# Velocity vectors
ax = axes[2]
skip = 4
ax.quiver(X[::skip, ::skip], Y[::skip, ::skip],
          u.T[::skip, ::skip], v.T[::skip, ::skip], scale=20)
ax.set_title('Velocity field')
ax.set_xlabel('x'); ax.set_ylabel('y')
ax.set_aspect('equal')

plt.suptitle(f'Lid-Driven Cavity (Re={100})', fontsize=14)
plt.tight_layout()
plt.savefig('cavity_flow.png', dpi=150, bbox_inches='tight')
```

### 2. Centerline Velocity Profiles (Ghia Benchmark)

```python
# Compare with Ghia et al. (1982) benchmark data for Re=100
# Vertical centerline: u(x=0.5, y)
j_center = len(x) // 2
u_centerline = u[j_center, :]

fig, ax = plt.subplots(figsize=(6, 8))
ax.plot(u_centerline, y, 'b-', linewidth=2, label='Computed')
ax.set_xlabel('u')
ax.set_ylabel('y')
ax.set_title(f'Vertical centerline velocity (Re={100})')
ax.legend()
ax.grid(True, alpha=0.3)
plt.savefig('centerline.png', dpi=150, bbox_inches='tight')
```

### 3. Flow Past a Cylinder (Immersed Boundary)

```python
def cylinder_flow_simple(Nx=200, Ny=100, Re=100, n_steps=10000):
    """
    Simplified 2D flow past a cylinder using penalty method.
    For production use, consider lattice Boltzmann or FEniCS.
    """
    # This is a simplified placeholder — real cylinder flows need
    # proper immersed boundary or body-fitted coordinates
    dx = 1.0 / Ny
    dt = 0.1 * dx / 1.0  # conservative CFL

    # Initialize velocity field with uniform inflow
    u = np.ones((Nx, Ny))
    v = np.zeros((Nx, Ny))

    # Cylinder mask
    cx, cy = Nx//4, Ny//2
    R = Ny // 10
    Y_grid, X_grid = np.meshgrid(np.arange(Ny), np.arange(Nx))
    mask = ((X_grid - cx)**2 + (Y_grid - cy)**2) < R**2

    for step in range(n_steps):
        # Force velocity to zero inside cylinder
        u[mask] = 0
        v[mask] = 0
        # ... (full NS solver needed for proper simulation)

    return u, v, mask
```

## Flow Regime Reference

| Re | Flow Type | Characteristics |
|---|---|---|
| Re < 1 | Stokes (creeping) | Reversible, no inertia |
| 1 < Re < 40 | Steady laminar | Attached flow, twin vortices |
| 40 < Re < 200 | Periodic (Von Karman) | Vortex shedding |
| 200 < Re < 10⁵ | Turbulent wake | Broad spectrum |
| Re > 10⁵ | Fully turbulent | Boundary layer transition |

## Validation Checklist

- [ ] Verify divergence-free condition: ∇·u = 0
- [ ] Check CFL condition: |u|dt/dx < 1
- [ ] Compare centerline profiles with Ghia et al. (1982) for cavity
- [ ] Verify mass conservation: ∫u·n dA = 0
- [ ] Check symmetry (if problem is symmetric)

## Troubleshooting

| Symptom | Fix |
|---|---|
| Solution blows up | CFL too large, reduce dt |
| Checkerboard pattern | Pressure-velocity decoupling — use staggered grid |
| Poisson solver slow | Use SOR (ω ≈ 1.5-1.9) or FFT-based solver |
| Wrong drag coefficient | Insufficient resolution near body surface |
