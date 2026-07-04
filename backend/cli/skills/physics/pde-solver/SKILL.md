---
name: pde-solver
description: Solve partial differential equations — finite differences, spectral methods, and physics-informed neural networks (PINNs via DeepXDE). Supports 1D/2D/3D, steady/transient, linear/nonlinear PDEs with Dirichlet, Neumann, and periodic boundary conditions.
category: physics
version: 1.0.0
author: Synthetic Sciences
license: MIT
tags: [PDE, Finite Difference, Spectral Methods, PINN, DeepXDE, Simulation, Physics]
dependencies: ["scipy>=1.11.0", "numpy>=1.24.0", "matplotlib>=3.7.0"]
---

# PDE Solver

## Overview

Solve partial differential equations using finite differences, spectral methods, or physics-informed neural networks (PINNs). Covers elliptic (Laplace, Poisson), parabolic (heat, diffusion), and hyperbolic (wave) equations in 1D, 2D, and 3D.

## When to Use

- Solving any PDE in physics (heat equation, wave equation, Navier-Stokes, Schrodinger, etc.)
- Steady-state or time-dependent problems
- Problems on simple geometries (rectangles, circles, boxes)
- Inverse problems (discovering parameters from data)

## Do NOT Use When

- Complex 3D geometries with unstructured meshes (use FEniCS — `pip install fenics-dolfinx`)
- Turbulent fluid dynamics on periodic domains (use `fluidsim`)
- Already know it's an ODE system (use `ode-solver`)

## Method Selection

| PDE Type | Simple Geometry | Complex Geometry | Inverse Problem |
|---|---|---|---|
| 1D steady | Finite differences | FEM (FEniCS) | PINN (DeepXDE) |
| 1D transient | MOL + `solve_ivp` | FEM | PINN |
| 2D steady | Finite differences / spectral | FEM | PINN |
| 2D transient | MOL or ADI | FEM | PINN |
| 3D | Spectral if periodic | FEM (Modal GPU) | PINN (Modal GPU) |

## Core Workflows

### 1. 1D Heat Equation (Finite Differences)

$$\frac{\partial u}{\partial t} = \alpha \frac{\partial^2 u}{\partial x^2}$$

```python
import numpy as np
import matplotlib.pyplot as plt

def solve_heat_1d(L=1.0, T=0.5, alpha=0.01, Nx=100, Nt=5000,
                  u_left=0.0, u_right=0.0, u0_func=None):
    """
    Solve 1D heat equation with Dirichlet BCs using explicit finite differences.
    Method of Lines approach: discretize space, integrate in time.
    """
    dx = L / Nx
    dt = T / Nt

    # CFL stability check
    r = alpha * dt / dx**2
    if r > 0.5:
        raise ValueError(f"CFL violated: r = {r:.4f} > 0.5. Reduce dt or increase Nx.")
    print(f"Grid: Nx={Nx}, Nt={Nt}, dx={dx:.4e}, dt={dt:.4e}, CFL r={r:.4f}")

    x = np.linspace(0, L, Nx + 1)
    u = u0_func(x) if u0_func else np.sin(np.pi * x / L)

    # Enforce BCs
    u[0] = u_left
    u[-1] = u_right

    # Time stepping (explicit Euler)
    u_history = [u.copy()]
    t_history = [0.0]

    for n in range(Nt):
        u_new = u.copy()
        u_new[1:-1] = u[1:-1] + r * (u[2:] - 2*u[1:-1] + u[:-2])
        u_new[0] = u_left
        u_new[-1] = u_right
        u = u_new

        if (n + 1) % (Nt // 10) == 0:
            u_history.append(u.copy())
            t_history.append((n + 1) * dt)

    return x, u_history, t_history

# Solve and plot
x, u_hist, t_hist = solve_heat_1d()

fig, ax = plt.subplots(figsize=(10, 6))
for u, t in zip(u_hist, t_hist):
    ax.plot(x, u, label=f't = {t:.3f}')
ax.set_xlabel('x')
ax.set_ylabel('u(x,t)')
ax.set_title('1D Heat Equation')
ax.legend()
ax.grid(True, alpha=0.3)
plt.savefig('heat_1d.png', dpi=150, bbox_inches='tight')

# Validate against analytical solution
# u(x,t) = sin(πx/L) * exp(-α(π/L)²t)
u_exact = np.sin(np.pi * x) * np.exp(-0.01 * (np.pi)**2 * t_hist[-1])
error = np.max(np.abs(u_hist[-1] - u_exact))
print(f"Max error vs analytical: {error:.2e}")
```

### 2. 2D Poisson Equation (Finite Differences)

$$\nabla^2 u = f(x,y)$$

```python
def solve_poisson_2d(Nx=50, Ny=50, Lx=1.0, Ly=1.0,
                     source_func=None, bc_func=None):
    """
    Solve 2D Poisson equation using direct sparse solver.
    Dirichlet BCs on all boundaries.
    """
    from scipy.sparse import diags, kron, eye
    from scipy.sparse.linalg import spsolve

    dx = Lx / Nx
    dy = Ly / Ny
    x = np.linspace(0, Lx, Nx + 1)
    y = np.linspace(0, Ly, Ny + 1)
    X, Y = np.meshgrid(x, y)

    # Interior points only
    n_interior_x = Nx - 1
    n_interior_y = Ny - 1
    N = n_interior_x * n_interior_y

    # 1D Laplacian operators
    Dxx = diags([1, -2, 1], [-1, 0, 1], shape=(n_interior_x, n_interior_x)) / dx**2
    Dyy = diags([1, -2, 1], [-1, 0, 1], shape=(n_interior_y, n_interior_y)) / dy**2

    # 2D Laplacian via Kronecker product
    Ix = eye(n_interior_x)
    Iy = eye(n_interior_y)
    L = kron(Iy, Dxx) + kron(Dyy, Ix)

    # Source term on interior
    if source_func is None:
        source_func = lambda x, y: -2 * np.pi**2 * np.sin(np.pi*x) * np.sin(np.pi*y)

    x_int = x[1:-1]
    y_int = y[1:-1]
    X_int, Y_int = np.meshgrid(x_int, y_int)
    f = source_func(X_int, Y_int).ravel()

    # Solve
    u_int = spsolve(L, f)

    # Reconstruct full solution (with BCs = 0)
    u = np.zeros((Ny + 1, Nx + 1))
    u[1:-1, 1:-1] = u_int.reshape(n_interior_y, n_interior_x)

    return X, Y, u

X, Y, u = solve_poisson_2d()

fig, ax = plt.subplots(figsize=(8, 7))
cf = ax.contourf(X, Y, u, levels=30, cmap='RdBu_r')
plt.colorbar(cf, ax=ax, label='u(x,y)')
ax.set_xlabel('x')
ax.set_ylabel('y')
ax.set_title(r'2D Poisson Equation: $\nabla^2 u = f(x,y)$')
ax.set_aspect('equal')
plt.savefig('poisson_2d.png', dpi=150, bbox_inches='tight')
```

### 3. Wave Equation (Spectral Method)

```python
def solve_wave_1d_spectral(L=2*np.pi, T=10, N=128, c=1.0, dt=0.01):
    """
    Solve 1D wave equation u_tt = c^2 u_xx using pseudospectral method.
    Periodic boundary conditions.
    """
    dx = L / N
    x = np.linspace(0, L, N, endpoint=False)
    k = np.fft.fftfreq(N, d=dx) * 2 * np.pi  # wavenumbers

    # Initial conditions
    u = np.exp(-((x - L/2)**2) / 0.1)  # Gaussian pulse
    v = np.zeros_like(u)  # zero initial velocity

    Nt = int(T / dt)
    u_hat = np.fft.fft(u)
    v_hat = np.fft.fft(v)

    # Stormer-Verlet in Fourier space
    # u_tt = -c^2 k^2 u (in Fourier space)
    omega2 = (c * k)**2

    snapshots = [(0, u.copy())]
    for n in range(Nt):
        # Leapfrog: v_hat += dt * (-omega2 * u_hat)
        v_hat -= dt * omega2 * u_hat
        u_hat += dt * v_hat

        t = (n + 1) * dt
        if (n + 1) % (Nt // 10) == 0:
            snapshots.append((t, np.real(np.fft.ifft(u_hat))))

    return x, snapshots

x, snaps = solve_wave_1d_spectral()

fig, ax = plt.subplots(figsize=(10, 6))
for t, u in snaps:
    ax.plot(x, u, label=f't = {t:.1f}')
ax.set_xlabel('x')
ax.set_ylabel('u(x,t)')
ax.set_title('1D Wave Equation (Spectral Method, Periodic BC)')
ax.legend(ncol=2)
ax.grid(True, alpha=0.3)
plt.savefig('wave_spectral.png', dpi=150, bbox_inches='tight')
```

### 4. Physics-Informed Neural Networks (DeepXDE)

For inverse problems or complex domains, use PINNs:

```bash
pip install deepxde  # uses TensorFlow or PyTorch backend
```

```python
import deepxde as dde
import numpy as np

# Example: solve u_xx + u_yy = 0 on unit square
# BC: u = sin(pi*x) on y=0, u = 0 elsewhere

def pde(x, y):
    """Laplace equation: u_xx + u_yy = 0"""
    dy_xx = dde.grad.hessian(y, x, i=0, j=0)
    dy_yy = dde.grad.hessian(y, x, i=1, j=1)
    return dy_xx + dy_yy

geom = dde.geometry.Rectangle([0, 0], [1, 1])

# Boundary conditions
def bc_bottom(x, on_boundary):
    return on_boundary and np.isclose(x[1], 0)

def bc_func(x):
    return np.sin(np.pi * x[:, 0:1])

bc1 = dde.icbc.DirichletBC(geom, bc_func, bc_bottom)
bc2 = dde.icbc.DirichletBC(geom, lambda x: 0, lambda x, on_boundary: on_boundary and not np.isclose(x[1], 0))

data = dde.data.PDE(geom, pde, [bc1, bc2],
                     num_domain=2000, num_boundary=200)

net = dde.nn.FNN([2] + [64]*3 + [1], "tanh", "Glorot uniform")
model = dde.Model(data, net)

model.compile("adam", lr=1e-3)
model.train(epochs=10000)
model.compile("L-BFGS")
model.train()
```

### 5. Method of Lines (MOL) for Time-Dependent PDEs

Convert PDE to system of ODEs, then use `solve_ivp`:

```python
from scipy.integrate import solve_ivp

def heat_equation_mol(L=1.0, alpha=0.01, Nx=100, T=0.5):
    """
    Heat equation via Method of Lines: spatial finite differences → ODE system.
    Solves with adaptive RK45 — no CFL restriction!
    """
    dx = L / Nx
    x = np.linspace(0, L, Nx + 1)

    def rhs(t, u_interior):
        u = np.zeros(Nx + 1)
        u[1:-1] = u_interior  # BCs: u[0] = u[-1] = 0
        dudt = alpha * (u[2:] - 2*u[1:-1] + u[:-2]) / dx**2
        return dudt

    u0 = np.sin(np.pi * x / L)
    sol = solve_ivp(rhs, (0, T), u0[1:-1],
                    method='RK45', rtol=1e-8, atol=1e-10,
                    t_eval=np.linspace(0, T, 100))

    return x, sol

x, sol = heat_equation_mol()
```

## Stability Reference

| Method | Stability Condition | Notes |
|---|---|---|
| Explicit Euler (heat) | r = αΔt/Δx² ≤ 0.5 | Simple but restrictive |
| Implicit Euler (heat) | Unconditionally stable | Requires linear solve per step |
| Crank-Nicolson (heat) | Unconditionally stable | 2nd order in time |
| Explicit (wave) | CFL: cΔt/Δx ≤ 1 | |
| Spectral + leapfrog | CFL with max wavenumber | Very restrictive for small Δx |
| MOL + adaptive RK | Automatic | Best general approach |
| PINN | N/A (optimization) | No stability constraint |

## Validation Checklist

After solving any PDE:
- [ ] Verify against analytical solution (if known)
- [ ] Run mesh convergence study (halve Δx, check solution doesn't change)
- [ ] Check boundary conditions are satisfied
- [ ] For conservation PDEs: verify total conserved quantity
- [ ] For time-dependent: check CFL condition (explicit methods)
- [ ] Plot residual of the PDE at the solution

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Solution blows up | CFL violation | Reduce Δt or use implicit method |
| Oscillations near boundaries | Numerical dispersion | Use higher-order scheme or finer grid |
| Slow convergence (PINN) | Bad architecture or learning rate | Try deeper network, reduce LR, use L-BFGS |
| Sparse solver fails | Matrix too large | Use iterative solver (CG, GMRES) |
| Wrong steady state | BC not properly enforced | Double-check BC implementation |
