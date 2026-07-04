---
name: flow-cytometry-analysis
description: Complete flow cytometry analysis pipeline. FCS file handling, compensation, manual/automated gating, immunophenotyping, CFSE proliferation analysis, cell cycle analysis (Dean-Jett-Fox), and apoptosis assays. Extends flowio with analytical workflows. For raw FCS parsing only use flowio.
category: biology
license: MIT license
metadata:
    skill-author: InkVell Inc.
---

# Flow Cytometry Analysis: Complete Analysis Pipeline

## Overview

Flow Cytometry Analysis provides end-to-end computational workflows for analyzing flow cytometry data. Starting from FCS file parsing, through compensation matrix application, gating strategies (manual rectangular/polygon gates and automated Gaussian mixture model gating), to downstream analyses including immunophenotyping, CFSE proliferation tracking, cell cycle phase quantification (Dean-Jett-Fox model), and apoptosis assays (Annexin V/PI). This skill extends basic FCS file handling (flowio) with full analytical pipelines.

## When to Use This Skill

- Analyzing multi-color flow cytometry experiments
- Applying compensation matrices to correct spectral overlap
- Building sequential gating hierarchies (debris exclusion, singlet gating, live/dead, marker gating)
- Immunophenotyping with multi-marker panels (CD3, CD4, CD8, etc.)
- Quantifying cell proliferation from CFSE/CellTrace dilution
- Determining cell cycle phase distribution from DNA content histograms
- Analyzing apoptosis from Annexin V / propidium iodide staining
- Creating density plots, histograms, and overlay visualizations
- Automated gating for high-throughput cytometry experiments

**Related Skills:** For raw FCS file parsing and creation use `flowio`. For single-cell RNA-seq analysis use `scanpy`.

## Installation

```bash
uv pip install flowio fcsparser scipy numpy pandas matplotlib scikit-learn
```

## Quick Start

```python
from flowio import FlowData
import numpy as np

# Read FCS file
fcs = FlowData('sample.fcs')
events = fcs.as_array()
channels = fcs.pnn_labels

print(f"Events: {events.shape[0]}, Channels: {len(channels)}")
print(f"Channels: {channels}")

# Simple FSC/SSC gate (remove debris)
fsc_idx = channels.index('FSC-A')
ssc_idx = channels.index('SSC-A')
mask = (events[:, fsc_idx] > 50000) & (events[:, ssc_idx] > 10000)
gated = events[mask]
print(f"After gating: {gated.shape[0]} events ({100*mask.sum()/len(mask):.1f}%)")
```

## Core Capabilities

### 1. FCS File Handling

Read FCS files and extract channel information.

```python
from flowio import FlowData
import fcsparser
import numpy as np

# Method 1: flowio
fcs = FlowData('sample.fcs')
events = fcs.as_array()
channel_names = fcs.pnn_labels
stain_names = fcs.pns_labels

# Method 2: fcsparser (returns metadata + DataFrame)
meta, data = fcsparser.parse('sample.fcs', reformat_meta=True)
print(f"Channels: {list(data.columns)}")

# Extract compensation matrix from metadata
if '$SPILLOVER' in fcs.text or 'SPILL' in fcs.text:
    spill_str = fcs.text.get('$SPILLOVER', fcs.text.get('SPILL', ''))
    print("Compensation matrix found in metadata")
```

### 2. Compensation

Apply spectral overlap correction.

```python
import numpy as np

def parse_spillover_matrix(spill_string):
    """Parse $SPILLOVER or SPILL keyword from FCS metadata."""
    parts = spill_string.split(',')
    n = int(parts[0])
    channel_names = parts[1:n+1]
    values = [float(x) for x in parts[n+1:]]
    matrix = np.array(values).reshape(n, n)
    return channel_names, matrix

def compensate(events, fluoro_indices, spillover_matrix):
    """Apply compensation to fluorescence channels."""
    inv_spill = np.linalg.inv(spillover_matrix)
    compensated = events.copy()
    fluoro_data = events[:, fluoro_indices]
    compensated[:, fluoro_indices] = fluoro_data @ inv_spill.T
    return compensated

# Apply compensation
spill_str = fcs.text.get('$SPILLOVER', fcs.text.get('SPILL', ''))
if spill_str:
    comp_channels, spill_matrix = parse_spillover_matrix(spill_str)
    fluoro_idx = [channel_names.index(ch) for ch in comp_channels]
    events_comp = compensate(events, fluoro_idx, spill_matrix)
    print(f"Compensated {len(fluoro_idx)} fluorescence channels")
```

### 3. Gating Strategies

Apply sequential gates to identify cell populations.

**Manual rectangular gates:**

```python
import numpy as np

def rect_gate(events, ch_idx, lo, hi):
    """Apply rectangular gate on one channel."""
    return (events[:, ch_idx] >= lo) & (events[:, ch_idx] <= hi)

def polygon_gate(events, x_idx, y_idx, vertices):
    """Apply polygon gate using ray casting."""
    from matplotlib.path import Path
    points = np.column_stack([events[:, x_idx], events[:, y_idx]])
    poly = Path(vertices)
    return poly.contains_points(points)

# Sequential gating tree
# Step 1: FSC/SSC - remove debris
scatter_gate = rect_gate(events, fsc_idx, 30000, 250000) & \
               rect_gate(events, ssc_idx, 5000, 200000)

# Step 2: Singlet gate (FSC-A vs FSC-H)
fsch_idx = channel_names.index('FSC-H')
singlet_gate = scatter_gate.copy()
ratio = events[:, fsc_idx] / (events[:, fsch_idx] + 1)
singlet_gate &= (ratio > 0.8) & (ratio < 1.2)

# Step 3: Live gate (exclude viability dye positive)
# live_gate = singlet_gate & rect_gate(events, viability_idx, 0, threshold)

print(f"Debris exclusion: {scatter_gate.sum()} events")
print(f"Singlets: {singlet_gate.sum()} events")
```

**Automated gating with Gaussian Mixture Models:**

```python
from sklearn.mixture import GaussianMixture
import numpy as np

def auto_gate_gmm(events, channels_idx, n_components=2):
    """Automated gating using Gaussian Mixture Model."""
    data = events[:, channels_idx]
    # Log transform for better separation
    data_log = np.log1p(np.clip(data, 0, None))

    gmm = GaussianMixture(n_components=n_components, random_state=42)
    labels = gmm.fit_predict(data_log)

    # Identify populations by mean intensity
    means = gmm.means_
    pop_order = np.argsort(means.sum(axis=1))

    return labels, gmm, pop_order

# Auto-gate lymphocytes vs debris
labels, gmm, order = auto_gate_gmm(events, [fsc_idx, ssc_idx], n_components=3)
lymphocyte_mask = labels == order[1]  # Middle population is typically lymphocytes
print(f"Lymphocyte gate: {lymphocyte_mask.sum()} events")
```

### 4. Immunophenotyping

Multi-marker panel analysis for population identification.

```python
import numpy as np
import pandas as pd

def immunophenotype(events, channel_names, gates, parent_mask=None):
    """Calculate population frequencies from marker gates."""
    if parent_mask is None:
        parent_mask = np.ones(len(events), dtype=bool)

    results = {}
    parent_count = parent_mask.sum()

    for pop_name, marker_gates in gates.items():
        pop_mask = parent_mask.copy()
        for ch_name, threshold, direction in marker_gates:
            ch_idx = channel_names.index(ch_name)
            if direction == '+':
                pop_mask &= events[:, ch_idx] > threshold
            else:
                pop_mask &= events[:, ch_idx] <= threshold

        count = pop_mask.sum()
        freq = 100 * count / parent_count if parent_count > 0 else 0
        results[pop_name] = {'count': count, 'frequency': freq, 'mask': pop_mask}

    return results

# Define immunophenotyping panel
phenotype_gates = {
    'CD3+ T cells': [('CD3', 500, '+')],
    'CD4+ T helper': [('CD3', 500, '+'), ('CD4', 300, '+'), ('CD8', 300, '-')],
    'CD8+ T cytotoxic': [('CD3', 500, '+'), ('CD4', 300, '-'), ('CD8', 300, '+')],
    'B cells (CD19+)': [('CD3', 500, '-'), ('CD19', 200, '+')],
    'NK cells': [('CD3', 500, '-'), ('CD56', 200, '+')],
}

# Calculate (assuming live-gated events)
results = immunophenotype(events, channel_names, phenotype_gates, parent_mask=singlet_gate)
for pop, data in results.items():
    print(f"{pop}: {data['count']} cells ({data['frequency']:.1f}%)")
```

### 5. CFSE Proliferation Analysis

Quantify cell division from dye dilution.

```python
import numpy as np
from scipy.signal import find_peaks
from scipy.optimize import curve_fit

def analyze_cfse_proliferation(cfse_values, n_generations=8):
    """Analyze CFSE dilution to quantify proliferation."""
    # Log-transform CFSE values
    log_cfse = np.log2(cfse_values[cfse_values > 0])

    # Build histogram
    hist, bin_edges = np.histogram(log_cfse, bins=200)
    bin_centers = (bin_edges[:-1] + bin_edges[1:]) / 2

    # Find peaks (each peak = one generation)
    peaks, properties = find_peaks(hist, height=len(cfse_values)*0.005,
                                    distance=10, prominence=50)

    # Peaks should be ~1 log2 unit apart (halving of dye)
    peak_positions = bin_centers[peaks]
    peak_heights = hist[peaks]

    # Calculate division index
    # DI = sum(cells in gen i) / sum(cells in gen 0 equivalents)
    total_cells = sum(peak_heights)
    undivided_equiv = sum(h / (2**i) for i, h in enumerate(peak_heights))
    division_index = total_cells / undivided_equiv if undivided_equiv > 0 else 0

    # Proliferation index (only among divided cells)
    if len(peak_heights) > 1:
        divided_cells = sum(peak_heights[1:])
        divided_precursors = sum(h / (2**i) for i, h in enumerate(peak_heights[1:], 1))
        prolif_index = divided_cells / divided_precursors if divided_precursors > 0 else 0
    else:
        prolif_index = 1.0

    return {
        'n_peaks': len(peaks),
        'division_index': division_index,
        'proliferation_index': prolif_index,
        'peak_positions': peak_positions,
        'peak_heights': peak_heights
    }

# Analyze
cfse_idx = channel_names.index('CFSE') if 'CFSE' in channel_names else 0
cfse_data = events[singlet_gate, cfse_idx]
prolif = analyze_cfse_proliferation(cfse_data)
print(f"Generations detected: {prolif['n_peaks']}")
print(f"Division index: {prolif['division_index']:.2f}")
print(f"Proliferation index: {prolif['proliferation_index']:.2f}")
```

### 6. Cell Cycle Analysis

Fit DNA content histograms to determine cell cycle phase distribution.

```python
import numpy as np
from scipy.optimize import curve_fit

def dean_jett_fox(x, g1_mean, g1_std, g1_amp,
                  s_amp, s_slope,
                  g2_amp, g2_std):
    """Dean-Jett-Fox cell cycle model.
    G1 and G2/M as Gaussians, S-phase as polynomial."""
    g2_mean = 2 * g1_mean  # G2/M DNA content is 2x G1

    # G1 peak
    g1 = g1_amp * np.exp(-0.5 * ((x - g1_mean) / g1_std) ** 2)

    # G2/M peak
    g2 = g2_amp * np.exp(-0.5 * ((x - g2_mean) / g2_std) ** 2)

    # S-phase (linear between G1 and G2)
    s = np.zeros_like(x)
    s_mask = (x > g1_mean + g1_std) & (x < g2_mean - g2_std)
    s[s_mask] = s_amp + s_slope * (x[s_mask] - g1_mean)

    return g1 + g2 + np.clip(s, 0, None)

def cell_cycle_analysis(dna_values):
    """Determine G0/G1, S, G2/M percentages from PI staining."""
    hist, bin_edges = np.histogram(dna_values, bins=256, range=(0, dna_values.max()))
    bin_centers = (bin_edges[:-1] + bin_edges[1:]) / 2

    # Initial parameter estimates
    g1_peak = bin_centers[np.argmax(hist)]
    g1_amp = hist.max()

    p0 = [g1_peak, g1_peak*0.05, g1_amp, g1_amp*0.1, 0, g1_amp*0.3, g1_peak*0.07]
    bounds = ([0, 0, 0, 0, -np.inf, 0, 0],
              [np.inf, np.inf, np.inf, np.inf, np.inf, np.inf, np.inf])

    try:
        popt, pcov = curve_fit(dean_jett_fox, bin_centers, hist, p0=p0,
                                bounds=bounds, maxfev=10000)
        fitted = dean_jett_fox(bin_centers, *popt)

        # Calculate phase fractions
        g1_mean, g1_std = popt[0], popt[1]
        g2_mean = 2 * g1_mean

        g1_mask = bin_centers < (g1_mean + 2*g1_std)
        g2_mask = bin_centers > (g2_mean - 2*popt[5])
        s_mask = ~g1_mask & ~g2_mask

        total = hist.sum()
        g1_pct = 100 * hist[g1_mask].sum() / total
        s_pct = 100 * hist[s_mask].sum() / total
        g2m_pct = 100 * hist[g2_mask].sum() / total

        return {'G0/G1': g1_pct, 'S': s_pct, 'G2/M': g2m_pct}
    except RuntimeError:
        return {'error': 'Curve fitting failed — check DNA histogram quality'}

# Analyze
pi_idx = channel_names.index('PI') if 'PI' in channel_names else 0
dna_data = events[singlet_gate, pi_idx]
phases = cell_cycle_analysis(dna_data)
print(f"G0/G1: {phases.get('G0/G1', 'N/A'):.1f}%")
print(f"S: {phases.get('S', 'N/A'):.1f}%")
print(f"G2/M: {phases.get('G2/M', 'N/A'):.1f}%")
```

### 7. Apoptosis Assays

Analyze Annexin V / Propidium Iodide staining.

```python
import numpy as np

def annexin_v_pi_analysis(events, annexin_idx, pi_idx,
                          annexin_threshold, pi_threshold, parent_mask=None):
    """Quadrant analysis for apoptosis assay."""
    if parent_mask is None:
        parent_mask = np.ones(len(events), dtype=bool)

    gated = events[parent_mask]
    total = len(gated)

    annexin_pos = gated[:, annexin_idx] > annexin_threshold
    pi_pos = gated[:, pi_idx] > pi_threshold

    viable = (~annexin_pos) & (~pi_pos)
    early_apoptotic = annexin_pos & (~pi_pos)
    late_apoptotic = annexin_pos & pi_pos
    necrotic = (~annexin_pos) & pi_pos

    return {
        'viable': 100 * viable.sum() / total,
        'early_apoptotic': 100 * early_apoptotic.sum() / total,
        'late_apoptotic': 100 * late_apoptotic.sum() / total,
        'necrotic': 100 * necrotic.sum() / total
    }

# Analyze
results = annexin_v_pi_analysis(events, annexin_idx=3, pi_idx=4,
                                 annexin_threshold=200, pi_threshold=200,
                                 parent_mask=singlet_gate)
for state, pct in results.items():
    print(f"{state}: {pct:.1f}%")
```

### 8. Visualization

Create publication-quality flow cytometry plots.

```python
import matplotlib.pyplot as plt
import numpy as np

def density_plot(events, x_idx, y_idx, channel_names, ax=None, gate_mask=None):
    """2D density (pseudo-color) plot."""
    if ax is None:
        fig, ax = plt.subplots(figsize=(6, 6))
    data = events if gate_mask is None else events[gate_mask]
    ax.hist2d(data[:, x_idx], data[:, y_idx], bins=256,
              cmap='jet', norm=plt.matplotlib.colors.LogNorm())
    ax.set_xlabel(channel_names[x_idx])
    ax.set_ylabel(channel_names[y_idx])
    return ax

def histogram_overlay(datasets, channel_idx, labels, channel_name, ax=None):
    """Overlay histograms for comparing conditions."""
    if ax is None:
        fig, ax = plt.subplots(figsize=(8, 5))
    for data, label in zip(datasets, labels):
        ax.hist(data[:, channel_idx], bins=256, alpha=0.5, label=label, density=True)
    ax.set_xlabel(channel_name)
    ax.set_ylabel('Density')
    ax.legend()
    return ax
```

## Typical Workflows

### Workflow 1: Full Immunophenotyping from Multi-Color FCS Files

```python
from flowio import FlowData
import numpy as np

fcs = FlowData('pbmc_panel.fcs')
events = fcs.as_array()
ch = fcs.pnn_labels

# Compensate
spill_str = fcs.text.get('$SPILLOVER', fcs.text.get('SPILL', ''))
if spill_str:
    comp_ch, spill = parse_spillover_matrix(spill_str)
    fidx = [ch.index(c) for c in comp_ch]
    events = compensate(events, fidx, spill)

# Gate: debris → singlets → live
fsc, ssc = ch.index('FSC-A'), ch.index('SSC-A')
gate = (events[:, fsc] > 30000) & (events[:, ssc] > 5000) & (events[:, ssc] < 200000)

# Immunophenotype
panels = {
    'T cells (CD3+)': [('CD3', 500, '+')],
    'Helper T (CD3+CD4+)': [('CD3', 500, '+'), ('CD4', 300, '+')],
    'Cytotoxic T (CD3+CD8+)': [('CD3', 500, '+'), ('CD8', 300, '+')],
}
results = immunophenotype(events, ch, panels, parent_mask=gate)
for pop, data in results.items():
    print(f"{pop}: {data['frequency']:.1f}%")
```

### Workflow 2: CFSE Proliferation Analysis with Division Tracking

```python
from flowio import FlowData

fcs = FlowData('cfse_stimulated.fcs')
events = fcs.as_array()
ch = fcs.pnn_labels

# Gate live cells
fsc = ch.index('FSC-A')
live = events[:, fsc] > 20000

# CFSE analysis
cfse_idx = ch.index('CFSE')
prolif = analyze_cfse_proliferation(events[live, cfse_idx])
print(f"Divisions detected: {prolif['n_peaks']}")
print(f"Division index: {prolif['division_index']:.2f}")
print(f"Proliferation index: {prolif['proliferation_index']:.2f}")
```

### Workflow 3: Cell Cycle Distribution from PI-Stained Samples

```python
from flowio import FlowData

fcs = FlowData('pi_stained.fcs')
events = fcs.as_array()
ch = fcs.pnn_labels

# Gate singlets (PI-area vs PI-width)
pi_a = ch.index('PI-A')
pi_w = ch.index('PI-W') if 'PI-W' in ch else None

if pi_w:
    singlets = (events[:, pi_w] > 50000) & (events[:, pi_w] < 150000)
else:
    singlets = np.ones(len(events), dtype=bool)

phases = cell_cycle_analysis(events[singlets, pi_a])
for phase, pct in phases.items():
    print(f"{phase}: {pct:.1f}%")
```

## Best Practices

1. **Always compensate** before gating on fluorescence channels — uncompensated data leads to incorrect population identification
2. **Gate sequentially** — debris exclusion first, then singlets, then viability, then markers
3. **Use FMO controls** (Fluorescence Minus One) to set accurate positive/negative thresholds
4. **Log or biexponential transform** fluorescence data for visualization and gating
5. **Back-gate** to verify gated populations appear in expected scatter positions
6. **Include isotype controls** or unstained controls for threshold determination
7. **Report parent gate denominators** — frequencies must reference the correct parent population
8. **Quality check** — verify event counts are sufficient for rare populations (>100 events minimum)

## Troubleshooting

**Problem:** Compensation produces negative values
**Solution:** This is normal for properly compensated data. Do not zero-clip — negative values carry information. Use biexponential display for visualization.

**Problem:** GMM auto-gating splits one population into two
**Solution:** Reduce `n_components`. Pre-gate to remove obvious debris first. Try log-transforming data before fitting.

**Problem:** Cell cycle fitting fails
**Solution:** Ensure DNA histogram has clear G1 peak. Filter for singlets using DNA-area vs DNA-width. Check that PI staining is optimal (no under/over-staining).

**Problem:** CFSE peaks not resolved
**Solution:** Increase histogram bins. Ensure cells were labeled at correct CFSE concentration. Later generations may be unresolvable — focus on first 4-5 divisions.

**Problem:** FCS file channels have unexpected names
**Solution:** Check both `pnn_labels` (short names) and `pns_labels` (descriptive stain names). Different instruments use different naming conventions.

## Resources

- [FlowIO Documentation](https://github.com/whitews/FlowIO)
- [ISAC Data Standards](https://isac-net.org/page/data-standards)
- [Flow Cytometry Bioinformatics (Bioconductor)](https://www.bioconductor.org/packages/release/BiocViews.html#___FlowCytometry)
- [Practical Flow Cytometry by Howard Shapiro](https://onlinelibrary.wiley.com/doi/book/10.1002/0471722731)
