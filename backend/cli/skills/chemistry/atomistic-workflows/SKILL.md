---
name: atomistic-workflows
description: Sets up and reports atomistic calculations so they are reproducible and converged, covering ASE Atoms, calculators, optimizers and MD drivers, pymatgen structures, symmetry analysis and the Materials Project API, LAMMPS and GROMACS input basics for molecular dynamics, convergence tests for k-points, plane-wave cutoffs and timesteps, the unit system each code uses, energy-minimization stopping criteria, and archiving of exact input files. Use for DFT, classical or machine-learned potential simulations of molecules, crystals, surfaces and liquids; use molecular-dynamics for biomolecular trajectory analysis and pymatgen for detailed library usage.
summary: "ASE, pymatgen, LAMMPS and GROMACS setup with convergence tests and units per code."
category: chemistry
allowed-tools: [Read, Write, Bash, python]
license: MIT
version: 1.0.0
author: Synthetic Sciences
metadata:
  skill-author: Synthetic Sciences
---

# Atomistic workflows

An atomistic number is defined only together with its code, units, convergence parameters
and stopping criteria; a "DFT energy" without k-mesh and cutoff cannot be reproduced.

## ASE

1. `Atoms(symbols, positions, cell, pbc)`; `ase.io.read` and `write` convert between
   formats (`read("traj.xyz", index=":")` for all frames). Internal units are eV and
   angstrom; `ase.units` supplies `fs`, `kB`, `Hartree` and `Bohr` for conversion (the
   native time unit is about 10.18 fs, so always multiply by `units.fs`). Attach a
   calculator with `atoms.calc = ...` (`EMT`, `ase.calculators.vasp.Vasp`,
   `espresso.Espresso`, `lammpslib.LAMMPSlib`, a machine-learned potential), then
   `get_potential_energy()`, `get_forces()`, `get_stress()` (eV per cubic angstrom).
2. Relaxation: `from ase.optimize import BFGS, LBFGS, FIRE`, then
   `opt = BFGS(atoms, trajectory="opt.traj", logfile="opt.log")` and
   `opt.run(fmax=0.01, steps=500)`. `fmax` is the largest force on any atom in eV per
   angstrom: 0.05 is loose, 0.01 standard, 0.001 for phonons. Relax the cell with
   `FrechetCellFilter` from `ase.filters` wrapped around the atoms; fix atoms with
   `FixAtoms`. Check that `opt.run` returned converged rather than exhausting `steps`.
3. MD: `MaxwellBoltzmannDistribution(atoms, temperature_K=300)` and `Stationary(atoms)`,
   then `Langevin(atoms, 1.0 * units.fs, temperature_K=300, friction=0.01 / units.fs)`
   or `NVTBerendsen`, `NPT`; `dyn.run(steps)` with a trajectory attached; record the seed.

## pymatgen

4. `Structure.from_file("POSCAR")` or a CIF; `structure.to(filename="out.cif")`.
   Symmetry via `SpacegroupAnalyzer(structure, symprec=0.01, angle_tolerance=5)` with
   `get_space_group_symbol()` and `get_conventional_standard_structure()`; `symprec`
   changes the answer (0.01 angstrom strict, 0.1 loose), so report it.
   `Kpoints.automatic_density(structure, kppa=1000)` sets k-mesh density per reciprocal
   atom. `Vasprun("vasprun.xml")` exposes `final_energy`, `converged_electronic` and
   `converged_ionic`; read both flags. `AseAtomsAdaptor` bridges to ASE.
5. Materials Project: `from mp_api.client import MPRester`, then
   `mpr.materials.summary.search(formula="Fe2O3", fields=[...])` with fields such as
   `material_id`, `structure`, `energy_above_hull` and `band_gap`. Database energies
   carry their own functional and correction scheme; never mix them with raw energies
   from your own runs without applying the same corrections. Record the database release
   and the `material_id`.

## Convergence

6. Plane-wave DFT: converge the quantity you report (total energy per atom, an energy
   difference, forces, stress) against cutoff (VASP `ENCUT` in eV, at least 1.3 x
   `ENMAX` for stress and cell relaxation; Quantum ESPRESSO `ecutwfc` in Ry with
   `ecutrho` 4 to 12 times larger) and against k-mesh (Monkhorst-Pack or Gamma-centred,
   density stated), to a criterion such as 1 meV per atom. Metals need smearing
   (`ISMEAR`, `SIGMA`; `occupations="smearing"`, `degauss`) and denser meshes. Record
   pseudopotential or PAW set and version, functional, DFT+U values, dispersion
   correction, spin initialization, electronic (`EDIFF`, `conv_thr`) and ionic (`EDIFFG`,
   `forc_conv_thr`) thresholds. Slabs need at least 10 to 15 angstrom of vacuum and a
   dipole correction; defects need a supercell-size test.
7. MD: timestep at most 1 fs with explicit hydrogens, 2 fs with bond constraints,
   0.5 fs for high temperatures or very light atoms; validate by energy drift in NVE.
   Equilibrate NVT then NPT before production; check the observable against run length
   (block averaging or autocorrelation) and against system size.

## LAMMPS and GROMACS

8. LAMMPS: the `units` command (`metal`, `real`, `lj`, `si`) fixes every other unit in the
   input, so state it first. Skeleton: `atom_style`, `boundary p p p`, `read_data`,
   `pair_style` and `pair_coeff`, `timestep 0.001` (in the chosen time unit),
   `velocity all create 300 4928459 dist gaussian` (the seed is part of the record),
   `fix 1 all nvt temp 300 300 0.1`, `thermo_style custom step temp pe etotal press vol`,
   `dump`, `run`. `minimize 1e-8 1e-10 10000 100000` gives energy tolerance, force
   tolerance, max iterations and max force evaluations; report which criterion stopped
   it. `write_restart` and `read_restart` continue a run; `log.lammps` is the evidence.
9. GROMACS (nm, ps, kJ/mol, bar): `gmx pdb2gmx -ff amber99sb-ildn -water tip3p`,
   `gmx editconf -c -d 1.0 -bt dodecahedron`, `gmx solvate`, `gmx grompp`,
   `gmx genion -neutral -conc 0.15`. Minimization `.mdp`: `integrator = steep`,
   `emtol = 1000.0` (kJ mol^-1 nm^-1). Production: `integrator = md`, `dt = 0.002`,
   `constraints = h-bonds`, `cutoff-scheme = Verlet`, `coulombtype = PME`,
   `rcoulomb = 1.0`, `rvdw = 1.0`, `tcoupl = V-rescale`, `tau_t = 0.1`, `ref_t = 300`,
   `pcoupl = C-rescale`, `ref_p = 1.0`, `compressibility = 4.5e-5`. Restart with
   `gmx mdrun -cpi state.cpt`; analyze with `gmx energy`, `gmx rms`, `gmx trjconv`.

## Units per code

| Code | Length | Energy | Time | Force |
| --- | --- | --- | --- | --- |
| ASE | angstrom | eV | angstrom sqrt(amu/eV), about 10.18 fs | eV/angstrom |
| VASP | angstrom | eV | fs (`POTIM`) | eV/angstrom |
| Quantum ESPRESSO | Bohr or angstrom (per card flag) | Ry (`ecutwfc`, `conv_thr`) | Rydberg atomic units, 4.8378e-17 s | Ry/Bohr |
| LAMMPS `metal` | angstrom | eV | ps | eV/angstrom |
| LAMMPS `real` | angstrom | kcal/mol | fs | kcal/mol/angstrom |
| GROMACS, OpenMM | nm | kJ/mol | ps | kJ/mol/nm |

## Reproducible inputs

- Archive the exact inputs (`INCAR`, `KPOINTS`, `POSCAR`, `POTCAR` titles and hashes;
  `in.lammps` and data files; every `.mdp` and `topol.top`), seeds, a `run.sh`, code
  versions (`lmp -h`, `gmx --version`, `ase.__version__`) and the raw outputs the
  numbers came from (`OUTCAR`, `vasprun.xml`, `log.lammps`, `.edr`).
- After any format conversion, check that atom counts, cell and composition survived.
- State functional, pseudopotentials, cutoffs, k-mesh, smearing, thresholds, force field,
  water model, timestep, ensemble, T and P, run length and equilibration discarded.

## Sources

- ASE documentation (units, optimizers, molecular dynamics): https://ase-lib.org/
- pymatgen documentation: https://pymatgen.org/
- Materials Project API documentation: https://docs.materialsproject.org/
- LAMMPS manual (`units`, `minimize`, `fix nvt`): https://docs.lammps.org/
- GROMACS reference manual and `.mdp` options: https://manual.gromacs.org/current/
- VASP wiki (`ENCUT`, `KPOINTS`, `EDIFFG`): https://www.vasp.at/wiki/
- Quantum ESPRESSO `pw.x` input description: https://www.quantum-espresso.org/Doc/INPUT_PW.html
- Lejaeghere et al. (2016), Reproducibility in density functional theory calculations of solids, Science 351, aad3000: https://doi.org/10.1126/science.aad3000
