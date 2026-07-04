---
name: microbial-dynamics
description: Microbial population dynamics modeling and analysis. Bacterial growth curve fitting (logistic, Gompertz, Baranyi), Lotka-Volterra community dynamics, Gillespie stochastic simulation, biofilm quantification, CFU enumeration, and genome annotation. For metabolic modeling use cobrapy; for sequence analysis use biopython.
category: biology
license: MIT license
metadata:
    skill-author: InkVell Inc.
---

# Microbial Dynamics: Population Dynamics & Modeling

## Overview

Microbial Dynamics provides computational tools for modeling and analyzing microbial populations. This skill covers bacterial growth curve fitting using standard models (logistic, Gompertz, Baranyi), multi-species community dynamics via Lotka-Volterra equations, stochastic population simulation using the Gillespie algorithm, biofilm quantification from crystal violet assays, colony-forming unit enumeration with statistical analysis, bacterial genome annotation via Prokka, and simplified anaerobic digestion modeling.

## When to Use This Skill

- Fitting bacterial growth curves from OD600 time-series data
- Extracting growth parameters: lag phase duration, maximum growth rate (mu_max), carrying capacity (K)
- Modeling multi-species microbial community interactions
- Running stochastic simulations of gene expression or population dynamics
- Processing crystal violet biofilm assay data
- Calculating CFU/mL from serial dilution plating
- Annotating bacterial genomes and extracting gene statistics
- Modeling biogas production from anaerobic digestion

**Related Skills:** For constraint-based metabolic modeling use `cobrapy`. For sequence manipulation and BLAST use `biopython`. For statistical analysis use `statistical-analysis`.

## Installation

```bash
uv pip install scipy numpy pandas matplotlib
```

For genome annotation (optional):
```bash
# conda install -c bioconda prokka
```

## Quick Start

```python
from scipy.optimize import curve_fit
import numpy as np

# Logistic growth model
def logistic(t, y0, K, r, lag):
    return K / (1 + ((K - y0) / y0) * np.exp(-r * (t - lag)))

# Example OD600 data
time = np.array([0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 12, 14, 16, 20, 24])
od600 = np.array([0.02, 0.02, 0.03, 0.06, 0.15, 0.38, 0.72, 1.05, 1.25, 1.42, 1.48, 1.50, 1.51, 1.51, 1.52])

popt, pcov = curve_fit(logistic, time, od600, p0=[0.02, 1.5, 0.5, 2.0], maxfev=10000)
print(f"y0={popt[0]:.4f}, K={popt[1]:.3f}, r={popt[2]:.3f} h^-1, lag={popt[3]:.2f} h")
```

## Core Capabilities

### 1. Growth Curve Modeling

Fit OD600 data to standard microbial growth models.

```python
import numpy as np
from scipy.optimize import curve_fit

def logistic(t, y0, K, r, lag):
    """Logistic growth model."""
    return K / (1 + ((K - y0) / y0) * np.exp(-r * (t - lag)))

def gompertz(t, y0, K, mu_max, lag):
    """Modified Gompertz growth model."""
    return y0 + (K - y0) * np.exp(-np.exp((mu_max * np.e / (K - y0)) * (lag - t) + 1))

def baranyi(t, y0, K, mu_max, lag):
    """Baranyi growth model."""
    A_t = t + (1 / mu_max) * np.log(np.exp(-mu_max * t) +
           np.exp(-mu_max * lag) - np.exp(-mu_max * (t + lag)))
    return K - np.log(1 + (np.exp(K) - np.exp(y0)) / np.exp(y0) * np.exp(-mu_max * A_t))

def fit_growth_curve(time, od600, model='logistic'):
    """Fit growth curve to OD data and return parameters."""
    models = {'logistic': logistic, 'gompertz': gompertz, 'baranyi': baranyi}
    func = models[model]

    # Initial guesses
    y0_guess = od600[0]
    K_guess = od600.max()
    r_guess = 0.5
    lag_guess = time[np.argmax(np.gradient(od600))] - 1

    p0 = [y0_guess, K_guess, r_guess, max(lag_guess, 0)]
    bounds = ([0, 0, 0, 0], [np.inf, np.inf, 10, time.max()])

    popt, pcov = curve_fit(func, time, od600, p0=p0, bounds=bounds, maxfev=10000)
    perr = np.sqrt(np.diag(pcov))

    # R-squared
    residuals = od600 - func(time, *popt)
    ss_res = np.sum(residuals**2)
    ss_tot = np.sum((od600 - np.mean(od600))**2)
    r_squared = 1 - (ss_res / ss_tot)

    param_names = ['y0', 'K', 'mu_max', 'lag']
    result = {name: {'value': val, 'std': err}
              for name, val, err in zip(param_names, popt, perr)}
    result['r_squared'] = r_squared
    result['model'] = model

    return result, popt

# Compare models
for model_name in ['logistic', 'gompertz', 'baranyi']:
    try:
        result, _ = fit_growth_curve(time, od600, model=model_name)
        print(f"{model_name}: R²={result['r_squared']:.4f}, "
              f"mu_max={result['mu_max']['value']:.3f} ± {result['mu_max']['std']:.3f} h⁻¹, "
              f"lag={result['lag']['value']:.2f} h")
    except RuntimeError:
        print(f"{model_name}: fitting failed")
```

### 2. Lotka-Volterra Community Dynamics

Simulate multi-species interactions.

```python
import numpy as np
from scipy.integrate import solve_ivp

def lotka_volterra(t, N, r, K, alpha):
    """Generalized Lotka-Volterra for n species.

    Args:
        N: array of population sizes
        r: array of intrinsic growth rates
        K: array of carrying capacities
        alpha: interaction matrix (alpha[i,j] = effect of j on i)
    """
    n = len(N)
    dNdt = np.zeros(n)
    for i in range(n):
        interaction = sum(alpha[i, j] * N[j] for j in range(n))
        dNdt[i] = r[i] * N[i] * (1 - interaction / K[i])
    return dNdt

# 3-species community
r = np.array([0.5, 0.4, 0.3])      # Growth rates
K = np.array([1000, 800, 600])       # Carrying capacities
alpha = np.array([                    # Interaction matrix
    [1.0, 0.5, 0.1],   # Species 1: self + competition from 2 and 3
    [0.3, 1.0, 0.4],   # Species 2
    [0.2, 0.6, 1.0],   # Species 3
])
N0 = np.array([10, 10, 10])  # Initial populations

sol = solve_ivp(
    lotka_volterra, [0, 100], N0,
    args=(r, K, alpha),
    t_eval=np.linspace(0, 100, 500),
    method='RK45'
)

print("Final populations:")
for i in range(3):
    print(f"  Species {i+1}: {sol.y[i, -1]:.1f}")

# Stability analysis: check if coexistence is stable
A = np.diag(1/K) @ alpha
try:
    eigenvalues = np.linalg.eigvals(A)
    stable = all(ev.real > 0 for ev in eigenvalues)
    print(f"Coexistence equilibrium is {'stable' if stable else 'unstable'}")
except np.linalg.LinAlgError:
    print("Stability analysis failed")
```

### 3. Stochastic Population Simulation

Gillespie SSA for exact stochastic simulation.

```python
import numpy as np

def gillespie_ssa(propensity_func, stoich_matrix, x0, t_end, max_steps=100000):
    """Gillespie Stochastic Simulation Algorithm.

    Args:
        propensity_func: function(x) -> array of reaction propensities
        stoich_matrix: reactions x species stoichiometry matrix
        x0: initial state vector
        t_end: simulation end time
    """
    t = 0
    x = np.array(x0, dtype=float)
    times = [t]
    states = [x.copy()]

    for step in range(max_steps):
        props = propensity_func(x)
        total_prop = np.sum(props)

        if total_prop == 0 or t >= t_end:
            break

        # Time to next reaction
        dt = np.random.exponential(1 / total_prop)
        t += dt

        if t > t_end:
            break

        # Choose reaction
        reaction = np.searchsorted(np.cumsum(props), np.random.uniform(0, total_prop))
        reaction = min(reaction, len(props) - 1)

        # Update state
        x += stoich_matrix[reaction]
        x = np.clip(x, 0, None)

        times.append(t)
        states.append(x.copy())

    return np.array(times), np.array(states)

# Birth-death-immigration model
def propensities(x):
    N = x[0]
    birth_rate = 0.5 * N
    death_rate = 0.01 * N * (N - 1)  # Density-dependent death
    immigration = 5.0
    return np.array([birth_rate, death_rate, immigration])

stoich = np.array([[1], [-1], [1]])  # Birth: +1, Death: -1, Immigration: +1

# Run ensemble
n_runs = 50
results = []
for i in range(n_runs):
    times, states = gillespie_ssa(propensities, stoich, [10], t_end=50)
    results.append((times, states))

# Summary statistics
final_pops = [states[-1, 0] for _, states in results]
print(f"Mean final population: {np.mean(final_pops):.1f} ± {np.std(final_pops):.1f}")
```

### 4. Biofilm Quantification

Process crystal violet biofilm assay data.

```python
import numpy as np
import pandas as pd

def analyze_biofilm_cv(od_data, blank_od=0.05, conditions=None):
    """Analyze crystal violet biofilm assay.

    Args:
        od_data: dict of condition -> list of OD570 replicates
        blank_od: blank well OD for background subtraction
    """
    results = []
    for condition, replicates in od_data.items():
        corrected = np.array(replicates) - blank_od
        corrected = np.clip(corrected, 0, None)
        results.append({
            'condition': condition,
            'mean_od': np.mean(corrected),
            'std_od': np.std(corrected, ddof=1),
            'n': len(corrected),
            'sem': np.std(corrected, ddof=1) / np.sqrt(len(corrected))
        })

    df = pd.DataFrame(results)
    # Normalize to control
    control_mean = df.iloc[0]['mean_od']
    df['fold_change'] = df['mean_od'] / control_mean
    return df

# Example: biofilm inhibition dose-response
od_data = {
    'Control': [0.85, 0.92, 0.88, 0.90],
    '1 uM': [0.80, 0.78, 0.82, 0.79],
    '10 uM': [0.55, 0.52, 0.58, 0.50],
    '100 uM': [0.20, 0.18, 0.22, 0.19],
}

df = analyze_biofilm_cv(od_data)
print(df[['condition', 'mean_od', 'std_od', 'fold_change']])
```

### 5. CFU Enumeration

Calculate colony-forming units from serial dilution plating.

```python
import numpy as np
from scipy import stats

def calculate_cfu(counts, dilution_factor, volume_plated_ml=0.1):
    """Calculate CFU/mL from plate counts.

    Args:
        counts: list of colony counts per plate
        dilution_factor: dilution used (e.g., 1e-6 for 10^-6)
        volume_plated_ml: volume plated in mL
    """
    counts = np.array(counts)
    cfu_per_ml = counts / (dilution_factor * volume_plated_ml)

    mean_cfu = np.mean(cfu_per_ml)
    std_cfu = np.std(cfu_per_ml, ddof=1)
    sem = std_cfu / np.sqrt(len(counts))

    # 95% confidence interval
    ci = stats.t.interval(0.95, df=len(counts)-1, loc=mean_cfu, scale=sem)

    return {
        'mean_cfu_per_ml': mean_cfu,
        'std': std_cfu,
        'sem': sem,
        'ci_95': ci,
        'n': len(counts),
        'log10_cfu': np.log10(mean_cfu)
    }

# Example
result = calculate_cfu(counts=[42, 38, 45], dilution_factor=1e-6, volume_plated_ml=0.1)
print(f"CFU/mL: {result['mean_cfu_per_ml']:.2e}")
print(f"Log10 CFU/mL: {result['log10_cfu']:.2f}")
print(f"95% CI: ({result['ci_95'][0]:.2e}, {result['ci_95'][1]:.2e})")
```

### 6. Bacterial Genome Annotation

Run Prokka and parse results.

```python
import subprocess
import pandas as pd

def run_prokka(fasta_path, output_dir, prefix='genome', genus=None, species=None):
    """Annotate bacterial genome with Prokka."""
    cmd = [
        'prokka', fasta_path,
        '--outdir', output_dir,
        '--prefix', prefix,
        '--cpus', '4',
        '--force'
    ]
    if genus:
        cmd.extend(['--genus', genus])
    if species:
        cmd.extend(['--species', species])

    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"Prokka failed: {result.stderr}")
    return f'{output_dir}/{prefix}'

def parse_prokka_gff(gff_path):
    """Parse Prokka GFF3 output to extract gene statistics."""
    genes = []
    with open(gff_path) as f:
        for line in f:
            if line.startswith('#') or line.startswith('>'):
                continue
            if '\t' not in line:
                continue
            parts = line.strip().split('\t')
            if len(parts) < 9:
                continue

            feature_type = parts[2]
            if feature_type in ('CDS', 'tRNA', 'rRNA', 'tmRNA'):
                attrs = dict(kv.split('=', 1) for kv in parts[8].split(';') if '=' in kv)
                genes.append({
                    'type': feature_type,
                    'start': int(parts[3]),
                    'end': int(parts[4]),
                    'strand': parts[6],
                    'gene': attrs.get('gene', ''),
                    'product': attrs.get('product', ''),
                    'length': int(parts[4]) - int(parts[3]) + 1
                })

    df = pd.DataFrame(genes)
    print(f"Total features: {len(df)}")
    print(f"Feature types:\n{df['type'].value_counts()}")
    print(f"Mean CDS length: {df[df['type']=='CDS']['length'].mean():.0f} bp")

    # Coding density
    total_coding = df[df['type'] == 'CDS']['length'].sum()
    genome_size = df['end'].max()
    coding_density = 100 * total_coding / genome_size
    print(f"Coding density: {coding_density:.1f}%")

    return df
```

### 7. Anaerobic Digestion Modeling

Simplified ADM1 for biogas prediction.

```python
import numpy as np
from scipy.integrate import solve_ivp

def adm1_simplified(t, y, params):
    """Simplified anaerobic digestion model.
    State: [S_substrate, X_acidogens, X_methanogens, S_VFA, CH4]
    """
    S, Xa, Xm, VFA, CH4 = y
    k_hyd = params['k_hyd']       # Hydrolysis rate
    mu_a = params['mu_a']         # Acidogen max growth rate
    Ks_a = params['Ks_a']         # Acidogen half-saturation
    mu_m = params['mu_m']         # Methanogen max growth rate
    Ks_m = params['Ks_m']         # Methanogen half-saturation
    Y_a = params['Y_a']           # Acidogen yield
    Y_m = params['Y_m']           # Methanogen yield
    kd = params['kd']             # Decay rate
    Ki = params['Ki']             # VFA inhibition constant

    # Hydrolysis
    r_hyd = k_hyd * S

    # Acidogenesis (Monod kinetics)
    r_acid = mu_a * (S / (Ks_a + S)) * Xa

    # Methanogenesis (Monod with VFA inhibition)
    inhibition = Ki / (Ki + VFA)
    r_meth = mu_m * (VFA / (Ks_m + VFA)) * Xm * inhibition

    dSdt = -r_hyd - r_acid / Y_a
    dXa = Y_a * r_acid - kd * Xa
    dXm = Y_m * r_meth - kd * Xm
    dVFA = r_acid - r_meth / Y_m
    dCH4 = r_meth

    return [dSdt, dXa, dXm, dVFA, dCH4]

params = {
    'k_hyd': 0.25, 'mu_a': 0.5, 'Ks_a': 200,
    'mu_m': 0.2, 'Ks_m': 50, 'Y_a': 0.1,
    'Y_m': 0.05, 'kd': 0.02, 'Ki': 3000
}

y0 = [5000, 100, 50, 100, 0]  # Initial conditions
sol = solve_ivp(adm1_simplified, [0, 60], y0, args=(params,),
                t_eval=np.linspace(0, 60, 300), method='RK45')

print(f"Final substrate: {sol.y[0, -1]:.0f} mg/L")
print(f"Total CH4 produced: {sol.y[4, -1]:.0f} mg/L")
```

## Typical Workflows

### Workflow 1: Fit Growth Curves and Compare Conditions

```python
import pandas as pd
import numpy as np

# Load multi-condition OD600 data
data = pd.read_csv('growth_data.csv')  # columns: time, condition, od600

results = []
for condition, group in data.groupby('condition'):
    time = group['time'].values
    od = group['od600'].values
    fit, popt = fit_growth_curve(time, od, model='gompertz')
    fit['condition'] = condition
    results.append(fit)
    print(f"{condition}: mu_max={fit['mu_max']['value']:.3f} h⁻¹, "
          f"lag={fit['lag']['value']:.1f} h, K={fit['K']['value']:.3f}")
```

### Workflow 2: Simulate 3-Species Lotka-Volterra Community

```python
import numpy as np
from scipy.integrate import solve_ivp

r = np.array([0.5, 0.4, 0.3])
K = np.array([1000, 800, 600])
alpha = np.array([[1.0, 0.5, 0.1], [0.3, 1.0, 0.4], [0.2, 0.6, 1.0]])
N0 = [10, 10, 10]

sol = solve_ivp(lotka_volterra, [0, 200], N0, args=(r, K, alpha),
                t_eval=np.linspace(0, 200, 1000), method='RK45')

for i in range(3):
    print(f"Species {i+1}: equilibrium = {sol.y[i, -1]:.0f}")
```

### Workflow 3: Annotate Bacterial Genome and Extract Statistics

```python
prefix = run_prokka('assembly.fasta', 'prokka_output', genus='Escherichia', species='coli')
genes_df = parse_prokka_gff(f'{prefix}.gff')
print(f"\nCDS count: {len(genes_df[genes_df['type'] == 'CDS'])}")
print(f"tRNA count: {len(genes_df[genes_df['type'] == 'tRNA'])}")
print(f"rRNA count: {len(genes_df[genes_df['type'] == 'rRNA'])}")
```

## Best Practices

1. **Growth curve replicates** — fit each replicate individually, then report mean ± SEM of parameters; do not average curves before fitting
2. **Model selection** — compare logistic, Gompertz, and Baranyi by AIC/BIC; Baranyi is most mechanistically justified but needs more data points during lag phase
3. **Gillespie SSA** — run sufficient ensemble size (>100 trajectories) for reliable statistics; check that propensities remain finite
4. **CFU statistics** — count plates with 30-300 colonies only; below 30 is unreliable, above 300 is too dense
5. **Biofilm normalization** — normalize to planktonic growth (OD600) to distinguish biofilm-specific effects from growth differences
6. **ODE integration** — use `RK45` for non-stiff systems, `BDF` or `Radau` for stiff systems (common in multi-species models)

## Troubleshooting

**Problem:** Growth curve fit fails to converge
**Solution:** Adjust initial parameter guesses closer to expected values. Increase `maxfev`. Check that data has sufficient points during lag and exponential phases.

**Problem:** Lotka-Volterra simulation diverges
**Solution:** Reduce step size or use adaptive solver. Check that interaction matrix doesn't produce negative populations — use `events` parameter in `solve_ivp` to stop at zero.

**Problem:** Gillespie SSA runs too slowly
**Solution:** For large populations (>10000), switch to tau-leaping approximation. Or use ODE mean-field approximation and add noise analytically.

**Problem:** Prokka fails with "no genes found"
**Solution:** Check FASTA file is properly formatted (no extra whitespace). Verify sequences are bacterial. Use `--kingdom Bacteria` flag explicitly.

## Resources

- [Baranyi Growth Model Paper](https://doi.org/10.1016/0168-1605(94)90157-0)
- [Prokka Documentation](https://github.com/tseemann/prokka)
- [scipy.integrate.solve_ivp](https://docs.scipy.org/doc/scipy/reference/generated/scipy.integrate.solve_ivp.html)
- [Gillespie Algorithm Tutorial](https://doi.org/10.1146/annurev.physchem.58.032806.104637)
