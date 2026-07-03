---
name: ode-solver
description: Solve ordinary differential equations (initial and boundary value problems). Supports stiff/non-stiff systems, event detection, Hamiltonian/symplectic integration, parameter sweeps, and phase space analysis. Use for any ODE system in physics, engineering, or applied math.
category: physics
version: 1.0.0
author: Synthetic Sciences
license: MIT
tags: [ODE, Differential Equations, Simulation, Dynamics, Physics, IVP, BVP]
dependencies: ["scipy>=1.11.0", "numpy>=1.24.0", "matplotlib>=3.7.0"]
---

# ODE Solver

## Overview

Solve systems of ordinary differential equations using scipy's battle-tested integrators. Covers initial value problems (IVP), boundary value problems (BVP), event detection, stiff systems, and Hamiltonian dynamics with symplectic integrators.

## When to Use

- Any initial value problem: dx/dt = f(t, x)
- Boundary value problems: solve with constraints at two endpoints
- Hamiltonian systems needing energy-conserving integration
- Parameter sweeps over ODE systems
- Systems with discrete events (bouncing ball, switching dynamics)

## Do NOT Use When

- Solving PDEs (use `pde-solver` or `fluidsim`)
- Fitting ODE parameters to data (use `physics-fitting`, then come back here)
- Discovering governing equations from data (use `symbolic-regression` or `sindy`)

## Core Workflows

### 1. Basic IVP (Initial Value Problem)

```python
import numpy as np
from scipy.integrate import solve_ivp
import matplotlib.pyplot as plt

# Define the system: dy/dt = f(t, y)
def harmonic_oscillator(t, y, omega=2.0):
    """Simple harmonic oscillator: x'' + omega^2 * x = 0"""
    x, v = y
    return [v, -omega**2 * x]

# Solve
t_span = (0, 10)
y0 = [1.0, 0.0]  # x(0)=1, v(0)=0
sol = solve_ivp(harmonic_oscillator, t_span, y0,
                method='RK45', t_eval=np.linspace(0, 10, 1000),
                rtol=1e-10, atol=1e-12)

# Plot
plt.plot(sol.t, sol.y[0], label='x(t)')
plt.plot(sol.t, sol.y[1], label='v(t)')
plt.xlabel('Time [s]')
plt.ylabel('State')
plt.legend()
plt.grid(True, alpha=0.3)
plt.savefig('harmonic_oscillator.png', dpi=150, bbox_inches='tight')
```

### 2. Stiff Systems

Use `method='Radau'` or `method='BDF'` for stiff problems:

```python
def stiff_system(t, y):
    """Van der Pol oscillator (stiff for large mu)"""
    mu = 1000  # stiffness parameter
    x, v = y
    return [v, mu * (1 - x**2) * v - x]

sol = solve_ivp(stiff_system, (0, 3000), [2.0, 0.0],
                method='Radau', rtol=1e-8, atol=1e-10,
                max_step=10.0)
```

**How to detect stiffness:**
- Explicit solver (RK45) takes extremely many steps or fails
- System has widely separated timescales
- Jacobian eigenvalues have large negative real parts

### 3. Event Detection

Find when specific conditions are met during integration:

```python
def projectile(t, y):
    """Projectile motion with drag"""
    x, vx, z, vz = y
    g = 9.80665
    drag = 0.01  # drag coefficient
    speed = np.sqrt(vx**2 + vz**2)
    return [vx, -drag * speed * vx,
            vz, -g - drag * speed * vz]

def hit_ground(t, y):
    """Event: z = 0 (projectile hits ground)"""
    return y[2]
hit_ground.terminal = True    # stop integration
hit_ground.direction = -1     # only when z is decreasing

def max_height(t, y):
    """Event: vz = 0 (apex)"""
    return y[3]
max_height.direction = -1

sol = solve_ivp(projectile, (0, 100), [0, 50, 0, 50],
                events=[hit_ground, max_height],
                max_step=0.1, dense_output=True)

print(f"Impact at t = {sol.t_events[0][0]:.3f} s")
print(f"Max height at t = {sol.t_events[1][0]:.3f} s")
```

### 4. Hamiltonian Systems (Symplectic Integration)

For energy-conserving systems, use symplectic methods:

```python
def symplectic_leapfrog(H_q, H_p, q0, p0, dt, n_steps):
    """
    Leapfrog (Stormer-Verlet) symplectic integrator.
    H_q = dH/dq (returns -dp/dt)
    H_p = dH/dp (returns dq/dt)
    """
    q = np.copy(q0)
    p = np.copy(p0)
    trajectory = [(q.copy(), p.copy())]

    for _ in range(n_steps):
        p -= 0.5 * dt * H_q(q, p)  # half-step momentum
        q += dt * H_p(q, p)         # full-step position
        p -= 0.5 * dt * H_q(q, p)  # half-step momentum
        trajectory.append((q.copy(), p.copy()))

    return trajectory

# Example: Kepler problem
def dH_dq(q, p):
    r = np.linalg.norm(q)
    return q / r**3  # gravitational force (GM=1)

def dH_dp(q, p):
    return p  # velocity

q0 = np.array([1.0, 0.0])   # initial position
p0 = np.array([0.0, 0.8])   # initial velocity (elliptical orbit)
traj = symplectic_leapfrog(dH_dq, dH_dp, q0, p0, dt=0.01, n_steps=10000)
```

### 5. Boundary Value Problems (BVP)

```python
from scipy.integrate import solve_bvp

def ode_bvp(x, y):
    """y'' + y = 0 (eigenvalue-like problem)"""
    return np.vstack([y[1], -y[0]])

def boundary_conditions(ya, yb):
    """y(0) = 0, y(pi) = 0"""
    return np.array([ya[0], yb[0]])

x = np.linspace(0, np.pi, 100)
y_init = np.zeros((2, x.size))
y_init[0] = np.sin(x)  # initial guess

sol = solve_bvp(ode_bvp, boundary_conditions, x, y_init)
print(f"BVP solved: {sol.success}")
```

### 6. Parameter Sweeps

```python
from functools import partial

def damped_oscillator(t, y, gamma=0.1, omega=1.0):
    x, v = y
    return [v, -2*gamma*v - omega**2 * x]

gammas = [0.05, 0.1, 0.5, 1.0, 2.0]
fig, ax = plt.subplots(figsize=(10, 6))

for gamma in gammas:
    rhs = partial(damped_oscillator, gamma=gamma)
    sol = solve_ivp(rhs, (0, 20), [1.0, 0.0],
                    t_eval=np.linspace(0, 20, 500), rtol=1e-10)
    label = f'γ={gamma}'
    if gamma < 1:
        label += ' (underdamped)'
    elif gamma == 1:
        label += ' (critical)'
    else:
        label += ' (overdamped)'
    ax.plot(sol.t, sol.y[0], label=label)

ax.set_xlabel('Time [s]')
ax.set_ylabel('x(t)')
ax.set_title('Damped Harmonic Oscillator: Parameter Sweep')
ax.legend()
ax.grid(True, alpha=0.3)
plt.savefig('damped_sweep.png', dpi=150, bbox_inches='tight')
```

## Method Selection Guide

| Problem Type | Method | When to Use |
|---|---|---|
| `RK45` | Non-stiff, general purpose | Default choice |
| `RK23` | Non-stiff, lower accuracy | Quick estimates |
| `DOP853` | Non-stiff, high accuracy | Long integrations, reference solutions |
| `Radau` | Stiff, implicit Runge-Kutta | Chemical kinetics, electrical circuits |
| `BDF` | Stiff, multistep | Large stiff systems |
| `LSODA` | Auto stiff/non-stiff detection | Unknown stiffness |
| Leapfrog/Verlet | Symplectic | Hamiltonian systems, long-time energy conservation |

## Validation Checklist

After solving any ODE:
- [ ] Check energy/invariant conservation (for conservative systems)
- [ ] Verify against analytical solution in known limits
- [ ] Confirm convergence: halve `max_step` and check solution doesn't change
- [ ] Check `sol.success` is True and `sol.message` is clean
- [ ] For stiff systems: verify `method='Radau'` or `'BDF'` was used
- [ ] Plot residuals if fitting to data

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Very slow integration | Stiff system with explicit solver | Switch to `Radau` or `BDF` |
| `max_step` warnings | Step size too large | Reduce `max_step` |
| Energy drift over long times | Non-symplectic integrator | Use leapfrog for Hamiltonian systems |
| Solution oscillates wildly | Insufficient resolution | Decrease `rtol`/`atol` |
| `solve_ivp` returns `success=False` | Integration failed | Check if system is stiff, reduce tolerances |
| Event not detected | Event function not smooth | Add `max_step` smaller than event timescale |
