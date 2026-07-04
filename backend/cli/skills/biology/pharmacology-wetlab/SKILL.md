---
name: pharmacology-wetlab
description: Computational analysis of pharmacology wet-lab experiments. Western blot densitometry, xenograft tumor growth inhibition, pharmaceutical stability modeling (Arrhenius), radiolabeled antibody biodistribution, MIRD dosimetry, and adverse event grading. For drug databases use chembl-database or fda-database; for molecular docking use diffdock.
category: biology
license: MIT license
metadata:
    skill-author: InkVell Inc.
---

# Pharmacology Wet-Lab: Experimental Data Analysis

## Overview

Pharmacology Wet-Lab provides computational tools for analyzing data from pharmacology experiments. This skill covers western blot densitometry and quantification, xenograft tumor growth inhibition analysis, pharmaceutical stability modeling using Arrhenius kinetics, radiolabeled antibody biodistribution calculations, MIRD-based dosimetry, adverse event grading against CTCAE criteria, and dose-response curve fitting for IC50/EC50 determination.

## When to Use This Skill

- Quantifying protein expression from western blot images
- Analyzing xenograft tumor growth data and calculating TGI%
- Predicting pharmaceutical shelf life from accelerated stability data
- Processing radiolabeled antibody biodistribution data (%ID/g)
- Estimating absorbed radiation doses (MIRD dosimetry)
- Grading adverse events against CTCAE or VCOG-CTCAE scales
- Fitting dose-response curves for IC50/EC50 determination
- Calculating combination indices (Chou-Talalay method)

**Related Skills:** For drug database queries use `chembl-database` or `fda-database`. For molecular docking use `diffdock`. For survival analysis use `scikit-survival`.

## Installation

```bash
uv pip install opencv-python scipy pandas numpy matplotlib lifelines
```

## Quick Start

```python
import numpy as np
from scipy.optimize import curve_fit

# 4-Parameter Logistic for dose-response (IC50)
def four_pl(x, bottom, top, ic50, hill):
    return bottom + (top - bottom) / (1 + (x / ic50) ** hill)

concentrations = np.array([0.001, 0.01, 0.1, 1, 10, 100])  # uM
viability = np.array([98, 95, 82, 45, 12, 3])  # % viability

popt, pcov = curve_fit(four_pl, concentrations, viability,
                       p0=[0, 100, 1, 1], maxfev=10000)
print(f"IC50: {popt[2]:.3f} uM")
print(f"Hill coefficient: {popt[3]:.2f}")
```

## Core Capabilities

### 1. Western Blot Densitometry

Quantify protein bands from western blot images.

```python
import cv2
import numpy as np

def quantify_western_blot(image_path, n_lanes, band_height=50):
    """Quantify western blot band intensities.

    Args:
        image_path: path to blot image
        n_lanes: number of lanes
        band_height: expected band height in pixels
    """
    image = cv2.imread(image_path, cv2.IMREAD_GRAYSCALE)
    if image is None:
        raise FileNotFoundError(f"Cannot load {image_path}")

    # Invert (bands are dark on light background)
    inverted = 255 - image
    h, w = inverted.shape

    # Divide into lanes
    lane_width = w // n_lanes
    lane_intensities = []

    for i in range(n_lanes):
        x_start = i * lane_width + int(lane_width * 0.1)
        x_end = (i + 1) * lane_width - int(lane_width * 0.1)
        lane = inverted[:, x_start:x_end]

        # Find band (peak in vertical intensity profile)
        profile = lane.mean(axis=1)

        # Background subtraction (rolling ball approximation)
        from scipy.ndimage import minimum_filter1d
        background = minimum_filter1d(profile, size=100)
        corrected = profile - background
        corrected = np.clip(corrected, 0, None)

        # Band detection
        from scipy.signal import find_peaks
        peaks, props = find_peaks(corrected, height=corrected.max()*0.1,
                                   distance=band_height)

        # Integrate band intensity (area under curve)
        total_intensity = 0
        for peak in peaks:
            start = max(0, peak - band_height // 2)
            end = min(len(corrected), peak + band_height // 2)
            band_area = corrected[start:end].sum()
            total_intensity += band_area

        lane_intensities.append({
            'lane': i + 1,
            'raw_intensity': total_intensity,
            'n_bands': len(peaks),
            'peak_positions': list(peaks)
        })

    # Normalize to loading control (first lane or specified)
    import pandas as pd
    df = pd.DataFrame(lane_intensities)
    control_intensity = df.iloc[0]['raw_intensity']
    df['normalized'] = df['raw_intensity'] / control_intensity
    df['fold_change'] = df['normalized']

    print("Lane intensities:")
    print(df[['lane', 'raw_intensity', 'normalized', 'fold_change']])

    return df

def calculate_fold_change(target_intensities, loading_control_intensities):
    """Calculate normalized fold change with loading control.

    Args:
        target_intensities: list of target protein band intensities
        loading_control_intensities: list of loading control (e.g., actin) intensities
    """
    target = np.array(target_intensities)
    control = np.array(loading_control_intensities)

    # Normalize target to loading control
    normalized = target / control

    # Fold change relative to first sample
    fold_change = normalized / normalized[0]

    return fold_change
```

### 2. Xenograft Tumor Growth Analysis

Analyze in vivo tumor growth and treatment efficacy.

```python
import numpy as np
import pandas as pd
from scipy import stats

def calculate_tgi(tumor_volumes, groups, time_points, control_group='Vehicle'):
    """Calculate Tumor Growth Inhibition (TGI%).

    TGI% = (1 - (Tt - T0) / (Ct - C0)) * 100
    where T=treatment, C=control, t=final, 0=initial

    Args:
        tumor_volumes: DataFrame with columns [animal_id, group, time, volume]
        control_group: name of control group
    """
    results = []
    final_time = max(time_points)

    # Control group growth
    ctrl = tumor_volumes[tumor_volumes['group'] == control_group]
    ctrl_initial = ctrl[ctrl['time'] == 0]['volume'].mean()
    ctrl_final = ctrl[ctrl['time'] == final_time]['volume'].mean()
    ctrl_growth = ctrl_final - ctrl_initial

    for group in tumor_volumes['group'].unique():
        if group == control_group:
            continue

        treat = tumor_volumes[tumor_volumes['group'] == group]
        treat_initial = treat[treat['time'] == 0]['volume'].mean()
        treat_final = treat[treat['time'] == final_time]['volume'].mean()
        treat_growth = treat_final - treat_initial

        tgi = (1 - treat_growth / ctrl_growth) * 100

        # Statistical comparison at final timepoint
        ctrl_final_vals = ctrl[ctrl['time'] == final_time]['volume'].values
        treat_final_vals = treat[treat['time'] == final_time]['volume'].values
        stat, pval = stats.mannwhitneyu(ctrl_final_vals, treat_final_vals,
                                         alternative='two-sided')

        results.append({
            'group': group,
            'TGI%': tgi,
            'mean_volume_final': treat_final,
            'control_volume_final': ctrl_final,
            'p_value': pval,
            'n_animals': len(treat['animal_id'].unique())
        })

    df = pd.DataFrame(results)
    print("Tumor Growth Inhibition:")
    print(df[['group', 'TGI%', 'mean_volume_final', 'p_value']])
    return df

def growth_delay(tumor_volumes, groups, doubling_volume):
    """Calculate tumor growth delay (time to reach doubling volume).

    Args:
        doubling_volume: target volume for comparison (e.g., 2x initial)
    """
    results = []
    for group in tumor_volumes['group'].unique():
        grp = tumor_volumes[tumor_volumes['group'] == group]
        times_to_double = []

        for animal in grp['animal_id'].unique():
            animal_data = grp[grp['animal_id'] == animal].sort_values('time')
            reached = animal_data[animal_data['volume'] >= doubling_volume]
            if len(reached) > 0:
                times_to_double.append(reached.iloc[0]['time'])

        if times_to_double:
            results.append({
                'group': group,
                'median_time_to_double': np.median(times_to_double),
                'mean_time_to_double': np.mean(times_to_double),
                'n_reached': len(times_to_double)
            })

    return pd.DataFrame(results)
```

### 3. Pharmaceutical Stability

Predict shelf life from accelerated stability data.

```python
import numpy as np
from scipy.optimize import curve_fit

def arrhenius_stability(temperatures_C, rate_constants):
    """Fit Arrhenius equation to predict shelf life.

    k = A * exp(-Ea / RT)

    Args:
        temperatures_C: storage temperatures in Celsius
        rate_constants: degradation rate constants at each temperature
    """
    T_kelvin = np.array(temperatures_C) + 273.15
    k = np.array(rate_constants)

    # Linearize: ln(k) = ln(A) - Ea/(R*T)
    ln_k = np.log(k)
    inv_T = 1 / T_kelvin

    # Linear regression
    slope, intercept, r_value, p_value, std_err = stats.linregress(inv_T, ln_k)

    R = 8.314  # J/(mol*K)
    Ea = -slope * R / 1000  # kJ/mol
    A = np.exp(intercept)

    print(f"Activation energy: {Ea:.1f} kJ/mol")
    print(f"Pre-exponential factor: {A:.4e}")
    print(f"R²: {r_value**2:.4f}")

    # Predict rate at storage temperature (25°C)
    T_storage = 25 + 273.15
    k_25 = A * np.exp(-Ea * 1000 / (R * T_storage))

    # Shelf life (time to 10% degradation, first-order kinetics)
    # C/C0 = exp(-k*t) → t = -ln(0.9) / k
    shelf_life_days = -np.log(0.9) / k_25
    shelf_life_months = shelf_life_days / 30.44

    print(f"\nPredicted at 25°C:")
    print(f"  Rate constant: {k_25:.6f} day⁻¹")
    print(f"  Shelf life (to 90%): {shelf_life_months:.0f} months ({shelf_life_days:.0f} days)")

    return {
        'Ea_kJ_mol': Ea,
        'A': A,
        'k_25C': k_25,
        'shelf_life_months': shelf_life_months,
        'shelf_life_days': shelf_life_days
    }

def fit_degradation_kinetics(time_points, concentrations, order=1):
    """Fit degradation kinetics (zero, first, or second order)."""
    time = np.array(time_points)
    conc = np.array(concentrations)

    if order == 0:
        # C = C0 - k*t
        slope, intercept, r, p, se = stats.linregress(time, conc)
        k = -slope
        r_sq = r**2
    elif order == 1:
        # ln(C) = ln(C0) - k*t
        slope, intercept, r, p, se = stats.linregress(time, np.log(conc))
        k = -slope
        r_sq = r**2
    elif order == 2:
        # 1/C = 1/C0 + k*t
        slope, intercept, r, p, se = stats.linregress(time, 1/conc)
        k = slope
        r_sq = r**2

    print(f"Order {order}: k = {k:.6f}, R² = {r_sq:.4f}")
    return {'k': k, 'r_squared': r_sq, 'order': order}
```

### 4. Radiolabeled Antibody Biodistribution

Process biodistribution data from radiolabeled compounds.

```python
import numpy as np
import pandas as pd

def calculate_biodistribution(tissue_counts, tissue_weights_g, injection_dose,
                               decay_correction_factor=1.0):
    """Calculate %ID/g from tissue radioactivity counts.

    Args:
        tissue_counts: dict of tissue_name -> counts per minute (CPM)
        tissue_weights_g: dict of tissue_name -> weight in grams
        injection_dose: total injected dose in CPM
        decay_correction_factor: factor to correct for radioactive decay
    """
    results = []
    for tissue in tissue_counts:
        cpm = tissue_counts[tissue] * decay_correction_factor
        weight = tissue_weights_g[tissue]

        id_per_g = (cpm / weight) / injection_dose * 100  # %ID/g

        results.append({
            'tissue': tissue,
            'CPM': tissue_counts[tissue],
            'weight_g': weight,
            'percent_ID_per_g': id_per_g
        })

    df = pd.DataFrame(results).sort_values('percent_ID_per_g', ascending=False)

    # Tumor-to-blood ratio (if both present)
    if 'tumor' in tissue_counts and 'blood' in tissue_counts:
        tumor_uptake = df[df['tissue'] == 'tumor']['percent_ID_per_g'].values[0]
        blood_uptake = df[df['tissue'] == 'blood']['percent_ID_per_g'].values[0]
        ratio = tumor_uptake / blood_uptake if blood_uptake > 0 else float('inf')
        print(f"Tumor-to-blood ratio: {ratio:.2f}")

    print(df[['tissue', 'percent_ID_per_g']].to_string(index=False))
    return df
```

### 5. MIRD Dosimetry

Estimate absorbed radiation dose using MIRD formalism.

```python
import numpy as np
from scipy.integrate import trapezoid

def mird_dosimetry(time_points_h, activity_values_MBq, s_values, organ_masses_kg):
    """Estimate absorbed dose using MIRD formalism.

    Dose = cumulative_activity * S_value

    Args:
        time_points_h: time points in hours
        activity_values_MBq: dict of organ -> list of activity values at each time
        s_values: dict of (source, target) -> S-value in mGy/(MBq*h)
        organ_masses_kg: dict of organ -> mass in kg
    """
    results = []
    time = np.array(time_points_h)

    for organ, activities in activity_values_MBq.items():
        act = np.array(activities)

        # Time-integrated activity (cumulative activity, A_tilde)
        cumulative_activity = trapezoid(act, time)  # MBq*h

        # Self-dose
        s_self = s_values.get((organ, organ), 0)
        dose_self = cumulative_activity * s_self  # mGy

        # Cross-dose from other organs
        dose_cross = 0
        for source_organ, source_activities in activity_values_MBq.items():
            if source_organ != organ:
                s_cross = s_values.get((source_organ, organ), 0)
                source_cumulative = trapezoid(np.array(source_activities), time)
                dose_cross += source_cumulative * s_cross

        total_dose = dose_self + dose_cross

        results.append({
            'organ': organ,
            'cumulative_activity_MBq_h': cumulative_activity,
            'self_dose_mGy': dose_self,
            'cross_dose_mGy': dose_cross,
            'total_dose_mGy': total_dose
        })

    import pandas as pd
    df = pd.DataFrame(results)
    print(df[['organ', 'cumulative_activity_MBq_h', 'total_dose_mGy']])
    return df
```

### 6. Adverse Event Grading

Grade adverse events against CTCAE v5.0 criteria.

```python
import pandas as pd

# CTCAE v5.0 grading examples (subset)
CTCAE_CRITERIA = {
    'neutrophil_count': {
        1: lambda x: 1500 <= x < 2000,  # Grade 1: LLN - 1500/mm3
        2: lambda x: 1000 <= x < 1500,  # Grade 2: 1000-1500
        3: lambda x: 500 <= x < 1000,   # Grade 3: 500-1000
        4: lambda x: x < 500,           # Grade 4: <500
    },
    'platelet_count': {
        1: lambda x: 75000 <= x < 150000,
        2: lambda x: 50000 <= x < 75000,
        3: lambda x: 25000 <= x < 50000,
        4: lambda x: x < 25000,
    },
    'hemoglobin': {
        1: lambda x: 10 <= x < 12,      # g/dL
        2: lambda x: 8 <= x < 10,
        3: lambda x: x < 8,
        4: lambda x: False,  # Life-threatening
    },
    'ALT': {
        1: lambda x: 1 <= x/40 < 3,     # x ULN (ULN=40)
        2: lambda x: 3 <= x/40 < 5,
        3: lambda x: 5 <= x/40 < 20,
        4: lambda x: x/40 >= 20,
    }
}

def grade_adverse_event(parameter, value):
    """Grade an adverse event by CTCAE v5.0."""
    if parameter not in CTCAE_CRITERIA:
        return {'grade': None, 'error': f'Unknown parameter: {parameter}'}

    criteria = CTCAE_CRITERIA[parameter]
    for grade in [4, 3, 2, 1]:  # Check highest grade first
        if criteria[grade](value):
            return {'parameter': parameter, 'value': value, 'grade': grade}

    return {'parameter': parameter, 'value': value, 'grade': 0}

def assess_dlt(adverse_events, dlt_grades={'hematologic': 4, 'non_hematologic': 3}):
    """Assess dose-limiting toxicity from adverse event list."""
    dlts = []
    for ae in adverse_events:
        if ae['grade'] >= dlt_grades.get('hematologic', 4):
            dlts.append(ae)
    return dlts
```

### 7. Dose-Response Curves

Fit dose-response data for IC50/EC50 determination.

```python
import numpy as np
from scipy.optimize import curve_fit

def four_pl(x, bottom, top, ec50, hill):
    """4-Parameter Logistic dose-response."""
    return bottom + (top - bottom) / (1 + (x / ec50) ** hill)

def fit_dose_response(concentrations, responses, response_type='inhibition'):
    """Fit dose-response curve and calculate IC50/EC50.

    Args:
        concentrations: drug concentrations
        responses: measured responses (viability %, activity, etc.)
        response_type: 'inhibition' (response decreases) or 'activation'
    """
    conc = np.array(concentrations)
    resp = np.array(responses)

    if response_type == 'inhibition':
        p0 = [resp.min(), resp.max(), np.median(conc), 1.0]
    else:
        p0 = [resp.min(), resp.max(), np.median(conc), 1.0]

    bounds = ([0, 0, 0, 0.1], [200, 200, conc.max() * 10, 10])

    popt, pcov = curve_fit(four_pl, conc, resp, p0=p0, bounds=bounds, maxfev=10000)
    perr = np.sqrt(np.diag(pcov))

    bottom, top, ec50, hill = popt

    # R-squared
    predicted = four_pl(conc, *popt)
    ss_res = np.sum((resp - predicted) ** 2)
    ss_tot = np.sum((resp - np.mean(resp)) ** 2)
    r_squared = 1 - ss_res / ss_tot

    label = 'IC50' if response_type == 'inhibition' else 'EC50'
    print(f"{label}: {ec50:.4f} ± {perr[2]:.4f}")
    print(f"Hill coefficient: {hill:.2f}")
    print(f"Bottom: {bottom:.1f}%, Top: {top:.1f}%")
    print(f"R²: {r_squared:.4f}")

    return {label: ec50, 'hill': hill, 'bottom': bottom, 'top': top,
            'r_squared': r_squared, 'params': popt}

def combination_index(drug1_ic50, drug2_ic50, combo_ic50_d1, combo_ic50_d2):
    """Calculate Chou-Talalay Combination Index.

    CI < 1: synergistic, CI = 1: additive, CI > 1: antagonistic
    """
    ci = (combo_ic50_d1 / drug1_ic50) + (combo_ic50_d2 / drug2_ic50)
    interpretation = 'synergistic' if ci < 0.9 else ('antagonistic' if ci > 1.1 else 'additive')
    print(f"CI = {ci:.3f} ({interpretation})")
    return {'CI': ci, 'interpretation': interpretation}
```

## Typical Workflows

### Workflow 1: Quantify Western Blot Bands and Calculate Fold Change

```python
# Target protein bands
target = [1500, 3200, 4800, 2100]  # Arbitrary units per lane
actin = [2000, 1950, 2100, 1900]   # Loading control

fc = calculate_fold_change(target, actin)
for i, f in enumerate(fc):
    print(f"Lane {i+1}: fold change = {f:.2f}")
```

### Workflow 2: Analyze Xenograft Tumor Growth and Calculate TGI%

```python
import pandas as pd

data = pd.DataFrame({
    'animal_id': ['V1','V1','V2','V2','T1','T1','T2','T2'],
    'group': ['Vehicle','Vehicle','Vehicle','Vehicle','Drug','Drug','Drug','Drug'],
    'time': [0, 14, 0, 14, 0, 14, 0, 14],
    'volume': [100, 800, 120, 750, 110, 350, 105, 380]
})

tgi = calculate_tgi(data, data['group'].unique(), [0, 14])
```

### Workflow 3: Predict Shelf Life from Accelerated Stability Data

```python
from scipy import stats

temps = [40, 50, 60, 70]  # Celsius
rates = [0.001, 0.003, 0.01, 0.03]  # day^-1

result = arrhenius_stability(temps, rates)
print(f"Predicted shelf life at 25°C: {result['shelf_life_months']:.0f} months")
```

## Best Practices

1. **Western blots** — always normalize to loading control (beta-actin, GAPDH, total protein); report fold change, not raw intensity
2. **Xenograft TGI** — require minimum 8-10 animals per group; report both TGI% and statistical significance; use caliper measurements consistently
3. **Stability studies** — use at least 3 temperatures for Arrhenius fitting; verify linearity of ln(k) vs 1/T; ICH guidelines require 25°C/60%RH long-term
4. **Dose-response** — use at least 6 concentrations spanning 3 log units; include 0 and saturating dose; fit with Hill slope unconstrained
5. **Combination index** — measure IC50 of each drug alone and in fixed-ratio combination; CI only valid at Fa (fraction affected) near 0.5
6. **Adverse events** — use CTCAE v5.0 for human clinical trials; VCOG-CTCAE for veterinary studies

## Troubleshooting

**Problem:** Dose-response fit gives unreasonable IC50
**Solution:** Ensure concentrations span the IC50 (responses should range from ~10% to ~90% effect). Add more points around the inflection. Check if response truly follows sigmoidal pattern.

**Problem:** Western blot quantification inconsistent
**Solution:** Ensure uniform exposure across lanes. Use ECL with linear dynamic range. Avoid saturated bands. Use total protein stain (Ponceau S) instead of housekeeping gene for normalization.

**Problem:** Arrhenius fit has low R²
**Solution:** Verify degradation follows the assumed kinetic order. Check for multiple degradation mechanisms at different temperatures. Exclude temperatures where phase transitions occur.

**Problem:** TGI% is negative
**Solution:** Treatment group grew faster than control. Verify group assignments. Check for handling errors. This can occur with growth factors or hormones.

## Resources

- [CTCAE v5.0 Grading Criteria](https://ctep.cancer.gov/protocoldevelopment/electronic_applications/ctc.htm)
- [ICH Stability Guidelines (Q1A-Q1E)](https://www.ich.org/page/quality-guidelines)
- [Chou-Talalay Method](https://doi.org/10.1124/pharmrev.58.3.621)
- [MIRD Primer](https://doi.org/10.2967/jnumed.107.046300)
