---
name: hamiltonian-mechanics
description: Hamiltonian mechanics — symplectic integrators (leapfrog, Yoshida), Hamilton's equations, Poisson brackets, canonical transformations, action-angle variables, and KAM theory analysis. Use for energy-conserving long-time integration of conservative systems.
category: physics
version: 1.0.0
author: Synthetic Sciences
license: MIT
tags: [Hamiltonian, Symplectic, Leapfrog, Classical Mechanics, Energy Conservation, Physics]
dependencies: ["scipy>=1.11.0", "numpy>=1.24.0", "matplotlib>=3.7.0"]
---

# Hamiltonian Mechanics

## Overview

Solve Hamilton's equations using symplectic integrators that exactly conserve the symplectic structure and approximately conserve energy for exponentially long times. Essential for N-body problems, celestial mechanics, molecular dynamics, and any conservative system needing long-time accuracy.

## When to Use

- Conservative (energy-preserving) systems
- Long-time integration (thousands of orbits, molecular dynamics)
- N-body gravitational or Coulomb problems
- When energy drift from standard RK45 is unacceptable
- Phase space structure analysis (KAM tori, resonances)

## Do NOT Use When

- System has dissipation (use `ode-solver` with RK45/Radau)
- System is stiff (symplectic methods are explicit → CFL-limited)
- You need adaptive time-stepping (symplectic methods use fixed dt)

## Core Workflows

### 1. Leapfrog / Stormer-Verlet (2nd Order Symplectic)

```python
import numpy as np
import matplotlib.pyplot as plt

def leapfrog(dH_dq, dH_dp, q0, p0, dt, n_steps):
    """
    Leapfrog (Stormer-Verlet) symplectic integrator.

    H(q, p) is the Hamiltonian.
    dH_dq = ∂H/∂q (returns force: dp/dt = -∂H/∂q)
    dH_dp = ∂H/∂p (returns velocity: dq/dt = ∂H/∂p)
    """
    n = len(q0)
    q = np.zeros((n_steps + 1, n))
    p = np.zeros((n_steps + 1, n))
    q[0] = q0
    p[0] = p0

    for i in range(n_steps):
        # Half-step momentum
        p_half = p[i] - 0.5 * dt * dH_dq(q[i], p[i])
        # Full-step position
        q[i+1] = q[i] + dt * dH_dp(q[i], p_half)
        # Half-step momentum
        p[i+1] = p_half - 0.5 * dt * dH_dq(q[i+1], p_half)

    return q, p

# Example: Kepler problem (2D)
# H = p²/2 - 1/|q|  (GM = 1)
def dH_dq(q, p):
    r = np.linalg.norm(q)
    return q / r**3  # -∂V/∂q with minus absorbed

def dH_dp(q, p):
    return p  # ∂T/∂p = p/m, m=1

# Elliptical orbit
q0 = np.array([1.0, 0.0])
p0 = np.array([0.0, 0.8])  # sub-circular → ellipse
dt = 0.01
n_steps = 100000  # 1000 time units

q, p = leapfrog(dH_dq, dH_dp, q0, p0, dt, n_steps)

# Check energy conservation
H = 0.5 * np.sum(p**2, axis=1) - 1 / np.linalg.norm(q, axis=1)
print(f"Energy conservation: max |ΔH/H₀| = {np.max(np.abs((H - H[0])/H[0])):.2e}")

fig, axes = plt.subplots(1, 2, figsize=(14, 6))
axes[0].plot(q[:, 0], q[:, 1], 'b-', linewidth=0.3)
axes[0].plot(0, 0, 'yo', markersize=10, label='Central body')
axes[0].set_xlabel('x')
axes[0].set_ylabel('y')
axes[0].set_title('Orbit (Leapfrog)')
axes[0].set_aspect('equal')
axes[0].legend()
axes[0].grid(True, alpha=0.3)

t = np.arange(n_steps + 1) * dt
axes[1].plot(t, (H - H[0])/abs(H[0]), 'r-', linewidth=0.3)
axes[1].set_xlabel('Time')
axes[1].set_ylabel('ΔH/|H₀|')
axes[1].set_title('Energy Conservation')
axes[1].grid(True, alpha=0.3)

plt.tight_layout()
plt.savefig('kepler_leapfrog.png', dpi=150, bbox_inches='tight')
```

### 2. Yoshida 4th Order Symplectic

```python
def yoshida4(dH_dq, dH_dp, q0, p0, dt, n_steps):
    """
    4th-order symplectic integrator (Yoshida 1990).
    Composes three leapfrog steps with specific coefficients.
    """
    # Yoshida coefficients
    w1 = 1 / (2 - 2**(1/3))
    w0 = -2**(1/3) * w1
    c = [w1/2, (w0+w1)/2, (w0+w1)/2, w1/2]
    d = [w1, w0, w1, 0]  # last is unused

    n = len(q0)
    q = np.zeros((n_steps + 1, n))
    p = np.zeros((n_steps + 1, n))
    q[0] = q0
    p[0] = p0

    for i in range(n_steps):
        qi, pi = q[i].copy(), p[i].copy()
        for k in range(4):
            qi = qi + c[k] * dt * dH_dp(qi, pi)
            if k < 3:
                pi = pi - d[k] * dt * dH_dq(qi, pi)
        q[i+1] = qi
        p[i+1] = pi

    return q, p

# Compare leapfrog vs Yoshida on same problem
q_y, p_y = yoshida4(dH_dq, dH_dp, q0, p0, dt, n_steps)
H_y = 0.5 * np.sum(p_y**2, axis=1) - 1 / np.linalg.norm(q_y, axis=1)
print(f"Yoshida4 energy: max |ΔH/H₀| = {np.max(np.abs((H_y - H_y[0])/H_y[0])):.2e}")
```

### 3. N-Body Problem

```python
def nbody_leapfrog(masses, q0, p0, dt, n_steps, G=1.0):
    """
    N-body gravitational simulation with leapfrog.
    q0: (N, 3) positions
    p0: (N, 3) momenta
    """
    N = len(masses)

    def acceleration(q):
        a = np.zeros_like(q)
        for i in range(N):
            for j in range(i+1, N):
                rij = q[j] - q[i]
                r = np.linalg.norm(rij)
                force = G * masses[i] * masses[j] / r**3 * rij
                a[i] += force / masses[i]
                a[j] -= force / masses[j]
        return a

    q = q0.copy()
    p = p0.copy()
    v = p / masses[:, None]

    trajectory = [q.copy()]

    a = acceleration(q)
    for step in range(n_steps):
        v += 0.5 * dt * a
        q += dt * v
        a = acceleration(q)
        v += 0.5 * dt * a

        if step % 100 == 0:
            trajectory.append(q.copy())

    return np.array(trajectory)

# 3-body problem (figure-8 solution)
masses = np.array([1.0, 1.0, 1.0])
# Chenciner-Montgomery initial conditions
q0 = np.array([
    [-0.97000436, 0.24308753, 0],
    [0.97000436, -0.24308753, 0],
    [0, 0, 0]
])
v0_base = np.array([0.4662036850, 0.4323657300, 0])
p0 = np.array([-v0_base/2, -v0_base/2, v0_base])

traj = nbody_leapfrog(masses, q0, p0, dt=0.001, n_steps=100000)
```

### 4. Poincare Surface of Section

```python
def poincare_section_hamiltonian(dH_dq, dH_dp, H_func, q0, p0, dt, n_steps,
                                  section_idx=0, section_val=0.0):
    """
    Compute Poincare section for a Hamiltonian system.
    Collects (q_j, p_j) when q[section_idx] crosses section_val.
    """
    q, p = leapfrog(dH_dq, dH_dp, q0, p0, dt, n_steps)

    crossings_q = []
    crossings_p = []

    for i in range(1, len(q)):
        q_prev = q[i-1, section_idx] - section_val
        q_curr = q[i, section_idx] - section_val

        if q_prev < 0 and q_curr >= 0:  # positive crossing
            # Linear interpolation
            frac = -q_prev / (q_curr - q_prev)
            q_cross = q[i-1] + frac * (q[i] - q[i-1])
            p_cross = p[i-1] + frac * (p[i] - p[i-1])

            # Record other phase space coordinates
            other_idx = [j for j in range(len(q0)) if j != section_idx]
            crossings_q.append(q_cross[other_idx])
            crossings_p.append(p_cross[other_idx])

    return np.array(crossings_q), np.array(crossings_p)
```

## Integrator Comparison

| Method | Order | Energy Error (1000 orbits) | Cost/Step | Best For |
|---|---|---|---|---|
| Euler (non-symplectic) | 1 | O(1) — drifts! | 1× | Never use for Hamiltonian |
| Leapfrog/Verlet | 2 | O(dt²) bounded | 1× | Default choice |
| Yoshida 4th order | 4 | O(dt⁴) bounded | 3× | High accuracy needed |
| Ruth 3rd order | 3 | O(dt³) bounded | 3× | Rarely used |
| RK4 (non-symplectic) | 4 | O(dt⁴) but DRIFTS | 4× | Short integrations only |

## Why Symplectic Matters

- **Non-symplectic** (RK4, Euler): Energy drifts linearly or worse → orbits spiral in/out
- **Symplectic** (Leapfrog, Yoshida): Energy oscillates around true value with bounded error
- For 10⁶ time steps, symplectic wins by orders of magnitude in energy conservation

## Troubleshooting

| Symptom | Fix |
|---|---|
| Energy drifts monotonically | You're using a non-symplectic method — switch to leapfrog |
| Close encounters cause blowup | Soften potential: 1/r → 1/√(r² + ε²) |
| Need adaptive timestep | Use time-transformed leapfrog (Mikkola & Aarseth) |
| Phase space structure smeared | Reduce dt (symplectic structure preserved at any dt, but accuracy improves) |
