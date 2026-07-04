---
name: physics-databases
description: Query physics databases — NIST CODATA constants, NIST Chemistry WebBook, Materials Project, Particle Data Group (PDG), OEIS sequences. Always use these instead of hardcoding physical constants.
category: physics
version: 1.0.0
author: Synthetic Sciences
license: MIT
tags: [NIST, CODATA, Physical Constants, Database, Materials Project, PDG]
dependencies: ["scipy>=1.11.0", "numpy>=1.24.0"]
---

# Physics Databases

## Overview

Access physical constants and reference data from authoritative databases. Never hardcode physical constants — always query from `scipy.constants` (CODATA 2018) or NIST APIs.

## CRITICAL: Always Use Database Values

- NEVER type physical constants from memory
- ALWAYS use `scipy.constants` or NIST lookup
- Constants change between CODATA editions (e.g., 2014 → 2018 → 2022)

## Core Workflows

### 1. CODATA Physical Constants (scipy.constants)

```python
from scipy import constants as const

# Fundamental constants
print("=== Fundamental Constants (CODATA 2018) ===")
print(f"Speed of light:       c  = {const.c:.10e} m/s")
print(f"Planck constant:      h  = {const.h:.10e} J·s")
print(f"Reduced Planck:       ℏ  = {const.hbar:.10e} J·s")
print(f"Boltzmann constant:   k  = {const.k:.10e} J/K")
print(f"Gravitational const:  G  = {const.G:.10e} m³/(kg·s²)")
print(f"Elementary charge:    e  = {const.e:.10e} C")
print(f"Electron mass:        mₑ = {const.m_e:.10e} kg")
print(f"Proton mass:          mₚ = {const.m_p:.10e} kg")
print(f"Neutron mass:         mₙ = {const.m_n:.10e} kg")
print(f"Vacuum permittivity:  ε₀ = {const.epsilon_0:.10e} F/m")
print(f"Vacuum permeability:  μ₀ = {const.mu_0:.10e} H/m")
print(f"Avogadro number:      Nₐ = {const.N_A:.10e} mol⁻¹")
print(f"Gas constant:         R  = {const.R:.10e} J/(mol·K)")
print(f"Stefan-Boltzmann:     σ  = {const.sigma:.10e} W/(m²·K⁴)")
print(f"Fine structure:       α  = {const.fine_structure:.10e}")
print(f"Rydberg constant:     R∞ = {const.Rydberg:.10e} m⁻¹")
print(f"Bohr radius:          a₀ = {const.physical_constants['Bohr radius'][0]:.10e} m")
print(f"Standard gravity:     g  = {const.g:.6f} m/s²")
print(f"Standard atmosphere:  atm= {const.atm:.2f} Pa")
```

### 2. Unit Conversions

```python
# Energy conversions
print("\n=== Energy Conversions ===")
print(f"1 eV  = {const.eV:.10e} J")
print(f"1 cal = {const.calorie:.6f} J")
print(f"1 BTU = {const.Btu:.6f} J")
print(f"1 erg = {const.erg:.10e} J")

# Length conversions
print("\n=== Length Conversions ===")
print(f"1 Å   = {const.angstrom:.10e} m")
print(f"1 au  = {const.au:.6e} m")  # astronomical unit
print(f"1 ly  = {const.light_year:.6e} m")
print(f"1 pc  = {const.parsec:.6e} m")

# Temperature
print(f"\n0°C = {const.zero_Celsius:.2f} K")

# Pressure
print(f"\n1 atm = {const.atm:.2f} Pa")
print(f"1 bar = {const.bar:.2f} Pa")
print(f"1 torr = {const.torr:.6f} Pa")
```

### 3. Look Up Any CODATA Constant

```python
# Search by name
def find_constant(keyword):
    """Search CODATA constants by keyword."""
    results = []
    for name, (value, unit, uncertainty) in const.physical_constants.items():
        if keyword.lower() in name.lower():
            results.append((name, value, unit, uncertainty))
            print(f"  {name}")
            print(f"    = {value:.10e} {unit}")
            print(f"    ± {uncertainty:.4e}")
    return results

print("Searching for 'Bohr':")
find_constant("Bohr")

print("\nSearching for 'magnetic moment':")
find_constant("magnetic moment")
```

### 4. Materials Project API

```python
# pip install mp-api
# Requires API key: https://materialsproject.org/api

def query_materials_project(formula, api_key=None):
    """
    Query Materials Project for material properties.
    Set MP_API_KEY environment variable or pass api_key.
    """
    try:
        from mp_api.client import MPRester
        import os

        key = api_key or os.environ.get('MP_API_KEY')
        if not key:
            print("Set MP_API_KEY environment variable")
            return None

        with MPRester(key) as mpr:
            docs = mpr.summary.search(formula=[formula])
            for doc in docs[:5]:
                print(f"  {doc.material_id}: {doc.formula_pretty}")
                print(f"    Space group: {doc.symmetry.symbol}")
                print(f"    Energy above hull: {doc.energy_above_hull:.4f} eV/atom")
                print(f"    Band gap: {doc.band_gap:.3f} eV")
                print(f"    Density: {doc.density:.3f} g/cm³")
            return docs
    except ImportError:
        print("Install mp-api: pip install mp-api")
        return None

# Example: query_materials_project("Si")
```

### 5. Particle Data Group (PDG)

```python
# Key particle properties (from PDG 2024)
# These are reference values — for precision work, check pdg.lbl.gov

particles = {
    'electron': {
        'mass_MeV': 0.51099895,
        'charge': -1,
        'spin': 0.5,
        'lifetime': 'stable',
    },
    'proton': {
        'mass_MeV': 938.27208816,
        'charge': +1,
        'spin': 0.5,
        'lifetime': 'stable (> 10^34 years)',
    },
    'neutron': {
        'mass_MeV': 939.56542052,
        'charge': 0,
        'spin': 0.5,
        'lifetime_s': 878.4,  # ~14.6 minutes
    },
    'muon': {
        'mass_MeV': 105.6583755,
        'charge': -1,
        'spin': 0.5,
        'lifetime_s': 2.1969811e-6,
    },
    'pion_charged': {
        'mass_MeV': 139.57039,
        'charge': +1,
        'spin': 0,
        'lifetime_s': 2.6033e-8,
    },
    'W_boson': {
        'mass_GeV': 80.3692,
        'charge': +1,
        'spin': 1,
    },
    'Z_boson': {
        'mass_GeV': 91.1876,
        'charge': 0,
        'spin': 1,
    },
    'Higgs': {
        'mass_GeV': 125.20,
        'charge': 0,
        'spin': 0,
    },
}

# Always cite: "Particle Data Group, Phys. Rev. D 110, 030001 (2024)"
# For precision values: https://pdg.lbl.gov
```

### 6. Astronomical Constants

```python
# Solar system data (IAU 2015 values)
print("\n=== Astronomical Constants ===")
print(f"Solar mass:    M☉ = 1.98892e30 kg")
print(f"Solar radius:  R☉ = 6.9634e8 m")
print(f"Solar luminosity: L☉ = 3.828e26 W")
print(f"Earth mass:    M⊕ = 5.9722e24 kg")
print(f"Earth radius:  R⊕ = 6.3781e6 m")
print(f"Moon mass:     M☾ = 7.342e22 kg")
print(f"AU:            1 AU = {const.au:.6e} m")

# For precise values, use astropy:
# from astropy import constants as astro_const
# print(astro_const.M_sun)
```

## Quick Reference

| Constant | Symbol | Value | scipy.constants |
|---|---|---|---|
| Speed of light | c | 2.998×10⁸ m/s | `const.c` |
| Planck | h | 6.626×10⁻³⁴ J·s | `const.h` |
| Boltzmann | k_B | 1.381×10⁻²³ J/K | `const.k` |
| Gravitational | G | 6.674×10⁻¹¹ m³/(kg·s²) | `const.G` |
| Elementary charge | e | 1.602×10⁻¹⁹ C | `const.e` |
| Electron mass | m_e | 9.109×10⁻³¹ kg | `const.m_e` |
| Proton mass | m_p | 1.673×10⁻²⁷ kg | `const.m_p` |
| Avogadro | N_A | 6.022×10²³ mol⁻¹ | `const.N_A` |
| Gas constant | R | 8.314 J/(mol·K) | `const.R` |
| 1 eV | — | 1.602×10⁻¹⁹ J | `const.eV` |
| 1 Å | — | 1.0×10⁻¹⁰ m | `const.angstrom` |

## Tips

1. **Always `from scipy import constants as const`** — never type values manually
2. **Check units**: `const.physical_constants['Bohr radius']` returns (value, unit, uncertainty)
3. **For astrophysics**: use `astropy.constants` for additional astronomical constants
4. **For materials**: use `mp-api` to query the Materials Project database
5. **Cite your source**: "CODATA 2018 via scipy.constants" or "PDG 2024"
