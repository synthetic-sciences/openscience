---
name: structure-analysis
description: Handles protein structure files and geometric criteria so that residue counts, contacts, hydrogen bonds and interfaces are reproducible, covering PDB versus mmCIF, author versus label chains and numbering, HETATM, water and ligand policy, alternate locations, insertion codes, biological assemblies versus the asymmetric unit, hydrogen-bond distance and angle cutoffs, interface definitions by distance or buried surface area, and the Biopython, MDAnalysis, gemmi, PyMOL and ChimeraX calls that implement them. Use whenever a task reads a structure file and reports anything derived from atom coordinates; use biopython for sequence work and molecular-docking or structure-prediction skills for generating structures.
summary: "Protein structure handling and interface, H-bond, SASA criteria; report every cutoff."
category: biology
allowed-tools: [Read, Bash, python]
license: MIT
version: 1.0.0
author: Synthetic Sciences
metadata:
  skill-author: Synthetic Sciences
---

# Protein structure analysis

One PDB entry yields different residue counts, interface lists and hydrogen-bond totals
depending on how waters, HETATM records, alternate locations and symmetry copies were
treated. Those choices, and every distance or angle cutoff, are part of the result and are
reported with it.

## Files and identity

1. Prefer PDBx/mmCIF over the legacy PDB format: PDB files break above 99,999 atoms and
   62 chains, truncate chain IDs to one character and have no entity concept. Download
   `https://files.rcsb.org/download/<id>.cif` or use Biopython
   `PDBList().retrieve_pdb_file("1abc", pdir=".", file_format="mmCif")`. Record the entry
   id, the model used (NMR ensembles have many; state the index) and the download date.
2. Chains and entities: mmCIF has `label_asym_id` (internal chain), `auth_asym_id` (the
   author chain that papers and viewers use) and `label_entity_id`; a homodimer is one
   entity with two chains. Residue numbering is `auth_seq_id` (author numbering with gaps,
   insertion codes and negatives) or `label_seq_id` (1..n over the entity sequence).
   UniProt numbering is a third scheme, mapped by SIFTS. Say which one every residue
   number in the report follows.
3. HETATM policy: ligands, ions, modified residues inside the polymer (MSE, SEP, TPO) and
   waters (HOH, DOD) are all HETATM. Decide and state whether waters are removed, ions
   kept, and modified residues counted as protein. Biopython encodes this in
   `residue.id[0]` (`" "` standard, `"W"` water, `"H_XXX"` hetero) and
   `Bio.PDB.Polypeptide.is_aa(res, standard=True)`; gemmi offers `st.remove_waters()`,
   `st.remove_ligands_and_waters()`, `st.remove_hydrogens()` and `Residue.het_flag`. Call
   `st.setup_entities()` after reading PDB files with gemmi.
4. Alternate locations: pick one conformer consistently. Biopython's `PDBParser` wraps
   them in `DisorderedAtom` objects that default to the highest occupancy
   (`atom.is_disordered()`); gemmi `st.remove_alternative_conformations()` keeps the
   first; MDAnalysis selects with `altloc A`. Counting all altlocs doubles some contacts.
5. Insertion codes: a Biopython residue id is `(hetflag, resseq, icode)`, so 52 and 52A are
   distinct residues; parsing the number alone merges them. Antibody numbering schemes rely
   on them.
6. Assemblies: the asymmetric unit may hold half a dimer or two copies of a monomer. The
   biological assembly applies the operators in `_pdbx_struct_assembly` (REMARK 350).
   gemmi: `gemmi.make_assembly(st.assemblies[0], st[0], gemmi.HowToNameCopiedChain.AddNumber)`
   or `st.transform_to_assembly("1", how)`; PyMOL `set assembly, 1` before `fetch`;
   ChimeraX `sym #1 assembly 1`; RCSB serves `<id>-assembly1.cif`. Interfaces across
   symmetry mates exist only in the assembly. Report which assembly, or that the
   asymmetric unit was used.
7. Hydrogens: crystal structures rarely include them. Angle-based hydrogen-bond criteria
   need added hydrogens (PDBFixer or OpenMM `Modeller.addHydrogens`, PyMOL `h_add`,
   ChimeraX `addh`); heavy-atom-only criteria are the alternative. State which.

## Criteria

8. Hydrogen bonds: heavy-atom donor-acceptor distance <= 3.5 angstroms is the common loose
   criterion, 3.2 or 3.0 strict; with hydrogens, D-H...A angle >= 120 degrees loose or
   >= 150 strict. MDAnalysis `HydrogenBondAnalysis` defaults to `d_a_cutoff=3.0` and
   `d_h_a_angle_cutoff=150`; ChimeraX `hbonds` applies Mills and Dean geometric criteria
   with default `distSlop 0.4` and `angleSlop 20` tolerances; PyMOL `distance ..., mode=2`
   uses a 3.5 angstrom default cutoff with its own polar-contact heuristics. Counts from
   different tools are not comparable; always name tool, version and numbers.
9. Interface residues by distance: any heavy atom within 4.0 angstroms of the partner
   chain (5.0 is the generous variant). Biopython
   `NeighborSearch(atoms).search_all(4.0, level="R")`; gemmi
   `NeighborSearch(st[0], st.cell, 5).populate()` with `ContactSearch(4.0)` and
   `ignore = ContactSearch.Ignore.SameChain`, which also finds contacts to symmetry
   images; MDAnalysis `select_atoms("chainID A and around 4.0 chainID B")`.
10. Interface residues by solvent accessibility: a residue is interfacial when its SASA
    drops on complexation (thresholds in use include > 0, > 1 square angstrom, and >= 5%).
    Buried surface area BSA = SASA(A) + SASA(B) - SASA(AB); PDBePISA reports interface area
    as BSA / 2, so say which convention a number follows. SASA with Shrake-Rupley and a
    1.4 angstrom probe: Biopython `ShrakeRupley(probe_radius=1.4, n_points=100)` from
    `Bio.PDB.SASA`, whose `.compute(struct, level="R")` fills `residue.sasa`; freesasa
    defaults to Lee-Richards; ChimeraX `measure buriedarea #1/A withAtoms2 #1/B` and
    `measure sasa`; PyMOL `set dot_solvent, 1` then `get_area`. Radii sets and point
    densities move SASA by a few percent. Remove waters and ligands first unless they are
    the question.
11. Secondary structure: DSSP through `Bio.PDB.DSSP(model, path, dssp="mkdssp")` (DSSP 4
    prefers mmCIF input); collapsing eight states to three (H, G, I to helix; E, B to
    strand; the rest to coil) is a convention to state.
12. Superposition and RMSD: report which atoms (CA only or all heavy), which residues
    (aligned core or all), and whether the RMSD is after the fit. PyMOL `align` rejects
    outliers over five cycles and reports RMSD on the kept subset, so also give `rms_cur`
    over all matched atoms; `Bio.PDB.Superimposer` and `MDAnalysis.analysis.rms.RMSD` fit
    on exactly the atoms you pass.

## Report

- Entry, assembly or asymmetric unit, model index, chains (author ids), numbering scheme.
- Altloc policy, HETATM and water policy, hydrogens added or not and by which tool.
- Every cutoff (distance, angle, SASA threshold, probe radius) with the tool and version.
- Counts at each filtering step, so a reader can see where residues went.

## Sources

- wwPDB PDBx/mmCIF dictionary: https://mmcif.wwpdb.org/
- wwPDB legacy PDB format v3.3: https://www.wwpdb.org/documentation/file-format-content/format33/v3.3.html
- Biopython Bio.PDB tutorial: https://biopython.org/docs/latest/Tutorial/chapter_pdb.html
- gemmi documentation (molecular models, neighbor and contact search): https://gemmi.readthedocs.io/
- MDAnalysis hydrogen bond analysis: https://docs.mdanalysis.org/stable/documentation_pages/analysis/hydrogenbonds.html
- ChimeraX commands `hbonds`, `measure`, `sym`: https://www.cgl.ucsf.edu/chimerax/docs/user/commands/
- PyMOL wiki (`align`, `distance`, `get_area`, `assembly`): https://pymolwiki.org/
- PDBePISA interface conventions: https://www.ebi.ac.uk/pdbe/pisa/
