---
name: wave-propagation
description: Simulate wave propagation — acoustic, electromagnetic, elastic, and quantum waves. FDTD, spectral methods, and absorbing boundary conditions for 1D/2D/3D wave equations with sources, scattering, and dispersion.
category: physics
version: 1.0.0
author: Synthetic Sciences
license: MIT
tags: [Wave Equation, FDTD, Acoustics, Electromagnetics, Propagation, Simulation]
dependencies: ["scipy>=1.11.0", "numpy>=1.24.0", "matplotlib>=3.7.0"]
---

# Wave Propagation

## Overview

Simulate wave propagation using finite-difference time-domain (FDTD) and spectral methods. Supports acoustic, electromagnetic, and elastic waves with various source types, boundary conditions, and media.

## When to Use

- Simulating sound, light, seismic, or water waves
- Wave scattering from obstacles
- Resonance and standing wave analysis
- Waveguide and cavity problems
- Time-domain pulse propagation

## Core Workflows

### 1. 1D Wave Equation (FDTD)

$$\frac{\partial^2 u}{\partial t^2} = c^2 \frac{\partial^2 u}{\partial x^2}$$

```python
import numpy as np
import matplotlib.pyplot as plt

def wave_1d_fdtd(Nx=1000, Nt=2000, c=1.0, dx=0.01, CFL=0.9,
                  source_pos=0.2, source_freq=5.0, bc='absorbing'):
    """
    1D wave equation solver using FDTD (leapfrog in time).
    CFL condition: c*dt/dx ≤ 1
    """
    dt = CFL * dx / c
    x = np.arange(Nx) * dx

    # Fields: u at three time levels
    u_prev = np.zeros(Nx)
    u_curr = np.zeros(Nx)
    u_next = np.zeros(Nx)

    r2 = (c * dt / dx)**2  # CFL number squared
    print(f"CFL = {c*dt/dx:.4f}, dt = {dt:.6f}")

    source_idx = int(source_pos / dx)
    snapshots = []

    for n in range(Nt):
        t = n * dt

        # Interior update
        u_next[1:-1] = (2*u_curr[1:-1] - u_prev[1:-1] +
                        r2 * (u_curr[2:] - 2*u_curr[1:-1] + u_curr[:-2]))

        # Source: Ricker wavelet
        t0 = 1.0 / source_freq
        source = (1 - 2*(np.pi*source_freq*(t - t0))**2) * \
                 np.exp(-(np.pi*source_freq*(t - t0))**2)
        u_next[source_idx] += dt**2 * source

        # Boundary conditions
        if bc == 'absorbing':
            # Mur first-order ABC
            u_next[0] = u_curr[1] + (c*dt - dx)/(c*dt + dx) * (u_next[1] - u_curr[0])
            u_next[-1] = u_curr[-2] + (c*dt - dx)/(c*dt + dx) * (u_next[-2] - u_curr[-1])
        elif bc == 'fixed':
            u_next[0] = 0
            u_next[-1] = 0
        elif bc == 'periodic':
            u_next[0] = u_next[-2]
            u_next[-1] = u_next[1]

        u_prev = u_curr.copy()
        u_curr = u_next.copy()

        if n % (Nt // 10) == 0:
            snapshots.append((t, u_curr.copy()))

    return x, snapshots

x, snaps = wave_1d_fdtd()

fig, ax = plt.subplots(figsize=(12, 6))
for t, u in snaps:
    ax.plot(x, u + t*0.3, linewidth=0.8, label=f't={t:.3f}')
ax.set_xlabel('x [m]')
ax.set_ylabel('u (offset by time)')
ax.set_title('1D Wave Propagation (Ricker Source, Absorbing BCs)')
ax.legend(ncol=2, fontsize=8)
ax.grid(True, alpha=0.3)
plt.savefig('wave_1d.png', dpi=150, bbox_inches='tight')
```

### 2. 2D Wave Equation

```python
def wave_2d_fdtd(Nx=200, Ny=200, Nt=500, c=1.0, dx=0.01, CFL=0.7):
    """2D wave equation using FDTD."""
    dt = CFL * dx / (c * np.sqrt(2))  # 2D CFL

    u_prev = np.zeros((Nx, Ny))
    u_curr = np.zeros((Nx, Ny))
    u_next = np.zeros((Nx, Ny))

    r2 = (c * dt / dx)**2
    source_i, source_j = Nx // 4, Ny // 2

    snapshots = []

    for n in range(Nt):
        t = n * dt

        # Interior
        u_next[1:-1, 1:-1] = (
            2*u_curr[1:-1, 1:-1] - u_prev[1:-1, 1:-1] + r2 * (
                u_curr[2:, 1:-1] + u_curr[:-2, 1:-1] +
                u_curr[1:-1, 2:] + u_curr[1:-1, :-2] -
                4*u_curr[1:-1, 1:-1]
            )
        )

        # Source
        freq = 10.0
        t0 = 0.1
        source = (1 - 2*(np.pi*freq*(t-t0))**2) * np.exp(-(np.pi*freq*(t-t0))**2)
        u_next[source_i, source_j] += dt**2 * source

        # Absorbing BCs (simple)
        u_next[0, :] = u_next[1, :]
        u_next[-1, :] = u_next[-2, :]
        u_next[:, 0] = u_next[:, 1]
        u_next[:, -1] = u_next[:, -2]

        u_prev = u_curr.copy()
        u_curr = u_next.copy()

        if n % (Nt // 6) == 0:
            snapshots.append((t, u_curr.copy()))

    return snapshots

snaps_2d = wave_2d_fdtd()

fig, axes = plt.subplots(2, 3, figsize=(15, 10))
for ax, (t, u) in zip(axes.flat, snaps_2d):
    im = ax.imshow(u.T, cmap='RdBu_r', vmin=-0.01, vmax=0.01,
                    origin='lower', extent=[0, 2, 0, 2])
    ax.set_title(f't = {t:.3f} s')
    ax.set_xlabel('x [m]')
    ax.set_ylabel('y [m]')
plt.suptitle('2D Wave Propagation')
plt.tight_layout()
plt.savefig('wave_2d.png', dpi=150, bbox_inches='tight')
```

### 3. Spectral Method (Periodic Waves)

```python
def wave_spectral(N=256, L=2*np.pi, T=10, c=1.0, dt=0.01):
    """Wave equation via pseudospectral method (periodic BC)."""
    x = np.linspace(0, L, N, endpoint=False)
    k = np.fft.fftfreq(N, d=L/N) * 2 * np.pi

    # Initial: Gaussian pulse
    u = np.exp(-((x - L/2)**2) / 0.05)
    v = np.zeros(N)  # du/dt = 0

    u_hat = np.fft.fft(u)
    v_hat = np.fft.fft(v)
    omega2 = (c * k)**2

    Nt = int(T / dt)
    snaps = [(0, u.copy())]

    for n in range(Nt):
        # Leapfrog in Fourier space
        v_hat -= dt * omega2 * u_hat
        u_hat += dt * v_hat

        if (n+1) % (Nt // 8) == 0:
            snaps.append(((n+1)*dt, np.real(np.fft.ifft(u_hat))))

    return x, snaps
```

### 4. Dispersion Relation Analysis

```python
def measure_dispersion(simulation_data, dx, dt):
    """
    Measure dispersion relation from simulation data.
    Compute 2D FFT (space-time) to get ω(k).
    """
    # 2D FFT
    ft = np.fft.fft2(simulation_data)
    ft_shifted = np.fft.fftshift(ft)

    Nt, Nx = simulation_data.shape
    k = np.fft.fftshift(np.fft.fftfreq(Nx, d=dx)) * 2 * np.pi
    omega = np.fft.fftshift(np.fft.fftfreq(Nt, d=dt)) * 2 * np.pi

    plt.figure(figsize=(8, 6))
    plt.pcolormesh(k, omega, np.log10(np.abs(ft_shifted)**2 + 1e-20),
                    cmap='hot', shading='auto')
    plt.plot(k, np.abs(k), 'w--', linewidth=1, label='ω = c|k| (exact)')
    plt.xlabel('Wavenumber k [rad/m]')
    plt.ylabel('Frequency ω [rad/s]')
    plt.title('Dispersion Relation')
    plt.colorbar(label='log₁₀|FFT|²')
    plt.legend()
    plt.savefig('dispersion.png', dpi=150)
```

## CFL Stability Conditions

| Dimension | Condition | Notes |
|---|---|---|
| 1D | c·dt/dx ≤ 1 | Exact for FDTD |
| 2D | c·dt/dx ≤ 1/√2 | Square grid |
| 3D | c·dt/dx ≤ 1/√3 | Cubic grid |

## Source Types

| Source | Formula | Use For |
|---|---|---|
| Ricker wavelet | (1-2(πft₀)²)exp(-(πft₀)²) | Seismic, broadband pulse |
| Gaussian pulse | exp(-t²/2σ²) | Simple test pulse |
| Sine burst | sin(2πft) × window | Narrowband excitation |
| Point source | δ(x-x₀)·s(t) | Monopole radiation |

## Troubleshooting

| Symptom | Fix |
|---|---|
| Solution blows up | CFL violation — reduce dt |
| Reflections from boundary | Use absorbing BC (Mur, PML) |
| Numerical dispersion | Reduce dx (need ~10-20 points per wavelength) |
| Spectral ringing | Smooth the source function |
