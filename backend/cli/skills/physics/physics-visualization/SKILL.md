---
name: physics-visualization
description: Publication-quality physics plots — vector fields, streamlines, contour maps, 3D surfaces, phase space, spectrograms, and animations. Optimized for journal submission with LaTeX labels, proper colormaps, and multi-panel layouts.
category: physics
version: 1.0.0
author: Synthetic Sciences
license: MIT
tags: [Visualization, Plotting, Physics, Publication, Matplotlib, Animation]
dependencies: ["matplotlib>=3.7.0", "numpy>=1.24.0"]
---

# Physics Visualization

## Overview

Generate publication-quality figures for physics: vector fields, streamlines, contour plots, 3D surfaces, phase diagrams, spectrograms, and animations. All plots use LaTeX rendering, proper colormaps, and journal-ready formatting.

## When to Use

- Any physics result that needs a figure
- Vector fields (E&M, fluid flow, gravitational fields)
- Contour/heatmap plots (potential fields, temperature distributions, wavefunctions)
- Phase space plots (trajectories, Poincare sections)
- 3D surface plots (energy landscapes, wavefunctions)
- Animations (time-evolving systems)
- Multi-panel comparison figures

## Setup

```python
import numpy as np
import matplotlib
matplotlib.use('Agg')  # non-interactive backend for scripts
import matplotlib.pyplot as plt
from matplotlib import cm
from mpl_toolkits.mplot3d import Axes3D

# Publication-quality defaults
plt.rcParams.update({
    'font.size': 12,
    'axes.labelsize': 14,
    'axes.titlesize': 15,
    'xtick.labelsize': 11,
    'ytick.labelsize': 11,
    'legend.fontsize': 11,
    'figure.dpi': 150,
    'savefig.dpi': 300,
    'savefig.bbox': 'tight',
    'axes.grid': True,
    'grid.alpha': 0.3,
    'lines.linewidth': 1.5,
})

# Enable LaTeX if available
try:
    plt.rcParams.update({
        'text.usetex': True,
        'font.family': 'serif',
    })
except:
    pass  # fallback to mathtext
```

## Core Plot Types

### 1. Vector Field

```python
def plot_vector_field(ax, X, Y, U, V, title='', normalize=True, cmap='viridis'):
    """Plot a 2D vector field with magnitude coloring."""
    magnitude = np.sqrt(U**2 + V**2)
    if normalize:
        U_n = U / (magnitude + 1e-10)
        V_n = V / (magnitude + 1e-10)
    else:
        U_n, V_n = U, V

    q = ax.quiver(X, Y, U_n, V_n, magnitude, cmap=cmap, alpha=0.8)
    plt.colorbar(q, ax=ax, label='|F|')
    ax.set_title(title)
    ax.set_aspect('equal')
    return q

# Example: Electric dipole field
x = np.linspace(-3, 3, 20)
y = np.linspace(-3, 3, 20)
X, Y = np.meshgrid(x, y)

# Dipole at (±0.5, 0)
def dipole_field(X, Y, d=0.5):
    r_plus = np.sqrt((X-d)**2 + Y**2)
    r_minus = np.sqrt((X+d)**2 + Y**2)
    Ex = (X-d)/r_plus**3 - (X+d)/r_minus**3
    Ey = Y/r_plus**3 - Y/r_minus**3
    return Ex, Ey

Ex, Ey = dipole_field(X, Y)
fig, ax = plt.subplots(figsize=(8, 8))
plot_vector_field(ax, X, Y, Ex, Ey, title='Electric Dipole Field')
ax.set_xlabel('x [m]')
ax.set_ylabel('y [m]')
plt.savefig('vector_field.png', dpi=150, bbox_inches='tight')
```

### 2. Streamlines

```python
fig, ax = plt.subplots(figsize=(10, 8))
x_fine = np.linspace(-3, 3, 100)
y_fine = np.linspace(-3, 3, 100)
X_f, Y_f = np.meshgrid(x_fine, y_fine)
Ex_f, Ey_f = dipole_field(X_f, Y_f)
magnitude = np.sqrt(Ex_f**2 + Ey_f**2)

strm = ax.streamplot(X_f, Y_f, Ex_f, Ey_f, color=np.log10(magnitude+1e-3),
                      cmap='inferno', density=2, linewidth=1, arrowsize=1.5)
plt.colorbar(strm.lines, ax=ax, label=r'$\log_{10}|E|$')
ax.plot([-0.5, 0.5], [0, 0], 'ro', markersize=10, label='Charges')
ax.set_xlabel('x [m]')
ax.set_ylabel('y [m]')
ax.set_title('Electric Field Streamlines')
ax.legend()
plt.savefig('streamlines.png', dpi=150, bbox_inches='tight')
```

### 3. Contour / Heatmap

```python
def plot_contour(ax, X, Y, Z, title='', levels=20, cmap='RdBu_r', symmetric=True):
    """Contour plot with optional symmetric colorbar (good for potentials)."""
    if symmetric:
        vmax = np.max(np.abs(Z))
        vmin = -vmax
    else:
        vmin, vmax = Z.min(), Z.max()

    cf = ax.contourf(X, Y, Z, levels=levels, cmap=cmap, vmin=vmin, vmax=vmax)
    cs = ax.contour(X, Y, Z, levels=levels, colors='k', linewidths=0.3, alpha=0.5)
    plt.colorbar(cf, ax=ax, label=title)
    ax.clabel(cs, inline=True, fontsize=8, fmt='%.1f')
    ax.set_aspect('equal')
    return cf

# Example: 2D wavefunction |ψ|²
r = np.linspace(-5, 5, 200)
X, Y = np.meshgrid(r, r)
R = np.sqrt(X**2 + Y**2)
# Hydrogen 2p orbital (simplified)
psi = R * np.exp(-R/2) * X / R  # p_x orbital
psi_sq = np.abs(psi)**2

fig, ax = plt.subplots(figsize=(8, 7))
plot_contour(ax, X, Y, psi_sq, title=r'$|\psi_{2p}|^2$', symmetric=False, cmap='hot')
ax.set_xlabel('x [a₀]')
ax.set_ylabel('y [a₀]')
ax.set_title(r'Hydrogen $2p_x$ Probability Density')
plt.savefig('wavefunction.png', dpi=150, bbox_inches='tight')
```

### 4. 3D Surface

```python
fig = plt.figure(figsize=(10, 8))
ax = fig.add_subplot(111, projection='3d')

# Energy landscape
x = np.linspace(-2, 2, 100)
y = np.linspace(-2, 2, 100)
X, Y = np.meshgrid(x, y)
Z = (X**2 - 1)**2 + Y**2  # double-well potential

surf = ax.plot_surface(X, Y, Z, cmap='coolwarm', alpha=0.8,
                       linewidth=0, antialiased=True)
ax.set_xlabel('x')
ax.set_ylabel('y')
ax.set_zlabel('V(x,y)')
ax.set_title('Double-Well Potential')
fig.colorbar(surf, ax=ax, shrink=0.6, label='V')
plt.savefig('surface_3d.png', dpi=150, bbox_inches='tight')
```

### 5. Animation

```python
from matplotlib.animation import FuncAnimation, PillowWriter

def create_animation(update_func, n_frames, fig, interval=50, filename='animation.gif'):
    """Create and save an animation."""
    anim = FuncAnimation(fig, update_func, frames=n_frames, interval=interval, blit=True)
    writer = PillowWriter(fps=1000/interval)
    anim.save(filename, writer=writer)
    print(f"Animation saved: {filename}")
    return anim

# Example: wave propagation
fig, ax = plt.subplots(figsize=(10, 4))
x = np.linspace(0, 10, 500)
line, = ax.plot(x, np.sin(x), 'b-', linewidth=2)
ax.set_ylim(-1.5, 1.5)
ax.set_xlabel('x')
ax.set_ylabel('u(x,t)')
time_text = ax.text(0.02, 0.95, '', transform=ax.transAxes)

def update(frame):
    t = frame * 0.05
    y = np.sin(2*np.pi*(x - t)) * np.exp(-0.1*t)
    line.set_ydata(y)
    time_text.set_text(f't = {t:.2f}')
    return line, time_text

create_animation(update, 200, fig, interval=33, filename='wave.gif')
```

### 6. Multi-Panel Figure

```python
def multi_panel(n_rows, n_cols, figsize=None, sharex=False, sharey=False):
    """Create a multi-panel figure with consistent styling."""
    if figsize is None:
        figsize = (5*n_cols, 4*n_rows)
    fig, axes = plt.subplots(n_rows, n_cols, figsize=figsize,
                              sharex=sharex, sharey=sharey)
    # Add panel labels (a), (b), (c), ...
    if n_rows * n_cols > 1:
        for i, ax in enumerate(np.atleast_1d(axes).flat):
            label = chr(ord('a') + i)
            ax.text(-0.12, 1.05, f'({label})', transform=ax.transAxes,
                    fontsize=14, fontweight='bold', va='top')
    return fig, axes
```

## Colormap Guide

| Data Type | Recommended Colormap | Why |
|---|---|---|
| Sequential (magnitude, density) | `viridis`, `plasma`, `inferno` | Perceptually uniform, colorblind-safe |
| Diverging (potential, temperature anomaly) | `RdBu_r`, `coolwarm` | Symmetric around zero |
| Cyclic (phase, angle) | `twilight`, `hsv` | Wraps around |
| Binary (positive/negative) | `bwr` | Clear sign distinction |

**Never use** `jet` or `rainbow` — they are not perceptually uniform and mislead.

## Save Format Guide

| Format | When to Use |
|---|---|
| PNG (300 dpi) | General use, presentations |
| PDF | Journal submission, vector graphics |
| SVG | Web, editable vector |
| EPS | Legacy journals requiring EPS |

Always save both PNG and PDF:
```python
plt.savefig('figure.png', dpi=300, bbox_inches='tight')
plt.savefig('figure.pdf', bbox_inches='tight')
```
