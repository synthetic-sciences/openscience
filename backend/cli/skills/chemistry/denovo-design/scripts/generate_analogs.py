#!/usr/bin/env python3
"""
Scaffold-based analog generation for de novo drug design.

Generates structural analogs of a lead compound using three strategies:
  1. R-group enumeration: substituent scanning at identified positions
  2. Bioisosteric replacement: functional group swapping
  3. Random mutation: fragment-based random modifications

Usage:
    python generate_analogs.py --smiles "c1ccc(NC(=O)c2ccccc2)cc1" --output analogs.csv --num 50 --strategy all
"""

import argparse
import csv
import sys
import os
from collections import OrderedDict

try:
    from rdkit import Chem
    from rdkit.Chem import AllChem, Descriptors, QED, DataStructs, rdMolDescriptors
    from rdkit.Chem import RWMol, rdmolops
    from rdkit import RDLogger
    RDLogger.logger().setLevel(RDLogger.ERROR)
except ImportError:
    print("ERROR: RDKit is required. Install with: pip install rdkit-pypi")
    sys.exit(1)

try:
    import numpy as np
except ImportError:
    print("WARNING: numpy not found. Install with: pip install numpy")
    np = None


# ---------------------------------------------------------------------------
# Bioisostere dictionary: SMARTS pattern -> list of replacement SMARTS
# Each entry is (name, target_smarts, replacement_smiles_list)
# ---------------------------------------------------------------------------
BIOISOSTERE_DICT = [
    ("carboxylic_acid_to_tetrazole",
     "[CX3](=O)[OX2H1]",
     ["c1nn[nH]n1"]),
    ("carboxylic_acid_to_acylsulfonamide",
     "[CX3](=O)[OX2H1]",
     ["S(=O)(=O)NC"]),
    ("phenyl_to_thienyl",
     "c1ccccc1",
     ["c1ccsc1", "c1cc[nH]c1", "c1ccoc1"]),
    ("amide_to_sulfonamide",
     "[NX3H1][CX3](=O)",
     ["NS(=O)(=O)"]),
    ("ester_to_amide",
     "[CX3](=O)[OX2][CH3]",
     ["C(=O)NC"]),
    ("hydroxyl_to_amine",
     "[OX2H1]",
     ["N", "[NH2]"]),
    ("ether_to_thioether",
     "[OX2]([#6])[#6]",
     ["S"]),
    ("fluorine_scan",
     "[CH1]",
     ["[C]F"]),
]

# Common R-groups for enumeration (SMILES)
RGROUP_LIBRARY = [
    ("methyl", "C"),
    ("ethyl", "CC"),
    ("isopropyl", "C(C)C"),
    ("cyclopropyl", "C1CC1"),
    ("trifluoromethyl", "C(F)(F)F"),
    ("fluorine", "F"),
    ("chlorine", "Cl"),
    ("bromine", "Br"),
    ("methoxy", "OC"),
    ("ethoxy", "OCC"),
    ("hydroxyl", "O"),
    ("amino", "N"),
    ("dimethylamino", "N(C)C"),
    ("nitro", "[N+](=O)[O-]"),
    ("cyano", "C#N"),
    ("acetyl", "C(=O)C"),
    ("carboxyl", "C(=O)O"),
    ("sulfonyl_methyl", "S(=O)(=O)C"),
    ("methylsulfonyl", "CS(=O)(=O)"),
    ("trifluoromethoxy", "OC(F)(F)F"),
    ("phenyl", "c1ccccc1"),
    ("pyridyl", "c1ccncc1"),
]


def compute_properties(mol):
    """Compute standard molecular properties."""
    if mol is None:
        return None
    try:
        props = {
            "mw": round(Descriptors.MolWt(mol), 2),
            "logp": round(Descriptors.MolLogP(mol), 2),
            "qed": round(QED.qed(mol), 4),
        }
        return props
    except Exception:
        return None


def tanimoto_similarity(mol1, mol2, radius=2, n_bits=2048):
    """Compute Tanimoto similarity between two molecules using Morgan fingerprints."""
    try:
        fp1 = AllChem.GetMorganFingerprintAsBitVect(mol1, radius, nBits=n_bits)
        fp2 = AllChem.GetMorganFingerprintAsBitVect(mol2, radius, nBits=n_bits)
        return round(DataStructs.TanimotoSimilarity(fp1, fp2), 4)
    except Exception:
        return 0.0


def canonicalize(smiles):
    """Return canonical SMILES or None if invalid."""
    mol = Chem.MolFromSmiles(smiles)
    if mol is None:
        return None
    return Chem.MolToSmiles(mol)


# ---------------------------------------------------------------------------
# Strategy 1: R-group enumeration
# ---------------------------------------------------------------------------
def enumerate_rgroups(parent_mol, parent_smiles, max_analogs=100):
    """
    Identify aromatic and aliphatic C-H positions on the parent molecule,
    then enumerate common R-groups at each position via RDKit reaction SMARTS.
    """
    analogs = []
    parent_canonical = Chem.MolToSmiles(parent_mol)

    # Reaction: replace aromatic C-H with C-R
    # We use a simple approach: find H atoms on aromatic carbons, replace with R-groups
    rxn_aromatic = AllChem.ReactionFromSmarts("[cH:1]>>[c:1]([*:2])")
    rxn_aliphatic = AllChem.ReactionFromSmarts("[CH3:1]>>[CH2:1]([*:2])")
    rxn_aliphatic2 = AllChem.ReactionFromSmarts("[CH2:1]>>[CH:1]([*:2])")

    reactions = [
        ("aromatic_H", rxn_aromatic),
        ("aliphatic_CH3", rxn_aliphatic),
        ("aliphatic_CH2", rxn_aliphatic2),
    ]

    seen = set()
    seen.add(parent_canonical)

    for rgroup_name, rgroup_smi in RGROUP_LIBRARY:
        rgroup_mol = Chem.MolFromSmiles(rgroup_smi)
        if rgroup_mol is None:
            continue

        for rxn_name, rxn in reactions:
            try:
                products = rxn.RunReactants((parent_mol,))
                for product_tuple in products:
                    for product in product_tuple:
                        try:
                            # Replace the wildcard atom with the R-group
                            Chem.SanitizeMol(product)
                            product_smi = Chem.MolToSmiles(product)

                            # Manual combination: attach R-group
                            combined_smi = product_smi.replace("[*:2]", "(" + rgroup_smi + ")")
                            combined_mol = Chem.MolFromSmiles(combined_smi)
                            if combined_mol is None:
                                continue
                            can_smi = Chem.MolToSmiles(combined_mol)
                            if can_smi in seen or can_smi == parent_canonical:
                                continue
                            seen.add(can_smi)
                            analogs.append((can_smi, combined_mol, f"rgroup_{rgroup_name}"))
                            if len(analogs) >= max_analogs:
                                return analogs
                        except Exception:
                            continue
            except Exception:
                continue

    # Simpler fallback: direct substitution on aromatic hydrogens
    if len(analogs) < max_analogs // 2:
        analogs.extend(_direct_substitution(parent_mol, parent_canonical, seen, max_analogs - len(analogs)))

    return analogs


def _direct_substitution(parent_mol, parent_canonical, seen, max_count):
    """Directly substitute H atoms on the molecule with R-groups using SMILES manipulation."""
    analogs = []
    parent_smi = parent_canonical

    for rgroup_name, rgroup_smi in RGROUP_LIBRARY:
        # Try adding R-group at various ring positions using RDKit's ReplaceSubstructs
        pattern = Chem.MolFromSmarts("[cH]")
        if pattern is None:
            continue

        matches = parent_mol.GetSubstructMatches(pattern)
        for match_idx, match in enumerate(matches):
            if len(analogs) >= max_count:
                return analogs
            try:
                rw_mol = RWMol(parent_mol)
                atom_idx = match[0]
                # Add the R-group atom
                rgroup_mol = Chem.MolFromSmiles(rgroup_smi)
                if rgroup_mol is None:
                    continue
                combined = AllChem.CombineMols(parent_mol, rgroup_mol)
                rw_combined = RWMol(combined)
                # Bond the first atom of R-group to the matched atom
                new_atom_start = parent_mol.GetNumAtoms()
                rw_combined.AddBond(atom_idx, new_atom_start, Chem.BondType.SINGLE)
                try:
                    Chem.SanitizeMol(rw_combined)
                    can_smi = Chem.MolToSmiles(rw_combined)
                    if can_smi not in seen and can_smi != parent_canonical:
                        seen.add(can_smi)
                        final_mol = Chem.MolFromSmiles(can_smi)
                        if final_mol is not None:
                            analogs.append((can_smi, final_mol, f"rgroup_{rgroup_name}"))
                except Exception:
                    continue
            except Exception:
                continue

    return analogs


# ---------------------------------------------------------------------------
# Strategy 2: Bioisosteric replacement
# ---------------------------------------------------------------------------
def bioisosteric_replacement(parent_mol, parent_smiles, max_analogs=100):
    """
    Scan the parent molecule for known functional groups and swap them
    with bioisosteric replacements.
    """
    analogs = []
    parent_canonical = Chem.MolToSmiles(parent_mol)
    seen = set()
    seen.add(parent_canonical)

    for name, target_smarts, replacements in BIOISOSTERE_DICT:
        pattern = Chem.MolFromSmarts(target_smarts)
        if pattern is None:
            continue

        if not parent_mol.HasSubstructMatch(pattern):
            continue

        for replacement_smi in replacements:
            replacement_mol = Chem.MolFromSmiles(replacement_smi)
            if replacement_mol is None:
                replacement_mol = Chem.MolFromSmarts(replacement_smi)
            if replacement_mol is None:
                continue

            try:
                products = AllChem.ReplaceSubstructs(parent_mol, pattern, replacement_mol)
                for product in products:
                    try:
                        Chem.SanitizeMol(product)
                        can_smi = Chem.MolToSmiles(product)
                        if can_smi in seen or can_smi == parent_canonical:
                            continue
                        seen.add(can_smi)
                        final_mol = Chem.MolFromSmiles(can_smi)
                        if final_mol is not None:
                            analogs.append((can_smi, final_mol, f"bioisostere_{name}"))
                            if len(analogs) >= max_analogs:
                                return analogs
                    except Exception:
                        continue
            except Exception:
                continue

    return analogs


# ---------------------------------------------------------------------------
# Strategy 3: Random mutation
# ---------------------------------------------------------------------------
def random_mutation(parent_mol, parent_smiles, max_analogs=100, seed=42):
    """
    Generate analogs via random structural modifications:
      - Atom type mutations (C->N, N->O, etc.)
      - Bond order changes
      - Ring opening/closing
      - Side chain addition/removal
    """
    if np is not None:
        rng = np.random.RandomState(seed)
    else:
        import random
        rng = random.Random(seed)

    analogs = []
    parent_canonical = Chem.MolToSmiles(parent_mol)
    seen = set()
    seen.add(parent_canonical)

    # Mutation operations
    atom_mutations = [6, 7, 8, 16, 9, 17]  # C, N, O, S, F, Cl
    max_attempts = max_analogs * 20

    for attempt in range(max_attempts):
        if len(analogs) >= max_analogs:
            break

        try:
            rw_mol = RWMol(Chem.RWMol(parent_mol))
            num_atoms = rw_mol.GetNumAtoms()
            if num_atoms == 0:
                continue

            if np is not None:
                mutation_type = rng.choice(["atom_swap", "add_atom", "remove_atom", "add_bond"])
            else:
                mutation_type = rng.choice(["atom_swap", "add_atom", "remove_atom", "add_bond"])

            if mutation_type == "atom_swap":
                # Change atom type at a random position
                if np is not None:
                    idx = rng.randint(0, num_atoms)
                else:
                    idx = rng.randint(0, num_atoms - 1)
                atom = rw_mol.GetAtomWithIdx(idx)
                old_num = atom.GetAtomicNum()
                candidates = [a for a in atom_mutations if a != old_num]
                if not candidates:
                    continue
                if np is not None:
                    new_num = rng.choice(candidates)
                else:
                    new_num = rng.choice(candidates)
                atom.SetAtomicNum(new_num)
                atom.SetFormalCharge(0)
                atom.SetNumExplicitHs(0)
                atom.SetNoImplicit(False)

            elif mutation_type == "add_atom":
                # Add an atom bonded to a random existing atom
                if np is not None:
                    idx = rng.randint(0, num_atoms)
                    new_atomic_num = rng.choice([6, 7, 8])
                else:
                    idx = rng.randint(0, num_atoms - 1)
                    new_atomic_num = rng.choice([6, 7, 8])
                new_idx = rw_mol.AddAtom(Chem.Atom(new_atomic_num))
                rw_mol.AddBond(idx, new_idx, Chem.BondType.SINGLE)

            elif mutation_type == "remove_atom":
                # Remove a terminal atom
                terminal_atoms = []
                for i in range(num_atoms):
                    atom = rw_mol.GetAtomWithIdx(i)
                    if atom.GetDegree() == 1 and atom.GetAtomicNum() != 1:
                        terminal_atoms.append(i)
                if not terminal_atoms:
                    continue
                if np is not None:
                    remove_idx = rng.choice(terminal_atoms)
                else:
                    remove_idx = rng.choice(terminal_atoms)
                rw_mol.RemoveAtom(remove_idx)

            elif mutation_type == "add_bond":
                # Try to add a bond between two non-bonded atoms
                if num_atoms < 3:
                    continue
                for _ in range(10):
                    if np is not None:
                        i, j = rng.randint(0, num_atoms, size=2)
                    else:
                        i = rng.randint(0, num_atoms - 1)
                        j = rng.randint(0, num_atoms - 1)
                    if i != j and rw_mol.GetBondBetweenAtoms(int(i), int(j)) is None:
                        rw_mol.AddBond(int(i), int(j), Chem.BondType.SINGLE)
                        break

            # Try to sanitize
            try:
                Chem.SanitizeMol(rw_mol)
            except Exception:
                continue

            smi = Chem.MolToSmiles(rw_mol)
            # Re-parse to validate
            check_mol = Chem.MolFromSmiles(smi)
            if check_mol is None:
                continue
            can_smi = Chem.MolToSmiles(check_mol)

            if can_smi in seen or can_smi == parent_canonical:
                continue

            # Basic sanity: MW between 100 and 1000
            mw = Descriptors.MolWt(check_mol)
            if mw < 100 or mw > 1000:
                continue

            seen.add(can_smi)
            analogs.append((can_smi, check_mol, "mutate"))

        except Exception:
            continue

    return analogs


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main():
    parser = argparse.ArgumentParser(
        description="Generate structural analogs of a lead compound for drug discovery."
    )
    parser.add_argument(
        "--smiles", required=True,
        help="SMILES string of the lead compound."
    )
    parser.add_argument(
        "--output", required=True,
        help="Output file path (CSV)."
    )
    parser.add_argument(
        "--num", type=int, default=50,
        help="Target number of analogs to generate (default: 50)."
    )
    parser.add_argument(
        "--strategy", default="all",
        choices=["all", "rgroup", "bioisostere", "mutate"],
        help="Generation strategy (default: all)."
    )
    args = parser.parse_args()

    # Parse parent molecule
    parent_mol = Chem.MolFromSmiles(args.smiles)
    if parent_mol is None:
        print(f"ERROR: Could not parse SMILES: {args.smiles}")
        sys.exit(1)

    parent_canonical = Chem.MolToSmiles(parent_mol)
    print(f"Lead compound: {parent_canonical}")
    parent_props = compute_properties(parent_mol)
    if parent_props:
        print(f"  MW: {parent_props['mw']}, LogP: {parent_props['logp']}, QED: {parent_props['qed']}")

    # Generate analogs
    all_analogs = []
    per_strategy = max(args.num // 3, 10) if args.strategy == "all" else args.num

    if args.strategy in ("all", "rgroup"):
        print(f"\n--- R-group enumeration (target: {per_strategy}) ---")
        rgroup_analogs = enumerate_rgroups(parent_mol, parent_canonical, max_analogs=per_strategy)
        print(f"  Generated: {len(rgroup_analogs)}")
        all_analogs.extend(rgroup_analogs)

    if args.strategy in ("all", "bioisostere"):
        print(f"\n--- Bioisosteric replacement (target: {per_strategy}) ---")
        bio_analogs = bioisosteric_replacement(parent_mol, parent_canonical, max_analogs=per_strategy)
        print(f"  Generated: {len(bio_analogs)}")
        all_analogs.extend(bio_analogs)

    if args.strategy in ("all", "mutate"):
        print(f"\n--- Random mutation (target: {per_strategy}) ---")
        mut_analogs = random_mutation(parent_mol, parent_canonical, max_analogs=per_strategy)
        print(f"  Generated: {len(mut_analogs)}")
        all_analogs.extend(mut_analogs)

    # Deduplicate by canonical SMILES
    deduped = OrderedDict()
    for smi, mol, strategy in all_analogs:
        can = canonicalize(smi)
        if can and can not in deduped and can != parent_canonical:
            deduped[can] = (mol, strategy)

    print(f"\nTotal unique analogs after deduplication: {len(deduped)}")

    # Compute properties and write output
    results = []
    for idx, (can_smi, (mol, strategy)) in enumerate(deduped.items()):
        props = compute_properties(mol)
        if props is None:
            continue
        sim = tanimoto_similarity(parent_mol, mol)
        results.append({
            "id": f"analog_{idx+1:04d}",
            "smiles": can_smi,
            "mw": props["mw"],
            "logp": props["logp"],
            "qed": props["qed"],
            "tanimoto_to_parent": sim,
            "strategy": strategy,
        })

    # Trim to requested number
    results = results[:args.num]

    # Write CSV
    if results:
        output_dir = os.path.dirname(args.output)
        if output_dir and not os.path.exists(output_dir):
            os.makedirs(output_dir, exist_ok=True)

        fieldnames = ["id", "smiles", "mw", "logp", "qed", "tanimoto_to_parent", "strategy"]
        with open(args.output, "w", newline="") as f:
            writer = csv.DictWriter(f, fieldnames=fieldnames)
            writer.writeheader()
            writer.writerows(results)
        print(f"\nWrote {len(results)} analogs to {args.output}")
    else:
        print("\nWARNING: No valid analogs generated.")
        sys.exit(1)

    # Print summary statistics
    if results:
        mw_vals = [r["mw"] for r in results]
        logp_vals = [r["logp"] for r in results]
        qed_vals = [r["qed"] for r in results]
        sim_vals = [r["tanimoto_to_parent"] for r in results]

        print("\n=== Summary ===")
        print(f"  Total analogs: {len(results)}")
        print(f"  MW   range: {min(mw_vals):.1f} - {max(mw_vals):.1f} (mean: {sum(mw_vals)/len(mw_vals):.1f})")
        print(f"  LogP range: {min(logp_vals):.2f} - {max(logp_vals):.2f} (mean: {sum(logp_vals)/len(logp_vals):.2f})")
        print(f"  QED  range: {min(qed_vals):.3f} - {max(qed_vals):.3f} (mean: {sum(qed_vals)/len(qed_vals):.3f})")
        print(f"  Similarity range: {min(sim_vals):.3f} - {max(sim_vals):.3f} (mean: {sum(sim_vals)/len(sim_vals):.3f})")

        # Strategy breakdown
        strategy_counts = {}
        for r in results:
            s = r["strategy"].split("_")[0] if "_" in r["strategy"] else r["strategy"]
            strategy_counts[s] = strategy_counts.get(s, 0) + 1
        print(f"  Strategy breakdown: {strategy_counts}")


if __name__ == "__main__":
    main()
