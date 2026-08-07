---
name: simulator-validation
description: Validate an ODE, PDE, CFD, materials, molecular, or physics simulator with executable convergence, residual, invariant, and reference checks. Use before trusting a numerical result, comparing solvers, or making a benchmark or scientific claim from simulated data.
---

# Simulator Validation

Treat simulation as a numerical experiment with a falsifiable validation contract, not as a picture generator.

## Select the smallest credible simulator

Choose from the problem structure and installed capability:

- analytic, symbolic, or low-dimensional ODE: SymPy and SciPy;
- structured finite differences or finite volumes: NumPy/SciPy or FiPy;
- unstructured finite elements and multiphysics: FEniCSx/DOLFINx;
- spectral PDEs: Dedalus or a documented spectral implementation;
- production CFD: OpenFOAM or SU2 when its model and mesh support are required;
- atomistic/material workflows: ASE or pymatgen as workflow layers plus the declared physical engine;
- molecular dynamics: OpenMM, GROMACS, or LAMMPS according to force field and scale.

Check the actual executable/import and capture its exact version. Do not silently replace an unavailable solver with a different physical model.

## Freeze the problem

Record equations, coefficients, units or nondimensionalization, domain and geometry, material regions, initial and boundary conditions, scheme and formal order, mesh/timestep sequence, linear/nonlinear solvers, tolerances, stopping rules, and random seeds. Hash the effective simulator configuration.

Choose at least one reference:

- analytic solution;
- manufactured solution with derived source term;
- trusted benchmark solution;
- independently implemented solver; or
- known limiting/asymptotic result.

## Run a refinement study

Use at least three systematically refined levels. Evaluate the same quantity and norm on every level. Capture a validation JSON:

```json
{
  "simulator":{"name":"solver","version":"1.2.3","command":"solver case.yaml","configSHA256":"64-hex"},
  "expectedOrder":2,
  "orderTolerance":0.3,
  "maxResidual":1e-8,
  "invariantTolerances":{"mass_drift":1e-6},
  "levels":[
    {"label":"coarse","h":0.1,"error":0.01,"residual":1e-9,"invariants":{"mass_drift":2e-7}},
    {"label":"medium","h":0.05,"error":0.0025,"residual":2e-9,"invariants":{"mass_drift":3e-7}},
    {"label":"fine","h":0.025,"error":0.000625,"residual":3e-9,"invariants":{"mass_drift":4e-7}}
  ]
}
```

Validate it:

```bash
python scripts/validate_convergence.py validation.json --output validation-report.json
```

The script exits nonzero unless resolution decreases, error decreases, median observed order meets tolerance, every residual passes, and every declared invariant deviation stays bounded.

## Adversarial validation

Also test applicable properties:

- timestep and solver-tolerance sensitivity;
- conservation, positivity, symmetry, maximum principle, or boundedness;
- coordinate, sign, and unit conventions;
- stiffness, shocks, singularities, mesh distortion, or chaotic sensitivity;
- domain truncation and boundary reflection;
- independent implementation or clean replay for the headline result.

Keep failed levels and nonconvergent runs. A small residual alone does not establish discretization accuracy, and visual agreement is not a convergence test.

## Report

Publish simulator/version, configuration hash, level table, error norm, observed orders, residuals, invariant deviations, reference identity, artifacts, compute, and the validator report. Do not claim physical fidelity beyond the validated model regime.
