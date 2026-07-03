---
name: statistical-mechanics
description: Monte Carlo simulation for statistical mechanics — Ising model, Metropolis-Hastings, Wolff cluster algorithm, observables (magnetization, susceptibility, specific heat), finite-size scaling, and critical phenomena analysis.
category: physics
version: 1.0.0
author: Synthetic Sciences
license: MIT
tags: [Statistical Mechanics, Monte Carlo, Ising Model, Phase Transition, Critical Phenomena]
dependencies: ["numpy>=1.24.0", "scipy>=1.11.0", "matplotlib>=3.7.0"]
---

# Statistical Mechanics (Monte Carlo)

## Overview

Monte Carlo simulation of classical statistical mechanics models. Metropolis-Hastings and cluster algorithms for spin models, with tools for measuring observables, detecting phase transitions, and finite-size scaling analysis.

## When to Use

- Simulating spin models (Ising, Potts, XY, Heisenberg)
- Finding critical temperatures and exponents
- Computing thermodynamic observables (energy, magnetization, susceptibility, specific heat)
- Finite-size scaling analysis
- Any equilibrium statistical mechanics simulation

## Core Workflows

### 1. 2D Ising Model (Metropolis)

```python
import numpy as np
import matplotlib.pyplot as plt

class IsingModel:
    def __init__(self, L, T, J=1.0):
        self.L = L
        self.T = T
        self.J = J
        self.beta = 1.0 / T
        self.spins = np.random.choice([-1, 1], size=(L, L))

    def energy(self):
        """Total energy: H = -J Σ s_i s_j (nearest neighbors)."""
        s = self.spins
        E = -self.J * np.sum(
            s * np.roll(s, 1, axis=0) +
            s * np.roll(s, 1, axis=1)
        )
        return E

    def magnetization(self):
        return np.sum(self.spins)

    def metropolis_step(self):
        """Single Metropolis sweep (L² spin flip attempts)."""
        L = self.L
        for _ in range(L * L):
            i, j = np.random.randint(0, L, size=2)
            s = self.spins[i, j]
            # Sum of nearest neighbors
            nn = (self.spins[(i+1)%L, j] + self.spins[(i-1)%L, j] +
                  self.spins[i, (j+1)%L] + self.spins[i, (j-1)%L])
            dE = 2 * self.J * s * nn
            if dE <= 0 or np.random.rand() < np.exp(-self.beta * dE):
                self.spins[i, j] *= -1

    def wolff_step(self):
        """Wolff cluster flip (much faster near T_c)."""
        L = self.L
        p_add = 1 - np.exp(-2 * self.beta * self.J)

        i, j = np.random.randint(0, L, size=2)
        cluster_spin = self.spins[i, j]
        stack = [(i, j)]
        visited = set()
        visited.add((i, j))

        while stack:
            ci, cj = stack.pop()
            for di, dj in [(1,0),(-1,0),(0,1),(0,-1)]:
                ni, nj = (ci+di)%L, (cj+dj)%L
                if (ni, nj) not in visited and self.spins[ni, nj] == cluster_spin:
                    if np.random.rand() < p_add:
                        visited.add((ni, nj))
                        stack.append((ni, nj))

        for ci, cj in visited:
            self.spins[ci, cj] *= -1

def simulate(L, T, n_equil=1000, n_measure=5000, algorithm='metropolis'):
    """Run simulation and collect observables."""
    model = IsingModel(L, T)

    # Equilibration
    for _ in range(n_equil):
        if algorithm == 'wolff':
            model.wolff_step()
        else:
            model.metropolis_step()

    # Measurement
    E_samples = []
    M_samples = []
    N = L * L

    for _ in range(n_measure):
        if algorithm == 'wolff':
            model.wolff_step()
        else:
            model.metropolis_step()
        E_samples.append(model.energy() / N)
        M_samples.append(abs(model.magnetization()) / N)

    E = np.array(E_samples)
    M = np.array(M_samples)

    return {
        'E_mean': np.mean(E),
        'E_std': np.std(E) / np.sqrt(len(E)),
        'M_mean': np.mean(M),
        'M_std': np.std(M) / np.sqrt(len(M)),
        'C': N * np.var(E) / T**2,           # specific heat
        'chi': N * np.var(M) / T,             # susceptibility
        'spins': model.spins.copy(),
    }
```

### 2. Phase Transition: Temperature Sweep

```python
from scipy import constants as const

T_c_exact = 2 / np.log(1 + np.sqrt(2))  # ≈ 2.269 (Onsager)
print(f"Exact T_c = {T_c_exact:.4f}")

L = 32
temperatures = np.linspace(1.5, 3.5, 30)
results = []

for T in temperatures:
    res = simulate(L, T, n_equil=2000, n_measure=5000, algorithm='wolff')
    results.append(res)
    print(f"T={T:.3f}: <E>={res['E_mean']:.4f}, <|M|>={res['M_mean']:.4f}, "
          f"C={res['C']:.4f}, χ={res['chi']:.4f}")

# Plot
fig, axes = plt.subplots(2, 2, figsize=(12, 10))

E_vals = [r['E_mean'] for r in results]
M_vals = [r['M_mean'] for r in results]
C_vals = [r['C'] for r in results]
chi_vals = [r['chi'] for r in results]

for ax, vals, ylabel, title in zip(
    axes.flat,
    [E_vals, M_vals, C_vals, chi_vals],
    [r'$\langle E \rangle / N$', r'$\langle |M| \rangle / N$',
     r'$C_v / N$', r'$\chi / N$'],
    ['Energy', 'Magnetization', 'Specific Heat', 'Susceptibility']
):
    ax.plot(temperatures, vals, 'bo-', markersize=4)
    ax.axvline(T_c_exact, color='red', linestyle='--', label=f'$T_c$ = {T_c_exact:.3f}')
    ax.set_xlabel('Temperature $T$ [$J/k_B$]')
    ax.set_ylabel(ylabel)
    ax.set_title(title)
    ax.legend()
    ax.grid(True, alpha=0.3)

plt.tight_layout()
plt.savefig('ising_phase_transition.png', dpi=150, bbox_inches='tight')
```

### 3. Finite-Size Scaling

```python
def finite_size_scaling(sizes, temperatures, n_equil=3000, n_measure=10000):
    """Run simulations for multiple L to extract critical exponents."""
    all_results = {}

    for L in sizes:
        all_results[L] = []
        for T in temperatures:
            res = simulate(L, T, n_equil=n_equil, n_measure=n_measure, algorithm='wolff')
            all_results[L].append(res)
        print(f"L={L} done")

    # Find T_c from susceptibility peak for each L
    for L in sizes:
        chi = [r['chi'] for r in all_results[L]]
        T_peak = temperatures[np.argmax(chi)]
        print(f"L={L:3d}: χ peak at T = {T_peak:.3f}")

    return all_results

# sizes = [8, 16, 32, 64]
# T_range = np.linspace(2.0, 2.6, 20)
# results = finite_size_scaling(sizes, T_range)
```

### 4. Autocorrelation and Error Estimation

```python
def autocorrelation_time(data):
    """Estimate integrated autocorrelation time."""
    n = len(data)
    mean = np.mean(data)
    var = np.var(data)
    if var == 0:
        return 1.0

    acf = np.correlate(data - mean, data - mean, mode='full')[n-1:]
    acf /= acf[0]

    # Integrate until first negative value
    tau = 0.5
    for k in range(1, n // 4):
        if acf[k] < 0:
            break
        tau += acf[k]

    return tau

# Effective number of independent samples = N / (2 * tau)
# True standard error = std(data) * sqrt(2 * tau / N)
```

## Critical Exponents (2D Ising, Exact)

| Exponent | Symbol | Value | Relation |
|---|---|---|---|
| Specific heat | α | 0 (log) | C ~ |T - T_c|^(-α) |
| Order parameter | β | 1/8 | M ~ |T_c - T|^β |
| Susceptibility | γ | 7/4 | χ ~ |T - T_c|^(-γ) |
| Correlation length | ν | 1 | ξ ~ |T - T_c|^(-ν) |
| Critical isotherm | δ | 15 | M ~ H^(1/δ) at T_c |

## Troubleshooting

| Symptom | Fix |
|---|---|
| Very long equilibration | Use Wolff algorithm near T_c (no critical slowing) |
| Noisy observables | Increase measurement sweeps, check autocorrelation time |
| Wrong T_c | Finite-size effect — run larger L or use scaling |
| Magnetization doesn't go to 0 | Take |M| (absolute), not M (which fluctuates around 0) |
| Metropolis too slow near T_c | Switch to Wolff cluster algorithm |
